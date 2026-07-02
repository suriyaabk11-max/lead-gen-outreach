const LeadProviderInterface = require('./leadProviderInterface');

class SearloProvider extends LeadProviderInterface {
  constructor(config = {}) {
    super('searlo', { priority: 8, ...config });
    this.apiKey = config.apiKey || process.env.SEARLO_API_KEY;
    this.baseUrl = 'https://api.searlo.tech/api/v1';
  }

  async search(query, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Searlo API key not configured');
    }

    const limit = options.limit || 20;
    const page = options.page || 1;

    try {
      const url = `${this.baseUrl}/search/web?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}&page=${page}`;
      const response = await fetch(url, {
        headers: { 'x-api-key': this.apiKey },
      });

      if (!response.ok) {
        throw new Error(`Searlo API error: ${response.status}`);
      }

      const data = await response.json();
      const items = data.items || [];

      // Extract company websites from search results
      const leads = [];
      for (const item of items) {
        if (!item.link) continue;

        try {
          const url = new URL(item.link);
          leads.push({
            company: item.title || url.hostname,
            website: `${url.protocol}//${url.hostname}`,
            sourceId: item.link,
          });
        } catch {
          // Skip malformed URLs
        }
      }

      return leads;
    } catch (error) {
      console.error('Searlo search failed:', error);
      throw error;
    }
  }

  isConfigured() {
    return !!this.apiKey;
  }
}

module.exports = SearloProvider;
