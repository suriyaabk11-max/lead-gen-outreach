const SearloProvider = require('./searloProvider');
const CSVProvider = require('./csvProvider');
const db = require('../db');

class ProviderRegistry {
  constructor() {
    this.providers = {};
    this.registerDefaults();
  }

  registerDefaults() {
    this.register(new SearloProvider());
    this.register(new CSVProvider());
  }

  register(provider) {
    if (!provider.name) {
      throw new Error('Provider must have a name');
    }
    this.providers[provider.name] = provider;
    console.log(`Provider registered: ${provider.name} (priority: ${provider.priority})`);
  }

  unregister(name) {
    delete this.providers[name];
  }

  getProvider(name) {
    return this.providers[name];
  }

  getProviders() {
    return Object.values(this.providers).sort((a, b) => b.priority - a.priority);
  }

  getMetadata() {
    return Object.values(this.providers).map((p) => p.getMetadata());
  }

  async search(query, options = {}) {
    const results = [];
    const providers = options.providers
      ? this.getProviders().filter((p) => options.providers.includes(p.name))
      : this.getProviders();

    for (const provider of providers) {
      if (!provider.isConfigured()) continue;

      try {
        console.log(`Searching via ${provider.name}...`);
        const leads = await provider.search(query, options);
        results.push(
          ...leads.map((lead) => ({
            ...provider.normalize(lead),
            provider: provider.name,
            priority: provider.priority,
          }))
        );
      } catch (error) {
        console.warn(`Provider ${provider.name} failed:`, error.message);
      }
    }

    // Deduplicate leads by email
    return this.deduplicateLeads(results);
  }

  deduplicateLeads(leads) {
    const seenEmails = new Set();
    const deduped = [];

    // Sort by priority (descending) so higher priority leads are kept
    const sorted = leads.sort((a, b) => b.priority - a.priority);

    for (const lead of sorted) {
      const emailLower = (lead.email || '').toLowerCase();
      if (!emailLower) continue; // Skip leads without email

      if (seenEmails.has(emailLower)) {
        console.log(`Deduplicating: ${emailLower} (from ${lead.provider})`);
        continue;
      }

      seenEmails.add(emailLower);
      deduped.push(lead);
    }

    return deduped;
  }

  async searchAndStore(query, options = {}) {
    const leads = await this.search(query, options);
    const stored = [];

    for (const leadData of leads) {
      try {
        // Check if lead already exists
        const existing = await db.prisma.lead.findUnique({
          where: { email: leadData.email.toLowerCase() },
        });

        if (existing) {
          console.log(`Lead already exists: ${leadData.email}`);
          stored.push({
            leadId: existing.id,
            status: 'existing',
            email: leadData.email,
          });
          continue;
        }

        // Create new lead
        const lead = await db.prisma.lead.create({
          data: {
            name: leadData.name,
            company: leadData.company,
            email: leadData.email.toLowerCase(),
            phone: leadData.phone,
            website: leadData.website,
            status: 'active',
            unsubscribeToken: require('crypto').randomBytes(16).toString('hex'),
          },
        });

        // Store lead source
        await db.prisma.leadSource.create({
          data: {
            leadId: lead.id,
            provider: leadData.provider,
            sourceId: leadData.sourceId,
          },
        });

        stored.push({
          leadId: lead.id,
          status: 'created',
          email: lead.email,
        });
      } catch (error) {
        console.error(`Failed to store lead ${leadData.email}:`, error);
        stored.push({
          email: leadData.email,
          status: 'error',
          error: error.message,
        });
      }
    }

    return stored;
  }
}

module.exports = new ProviderRegistry();
