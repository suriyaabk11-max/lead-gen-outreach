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
const BLOCKED_HOST_SUBSTRINGS = [
  'google.com', 'youtube.com', 'facebook.com', 'yelp.com', 'instagram.com',
  'linkedin.com', 'reddit.com',
];
// Tried in order, on the same domain as the search result, until one yields
// an email. Homepage is always tried first (added in scrapeContactInfo).
const CONTACT_PATHS = ['/contact', '/contact-us', '/about', '/about-us'];

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

// Searlo's /search/web returns { organic: [...], nextPage: <number|null>, ... }
// - NOT the older { items: [...], searchInformation: { hasNextPage } } shape.
async function collectSearchResultLinks(query, count) {
  const links = new Set();
  let page = 1;
  while (links.size < count && page <= 10) {
    const data = await searloSearch(query, page);
    const results = data.organic || [];
    if (results.length === 0) break;

    for (const item of results) {
      if (!item.link || !isUsableWebsite(item.link)) continue;
      try {
        const u = new URL(item.link);
        links.add(`${u.protocol}//${u.hostname}`);
      } catch {
        // ignore malformed URLs
      }
      if (links.size >= count) break;
    }

    if (!data.nextPage) break;
    page += 1;
  }
  return Array.from(links).slice(0, count);
}

// Tries, in order: mailto link, footer text, then whole-page body text.
// Returns '' if none of those contain a plausible email.
async function extractEmailFromPage(browserPage) {
  const mailtoHref = await browserPage
    .$$eval('a[href^="mailto:"]', (as) => (as[0] ? as[0].getAttribute('href') : null))
    .catch(() => null);
  if (mailtoHref) {
    const email = mailtoHref.replace('mailto:', '').split('?')[0].trim();
    if (email && EMAIL_RE.test(email)) return email;
  }

  const footerText = (await browserPage.textContent('footer').catch(() => '')) || '';
  const footerMatch = footerText.match(EMAIL_RE);
  if (footerMatch) return footerMatch[0];

  const bodyText = (await browserPage.textContent('body').catch(() => '')) || '';
  const bodyMatch = bodyText.match(EMAIL_RE);
  if (bodyMatch) return bodyMatch[0];

  return '';
}

// Visits the homepage, then /contact, /contact-us, /about, /about-us (in
// that order) until an email is found, staying on the original domain the
// whole way (a redirect to a different host - e.g. a parked domain - means
// skip that page, not follow it). Tolerates timeouts/404s/SSL issues on any
// single page by moving on to the next candidate; only a failure to load the
// homepage itself is treated as this site being unreachable.
async function scrapeContactInfo(browserPage, websiteUrl) {
  const result = { company: '', email: '', phone: '' };
  let originalHost;
  try {
    originalHost = new URL(websiteUrl).hostname.toLowerCase();
  } catch {
    result.error = 'Invalid website URL';
    return result;
  }

  const candidatePages = [
    websiteUrl,
    ...CONTACT_PATHS.map((p) => {
      try {
        return new URL(p, websiteUrl).toString();
      } catch {
        return null;
      }
    }).filter(Boolean),
  ];

  for (let i = 0; i < candidatePages.length; i++) {
    try {
      await browserPage.goto(candidatePages[i], { waitUntil: 'domcontentloaded', timeout: i === 0 ? 20000 : 15000 });
    } catch (e) {
      if (i === 0) {
        // Homepage itself is unreachable (DNS failure, connection refused,
        // timeout) - the whole domain is down, no point trying subpaths.
        result.error = e.message;
        break;
      }
      continue; // this subpath 404s / times out / doesn't exist - try the next one
    }

    let finalHost;
    try {
      finalHost = new URL(browserPage.url()).hostname.toLowerCase();
    } catch {
      finalHost = null;
    }
    if (finalHost !== originalHost) continue; // redirected off-domain - don't trust this page's content

    if (i === 0) {
      result.company = (await browserPage.title().catch(() => '')).split(/[-|]/)[0].trim();
    }

    if (!result.email) {
      const email = await extractEmailFromPage(browserPage);
      if (email) result.email = email;
    }
    if (!result.phone) {
      const bodyText = (await browserPage.textContent('body').catch(() => '')) || '';
      const p = bodyText.match(PHONE_RE);
      if (p) result.phone = p[0].trim();
    }

    if (result.email && result.phone) break; // got everything worth having
  }

  return result;
}

// Searches for `query`, visits up to `count` matching business sites, and
// returns leads that had a scrapeable contact email (unverified - caller is
// expected to run these through emailVerificationService before using them).
// onProgress (optional) is called with { phase: 'searching' }, then
// { phase: 'scraping', total, visited, found, site, emailFound } per site,
// then { phase: 'done', total, visited, found }.
async function findLeads(query, count, { delayMs = 2000, onProgress } = {}) {
  if (onProgress) onProgress({ phase: 'searching' });
  const websites = await collectSearchResultLinks(query, count);
  if (onProgress) onProgress({ phase: 'scraping', total: websites.length, visited: 0, found: 0 });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, ignoreHTTPSErrors: true });
    const browserPage = await context.newPage();

    const leads = [];
    for (let i = 0; i < websites.length; i++) {
      const site = websites[i];
      const info = await scrapeContactInfo(browserPage, site);
      if (info.email) {
        leads.push({ name: '', company: info.company, email: info.email, phone: info.phone, website: site });
      }
      if (onProgress) {
        onProgress({ phase: 'scraping', total: websites.length, visited: i + 1, found: leads.length, site, emailFound: !!info.email });
      }
      await jitteredDelay(delayMs);
    }
    if (onProgress) onProgress({ phase: 'done', total: websites.length, visited: websites.length, found: leads.length });
    return leads;
  } finally {
    await browser.close();
  }
}

module.exports = { findLeads, isUsableWebsite };
