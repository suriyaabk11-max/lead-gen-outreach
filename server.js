require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const cron = require('node-cron');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Tiny JSON file "database"
// Good enough for tens/hundreds of leads a week. If you outgrow this, swap
// the functions below for a real database (Postgres works great on Railway).
// NOTE: Railway's filesystem is ephemeral across redeploys unless you attach
// a persistent volume mounted at this app's /data path. See README.
// ---------------------------------------------------------------------------

const DEFAULT_SEQUENCE = [
  {
    stepNumber: 1,
    delayDays: 0,
    enabled: true,
    subject: 'missed calls at {{company}}',
    body: `Hey {{first_name}},

Quick question - when {{company}} gets a call during a busy stretch, or after you've closed for the day, what happens to it?

Most local businesses we talk to lose a handful of bookings every week just because nobody picked up in time. We built an AI voice agent that answers every call like a real receptionist, books the appointment straight into your calendar, and never puts anyone on hold.

Worth a quick look?`,
  },
  {
    stepNumber: 2,
    delayDays: 4,
    enabled: true,
    subject: 'front desk overflow',
    body: `Hey {{first_name}},

Following up on my note about missed calls at {{company}}.

One way to think about it: if your front desk is tied up for even 10 minutes during peak hours, that's every call in that window going to voicemail - and most callers just hang up and try the next place on Google.

The AI receptionist we built picks up instantly, every time, and handles booking without anyone on your team lifting a finger. Happy to send over a 2-minute recording of it in action if useful.`,
  },
  {
    stepNumber: 3,
    delayDays: 10,
    enabled: true,
    subject: 'after-hours calls',
    body: `Hey {{first_name}},

Separate angle worth raising: a good chunk of the calls {{company}} gets probably land outside business hours - evenings, weekends, lunch breaks.

Right now those likely go to voicemail (if that). Our AI voice agent covers those hours too, so nothing falls through the cracks and you show up as "always available" without anyone working nights.

Want me to send a quick example call recording?`,
  },
  {
    stepNumber: 4,
    delayDays: 18,
    enabled: true,
    subject: 'quick one',
    body: `Hey {{first_name}},

Not trying to be pushy - just wanted to leave you with something useful. Businesses similar to {{company}} that put an AI receptionist in front of their phone lines typically recover several missed bookings a week that were previously going to voicemail or a competitor.

If that problem doesn't really apply to how {{company}} operates, totally fine to ignore this. If it does, I'm glad to walk through exactly how it'd work for your setup.`,
  },
  {
    stepNumber: 5,
    delayDays: 20,
    enabled: true,
    subject: 'closing the loop',
    body: `Hey {{first_name}},

Haven't heard back, so I'll assume this isn't a priority for {{company}} right now and I'll stop following up.

If missed/after-hours calls ever become a bigger pain point, feel free to reply anytime and I'll pick this back up. Wishing you well either way.`,
  },
];

function defaultData() {
  return {
    leads: [],
    sequenceSteps: JSON.parse(JSON.stringify(DEFAULT_SEQUENCE)),
    settings: {
      dryRun: (process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
      fromName: process.env.FROM_NAME || 'Your Name',
      fromEmail: process.env.FROM_EMAIL || 'you@yourdomain.com',
      appUrl: process.env.APP_URL || `http://localhost:${PORT}`,
    },
    logs: [],
  };
}

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const fresh = defaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    // backfill in case fields are missing from an older version of the file
    parsed.leads = parsed.leads || [];
    parsed.sequenceSteps = parsed.sequenceSteps && parsed.sequenceSteps.length
      ? parsed.sequenceSteps
      : JSON.parse(JSON.stringify(DEFAULT_SEQUENCE));
    parsed.settings = Object.assign(defaultData().settings, parsed.settings || {});
    parsed.logs = parsed.logs || [];
    return parsed;
  } catch (e) {
    console.error('Corrupt data file, starting fresh:', e);
    const fresh = defaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

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
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (map[key] !== undefined ? map[key] : m));
}

function unsubscribeFooter(db, lead) {
  const url = `${db.settings.appUrl.replace(/\/$/, '')}/api/unsubscribe/${lead.unsubscribeToken}`;
  return `\n\n---\nDon't want to hear from us again? Unsubscribe: ${url}`;
}

let resendClient = null;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

async function sendEmail(db, { to, subject, text }) {
  const dryRun = db.settings.dryRun || !process.env.RESEND_API_KEY;
  if (dryRun) {
    console.log(`[DRY RUN] Would send to ${to} | subject: "${subject}"`);
    return { status: 'dry_run' };
  }
  try {
    const client = getResendClient();
    const from = `${db.settings.fromName} <${db.settings.fromEmail}>`;
    const result = await client.emails.send({ from, to, subject, text });
    if (result.error) return { status: 'failed', error: result.error.message || String(result.error) };
    return { status: 'sent', resendId: result.data ? result.data.id : undefined };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err) };
  }
}

// Sends whichever step is next due for a single lead (used both on lead
// creation, for the immediate first email, and by the scheduler loop).
async function processLead(db, lead) {
  if (lead.status !== 'active') return lead;
  const stepNumber = lead.currentStage + 1;
  const step = db.sequenceSteps.find((s) => s.stepNumber === stepNumber);

  if (!step || !step.enabled) {
    // no more steps configured - sequence finished
    lead.status = 'completed';
    lead.nextSendAt = null;
    return lead;
  }

  const subject = render(step.subject, lead);
  const body = render(step.body, lead) + unsubscribeFooter(db, lead);
  const result = await sendEmail(db, { to: lead.email, subject, text: body });

  db.logs.unshift({
    id: crypto.randomUUID(),
    leadId: lead.id,
    leadEmail: lead.email,
    stepNumber,
    subject,
    sentAt: new Date().toISOString(),
    status: result.status,
    resendId: result.resendId || null,
    error: result.error || null,
  });
  // keep log list from growing forever
  if (db.logs.length > 2000) db.logs.length = 2000;

  if (result.status === 'failed') {
    // leave the lead active with the same nextSendAt so it retries next tick
    return lead;
  }

  lead.currentStage = stepNumber;
  lead.lastSentAt = new Date().toISOString();

  const nextStep = db.sequenceSteps.find((s) => s.stepNumber === stepNumber + 1 && s.enabled);
  if (nextStep) {
    lead.nextSendAt = new Date(Date.now() + nextStep.delayDays * 86400000).toISOString();
  } else {
    lead.status = 'completed';
    lead.nextSendAt = null;
  }
  return lead;
}

async function runDueSends() {
  const db = loadDb();
  const now = Date.now();
  let processed = 0;
  for (const lead of db.leads) {
    if (lead.status === 'active' && lead.nextSendAt && new Date(lead.nextSendAt).getTime() <= now) {
      await processLead(db, lead);
      processed += 1;
    }
  }
  if (processed > 0) saveDb(db);
  return processed;
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

function newLeadRecord({ name, company, email, phone, website }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: name || '',
    company: company || '',
    email,
    phone: phone || '',
    website: website || '',
    status: 'active',
    currentStage: 0,
    nextSendAt: now,
    createdAt: now,
    lastSentAt: null,
    unsubscribeToken: crypto.randomBytes(16).toString('hex'),
  };
}

// ---------------------------------------------------------------------------
// Routes: leads
// ---------------------------------------------------------------------------

app.get('/api/leads', (req, res) => {
  const db = loadDb();
  res.json(db.leads);
});

app.post('/api/leads', async (req, res) => {
  const { name, company, email, phone, website } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  const db = loadDb();
  if (db.leads.some((l) => l.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'A lead with this email already exists.' });
  }
  const lead = newLeadRecord({ name, company, email, phone, website });
  db.leads.push(lead);
  await processLead(db, lead);
  saveDb(db);
  res.status(201).json(lead);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/leads/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
  }

  const db = loadDb();
  const existing = new Set(db.leads.map((l) => l.email.toLowerCase()));
  let added = 0;
  let skippedNoEmail = 0;
  let skippedDuplicate = 0;

  for (const row of rows) {
    const mapped = csvRowToLead(row);
    if (!mapped.email || !EMAIL_RE.test(mapped.email)) {
      skippedNoEmail += 1;
      continue;
    }
    const emailLower = mapped.email.toLowerCase();
    if (existing.has(emailLower)) {
      skippedDuplicate += 1;
      continue;
    }
    existing.add(emailLower);
    const lead = newLeadRecord(mapped);
    db.leads.push(lead);
    await processLead(db, lead);
    added += 1;
  }

  saveDb(db);
  res.json({ added, skippedNoEmail, skippedDuplicate, total: rows.length });
});

app.post('/api/leads/:id/pause', (req, res) => {
  const db = loadDb();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  lead.status = 'paused';
  saveDb(db);
  res.json(lead);
});

app.post('/api/leads/:id/resume', (req, res) => {
  const db = loadDb();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  lead.status = 'active';
  if (!lead.nextSendAt || new Date(lead.nextSendAt).getTime() < Date.now()) {
    lead.nextSendAt = new Date().toISOString();
  }
  saveDb(db);
  res.json(lead);
});

app.post('/api/leads/:id/mark-replied', (req, res) => {
  const db = loadDb();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  lead.status = 'replied';
  lead.nextSendAt = null;
  saveDb(db);
  res.json(lead);
});

app.post('/api/leads/:id/unsubscribe', (req, res) => {
  const db = loadDb();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  lead.status = 'unsubscribed';
  lead.nextSendAt = null;
  saveDb(db);
  res.json(lead);
});

app.delete('/api/leads/:id', (req, res) => {
  const db = loadDb();
  const before = db.leads.length;
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  if (db.leads.length === before) return res.status(404).json({ error: 'Not found' });
  saveDb(db);
  res.json({ ok: true });
});

// Public unsubscribe link used inside emails - no auth, just the token.
app.get('/api/unsubscribe/:token', (req, res) => {
  const db = loadDb();
  const lead = db.leads.find((l) => l.unsubscribeToken === req.params.token);
  if (lead) {
    lead.status = 'unsubscribed';
    lead.nextSendAt = null;
    saveDb(db);
  }
  res.send(`<!doctype html><html><body style="font-family: system-ui; max-width: 480px; margin: 80px auto; text-align:center;">
    <h2>You're unsubscribed</h2>
    <p>You won't receive any further emails from us. Sorry for the noise.</p>
  </body></html>`);
});

// ---------------------------------------------------------------------------
// Routes: sequence steps
// ---------------------------------------------------------------------------

app.get('/api/sequence', (req, res) => {
  const db = loadDb();
  res.json(db.sequenceSteps);
});

app.put('/api/sequence/:stepNumber', (req, res) => {
  const db = loadDb();
  const stepNumber = Number(req.params.stepNumber);
  const step = db.sequenceSteps.find((s) => s.stepNumber === stepNumber);
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const { subject, body, delayDays, enabled } = req.body || {};
  if (subject !== undefined) step.subject = subject;
  if (body !== undefined) step.body = body;
  if (delayDays !== undefined) step.delayDays = Math.max(0, Number(delayDays) || 0);
  if (enabled !== undefined) step.enabled = !!enabled;
  saveDb(db);
  res.json(step);
});

app.post('/api/sequence/preview', (req, res) => {
  const db = loadDb();
  const { stepNumber, sample } = req.body || {};
  const step = db.sequenceSteps.find((s) => s.stepNumber === Number(stepNumber));
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const fakeLead = {
    name: (sample && sample.name) || 'Alex Morgan',
    company: (sample && sample.company) || 'Acme Dental',
    website: (sample && sample.website) || 'acmedental.com',
    email: (sample && sample.email) || 'alex@acmedental.com',
    unsubscribeToken: 'preview-token',
  };
  const subject = render(step.subject, fakeLead);
  const body = render(step.body, fakeLead) + unsubscribeFooter(db, fakeLead);
  res.json({ subject, body });
});

// ---------------------------------------------------------------------------
// Routes: settings
// ---------------------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  const db = loadDb();
  res.json({ ...db.settings, resendConfigured: !!process.env.RESEND_API_KEY });
});

app.put('/api/settings', (req, res) => {
  const db = loadDb();
  const { dryRun, fromName, fromEmail, appUrl } = req.body || {};
  if (dryRun !== undefined) db.settings.dryRun = !!dryRun;
  if (fromName !== undefined) db.settings.fromName = fromName;
  if (fromEmail !== undefined) db.settings.fromEmail = fromEmail;
  if (appUrl !== undefined) db.settings.appUrl = appUrl;
  saveDb(db);
  res.json(db.settings);
});

app.post('/api/settings/test-send', async (req, res) => {
  const db = loadDb();
  const { to, force } = req.body || {};
  if (!to || !EMAIL_RE.test(to)) return res.status(400).json({ error: 'A valid "to" email is required.' });
  const testDb = force ? { ...db, settings: { ...db.settings, dryRun: false } } : db;
  const step = db.sequenceSteps.find((s) => s.stepNumber === 1);
  const fakeLead = { name: 'Alex Morgan', company: 'Acme Dental', email: to, unsubscribeToken: 'preview-token' };
  const subject = `[TEST] ${render(step.subject, fakeLead)}`;
  const body = render(step.body, fakeLead) + unsubscribeFooter(db, fakeLead);
  const result = await sendEmail(testDb, { to, subject, text: body });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Routes: logs + manual scheduler trigger
// ---------------------------------------------------------------------------

app.get('/api/logs', (req, res) => {
  const db = loadDb();
  res.json(db.logs.slice(0, 200));
});

app.post('/api/scheduler/run', async (req, res) => {
  const processed = await runDueSends();
  res.json({ processed });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Scheduler: check every 15 minutes for leads due their next email
// ---------------------------------------------------------------------------

cron.schedule('*/15 * * * *', () => {
  runDueSends().then((n) => {
    if (n > 0) console.log(`Scheduler: sent ${n} email(s).`);
  }).catch((e) => console.error('Scheduler error:', e));
});

app.listen(PORT, () => {
  loadDb(); // ensure data file exists on boot
  console.log(`Lead outreach app running on port ${PORT}`);
  console.log(`Dry run mode: ${loadDb().settings.dryRun ? 'ON (no real emails will send)' : 'OFF (real emails will send)'}`);
});
