const leadScoreRepository = require('../repositories/leadScoreRepository');
const db = require('../db');

class LeadScoringService {
  constructor() {
    // Weights for each scoring factor (should sum to 100)
    this.weights = {
      websiteQuality: 0.25,     // 25%
      completeness: 0.15,       // 15%
      emailAvailability: 0.08,  // 8%
      phoneAvailability: 0.02,  // 2%
      techMaturity: 0.15,       // 15%
      socialPresence: 0.10,     // 10%
      seoQuality: 0.10,         // 10%
      icpFit: 0.10,             // 10%
      contentFreshness: 0.05,   // 5%
    };
  }

  async scoreLead(lead) {
    try {
      await leadScoreRepository.updateScoringStatus(lead.id, 'processing');

      // Fetch related data
      const websiteAudit = await db.prisma.websiteAudit.findUnique({ where: { leadId: lead.id } });
      const companyProfile = await db.prisma.companyProfile.findUnique({ where: { leadId: lead.id } });

      // Calculate individual scores
      const scores = {
        websiteQualityScore: websiteAudit?.overallScore || 0,
        completenessScore: this.calculateCompletenessScore(companyProfile),
        contactAvailability: this.calculateContactAvailability(lead, companyProfile),
        technologyMaturity: this.calculateTechMaturity(companyProfile),
        socialPresence: this.calculateSocialPresence(companyProfile),
        seoQualityScore: websiteAudit?.metaTitleQuality || 0,
        icpFitScore: this.calculateICPFit(lead, companyProfile),
        contentFreshness: this.calculateContentFreshness(companyProfile),
      };

      // Calculate overall score (weighted)
      const overallScore = this.calculateOverallScore(scores);

      // Determine qualification level
      const qualification = this.getQualification(overallScore);

      // Store results
      const scoreData = {
        ...scores,
        overallScore,
        qualification,
      };

      await leadScoreRepository.upsert(lead.id, scoreData);
      await leadScoreRepository.updateScoringStatus(lead.id, 'completed');

      return scoreData;
    } catch (error) {
      await leadScoreRepository.updateScoringStatus(lead.id, 'failed', error.message);
      throw error;
    }
  }

  calculateCompletenessScore(companyProfile) {
    if (!companyProfile) return 0;

    let score = 0;
    const maxScore = 100;
    const fields = [
      'companyName',
      'description',
      'services',
      'email',
      'phone',
      'techStack',
      'socialLinks',
    ];

    for (const field of fields) {
      const value = companyProfile[field];
      if (value && (Array.isArray(value) ? value.length > 0 : value.toString().length > 0)) {
        score += maxScore / fields.length;
      }
    }

    return Math.round(score);
  }

  calculateContactAvailability(lead, companyProfile) {
    let score = 0;

    if (lead.email) score += 50;
    if (lead.phone) score += 25;
    if (companyProfile?.email) score += 15;
    if (companyProfile?.phone) score += 10;

    return Math.min(100, score);
  }

  calculateTechMaturity(companyProfile) {
    if (!companyProfile?.techStack || companyProfile.techStack.length === 0) {
      return 20; // Basic presence
    }

    const modernTechs = ['React', 'Vue', 'Angular', 'Next.js', 'Shopify', 'Stripe'];
    const legacyTechs = ['jQuery', 'outdated'];

    let score = 30; // Base for having any tech detected

    const techCount = companyProfile.techStack.length;
    score += Math.min(30, techCount * 5); // Up to 5 techs detected

    const hasModern = companyProfile.techStack.some((t) => modernTechs.some((m) => t.includes(m)));
    if (hasModern) score += 25;

    const hasLegacy = companyProfile.techStack.some((t) => legacyTechs.includes(t));
    if (hasLegacy) score -= 15;

    return Math.min(100, Math.max(0, score));
  }

  calculateSocialPresence(companyProfile) {
    if (!companyProfile?.socialLinks) return 0;

    const links = Object.values(companyProfile.socialLinks || {}).filter(Boolean);
    const score = Math.min(100, links.length * 25);

    return score;
  }

  calculateICPFit(lead, companyProfile) {
    // ICP (Ideal Customer Profile) fit - customize based on your business
    // This is a simplified example
    let score = 50; // Base score

    // Industry signals
    if (companyProfile?.industryCategory) {
      const fitIndustries = ['software', 'technology', 'services', 'ecommerce'];
      if (fitIndustries.some((ind) => companyProfile.industryCategory?.toLowerCase().includes(ind))) {
        score += 30;
      }
    }

    // Size signals (from web presence)
    if (companyProfile?.hasPortfolio && companyProfile?.hasBlog) {
      score += 20; // Established business
    }

    return Math.min(100, score);
  }

  calculateContentFreshness(companyProfile) {
    if (!companyProfile?.hasBlog) return 10;
    if (companyProfile?.blogFrequency === 'weekly') return 100;
    if (companyProfile?.blogFrequency === 'monthly') return 75;
    if (companyProfile?.blogFrequency === 'rarely') return 40;
    return 50; // Unknown frequency but has blog
  }

  calculateOverallScore(scores) {
    let totalScore = 0;

    // Weighted sum
    totalScore += scores.websiteQualityScore * this.weights.websiteQuality;
    totalScore += scores.completenessScore * this.weights.completeness;
    totalScore += scores.contactAvailability * (this.weights.emailAvailability + this.weights.phoneAvailability);
    totalScore += scores.technologyMaturity * this.weights.techMaturity;
    totalScore += scores.socialPresence * this.weights.socialPresence;
    totalScore += scores.seoQualityScore * this.weights.seoQuality;
    totalScore += scores.icpFitScore * this.weights.icpFit;
    totalScore += scores.contentFreshness * this.weights.contentFreshness;

    return Math.round(Math.min(100, Math.max(0, totalScore)));
  }

  getQualification(score) {
    if (score >= 80) return 'hot';
    if (score >= 50) return 'warm';
    return 'cold';
  }

  async scoreLeadBatch(leads) {
    const results = [];

    for (const lead of leads) {
      try {
        const score = await this.scoreLead(lead);
        results.push({ leadId: lead.id, score, status: 'success' });
      } catch (error) {
        results.push({ leadId: lead.id, status: 'failed', error: error.message });
      }
    }

    return results;
  }
}

module.exports = new LeadScoringService();
