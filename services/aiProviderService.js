const Anthropic = require('@anthropic-ai/sdk');

class AIProviderService {
  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    this.model = process.env.AI_MODEL || 'claude-opus-4-1';
    this.maxTokens = parseInt(process.env.AI_MAX_TOKENS || '1000');
    this.monthlyTokenBudget = parseInt(process.env.AI_MONTHLY_TOKEN_BUDGET || '1000000');
    this.monthlyTokensUsed = 0;
  }

  async generatePersonalization(lead, companyProfile, score) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return this.getFallbackPersonalization(lead, companyProfile);
    }

    const prompt = this.buildPersonalizationPrompt(lead, companyProfile, score);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
      this.monthlyTokensUsed += tokensUsed;

      // Parse Claude's response
      const personalization = this.parsePersonalizationResponse(content.text, lead);
      personalization.tokensUsed = tokensUsed;
      personalization.estimatedCost = this.estimateCost(tokensUsed);

      return personalization;
    } catch (error) {
      console.error('AI personalization failed:', error);
      return this.getFallbackPersonalization(lead, companyProfile);
    }
  }

  buildPersonalizationPrompt(lead, companyProfile, score) {
    return `Generate personalized cold email outreach for this business lead. Return response in JSON format.

Lead Information:
- Company: ${lead.company}
- Contact: ${lead.name || 'Unknown'}
- Email: ${lead.email}
- Website: ${lead.website}

Company Profile (if available):
- Description: ${companyProfile?.description || 'Not extracted'}
- Services: ${(companyProfile?.services || []).join(', ') || 'Not extracted'}
- Tech Stack: ${(companyProfile?.techStack || []).join(', ') || 'Not detected'}
- Industry: ${companyProfile?.industryCategory || 'Unknown'}
- Has Portfolio: ${companyProfile?.hasPortfolio || false}
- Has Blog: ${companyProfile?.hasBlog || false}
- Social Media: ${Object.keys(companyProfile?.socialLinks || {}).join(', ') || 'None detected'}

Lead Score: ${score?.overallScore || 'N/A'}

Task: Generate a highly personalized email opening that:
1. References something specific about their business (from the company profile above)
2. Identifies a likely pain point based on their industry/size/tech stack
3. Presents a relevant value proposition
4. Includes a specific, personalized call-to-action
5. Keeps subject line under 50 characters
6. Keeps opening sentence under 20 words
7. Identifies 3-5 specific pain points based on their business
8. Provides a tailored value proposition (1-2 sentences)

Return ONLY valid JSON with these exact keys:
{
  "subject": "Personalized subject line",
  "openingSentence": "Personalized opening (under 20 words)",
  "companySummary": "1-2 sentence summary of what they do",
  "painPoints": ["pain1", "pain2", "pain3"],
  "valueProposition": "1-2 sentences about your offer tailored to them",
  "cta": "Specific call-to-action"
}`;
  }

  parsePersonalizationResponse(response, lead) {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.getFallbackPersonalization(lead);
      }

      const data = JSON.parse(jsonMatch[0]);

      return {
        subject: (data.subject || 'Check out ' + (lead.company || 'your business')).slice(0, 100),
        openingSentence: (data.openingSentence || `Hi ${(lead.name || 'there')},`).slice(0, 200),
        companySummary: (data.companySummary || 'Your business').slice(0, 500),
        painPoints: Array.isArray(data.painPoints) ? data.painPoints.slice(0, 5) : ['Growth challenges'],
        valueProposition: (data.valueProposition || 'We can help improve your operations').slice(0, 500),
        cta: (data.cta || 'Let\'s talk').slice(0, 200),
      };
    } catch (error) {
      console.warn('Failed to parse AI response, using fallback');
      return this.getFallbackPersonalization(lead);
    }
  }

  getFallbackPersonalization(lead, companyProfile) {
    const firstName = (lead.name || 'there').split(/\s+/)[0];
    const company = lead.company || 'your business';

    return {
      subject: `Quick question about ${company}`,
      openingSentence: `Hi ${firstName}, noticed your site and had a quick question.`,
      companySummary: `${company} appears to be a growing business.`,
      painPoints: ['Scaling operations', 'Lead generation', 'Customer retention'],
      valueProposition: 'We help businesses like yours grow more efficiently.',
      cta: 'Would love to chat for 15 minutes?',
      isFallback: true,
    };
  }

  estimateCost(tokensUsed) {
    // Approximate cost: $3 per 1M input tokens, $15 per 1M output tokens
    // Rough average: $0.004 per 1000 tokens
    return tokensUsed * 0.000004; // in dollars
  }

  async checkTokenBudget() {
    const remaining = this.monthlyTokenBudget - this.monthlyTokensUsed;
    return {
      monthlyBudget: this.monthlyTokenBudget,
      tokensUsed: this.monthlyTokensUsed,
      remaining,
      percentageUsed: (this.monthlyTokensUsed / this.monthlyTokenBudget) * 100,
    };
  }

  resetMonthlyCount() {
    this.monthlyTokensUsed = 0;
  }

  async analyzeCompanyDescription(description) {
    if (!process.env.ANTHROPIC_API_KEY || !description) {
      return { industries: [], painPoints: [] };
    }

    const prompt = `Analyze this company description and identify:
1. Primary industry/vertical
2. 3-5 likely pain points based on their description

Company Description:
${description}

Return ONLY valid JSON:
{
  "industries": ["industry1", "industry2"],
  "painPoints": ["pain1", "pain2", "pain3"]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });

      const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.warn('Failed to analyze company description:', error);
    }

    return { industries: [], painPoints: [] };
  }
}

module.exports = new AIProviderService();
