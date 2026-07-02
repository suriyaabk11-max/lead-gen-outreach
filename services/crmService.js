const opportunityRepository = require('../repositories/opportunityRepository');
const db = require('../db');

class CRMService {
  async convertLeadToOpportunity(leadId, data = {}) {
    const lead = await db.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error('Lead not found');

    // Check if opportunity already exists
    const existing = await opportunityRepository.findByLeadId(leadId);
    if (existing) return existing;

    const opportunity = await opportunityRepository.create(leadId, {
      stage: data.stage || 'discovered',
      estimatedValue: data.estimatedValue || null,
      currency: data.currency || 'USD',
      salesOwner: data.salesOwner || null,
      notes: data.notes || null,
    });

    // Log activity
    await this.addActivity(opportunity.id, {
      type: 'opportunity_created',
      description: 'Opportunity created from lead',
    });

    return opportunity;
  }

  async moveToStage(opportunityId, stage) {
    const validStages = [
      'discovered',
      'qualified',
      'contacted',
      'engaged',
      'opportunity',
      'negotiation',
      'closed_won',
      'closed_lost',
    ];

    if (!validStages.includes(stage)) {
      throw new Error(`Invalid stage: ${stage}`);
    }

    const opportunity = await opportunityRepository.update(opportunityId, { stage });

    // Log activity
    await this.addActivity(opportunityId, {
      type: 'stage_changed',
      description: `Moved to ${stage}`,
    });

    return opportunity;
  }

  async assignToSalesOwner(opportunityId, salesOwner) {
    const opportunity = await opportunityRepository.update(opportunityId, { salesOwner });

    await this.addActivity(opportunityId, {
      type: 'assigned',
      description: `Assigned to ${salesOwner}`,
    });

    return opportunity;
  }

  async updateValue(opportunityId, estimatedValue) {
    const opportunity = await opportunityRepository.update(opportunityId, { estimatedValue });

    await this.addActivity(opportunityId, {
      type: 'value_updated',
      description: `Value updated to $${estimatedValue}`,
    });

    return opportunity;
  }

  async addActivity(opportunityId, activity) {
    return opportunityRepository.addActivity(opportunityId, activity);
  }

  async addNote(opportunityId, content, author = null) {
    return opportunityRepository.addNote(opportunityId, { content, author });
  }

  async logEmailSent(opportunityId, stepNumber, subject) {
    return this.addActivity(opportunityId, {
      type: 'email_sent',
      description: `Step ${stepNumber} sent: "${subject}"`,
    });
  }

  async logEmailReplied(opportunityId, replyContent = null) {
    return this.addActivity(opportunityId, {
      type: 'email_replied',
      description: replyContent || 'Lead replied to email',
    });
  }

  async logCall(opportunityId, duration, notes = null) {
    return this.addActivity(opportunityId, {
      type: 'call',
      description: `Call (${duration} min)${notes ? ': ' + notes : ''}`,
    });
  }

  async logMeeting(opportunityId, meetingDate, title, notes = null) {
    return this.addActivity(opportunityId, {
      type: 'meeting',
      description: `Meeting: ${title} on ${meetingDate}${notes ? ' - ' + notes : ''}`,
    });
  }

  async createTask(opportunityId, taskData) {
    return db.prisma.task.create({
      data: {
        opportunityId,
        title: taskData.title,
        description: taskData.description,
        dueDate: taskData.dueDate,
        assignedTo: taskData.assignedTo,
        completed: false,
      },
    });
  }

  async completeTask(taskId) {
    return db.prisma.task.update({
      where: { id: taskId },
      data: { completed: true, completedAt: new Date() },
    });
  }

  async getOpportunityTimeline(opportunityId) {
    const opportunity = await opportunityRepository.findById(opportunityId);
    if (!opportunity) throw new Error('Opportunity not found');

    const timeline = [
      {
        type: 'opportunity',
        date: opportunity.createdAt,
        description: `Opportunity created`,
      },
      ...opportunity.activities.map((a) => ({
        type: a.type,
        date: a.createdAt,
        description: a.description,
      })),
      ...opportunity.notes_relation.map((n) => ({
        type: 'note',
        date: n.createdAt,
        description: `Note: ${n.content}`,
        author: n.author,
      })),
    ];

    return timeline.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  async getStageStats() {
    return opportunityRepository.getStageDistribution();
  }

  async getTotalPipelineValue() {
    return opportunityRepository.getTotalPipelineValue();
  }

  async getOpportunitiesByStage(stage) {
    return opportunityRepository.findByStage(stage);
  }

  async getOpportunitiesBySalesOwner(salesOwner) {
    return opportunityRepository.findBySalesOwner(salesOwner);
  }
}

module.exports = new CRMService();
