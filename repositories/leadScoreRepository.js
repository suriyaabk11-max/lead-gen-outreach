const db = require('../db');

class LeadScoreRepository {
  async create(leadId, data) {
    return db.prisma.leadScore.create({
      data: { leadId, ...data },
    });
  }

  async findByLeadId(leadId) {
    return db.prisma.leadScore.findUnique({
      where: { leadId },
    });
  }

  async update(leadId, data) {
    return db.prisma.leadScore.update({
      where: { leadId },
      data,
    });
  }

  async upsert(leadId, data) {
    return db.prisma.leadScore.upsert({
      where: { leadId },
      create: { leadId, ...data },
      update: data,
    });
  }

  async findByQualification(qualification) {
    return db.prisma.leadScore.findMany({
      where: { qualification },
      include: { lead: true },
    });
  }

  async findTopScores(limit = 50) {
    return db.prisma.leadScore.findMany({
      orderBy: { overallScore: 'desc' },
      take: limit,
      include: { lead: true },
    });
  }

  async getQualificationDistribution() {
    return db.prisma.leadScore.groupBy({
      by: ['qualification'],
      _count: true,
      _avg: { overallScore: true },
    });
  }

  async updateScoringStatus(leadId, status, error = null) {
    return db.prisma.leadScore.update({
      where: { leadId },
      data: { scoringStatus: status, scoringError: error, scoredAt: new Date() },
    });
  }
}

module.exports = new LeadScoreRepository();
