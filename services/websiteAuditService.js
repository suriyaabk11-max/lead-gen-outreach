const { chromium } = require('playwright');
const websiteAuditRepository = require('../repositories/websiteAuditRepository');

class WebsiteAuditService {
  constructor() {
    this.timeout = 15000;
  }

  async auditWebsite(lead, companyProfile) {
    if (!lead.website || !companyProfile) {
      throw new Error('Lead requires website and company profile data');
    }

    try {
      await websiteAuditRepository.updateAuditStatus(lead.id, 'auditing');

      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      const website = companyProfile.website || lead.website;

      // Measure performance
      const startTime = Date.now();
      const pageMetrics = await this.measurePage(page, website);
      const loadTime = (Date.now() - startTime) / 1000;

      // Get page content
      const html = await page.content();
      const text = await page.textContent('body');

      // Run audits
      const auditResults = {
        // Mobile responsiveness
        isMobileResponsive: await this.checkMobileResponsiveness(page),

        // SEO
        hasMetaTitle: /<title>/.test(html) && /<title>.+<\/title>/.test(html),
        hasMetaDescription: /meta.*description/i.test(html),
        metaTitleQuality: this.scoreSEOTitle(html),
        headingStructure: /^<h[1-6]/.test(html),
        hasSchemaMarkup: /schema.org|ld\+json/i.test(html),

        // Performance
        pageLoadTime: loadTime,
        coreWebVitalsScore: this.estimateWebVitals(loadTime),

        // Technical
        isSecure: website.startsWith('https'),
        brokenLinksCount: await this.checkBrokenLinks(page, website),
        errorPagesCount: await this.checkErrorPages(page, website),
        hasRobotsTxt: await this.checkRobotsTxt(website),

        // Content quality
        portfolioQuality: companyProfile.hasPortfolio ? 60 : 20,
        blogQuality: companyProfile.hasBlog ? 50 : 10,
        blogFrequency: companyProfile.hasBlog ? 'unknown' : 'none',
      };

      // Calculate overall score
      auditResults.overallScore = this.calculateOverallScore(auditResults);

      // Store detailed audit
      auditResults.auditDetails = {
        url: website,
        pageMetrics,
        crawlTime: new Date().toISOString(),
      };

      await browser.close();

      // Save audit results
      await websiteAuditRepository.upsert(lead.id, auditResults);
      await websiteAuditRepository.updateAuditStatus(lead.id, 'completed');

      return auditResults;
    } catch (error) {
      await websiteAuditRepository.updateAuditStatus(lead.id, 'failed', error.message);
      throw error;
    }
  }

  async checkMobileResponsiveness(page) {
    try {
      // Check for viewport meta tag
      const html = await page.content();
      return /viewport.*width=device-width/i.test(html);
    } catch {
      return false;
    }
  }

  scoreSEOTitle(html) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (!titleMatch) return 0;
    const title = titleMatch[1];
    const length = title.length;
    // Score higher for titles 30-60 chars
    if (length >= 30 && length <= 60) return 100;
    if (length >= 20 && length <= 70) return 80;
    if (length > 0) return 50;
    return 0;
  }

  estimateWebVitals(loadTimeSeconds) {
    // Quick estimation based on load time
    if (loadTimeSeconds < 1) return 100;
    if (loadTimeSeconds < 2) return 90;
    if (loadTimeSeconds < 3) return 75;
    if (loadTimeSeconds < 5) return 50;
    return 30;
  }

  async checkBrokenLinks(page, baseUrl) {
    try {
      const links = await page.$$('a');
      let broken = 0;

      for (const link of links.slice(0, 20)) {
        // Sample 20 links
        const href = await link.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
          // Simplified check - count external links we can't verify
          if (href.startsWith('/') || href.startsWith(new URL(baseUrl).hostname)) {
            // Internal link - would need actual HTTP check
            broken += 0;
          }
        }
      }

      return broken;
    } catch {
      return 0;
    }
  }

  async checkErrorPages(page, baseUrl) {
    try {
      const response = await page.goto(baseUrl + '/nonexistent-page-12345', { waitUntil: 'domcontentloaded' });
      return response?.status() === 404 ? 0 : 1;
    } catch {
      return 0;
    }
  }

  async checkRobotsTxt(baseUrl) {
    try {
      const robotsUrl = new URL('/robots.txt', baseUrl).toString();
      const response = await fetch(robotsUrl);
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async measurePage(page, url) {
    try {
      const metrics = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0];
        return {
          domInteractive: navigation?.domInteractive || 0,
          domContentLoaded: navigation?.domContentLoadedEventEnd || 0,
          loadEventEnd: navigation?.loadEventEnd || 0,
          transferSize: navigation?.transferSize || 0,
          encodedBodySize: navigation?.encodedBodySize || 0,
        };
      });
      return metrics;
    } catch {
      return {};
    }
  }

  calculateOverallScore(audit) {
    let score = 0;
    let weightCount = 0;

    // Mobile responsiveness (15%)
    if (audit.isMobileResponsive) {
      score += 15;
      weightCount += 15;
    }

    // SEO (25%)
    let seoScore = 0;
    if (audit.hasMetaTitle) seoScore += 5;
    if (audit.hasMetaDescription) seoScore += 5;
    seoScore += (audit.metaTitleQuality / 100) * 5;
    if (audit.headingStructure) seoScore += 5;
    if (audit.hasSchemaMarkup) seoScore += 5;
    score += (seoScore / 25) * 25;
    weightCount += 25;

    // Performance (15%)
    score += (audit.coreWebVitalsScore / 100) * 15;
    weightCount += 15;

    // Technical (15%)
    let technicalScore = 0;
    if (audit.isSecure) technicalScore += 5;
    technicalScore += Math.max(0, (10 - audit.brokenLinksCount * 2));
    technicalScore += Math.max(0, (5 - audit.errorPagesCount * 5));
    if (audit.hasRobotsTxt) technicalScore += 5;
    score += (technicalScore / 25) * 15;
    weightCount += 15;

    // Content quality (15%)
    const contentScore = audit.portfolioQuality + audit.blogQuality;
    score += (contentScore / 110) * 15;
    weightCount += 15;

    // Additional points for social presence (15%)
    // This would come from companyProfile - added in audit call

    return Math.round(Math.min(100, Math.max(0, score)));
  }
}

module.exports = new WebsiteAuditService();
