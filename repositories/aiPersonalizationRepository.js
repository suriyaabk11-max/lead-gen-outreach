const db = require('../db');

class AIPersonalizationRepository {
  async create(leadId, data) {
    return db.prisma.aIPersonalization.create({
      data: { leadId, ...data },
    });
  }

  async findByLeadId(leadId) {
    return db.prisma.aIPersonalization.findUnique({
      where: { leadId },
    });
  }

  async update(leadId, data) {
    return db.prisma.aIPersonalization.update({
      where: { leadId },
      data,
    });
  }

  async upsert(leadId, data) {
    return db.prisma.aIPersonalization.upsert({
      where: { leadId },
      create: { leadId, ...data },
      update: data,
    });
  }

  async findByGenerationStatus(status) {
    return db.prisma.aIPersonalization.findMany({
      where: { generationStatus: status },
      include: { lead: true },
    });
  }

  async updateGenerationStatus(leadId, status, error = null) {
    return db.prisma.aIPersonalization.update({
      where: { leadId },
      data: { generationStatus: status, generationError: error, generatedAt: new Date() },
    });
  }

  async getUsageStats(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return db.prisma.aIPersonalization.aggregate({
      where: { generatedAt: { gte: since } },
      _sum: { tokensUsed: true, estimatedCost: true },
      _count: true,
    });
  }
}

module.exports = new AIPersonalizationRepository();
