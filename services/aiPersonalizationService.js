const aiProviderService = require('./aiProviderService');
const aiPersonalizationRepository = require('../repositories/aiPersonalizationRepository');
const db = require('../db');

class AIPersonalizationService {
  async generatePersonalization(lead) {
    try {
      await aiPersonalizationRepository.updateGenerationStatus(lead.id, 'generating');

      // Fetch related data
      const companyProfile = await db.prisma.companyProfile.findUnique({ where: { leadId: lead.id } });
      const score = await db.prisma.leadScore.findUnique({ where: { leadId: lead.id } });

      // Generate personalization via Claude
      const generatedContent = await aiProviderService.generatePersonalization(lead, companyProfile, score);

      // Prepare data to store
      const personalizationData = {
        subject: generatedContent.subject,
        openingSentence: generatedContent.openingSentence,
        companySummary: generatedContent.companySummary,
        painPoints: generatedContent.painPoints,
        valueProposition: generatedContent.valueProposition,
        cta: generatedContent.cta,
        tokensUsed: generatedContent.tokensUsed || 0,
        estimatedCost: generatedContent.estimatedCost || 0,
        model: aiProviderService.model,
      };

      // Store in database
      await aiPersonalizationRepository.upsert(lead.id, personalizationData);
      await aiPersonalizationRepository.updateGenerationStatus(lead.id, 'completed');

      return personalizationData;
    } catch (error) {
      await aiPersonalizationRepository.updateGenerationStatus(lead.id, 'failed', error.message);
      throw error;
    }
  }

  async generatePersonalizationBatch(leads) {
    const results = [];

    for (const lead of leads) {
      try {
        const personalization = await this.generatePersonalization(lead);
        results.push({
          leadId: lead.id,
          status: 'success',
          personalization,
        });
      } catch (error) {
        results.push({
          leadId: lead.id,
          status: 'failed',
          error: error.message,
        });
      }
    }

    return results;
  }

  async getPersonalizedEmailContent(lead) {
    const personalization = await aiPersonalizationRepository.findByLeadId(lead.id);

    if (!personalization) {
      throw new Error(`No personalization found for lead ${lead.id}`);
    }

    return {
      subject: personalization.subject,
      body: `${personalization.openingSentence}

${personalization.companySummary}

I noticed a few things about ${lead.company || 'your business'}:
${personalization.painPoints.map((pain) => `• ${pain}`).join('\n')}

${personalization.valueProposition}

${personalization.cta}

Thanks,
[Your Name]`,
      personalization, // raw personalization data
    };
  }

  async updatePersonalizationTemplate(leadId, updates) {
    return aiPersonalizationRepository.update(leadId, updates);
  }
}

module.exports = new AIPersonalizationService();
