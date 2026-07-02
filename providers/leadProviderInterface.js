/**
 * Interface/base class for lead providers
 * All providers should implement these methods
 */
class LeadProviderInterface {
  constructor(name, config = {}) {
    this.name = name; // e.g., "searlo", "csv", "google_search"
    this.priority = config.priority || 5; // 1-10, higher = more trusted
    this.config = config;
  }

  /**
   * Search for leads based on query
   * @param {string} query - Search query
   * @param {object} options - Search options (limit, filters, etc)
   * @returns {Promise<Array>} Array of lead objects
   */
  async search(query, options = {}) {
    throw new Error('search() not implemented');
  }

  /**
   * Validate a lead object
   * @param {object} lead - Lead to validate
   * @returns {boolean} True if lead is valid
   */
  validate(lead) {
    const required = ['email', 'company'];
    return required.every((field) => lead[field] && lead[field].toString().length > 0);
  }

  /**
   * Normalize lead data to standard format
   * @param {object} lead - Raw lead from provider
   * @returns {object} Standardized lead object
   */
  normalize(lead) {
    return {
      name: lead.name || '',
      company: lead.company || '',
      email: lead.email || '',
      phone: lead.phone || '',
      website: lead.website || '',
      title: lead.title || '',
      sourceId: lead.id, // Original ID from provider
    };
  }

  /**
   * Check if provider is configured properly
   * @returns {boolean}
   */
  isConfigured() {
    return true;
  }

  /**
   * Get provider metadata
   * @returns {object}
   */
  getMetadata() {
    return {
      name: this.name,
      priority: this.priority,
      configured: this.isConfigured(),
    };
  }
}

module.exports = LeadProviderInterface;
