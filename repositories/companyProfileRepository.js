const db = require('../db');

class CompanyProfileRepository {
  async create(leadId, data) {
    return db.prisma.companyProfile.create({
      data: { leadId, ...data },
    });
  }

  async findByLeadId(leadId) {
    return db.prisma.companyProfile.findUnique({
      where: { leadId },
    });
  }

  async update(leadId, data) {
    return db.prisma.companyProfile.update({
      where: { leadId },
      data,
    });
  }

  async upsert(leadId, data) {
    return db.prisma.companyProfile.upsert({
      where: { leadId },
      create: { leadId, ...data },
      update: data,
    });
  }

  async findByCrawlStatus(status) {
    return db.prisma.companyProfile.findMany({
      where: { crawlStatus: status },
      include: { lead: true },
    });
  }

  async updateCrawlStatus(leadId, status, error = null) {
    return db.prisma.companyProfile.update({
      where: { leadId },
      data: { crawlStatus: status, crawlError: error, crawledAt: new Date() },
    });
  }
}

module.exports = new CompanyProfileRepository();
