const db = require('../db');

class BackgroundJobRepository {
  async create(jobType, data = {}, priority = 5) {
    return db.prisma.backgroundJob.create({
      data: {
        jobType,
        data,
        priority,
        status: 'pending',
      },
    });
  }

  async findById(id) {
    return db.prisma.backgroundJob.findUnique({
      where: { id },
    });
  }

  async findPending(jobType = null, limit = 10) {
    return db.prisma.backgroundJob.findMany({
      where: {
        status: 'pending',
        ...(jobType && { jobType }),
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  async updateStatus(id, status, result = null, error = null) {
    return db.prisma.backgroundJob.update({
      where: { id },
      data: {
        status,
        result,
        error,
        ...(status === 'processing' && { startedAt: new Date() }),
        ...(status === 'completed' && { completedAt: new Date() }),
        ...(status === 'failed' && { completedAt: new Date() }),
      },
    });
  }

  async incrementRetries(id) {
    return db.prisma.backgroundJob.update({
      where: { id },
      data: { retries: { increment: 1 } },
    });
  }

  async getStats(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return db.prisma.backgroundJob.groupBy({
      by: ['jobType', 'status'],
      where: { createdAt: { gte: since } },
      _count: true,
    });
  }
}

module.exports = new BackgroundJobRepository();
