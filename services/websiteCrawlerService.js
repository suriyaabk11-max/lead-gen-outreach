const { chromium } = require('playwright');
const companyProfileRepository = require('../repositories/companyProfileRepository');

class WebsiteCrawlerService {
  constructor() {
    this.timeout = 20000; // 20 seconds per page
    this.pageLoadTimeout = 15000;
  }

  async crawlLead(lead) {
    if (!lead.website) {
      throw new Error('Lead has no website URL');
    }

    try {
      await companyProfileRepository.updateCrawlStatus(lead.id, 'crawling');

      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      const baseUrl = this.normalizeUrl(lead.website);
      const crawledData = {
        website: baseUrl,
        companyName: '',
        description: '',
        services: [],
        techStack: [],
        cms: null,
        frameworks: [],
        socialLinks: {},
        hasBookingSystem: false,
        hasPortfolio: false,
        hasBlog: false,
        email: null,
        phone: null,
        contactForms: [],
      };

      // Crawl key pages
      const pages = [
        { url: baseUrl, key: 'home' },
        { url: `${baseUrl}/about`, key: 'about' },
        { url: `${baseUrl}/services`, key: 'services' },
        { url: `${baseUrl}/portfolio`, key: 'portfolio' },
        { url: `${baseUrl}/contact`, key: 'contact' },
        { url: `${baseUrl}/blog`, key: 'blog' },
      ];

      for (const p of pages) {
        try {
          await this.crawlPage(page, p.url, p.key, crawledData);
        } catch (err) {
          console.warn(`Failed to crawl ${p.url}:`, err.message);
        }
      }

      // Extract company name from title if not found
      if (!crawledData.companyName) {
        crawledData.companyName = lead.company || '';
      }

      await browser.close();

      // Save crawled data
      await companyProfileRepository.upsert(lead.id, crawledData);
      await companyProfileRepository.updateCrawlStatus(lead.id, 'completed');

      return crawledData;
    } catch (error) {
      await companyProfileRepository.updateCrawlStatus(lead.id, 'failed', error.message);
      throw error;
    }
  }

  async crawlPage(page, url, pageKey, crawledData) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.pageLoadTimeout });
    } catch (err) {
      console.warn(`Could not load ${url}:`, err.message);
      return;
    }

    const pageText = (await page.textContent('body')) || '';
    const pageHtml = await page.content();

    // Extract text content
    if (pageKey === 'home') {
      const title = (await page.title()) || '';
      if (!crawledData.companyName && title) {
        crawledData.companyName = title.split(/[-|/]/)[0].trim();
      }
    }

    if (pageKey === 'about') {
      const firstParagraph = await page.$eval('p', (el) => el?.textContent?.slice(0, 500)).catch(() => null);
      if (firstParagraph && !crawledData.description) {
        crawledData.description = firstParagraph;
      }
    }

    if (pageKey === 'services') {
      const services = await page.$$eval('h2, h3', (els) =>
        els.map((el) => el.textContent?.trim()).filter(Boolean).slice(0, 5)
      ).catch(() => []);
      crawledData.services.push(...services);
    }

    if (pageKey === 'portfolio') {
      crawledData.hasPortfolio = true;
    }

    if (pageKey === 'blog') {
      crawledData.hasBlog = true;
    }

    // Extract contact info
    const emailMatch = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch && !crawledData.email) {
      crawledData.email = emailMatch[0];
    }

    const phoneMatch = pageText.match(/\b[\+]?[\d\s().\-]{10,}\b/);
    if (phoneMatch && !crawledData.phone) {
      crawledData.phone = phoneMatch[0];
    }

    // Detect contact forms
    const formCount = await page.$$('form').then((els) => els.length);
    if (formCount > 0) {
      crawledData.contactForms.push(url);
    }

    // Detect booking systems
    if (pageText.toLowerCase().includes('book') || pageText.toLowerCase().includes('calendar')) {
      crawledData.hasBookingSystem = true;
    }

    // Extract social links
    const socialUrls = await page.$$eval('a[href*="linkedin"], a[href*="twitter"], a[href*="facebook"], a[href*="instagram"]', (els) =>
      els.map((el) => el.href).slice(0, 4)
    ).catch(() => []);
    socialUrls.forEach((url) => {
      if (url.includes('linkedin')) crawledData.socialLinks.linkedin = url;
      else if (url.includes('twitter')) crawledData.socialLinks.twitter = url;
      else if (url.includes('facebook')) crawledData.socialLinks.facebook = url;
      else if (url.includes('instagram')) crawledData.socialLinks.instagram = url;
    });

    // Detect technology stack
    this.detectTechStack(pageHtml, crawledData);
  }

  detectTechStack(html, crawledData) {
    const techSignatures = {
      'WordPress': /wp-content/i,
      'React': /<div id="react-root|__react|data-react/i,
      'Vue': /vue\.|__VUE/i,
      'Angular': /ng-app|angular/i,
      'Next.js': /_next/,
      'Shopify': /cdn.shopify.com|Shopify.theme/,
      'Stripe': /stripe.com/i,
      'Google Analytics': /google-analytics|gtag|GA_ID/i,
      'jQuery': /jquery/i,
      'Bootstrap': /bootstrap\.|btn-/i,
      'Tailwind': /tailwind/i,
    };

    for (const [tech, regex] of Object.entries(techSignatures)) {
      if (regex.test(html) && !crawledData.techStack.includes(tech)) {
        crawledData.techStack.push(tech);
      }
    }

    if (crawledData.techStack.length === 0) {
      crawledData.techStack = ['Unknown'];
    }
  }

  normalizeUrl(website) {
    let url = website.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }
    return url.replace(/\/$/, ''); // Remove trailing slash
  }
}

module.exports = new WebsiteCrawlerService();
