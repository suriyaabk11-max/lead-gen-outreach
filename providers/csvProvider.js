const { parse: parseCsv } = require('csv-parse/sync');
const LeadProviderInterface = require('./leadProviderInterface');

class CSVProvider extends LeadProviderInterface {
  constructor(config = {}) {
    super('csv', { priority: 6, ...config });
  }

  async search(csvBuffer, options = {}) {
    try {
      const csvText = csvBuffer.toString('utf8');
      const rows = parseCsv(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });

      const leads = [];
      for (const row of rows) {
        const lead = this.csvRowToLead(row);
        if (this.validate(lead)) {
          leads.push({
            ...lead,
            sourceId: `csv-${lead.email}`,
          });
        }
      }

      return leads;
    } catch (error) {
      console.error('CSV parsing failed:', error);
      throw new Error(`Failed to parse CSV: ${error.message}`);
    }
  }

  csvRowToLead(row) {
    const normalizeHeader = (h) => String(h || '').trim().toLowerCase().replace(/[\s_-]+/g, '');

    const headerMap = {
      name: 'name',
      fullname: 'name',
      contactname: 'name',
      contact: 'name',
      company: 'company',
      businessname: 'company',
      business: 'company',
      companyname: 'company',
      email: 'email',
      contactemail: 'email',
      emailaddress: 'email',
      phone: 'phone',
      phonenumber: 'phone',
      tel: 'phone',
      website: 'website',
      url: 'website',
      site: 'website',
      title: 'title',
      jobtitle: 'title',
      position: 'title',
      role: 'title',
    };

    const lead = {};
    for (const [key, val] of Object.entries(row)) {
      const norm = normalizeHeader(key);
      const field = headerMap[norm];
      if (field && val) {
        lead[field] = String(val).trim();
      }
    }

    return lead;
  }

  isConfigured() {
    return true; // CSV provider is always available
  }
}

module.exports = CSVProvider;
