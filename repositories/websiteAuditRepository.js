const db = require('../db');

class WebsiteAuditRepository {
  async create(leadId, data) {
    return db.prisma.websiteAudit.create({
      data: { leadId, ...data },
    });
  }

  async findByLeadId(leadId) {
    return db.prisma.websiteAudit.findUnique({
      where: { leadId },
    });
  }

  async update(leadId, data) {
    return db.prisma.websiteAudit.update({
      where: { leadId },
      data,
    });
  }

  async upsert(leadId, data) {
    return db.prisma.websiteAudit.upsert({
      where: { leadId },
      create: { leadId, ...data },
      update: data,
    });
  }

  async findByAuditStatus(status) {
    return db.prisma.websiteAudit.findMany({
      where: { auditStatus: status },
      include: { lead: true },
    });
  }

  async updateAuditStatus(leadId, status, error = null) {
    return db.prisma.websiteAudit.update({
      where: { leadId },
      data: { auditStatus: status, auditError: error, auditedAt: new Date() },
    });
  }

  async findTopScores(limit = 50) {
    return db.prisma.websiteAudit.findMany({
      orderBy: { overallScore: 'desc' },
      take: limit,
      include: { lead: true },
    });
  }

  async getScoreDistribution() {
    return db.prisma.websiteAudit.groupBy({
      by: ['overallScore'],
      _count: true,
    });
  }
}

module.exports = new WebsiteAuditRepository();
