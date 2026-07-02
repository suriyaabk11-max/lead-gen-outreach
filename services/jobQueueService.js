// In-process job queue - no Redis required, so the whole app fits on a single
// small instance (e.g. Railway Hobby). Job status is persisted in the
// BackgroundJob table; the pending queue itself is in memory, so jobs that
// haven't started yet are lost on restart and must be re-triggered. Jobs run
// one at a time because crawl/audit launch a headless browser and running
// several concurrently would exhaust a 512MB-1GB container.
const websiteCrawlerService = require('./websiteCrawlerService');
const websiteAuditService = require('./websiteAuditService');
const leadScoringService = require('./leadScoringService');
const aiPersonalizationService = require('./aiPersonalizationService');
const backgroundJobRepository = require('../repositories/backgroundJobRepository');
const db = require('../db');

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class JobQueueService {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.activeType = null;
    this.counts = {
      crawl: { completed: 0, failed: 0 },
      audit: { completed: 0, failed: 0 },
      score: { completed: 0, failed: 0 },
      personalization: { completed: 0, failed: 0 },
    };

    this.handlers = {
      crawl: async (leadId) => {
        const lead = await db.prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) throw new Error('Lead not found');
        return websiteCrawlerService.crawlLead(lead);
      },
      audit: async (leadId) => {
        const lead = await db.prisma.lead.findUnique({ where: { id: leadId } });
        const companyProfile = await db.prisma.companyProfile.findUnique({ where: { leadId } });
        if (!lead || !companyProfile) throw new Error('Lead or company profile not found');
        return websiteAuditService.auditWebsite(lead, companyProfile);
      },
      score: async (leadId) => {
        const lead = await db.prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) throw new Error('Lead not found');
        return leadScoringService.scoreLead(lead);
      },
      personalization: async (leadId) => {
        const lead = await db.prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) throw new Error('Lead not found');
        return aiPersonalizationService.generatePersonalization(lead);
      },
    };
  }

  async enqueue(type, jobType, leadId, priority) {
    const job = await backgroundJobRepository.create(jobType, { leadId }, priority);
    this.queue.push({ type, leadId, jobId: job.id });
    this.processNext(); // fire and forget; errors are recorded per job
    return job;
  }

  async processNext() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        this.activeType = item.type;
        await this.runJob(item);
      }
    } finally {
      this.activeType = null;
      this.processing = false;
    }
  }

  async runJob({ type, leadId, jobId }) {
    await backgroundJobRepository.updateStatus(jobId, 'processing');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.handlers[type](leadId);
        await backgroundJobRepository.updateStatus(jobId, 'completed', result);
        this.counts[type].completed += 1;
        console.log(`${type} job ${jobId} completed`);
        return;
      } catch (error) {
        console.error(`Error in ${type} job ${jobId} (attempt ${attempt}):`, error.message);
        await backgroundJobRepository.incrementRetries(jobId).catch(() => {});
        if (attempt === MAX_ATTEMPTS) {
          await backgroundJobRepository
            .updateStatus(jobId, 'failed', null, error.message)
            .catch(() => {});
          this.counts[type].failed += 1;
          return; // swallow: one bad lead must not kill the queue loop
        }
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  async queueCrawlJob(leadId, priority = 5) {
    return this.enqueue('crawl', 'crawl_website', leadId, priority);
  }

  async queueAuditJob(leadId, priority = 5) {
    return this.enqueue('audit', 'audit_website', leadId, priority);
  }

  async queueScoreJob(leadId, priority = 5) {
    return this.enqueue('score', 'score_lead', leadId, priority);
  }

  async queuePersonalizationJob(leadId, priority = 8) {
    return this.enqueue('personalization', 'generate_personalization', leadId, priority);
  }

  // Jobs run strictly in insertion order, so enqueueing in dependency order
  // guarantees crawl finishes before audit needs its company profile, etc.
  async queueFullPipeline(leadId) {
    const crawlJob = await this.queueCrawlJob(leadId, 8);
    const auditJob = await this.queueAuditJob(leadId, 7);
    const scoreJob = await this.queueScoreJob(leadId, 6);
    const personalizationJob = await this.queuePersonalizationJob(leadId, 9);

    return {
      crawl: crawlJob,
      audit: auditJob,
      score: scoreJob,
      personalization: personalizationJob,
    };
  }

  async getJobStatus(jobId) {
    return backgroundJobRepository.findById(jobId);
  }

  async getQueueStats() {
    const stats = {};
    for (const type of Object.keys(this.counts)) {
      stats[type] = {
        waiting: this.queue.filter((j) => j.type === type).length,
        active: this.activeType === type ? 1 : 0,
        completed: this.counts[type].completed,
        failed: this.counts[type].failed,
      };
    }
    return stats;
  }

  async clearQueues() {
    this.queue.length = 0;
  }

  async closeQueues() {
    this.queue.length = 0;
  }
}

module.exports = new JobQueueService();
