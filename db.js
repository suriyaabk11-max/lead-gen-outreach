const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULT_SEQUENCE = [
  {
    stepNumber: 1,
    delayDays: 0,
    enabled: true,
    subject: 'quick question about {{company}}',
    body: `Hey {{first_name}},

I came across {{company}} while looking at businesses in {{city}}.

I noticed you're doing a great job with {{positive_note}}.

One thing I also noticed is that {{observation}}.

We recently built AI automation that helps businesses reduce manual work like:

- Appointment reminders
- Customer follow-ups
- Lead qualification
- AI Chatbots
- Quote automation

Usually this saves owners several hours every week.

Would you be open to a quick 10-minute call next week?

Thanks,
Suriyaa
Visionary Byte Works`,
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

async function ensureSeeded() {
  const stepCount = await prisma.sequenceStep.count();
  if (stepCount === 0) {
    await prisma.sequenceStep.createMany({ data: DEFAULT_SEQUENCE });
  }
  const existingSettings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!existingSettings) {
    await prisma.setting.create({
      data: {
        id: 1,
        dryRun: (process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
        fromName: process.env.FROM_NAME || 'Your Name',
        fromEmail: process.env.FROM_EMAIL || 'you@yourdomain.com',
        appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
      },
    });
  }
  const existingLinkedinTemplate = await prisma.linkedinTemplate.findUnique({ where: { id: 1 } });
  if (!existingLinkedinTemplate) {
    await prisma.linkedinTemplate.create({ data: { id: 1 } });
  }
  const existingLeadFinderConfig = await prisma.leadFinderConfig.findUnique({ where: { id: 1 } });
  if (!existingLeadFinderConfig) {
    await prisma.leadFinderConfig.create({ data: { id: 1 } });
  }
}

function getSettings() {
  return prisma.setting.findUnique({ where: { id: 1 } });
}

function updateSettings(patch) {
  return prisma.setting.update({ where: { id: 1 }, data: patch });
}

function getSequenceSteps() {
  return prisma.sequenceStep.findMany({ orderBy: { stepNumber: 'asc' } });
}

function getSequenceStep(stepNumber) {
  return prisma.sequenceStep.findUnique({ where: { stepNumber } });
}

function updateSequenceStep(stepNumber, patch) {
  return prisma.sequenceStep.update({ where: { stepNumber }, data: patch });
}

function getLeads() {
  return prisma.lead.findMany({ orderBy: { createdAt: 'desc' } });
}

function getLeadById(id) {
  return prisma.lead.findUnique({ where: { id } });
}

function getLeadByEmail(email) {
  return prisma.lead.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
}

function getLeadByUnsubscribeToken(token) {
  return prisma.lead.findUnique({ where: { unsubscribeToken: token } });
}

function createLead(data) {
  return prisma.lead.create({ data });
}

function updateLead(id, patch) {
  return prisma.lead.update({ where: { id }, data: patch });
}

function deleteLead(id) {
  return prisma.lead.delete({ where: { id } });
}

async function getDueLeads() {
  // Use row-level locking (SELECT ... FOR UPDATE) to prevent concurrent sends of same lead.
  // SELECT * deliberately - an explicit column list here has already gone
  // stale twice as Lead gained new columns (emailVerification, city, AI
  // cache fields), silently dropping them for every lead processed via the
  // scheduler (as opposed to the immediate on-create send, which uses the
  // full Prisma object). That caused those columns to look empty/undefined
  // here even though they had real values in the database.
  //
  // "nextSendAt" MUST be quoted: Prisma creates Postgres columns preserving
  // exact case, but an unquoted identifier gets folded to lowercase by
  // Postgres, which then doesn't match - this was previously unquoted and
  // threw `column "nextsendat" does not exist` on every single call. That
  // means the 15-minute scheduler (which calls this) has never successfully
  // processed a single due lead since this app existed - every real send
  // seen so far came from the immediate on-create path (POST /api/leads,
  // CSV upload), never from a scheduled follow-up. Steps 2-5 of the
  // sequence were never actually firing automatically until this fix.
  return prisma.$transaction(async (tx) => {
    const leads = await tx.$queryRaw`
      SELECT * FROM "Lead"
      WHERE status = 'active' AND "nextSendAt" <= NOW()
      FOR UPDATE SKIP LOCKED
    `;
    return leads;
  });
}

async function addLog(entry) {
  await prisma.log.create({ data: entry });
  const count = await prisma.log.count();
  if (count > 2000) {
    const excess = count - 2000;
    const oldest = await prisma.log.findMany({
      orderBy: { sentAt: 'asc' },
      take: excess,
      select: { id: true },
    });
    await prisma.log.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
  }
}

// Atomically create a log entry and update a lead in a single transaction.
// This prevents partial-failure double-sends where email succeeds but lead update fails.
async function addLogAndUpdateLead(leadId, logEntry, leadPatch) {
  return prisma.$transaction(async (tx) => {
    await tx.log.create({ data: logEntry });
    const updated = await tx.lead.update({ where: { id: leadId }, data: leadPatch });
    const count = await tx.log.count();
    if (count > 2000) {
      const excess = count - 2000;
      const oldest = await tx.log.findMany({
        orderBy: { sentAt: 'asc' },
        take: excess,
        select: { id: true },
      });
      await tx.log.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
    }
    return updated;
  });
}

function getLogs(limit) {
  return prisma.log.findMany({ orderBy: { sentAt: 'desc' }, take: limit });
}

function getLinkedinTemplate() {
  return prisma.linkedinTemplate.findUnique({ where: { id: 1 } });
}

function updateLinkedinTemplate(patch) {
  return prisma.linkedinTemplate.update({ where: { id: 1 }, data: patch });
}

function getLinkedinProspects() {
  return prisma.linkedinProspect.findMany({ orderBy: { createdAt: 'desc' } });
}

function getLinkedinProspectById(id) {
  return prisma.linkedinProspect.findUnique({ where: { id } });
}

function createLinkedinProspect(data) {
  return prisma.linkedinProspect.create({ data });
}

function updateLinkedinProspect(id, patch) {
  return prisma.linkedinProspect.update({ where: { id }, data: patch });
}

function deleteLinkedinProspect(id) {
  return prisma.linkedinProspect.delete({ where: { id } });
}

function getLeadFinderConfig() {
  return prisma.leadFinderConfig.findUnique({ where: { id: 1 } });
}

function updateLeadFinderConfig(patch) {
  return prisma.leadFinderConfig.update({ where: { id: 1 }, data: patch });
}

module.exports = {
  prisma,
  ensureSeeded,
  getSettings,
  updateSettings,
  getSequenceSteps,
  getSequenceStep,
  updateSequenceStep,
  getLeads,
  getLeadById,
  getLeadByEmail,
  getLeadByUnsubscribeToken,
  createLead,
  updateLead,
  deleteLead,
  getDueLeads,
  addLog,
  addLogAndUpdateLead,
  getLogs,
  getLinkedinTemplate,
  updateLinkedinTemplate,
  getLinkedinProspects,
  getLinkedinProspectById,
  createLinkedinProspect,
  updateLinkedinProspect,
  deleteLinkedinProspect,
  getLeadFinderConfig,
  updateLeadFinderConfig,
};
