const express = require('express');
const router = express.Router();
const db = require('../db');
const jobQueueService = require('../services/jobQueueService');
const aiPersonalizationService = require('../services/aiPersonalizationService');
const crmService = require('../services/crmService');
const providerRegistry = require('../providers/providerRegistry');
const leadScoreRepository = require('../repositories/leadScoreRepository');
const websiteAuditRepository = require('../repositories/websiteAuditRepository');
const opportunityRepository = require('../repositories/opportunityRepository');

// ============================================================================
// LEAD INTELLIGENCE ENDPOINTS
// ============================================================================

// GET /api/leads/:id/intelligence - Get all intelligence data for a lead
router.get('/leads/:id/intelligence', async (req, res) => {
  try {
    const lead = await db.prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const [companyProfile, websiteAudit, leadScore, personalization] = await Promise.all([
      db.prisma.companyProfile.findUnique({ where: { leadId: lead.id } }),
      db.prisma.websiteAudit.findUnique({ where: { leadId: lead.id } }),
      db.prisma.leadScore.findUnique({ where: { leadId: lead.id } }),
      db.prisma.aIPersonalization.findUnique({ where: { leadId: lead.id } }),
    ]);

    res.json({
      lead,
      intelligence: {
        companyProfile,
        websiteAudit,
        leadScore,
        personalization,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leads/:id/crawl - Trigger website crawl for a lead
router.post('/leads/:id/crawl', async (req, res) => {
  try {
    const lead = await db.prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const job = await jobQueueService.queueCrawlJob(lead.id, 9);
    res.status(202).json({ job, message: 'Crawl job queued' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leads/:id/audit - Trigger website audit for a lead
router.post('/leads/:id/audit', async (req, res) => {
  try {
    const lead = await db.prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const job = await jobQueueService.queueAuditJob(lead.id, 8);
    res.status(202).json({ job, message: 'Audit job queued' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leads/:id/score - Trigger lead scoring
router.post('/leads/:id/score', async (req, res) => {
  try {
    const lead = await db.prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const job = await jobQueueService.queueScoreJob(lead.id, 7);
    res.status(202).json({ job, message: 'Scoring job queued' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leads/:id/personalize - Trigger AI personalization
router.post('/leads/:id/personalize', async (req, res) => {
  try {
    const lead = await db.prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const job = await jobQueueService.queuePersonalizationJob(lead.id, 9);
    res.status(202).json({ job, message: 'Personalization job queued' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leads/:id/pipeline - Run entire AI pipeline for a lead
router.post('/leads/:id/pipeline', async (req, res) => {
  try {
    const lead = await db.prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const jobs = await jobQueueService.queueFullPipeline(lead.id);
    res.status(202).json({ jobs, message: 'Full pipeline queued' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/leads/batch/pipeline - Run pipeline for multiple leads
router.post('/leads/batch/pipeline', async (req, res) => {
  const { leadIds } = req.body || {};
  if (!Array.isArray(leadIds)) {
    return res.status(400).json({ error: 'leadIds must be an array' });
  }

  try {
    const jobs = [];
    for (const leadId of leadIds) {
      const pipelineJobs = await jobQueueService.queueFullPipeline(leadId);
      jobs.push({ leadId, jobs: pipelineJobs });
    }
    res.status(202).json({ jobs, message: `Pipeline queued for ${leadIds.length} leads` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ANALYTICS ENDPOINTS
// ============================================================================

// GET /api/analytics/summary - Get summary statistics
router.get('/analytics/summary', async (req, res) => {
  try {
    const [totalLeads, leadsWithIntelligence, scoreDistribution, websiteAudits, opportunities, personalizations] = await Promise.all([
      db.prisma.lead.count(),
      db.prisma.companyProfile.count(),
      db.prisma.leadScore.groupBy({ by: ['qualification'], _count: true }),
      db.prisma.websiteAudit.count(),
      db.prisma.opportunity.count(),
      db.prisma.aIPersonalization.count(),
    ]);

    const hot = scoreDistribution.find((d) => d.qualification === 'hot')?._count || 0;
    const warm = scoreDistribution.find((d) => d.qualification === 'warm')?._count || 0;
    const cold = scoreDistribution.find((d) => d.qualification === 'cold')?._count || 0;

    const emailsSent = await db.prisma.log.count();
    const replied = (await db.prisma.lead.findMany({ where: { status: 'replied' } })).length;

    const pipelineValue = await opportunityRepository.getTotalPipelineValue();

    const usage = await db.prisma.aIUsage.aggregate({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      _sum: { tokensUsed: true, estimatedCost: true },
    });

    res.json({
      summary: {
        totalLeads,
        leadsWithIntelligence,
        leadsAnalyzed: websiteAudits,
        leadsScored: scoreDistribution.reduce((sum, d) => sum + d._count, 0),
        personalizedLeads: personalizations,
        opportunities,
      },
      qualification: {
        hot,
        warm,
        cold,
      },
      engagement: {
        emailsSent,
        repliesReceived: replied,
        replyRate: emailsSent > 0 ? ((replied / emailsSent) * 100).toFixed(2) + '%' : '0%',
      },
      pipeline: {
        totalValue: pipelineValue,
        opportunities,
      },
      ai: {
        tokensUsedThisMonth: usage._sum.tokensUsed || 0,
        estimatedCostThisMonth: (usage._sum.estimatedCost || 0).toFixed(2),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/score-distribution - Score distribution histogram
router.get('/analytics/score-distribution', async (req, res) => {
  try {
    const distribution = await db.prisma.leadScore.groupBy({
      by: ['qualification'],
      _count: true,
      _avg: { overallScore: true },
    });

    const ranges = {
      '0-20': 0,
      '21-40': 0,
      '41-60': 0,
      '61-80': 0,
      '81-100': 0,
    };

    const scores = await db.prisma.leadScore.findMany({
      select: { overallScore: true },
    });

    scores.forEach((s) => {
      if (s.overallScore <= 20) ranges['0-20']++;
      else if (s.overallScore <= 40) ranges['21-40']++;
      else if (s.overallScore <= 60) ranges['41-60']++;
      else if (s.overallScore <= 80) ranges['61-80']++;
      else ranges['81-100']++;
    });

    res.json({
      byQualification: distribution,
      byRange: ranges,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/website-quality - Website quality rankings
router.get('/analytics/website-quality', async (req, res) => {
  const { limit = 50 } = req.query;

  try {
    const topScores = await websiteAuditRepository.findTopScores(parseInt(limit));

    res.json({
      topPerformers: topScores,
      averageScore: topScores.reduce((sum, a) => sum + a.overallScore, 0) / topScores.length,
      count: topScores.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/pipeline - Pipeline stage distribution
router.get('/analytics/pipeline', async (req, res) => {
  try {
    const stageDistribution = await opportunityRepository.getStageDistribution();
    const totalValue = await opportunityRepository.getTotalPipelineValue();

    res.json({
      stages: stageDistribution,
      totalPipelineValue: totalValue,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// OPPORTUNITY ENDPOINTS
// ============================================================================

// GET /api/opportunities - List opportunities
router.get('/opportunities', async (req, res) => {
  const { stage, salesOwner, limit = 50 } = req.query;

  try {
    let where = {};
    if (stage) where.stage = stage;
    if (salesOwner) where.salesOwner = salesOwner;

    const opportunities = await db.prisma.opportunity.findMany({
      where,
      include: { lead: true },
      take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
    });

    res.json(opportunities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/opportunities - Convert lead to opportunity
router.post('/opportunities', async (req, res) => {
  const { leadId, stage, estimatedValue, salesOwner, notes } = req.body || {};

  if (!leadId) return res.status(400).json({ error: 'leadId is required' });

  try {
    const opportunity = await crmService.convertLeadToOpportunity(leadId, {
      stage,
      estimatedValue,
      salesOwner,
      notes,
    });

    res.status(201).json(opportunity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/opportunities/:id - Update opportunity
router.put('/opportunities/:id', async (req, res) => {
  const { stage, estimatedValue, salesOwner, notes } = req.body || {};

  try {
    let data = {};
    if (stage) {
      await crmService.moveToStage(req.params.id, stage);
      data.stage = stage;
    }
    if (estimatedValue !== undefined) {
      await crmService.updateValue(req.params.id, estimatedValue);
      data.estimatedValue = estimatedValue;
    }
    if (salesOwner) {
      await crmService.assignToSalesOwner(req.params.id, salesOwner);
      data.salesOwner = salesOwner;
    }
    if (notes) data.notes = notes;

    const opportunity = await db.prisma.opportunity.update({
      where: { id: req.params.id },
      data,
      include: { lead: true },
    });

    res.json(opportunity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/opportunities/:id/activity - Add activity
router.post('/opportunities/:id/activity', async (req, res) => {
  const { type, description } = req.body || {};

  if (!type || !description) {
    return res.status(400).json({ error: 'type and description are required' });
  }

  try {
    const activity = await crmService.addActivity(req.params.id, { type, description });
    res.status(201).json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/opportunities/:id/notes - Add note
router.post('/opportunities/:id/notes', async (req, res) => {
  const { content, author } = req.body || {};

  if (!content) return res.status(400).json({ error: 'content is required' });

  try {
    const note = await crmService.addNote(req.params.id, content, author);
    res.status(201).json(note);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opportunities/:id/timeline - Get opportunity timeline
router.get('/opportunities/:id/timeline', async (req, res) => {
  try {
    const timeline = await crmService.getOpportunityTimeline(req.params.id);
    res.json(timeline);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PROVIDER ENDPOINTS
// ============================================================================

// GET /api/providers - List available providers
router.get('/providers', (req, res) => {
  try {
    const metadata = providerRegistry.getMetadata();
    res.json({ providers: metadata });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/providers/:name/search - Search via specific provider
router.post('/providers/:name/search', async (req, res) => {
  const { query, limit = 20 } = req.body || {};

  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    const provider = providerRegistry.getProvider(req.params.name);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const leads = await provider.search(query, { limit });
    res.json({ provider: provider.name, count: leads.length, leads });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// JOB QUEUE ENDPOINTS
// ============================================================================

// GET /api/jobs/:id - Get job status
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await jobQueueService.getJobStatus(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/jobs/stats - Get queue statistics
router.get('/jobs/stats', async (req, res) => {
  try {
    const stats = await jobQueueService.getQueueStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
