require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const cron = require('node-cron');
const { Resend } = require('resend');
const db = require('./db');
const aiRoutes = require('./routes/aiRoutes');
const emailVerificationService = require('./services/emailVerificationService');
const leadFinderService = require('./services/leadFinderService');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SEND_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Optional Basic Auth gate. This app can dump lead PII and, once dry run is
// off, send real emails - by default it has zero access control, so anyone
// with the URL could do either. Set APP_USERNAME + APP_PASSWORD (e.g. in
// Railway's Variables tab) to require a login. Leave both unset for local
// dev. The unsubscribe link recipients click from their inbox stays public
// either way - they have no way to supply credentials.
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = [/^\/api\/unsubscribe\//, /^\/api\/health$/];

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep timing consistent either way
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuthMiddleware(req, res, next) {
  if (PUBLIC_PATHS.some((re) => re.test(req.path))) return next();
  const user = process.env.APP_USERNAME;
  const pass = process.env.APP_PASSWORD;
  if (!user || !pass) return next(); // auth disabled unless both are set
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const reqUser = sep === -1 ? decoded : decoded.slice(0, sep);
    const reqPass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (safeEqual(reqUser, user) && safeEqual(reqPass, pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Outreach Sequencer"');
  return res.status(401).send('Authentication required.');
}

app.use(basicAuthMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Email rendering + sending
// ---------------------------------------------------------------------------

function render(template, lead) {
  const firstName = (lead.name || '').trim().split(/\s+/)[0] || 'there';
  const map = {
    first_name: firstName,
    name: lead.name || '',
    company: lead.company || 'your business',
    website: lead.website || '',
    email: lead.email || '',
    title: lead.title || '',
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (map[key] !== undefined ? map[key] : m));
}

function unsubscribeFooter(settings, lead) {
  const url = `${settings.appUrl.replace(/\/$/, '')}/api/unsubscribe/${lead.unsubscribeToken}`;
  return `\n\n---\nDon't want to hear from us again? Unsubscribe: ${url}`;
}

let resendClient = null;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const SEND_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function sendEmail(settings, { to, subject, text }) {
  const dryRun = settings.dryRun || !process.env.RESEND_API_KEY;
  if (dryRun) {
    console.log(`[DRY RUN] Would send to ${to} | subject: "${subject}"`);
    return { status: 'dry_run' };
  }
  try {
    const client = getResendClient();
    const from = `${settings.fromName} <${settings.fromEmail}>`;
    // Without a timeout, a single hung Resend call blocks every subsequent
    // lead in the scheduler's batch loop indefinitely - one slow request
    // would silently stall the whole send run.
    const result = await withTimeout(client.emails.send({ from, to, subject, text }), SEND_TIMEOUT_MS, 'Resend send');
    if (result.error) return { status: 'failed', error: result.error.message || String(result.error) };
    return { status: 'sent', resendId: result.data ? result.data.id : undefined };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err) };
  }
}

// Sends whichever step is next due for a single lead (used both on lead
// creation, for the immediate first email, and by the scheduler loop).
async function processLead(lead) {
  if (lead.status !== 'active') return lead;

  const [settings, sequenceSteps] = await Promise.all([db.getSettings(), db.getSequenceSteps()]);
  if (!settings) {
    console.error('Settings row not found in database. Initialize with ensureSeeded().');
    return lead;
  }
  const nextStepNumber = lead.currentStage + 1;
  // Find the next enabled step, skipping any disabled steps
  const step = sequenceSteps.find((s) => s.stepNumber >= nextStepNumber && s.enabled);

  if (!step) {
    // no more enabled steps - sequence finished
    return db.updateLead(lead.id, { status: 'completed', nextSendAt: null });
  }

  const subject = render(step.subject, lead);
  const body = render(step.body, lead) + unsubscribeFooter(settings, lead);
  const result = await sendEmail(settings, { to: lead.email, subject, text: body });

  const logEntry = {
    leadId: lead.id,
    leadEmail: lead.email,
    stepNumber: step.stepNumber,
    subject,
    status: result.status,
    resendId: result.resendId || null,
    error: result.error || null,
  };

  if (result.status === 'failed') {
    const failCount = (lead.failCount || 0) + 1;
    const patch = { failCount };
    if (failCount >= MAX_SEND_ATTEMPTS) {
      // stop hammering Resend for a permanently-broken address; surface it
      // so it can be fixed and manually resumed instead of retrying forever
      patch.status = 'bounced';
      patch.nextSendAt = null;
    }
    // Atomically log the failure and update the lead
    return db.addLogAndUpdateLead(lead.id, logEntry, patch);
  }

  const patch = { currentStage: step.stepNumber, lastSentAt: new Date(), failCount: 0 };
  // Find the next enabled step after this one
  const nextStep = sequenceSteps.find((s) => s.stepNumber > step.stepNumber && s.enabled);
  if (nextStep) {
    patch.nextSendAt = new Date(Date.now() + nextStep.delayDays * 86400000);
  } else {
    patch.status = 'completed';
    patch.nextSendAt = null;
  }
  // Atomically log the success and update the lead
  return db.addLogAndUpdateLead(lead.id, logEntry, patch);
}

async function runDueSends() {
  const dueLeads = await db.getDueLeads();
  for (const lead of dueLeads) {
    try {
      await processLead(lead);
    } catch (err) {
      // One lead's DB hiccup or network issue must not stop the rest of the
      // batch from being attempted - it'll just retry this lead next tick,
      // since nextSendAt was never advanced.
      console.error(`runDueSends: failed to process lead ${lead.id} (${lead.email}):`, err.message);
    }
  }
  return dueLeads.length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

const HEADER_MAP = {
  name: 'name', fullname: 'name', contactname: 'name', contact: 'name',
  company: 'company', businessname: 'company', business: 'company', companyname: 'company',
  email: 'email', contactemail: 'email', emailaddress: 'email',
  phone: 'phone', phonenumber: 'phone', tel: 'phone',
  website: 'website', url: 'website', site: 'website',
};

function csvRowToLead(row) {
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    const norm = normalizeHeader(key);
    const field = HEADER_MAP[norm];
    if (field && val) out[field] = String(val).trim();
  }
  return out;
}

const LINKEDIN_HEADER_MAP = {
  name: 'name', fullname: 'name', contactname: 'name', contact: 'name',
  company: 'company', businessname: 'company', business: 'company', companyname: 'company',
  title: 'title', jobtitle: 'title', position: 'title', role: 'title',
  profileurl: 'profileUrl', linkedin: 'profileUrl', linkedinurl: 'profileUrl', profile: 'profileUrl', url: 'profileUrl',
};

function csvRowToLinkedinProspect(row) {
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    const norm = normalizeHeader(key);
    const field = LINKEDIN_HEADER_MAP[norm];
    if (field && val) out[field] = String(val).trim();
  }
  return out;
}

function newLeadRecord({ name, company, email, phone, website }, verification) {
  return {
    name: name || '',
    company: company || '',
    email,
    phone: phone || '',
    website: website || '',
    status: 'active',
    currentStage: 0,
    failCount: 0,
    nextSendAt: new Date(),
    unsubscribeToken: crypto.randomBytes(16).toString('hex'),
    emailVerification: verification ? verification.status : 'unverified',
    emailVerifiedAt: verification ? new Date() : null,
  };
}

// ---------------------------------------------------------------------------
// Routes: leads
// ---------------------------------------------------------------------------

app.get('/api/leads', async (req, res) => {
  res.json(await db.getLeads());
});

app.post('/api/leads', async (req, res) => {
  const { name, company, email, phone, website } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  const verification = await emailVerificationService.verifyEmail(email);
  if (verification.status === 'invalid') {
    return res.status(400).json({ error: 'This email address does not look deliverable (no mail server found, or a known disposable domain).' });
  }
  try {
    const lead = await db.createLead(newLeadRecord({ name, company, email, phone, website }, verification));
    await processLead(lead);
    res.status(201).json(await db.getLeadById(lead.id));
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A lead with this email already exists.' });
    }
    throw err;
  }
});

// Shared by CSV upload and the scheduled lead finder: dedupes candidates
// against existing leads (and each other), verifies remaining emails, then
// creates + enrolls whichever ones pass. `candidates` items need at least
// {email}; name/company/phone/website are optional.
async function ingestLeadCandidates(candidates) {
  const existingLeads = await db.getLeads();
  const existing = new Set(existingLeads.map((l) => l.email.toLowerCase()));
  let added = 0;
  let addedRisky = 0;
  let skippedDuplicate = 0;
  let skippedUnverifiable = 0;
  const details = []; // per-candidate outcome, used by the lead-finder "show results" view

  const deduped = [];
  for (const c of candidates) {
    const emailLower = c.email.toLowerCase();
    if (existing.has(emailLower)) {
      skippedDuplicate += 1;
      details.push({ ...c, outcome: 'duplicate' });
      continue;
    }
    existing.add(emailLower);
    deduped.push(c);
  }

  // Dedupe before doing any DNS lookups, so repeats don't waste MX queries.
  const verifications = await emailVerificationService.verifyBatch(deduped.map((c) => c.email));

  for (let i = 0; i < deduped.length; i++) {
    const mapped = deduped[i];
    const verification = verifications[i];
    if (verification.status === 'invalid') {
      skippedUnverifiable += 1;
      details.push({ ...mapped, outcome: 'unverifiable' });
      continue;
    }
    try {
      const lead = await db.createLead(newLeadRecord(mapped, verification));
      await processLead(lead);
      added += 1;
      if (verification.status === 'risky') addedRisky += 1;
      details.push({ ...mapped, outcome: verification.status === 'risky' ? 'added_risky' : 'added' });
    } catch (err) {
      if (err.code === 'P2002') {
        skippedDuplicate += 1;
        details.push({ ...mapped, outcome: 'duplicate' });
      } else {
        throw err;
      }
    }
  }

  return { added, addedRisky, skippedDuplicate, skippedUnverifiable, details };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/leads/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
  }

  let skippedNoEmail = 0;
  const candidates = [];
  for (const row of rows) {
    const mapped = csvRowToLead(row);
    if (!mapped.email || !EMAIL_RE.test(mapped.email)) {
      skippedNoEmail += 1;
      continue;
    }
    candidates.push(mapped);
  }

  const { added, addedRisky, skippedDuplicate, skippedUnverifiable } = await ingestLeadCandidates(candidates);

  res.json({ added, addedRisky, skippedNoEmail, skippedDuplicate, skippedUnverifiable, total: rows.length });
});

app.post('/api/leads/:id/pause', async (req, res) => {
  const lead = await db.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(await db.updateLead(lead.id, { status: 'paused' }));
});

app.post('/api/leads/:id/resume', async (req, res) => {
  const lead = await db.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const patch = { status: 'active', failCount: 0 };
  if (!lead.nextSendAt || new Date(lead.nextSendAt).getTime() < Date.now()) {
    patch.nextSendAt = new Date();
  }
  res.json(await db.updateLead(lead.id, patch));
});

app.post('/api/leads/:id/mark-replied', async (req, res) => {
  const lead = await db.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(await db.updateLead(lead.id, { status: 'replied', nextSendAt: null }));
});

app.post('/api/leads/:id/unsubscribe', async (req, res) => {
  const lead = await db.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(await db.updateLead(lead.id, { status: 'unsubscribed', nextSendAt: null }));
});

app.delete('/api/leads/:id', async (req, res) => {
  const lead = await db.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  await db.deleteLead(lead.id);
  res.json({ ok: true });
});

// Public unsubscribe link used inside emails - no auth, just the token.
app.get('/api/unsubscribe/:token', async (req, res) => {
  const lead = await db.getLeadByUnsubscribeToken(req.params.token);
  if (lead) {
    await db.updateLead(lead.id, { status: 'unsubscribed', nextSendAt: null });
  }
  res.send(`<!doctype html><html><body style="font-family: system-ui; max-width: 480px; margin: 80px auto; text-align:center;">
    <h2>You're unsubscribed</h2>
    <p>You won't receive any further emails from us. Sorry for the noise.</p>
  </body></html>`);
});

// ---------------------------------------------------------------------------
// Routes: sequence steps
// ---------------------------------------------------------------------------

app.get('/api/sequence', async (req, res) => {
  res.json(await db.getSequenceSteps());
});

app.put('/api/sequence/:stepNumber', async (req, res) => {
  const stepNumber = Number(req.params.stepNumber);
  const step = await db.getSequenceStep(stepNumber);
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const { subject, body, delayDays, enabled } = req.body || {};
  const patch = {};
  if (subject !== undefined) patch.subject = subject;
  if (body !== undefined) patch.body = body;
  if (delayDays !== undefined) patch.delayDays = Math.max(0, Number(delayDays) || 0);
  if (enabled !== undefined) patch.enabled = !!enabled;
  res.json(await db.updateSequenceStep(stepNumber, patch));
});

app.post('/api/sequence/preview', async (req, res) => {
  const { stepNumber, sample } = req.body || {};
  const step = await db.getSequenceStep(Number(stepNumber));
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const settings = await db.getSettings();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized. Contact administrator.' });
  const fakeLead = {
    name: (sample && sample.name) || 'Alex Morgan',
    company: (sample && sample.company) || 'Acme Dental',
    website: (sample && sample.website) || 'acmedental.com',
    email: (sample && sample.email) || 'alex@acmedental.com',
    unsubscribeToken: 'preview-token',
  };
  const subject = render(step.subject, fakeLead);
  const body = render(step.body, fakeLead) + unsubscribeFooter(settings, fakeLead);
  res.json({ subject, body });
});

// ---------------------------------------------------------------------------
// Routes: settings
// ---------------------------------------------------------------------------

app.get('/api/settings', async (req, res) => {
  const settings = await db.getSettings();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized. Contact administrator.' });
  res.json({ ...settings, resendConfigured: !!process.env.RESEND_API_KEY });
});

app.put('/api/settings', async (req, res) => {
  const { dryRun, fromName, fromEmail, appUrl } = req.body || {};
  const patch = {};
  if (dryRun !== undefined) patch.dryRun = !!dryRun;
  if (fromName !== undefined) patch.fromName = fromName;
  if (fromEmail !== undefined) patch.fromEmail = fromEmail;
  if (appUrl !== undefined) patch.appUrl = appUrl;
  res.json(await db.updateSettings(patch));
});

app.post('/api/settings/test-send', async (req, res) => {
  const { to, force } = req.body || {};
  if (!to || !EMAIL_RE.test(to)) return res.status(400).json({ error: 'A valid "to" email is required.' });
  const settings = await db.getSettings();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized. Contact administrator.' });
  const sendSettings = force ? { ...settings, dryRun: false } : settings;
  const step = await db.getSequenceStep(1);
  const fakeLead = { name: 'Alex Morgan', company: 'Acme Dental', email: to, unsubscribeToken: 'preview-token' };
  const subject = `[TEST] ${render(step.subject, fakeLead)}`;
  const body = render(step.body, fakeLead) + unsubscribeFooter(settings, fakeLead);
  const result = await sendEmail(sendSettings, { to, subject, text: body });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Routes: logs + manual scheduler trigger
// ---------------------------------------------------------------------------

app.get('/api/logs', async (req, res) => {
  res.json(await db.getLogs(200));
});

app.post('/api/scheduler/run', async (req, res) => {
  try {
    const processed = await runDueSends();
    res.json({ processed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ============================================================================
// AI-POWERED SALES OS ROUTES
// ============================================================================
app.use('/api', aiRoutes);

// ---------------------------------------------------------------------------
// Routes: LinkedIn outreach assist (semi-automated - drafts/queues notes only,
// never contacts linkedin.com itself; a human clicks Connect/Send for every
// prospect in their own browser).
// ---------------------------------------------------------------------------

const LINKEDIN_NOTE_LIMIT = 300; // LinkedIn's own connection-note character cap

app.get('/api/linkedin/template', async (req, res) => {
  const template = await db.getLinkedinTemplate();
  if (!template) return res.status(500).json({ error: 'LinkedIn template not initialized. Contact administrator.' });
  res.json(template);
});

app.put('/api/linkedin/template', async (req, res) => {
  const { note } = req.body || {};
  if (note === undefined) return res.status(400).json({ error: 'note is required' });
  res.json(await db.updateLinkedinTemplate({ note }));
});

app.post('/api/linkedin/template/preview', async (req, res) => {
  const { sample } = req.body || {};
  const template = await db.getLinkedinTemplate();
  if (!template) return res.status(500).json({ error: 'LinkedIn template not initialized. Contact administrator.' });
  const fakeProspect = {
    name: (sample && sample.name) || 'Alex Morgan',
    company: (sample && sample.company) || 'Acme Dental',
    title: (sample && sample.title) || 'Practice Manager',
  };
  const note = render(template.note, fakeProspect);
  res.json({ note, length: note.length, overLimit: note.length > LINKEDIN_NOTE_LIMIT });
});

app.get('/api/linkedin/prospects', async (req, res) => {
  res.json(await db.getLinkedinProspects());
});

app.post('/api/linkedin/prospects', async (req, res) => {
  const { name, company, title, profileUrl } = req.body || {};
  if (!profileUrl) return res.status(400).json({ error: 'A LinkedIn profile URL is required.' });
  const template = await db.getLinkedinTemplate();
  if (!template) return res.status(500).json({ error: 'LinkedIn template not initialized. Contact administrator.' });
  const note = render(template.note, { name, company, title });
  const prospect = await db.createLinkedinProspect({
    name: name || '',
    company: company || '',
    title: title || '',
    profileUrl,
    note,
    status: 'queued',
  });
  res.status(201).json(prospect);
});

app.post('/api/linkedin/prospects/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
  }

  const template = await db.getLinkedinTemplate();
  if (!template) return res.status(500).json({ error: 'LinkedIn template not initialized. Contact administrator.' });
  const existingProspects = await db.getLinkedinProspects();
  const existingUrls = new Set(existingProspects.map((p) => p.profileUrl.toLowerCase()));
  let added = 0;
  let skippedNoUrl = 0;
  let skippedDuplicate = 0;

  for (const row of rows) {
    const mapped = csvRowToLinkedinProspect(row);
    if (!mapped.profileUrl) {
      skippedNoUrl += 1;
      continue;
    }
    const urlLower = mapped.profileUrl.toLowerCase();
    if (existingUrls.has(urlLower)) {
      skippedDuplicate += 1;
      continue;
    }
    existingUrls.add(urlLower);
    const note = render(template.note, mapped);
    await db.createLinkedinProspect({
      name: mapped.name || '',
      company: mapped.company || '',
      title: mapped.title || '',
      profileUrl: mapped.profileUrl,
      note,
      status: 'queued',
    });
    added += 1;
  }

  res.json({ added, skippedNoUrl, skippedDuplicate, total: rows.length });
});

app.put('/api/linkedin/prospects/:id', async (req, res) => {
  const prospect = await db.getLinkedinProspectById(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'Not found' });
  const { note } = req.body || {};
  if (note === undefined) return res.status(400).json({ error: 'note is required' });
  res.json(await db.updateLinkedinProspect(prospect.id, { note }));
});

app.post('/api/linkedin/prospects/:id/mark-sent', async (req, res) => {
  const prospect = await db.getLinkedinProspectById(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'Not found' });
  res.json(await db.updateLinkedinProspect(prospect.id, { status: 'sent', sentAt: new Date() }));
});

app.post('/api/linkedin/prospects/:id/skip', async (req, res) => {
  const prospect = await db.getLinkedinProspectById(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'Not found' });
  res.json(await db.updateLinkedinProspect(prospect.id, { status: 'skipped' }));
});

app.post('/api/linkedin/prospects/:id/mark-replied', async (req, res) => {
  const prospect = await db.getLinkedinProspectById(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'Not found' });
  res.json(await db.updateLinkedinProspect(prospect.id, { status: 'replied' }));
});

app.delete('/api/linkedin/prospects/:id', async (req, res) => {
  const prospect = await db.getLinkedinProspectById(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'Not found' });
  await db.deleteLinkedinProspect(prospect.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routes: lead finder (scheduled, unattended lead discovery via Searlo)
// ---------------------------------------------------------------------------

app.get('/api/lead-finder/config', async (req, res) => {
  res.json(await db.getLeadFinderConfig());
});

app.put('/api/lead-finder/config', async (req, res) => {
  const { enabled, query, maxPerRun, intervalDays } = req.body || {};
  const patch = {};
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (query !== undefined) patch.query = String(query).trim();
  if (maxPerRun !== undefined) patch.maxPerRun = Math.max(1, Math.min(200, Number(maxPerRun) || 20));
  if (intervalDays !== undefined) patch.intervalDays = Math.max(1, Math.min(90, Number(intervalDays) || 7));

  if (patch.enabled) {
    const current = await db.getLeadFinderConfig();
    const resultingQuery = patch.query !== undefined ? patch.query : current.query;
    if (!resultingQuery) return res.status(400).json({ error: 'Set a search query before enabling the lead finder.' });
  }

  res.json(await db.updateLeadFinderConfig(patch));
});

// In-memory only - reset on restart. Powers the "show progress" / "show
// results" UI; the leads themselves are already durably saved in Postgres
// by the time this is populated, so losing this on restart costs nothing
// but the convenience view.
let leadFinderProgress = { running: false, phase: 'idle', total: 0, visited: 0, found: 0, lastSite: null };
let lastRunResults = [];

// Runs one lead-finder pass right now, regardless of schedule. Shared by the
// manual "run now" endpoint and the hourly due-check below.
async function runLeadFinderNow() {
  if (leadFinderProgress.running) return { skipped: 'already running' };
  const config = await db.getLeadFinderConfig();
  if (!config.query) return { skipped: 'no query configured' };
  if (!process.env.SEARLO_API_KEY) return { skipped: 'SEARLO_API_KEY not set' };

  leadFinderProgress = { running: true, phase: 'searching', total: 0, visited: 0, found: 0, lastSite: null };
  try {
    console.log(`Lead finder: searching "${config.query}" for up to ${config.maxPerRun} lead(s)...`);
    const found = await leadFinderService.findLeads(config.query, config.maxPerRun, {
      onProgress: (p) => {
        leadFinderProgress = {
          ...leadFinderProgress,
          phase: p.phase,
          total: p.total || leadFinderProgress.total,
          visited: p.visited || leadFinderProgress.visited,
          found: p.found ?? leadFinderProgress.found,
          lastSite: p.site || leadFinderProgress.lastSite,
        };
      },
    });
    const result = await ingestLeadCandidates(found);
    lastRunResults = result.details;
    await db.updateLeadFinderConfig({
      lastRunAt: new Date(),
      lastRunAdded: result.added,
      lastRunError: null,
    });
    console.log(`Lead finder: found ${found.length}, added ${result.added} (${result.addedRisky} risky), skipped ${result.skippedDuplicate} duplicate + ${result.skippedUnverifiable} unverifiable.`);
    return { found: found.length, ...result };
  } catch (err) {
    await db.updateLeadFinderConfig({ lastRunAt: new Date(), lastRunError: err.message });
    console.error('Lead finder run failed:', err.message);
    return { error: err.message };
  } finally {
    leadFinderProgress = { ...leadFinderProgress, running: false, phase: 'idle' };
  }
}

app.get('/api/lead-finder/progress', (req, res) => {
  res.json({ ...leadFinderProgress, lastRunResults });
});

app.get('/api/lead-finder/last-run.csv', (req, res) => {
  const headers = ['name', 'company', 'email', 'phone', 'website', 'outcome'];
  const escape = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const r of lastRunResults) {
    lines.push(headers.map((h) => escape(r[h])).join(','));
  }
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="lead-finder-last-run.csv"');
  res.send(lines.join('\n'));
});

app.post('/api/lead-finder/run-now', async (req, res) => {
  const config = await db.getLeadFinderConfig();
  if (!config.query) return res.status(400).json({ error: 'Set a search query first.' });
  if (leadFinderProgress.running) return res.status(409).json({ error: 'A lead finder run is already in progress.' });
  res.status(202).json({ message: 'Lead finder run started. Poll /api/lead-finder/progress for live status.' });
  runLeadFinderNow().catch((e) => console.error('Lead finder run-now error:', e));
});

// ---------------------------------------------------------------------------
// Scheduler: check every 15 minutes for leads due their next email; check
// hourly whether the lead finder is due to run again.
// ---------------------------------------------------------------------------

cron.schedule('*/15 * * * *', () => {
  runDueSends().then((n) => {
    if (n > 0) console.log(`Scheduler: sent ${n} email(s).`);
  }).catch((e) => console.error('Scheduler error:', e));
});

cron.schedule('0 * * * *', async () => {
  try {
    const config = await db.getLeadFinderConfig();
    if (!config.enabled || !config.query) return;
    const dueAt = config.lastRunAt ? new Date(config.lastRunAt).getTime() + config.intervalDays * 86400000 : 0;
    if (Date.now() < dueAt) return;
    await runLeadFinderNow();
  } catch (e) {
    console.error('Lead finder scheduler error:', e);
  }
});

async function start() {
  await db.ensureSeeded();
  const settings = await db.getSettings();
  app.listen(PORT, () => {
    console.log(`Lead outreach app running on port ${PORT}`);
    console.log(`Dry run mode: ${settings.dryRun ? 'ON (no real emails will send)' : 'OFF (real emails will send)'}`);
    if (process.env.APP_USERNAME && process.env.APP_PASSWORD) {
      console.log('Basic auth: ON');
    } else {
      console.log('Basic auth: OFF (set APP_USERNAME + APP_PASSWORD to require a login)');
    }
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
