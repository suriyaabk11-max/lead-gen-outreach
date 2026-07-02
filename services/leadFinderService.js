// Core lead-finding logic: searches via the Searlo Google SERP API, then
// visits each business's own website to pull a contact email + phone.
// Shared by scripts/scrape-leads.js (manual CLI run) and the scheduled
// unattended job in server.js (LeadFinderConfig-driven cron).
const { chromium } = require('playwright');

const SEARLO_BASE_URL = 'https://api.searlo.tech/api/v1';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /\b(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{3,4}\b/;
const BLOCKED_HOST_SUBSTRINGS = ['google.com', 'youtube.com', 'facebook.com', 'yelp.com', 'instagram.com'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(baseMs) {
  const factor = 0.5 + Math.random(); // 0.5x - 1.5x
  return sleep(Math.round(baseMs * factor));
}

function isUsableWebsite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !BLOCKED_HOST_SUBSTRINGS.some((b) => host.includes(b));
  } catch {
    return false;
  }
}

async function searloSearch(query, page) {
  if (!process.env.SEARLO_API_KEY) {
    throw new Error('SEARLO_API_KEY is not set. Get one at https://searlo.tech and add it to .env.');
  }
  const url = `${SEARLO_BASE_URL}/search/web?q=${encodeURIComponent(query)}&limit=10&page=${page}`;
  const res = await fetch(url, { headers: { 'x-api-key': process.env.SEARLO_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Searlo API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function collectSearchResultLinks(query, count) {
  const links = new Set();
  let page = 1;
  while (links.size < count && page <= 10) {
    const data = await searloSearch(query, page);
    const items = data.items || [];
    if (items.length === 0) break;

    for (const item of items) {
      if (!item.link || !isUsableWebsite(item.link)) continue;
      try {
        const u = new URL(item.link);
        links.add(`${u.protocol}//${u.hostname}`);
      } catch {
        // ignore malformed URLs
      }
      if (links.size >= count) break;
    }

    if (!data.searchInformation || !data.searchInformation.hasNextPage) break;
    page += 1;
  }
  return Array.from(links).slice(0, count);
}

async function scrapeContactInfo(browserPage, websiteUrl) {
  const result = { company: '', email: '', phone: '' };
  try {
    await browserPage.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    result.company = (await browserPage.title()).split(/[-|]/)[0].trim();

    const mailtoHref = await browserPage
      .$$eval('a[href^="mailto:"]', (as) => (as[0] ? as[0].getAttribute('href') : null))
      .catch(() => null);
    const bodyText = (await browserPage.textContent('body').catch(() => '')) || '';

    if (mailtoHref) {
      result.email = mailtoHref.replace('mailto:', '').split('?')[0].trim();
    } else {
      const m = bodyText.match(EMAIL_RE);
      if (m) result.email = m[0];
    }

    const p = bodyText.match(PHONE_RE);
    if (p) result.phone = p[0].trim();

    // If no email on the homepage, try a /contact page once (if it stays on same domain).
    if (!result.email) {
      const contactUrl = new URL('/contact', websiteUrl).toString();
      const originalHost = new URL(websiteUrl).hostname.toLowerCase();
      try {
        await browserPage.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const finalUrl = browserPage.url();
        const finalHost = new URL(finalUrl).hostname.toLowerCase();
        if (finalHost === originalHost) {
          const contactText = (await browserPage.textContent('body').catch(() => '')) || '';
          const m2 = contactText.match(EMAIL_RE);
          if (m2) result.email = m2[0];
        }
      } catch {
        // /contact page doesn't exist or failed to load
      }
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// Searches for `query`, visits up to `count` matching business sites, and
// returns leads that had a scrapeable contact email (unverified - caller is
// expected to run these through emailVerificationService before using them).
async function findLeads(query, count, { delayMs = 2000, onProgress } = {}) {
  const websites = await collectSearchResultLinks(query, count);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const browserPage = await context.newPage();

    const leads = [];
    for (const site of websites) {
      const info = await scrapeContactInfo(browserPage, site);
      if (info.email) {
        leads.push({ name: '', company: info.company, email: info.email, phone: info.phone, website: site });
      }
      if (onProgress) onProgress({ site, found: !!info.email });
      await jitteredDelay(delayMs);
    }
    return leads;
  } finally {
    await browser.close();
  }
}

module.exports = { findLeads };
