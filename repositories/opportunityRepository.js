const db = require('../db');

class OpportunityRepository {
  async create(leadId, data) {
    return db.prisma.opportunity.create({
      data: { leadId, ...data },
    });
  }

  async findByLeadId(leadId) {
    return db.prisma.opportunity.findUnique({
      where: { leadId },
      include: { activities: true, notes_relation: true, tasks: true },
    });
  }

  async findById(id) {
    return db.prisma.opportunity.findUnique({
      where: { id },
      include: { lead: true, activities: true, notes_relation: true, tasks: true },
    });
  }

  async update(id, data) {
    return db.prisma.opportunity.update({
      where: { id },
      data,
    });
  }

  async findByStage(stage) {
    return db.prisma.opportunity.findMany({
      where: { stage },
      include: { lead: true },
    });
  }

  async findBySalesOwner(salesOwner) {
    return db.prisma.opportunity.findMany({
      where: { salesOwner },
      include: { lead: true },
    });
  }

  async getStageDistribution() {
    return db.prisma.opportunity.groupBy({
      by: ['stage'],
      _count: true,
      _sum: { estimatedValue: true },
    });
  }

  async getTotalPipelineValue() {
    const result = await db.prisma.opportunity.aggregate({
      _sum: { estimatedValue: true },
      where: { stage: { not: 'closed_lost' } },
    });
    return result._sum.estimatedValue || 0;
  }

  async addActivity(opportunityId, activity) {
    return db.prisma.activity.create({
      data: { opportunityId, ...activity },
    });
  }

  async addNote(opportunityId, note) {
    return db.prisma.note.create({
      data: { opportunityId, ...note },
    });
  }
}

module.exports = new OpportunityRepository();
