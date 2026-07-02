#!/usr/bin/env node
/*
 * Finds business leads via the Searlo Google SERP API, then visits each
 * business's own website directly to pull a contact email + phone number.
 *
 * Requires SEARLO_API_KEY (get one at https://searlo.tech). Searching is
 * done through Searlo's API, not by scraping Google directly, so it won't
 * get blocked/CAPTCHA'd. Visiting each business's own site to look for a
 * public contact email is a normal, low-risk operation.
 *
 * Usage:
 *   node scripts/scrape-leads.js "dentists in Melbourne" --count 50 --out leads.csv
 *
 * Options:
 *   --count <n>   how many leads to try to find (default 20)
 *   --out <file>  CSV output path (default leads.csv in cwd)
 *   --delay <ms>  base delay between site visits, randomized +/-50% (default 2000)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const emailVerificationService = require('../services/emailVerificationService');

const SEARLO_BASE_URL = 'https://api.searlo.tech/api/v1';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /\b(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{3,4}\b/;
const BLOCKED_HOST_SUBSTRINGS = ['google.com', 'youtube.com', 'facebook.com', 'yelp.com', 'instagram.com'];

function parseArgs(argv) {
  const args = { count: 20, out: 'leads.csv', delay: 2000, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--delay') args.delay = Number(argv[++i]);
    else args._.push(a);
  }
  args.query = args._.join(' ');
  return args;
}

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
    console.warn(`  could not load ${websiteUrl}: ${e.message}`);
  }
  return result;
}

function toCsv(rows) {
  const headers = ['name', 'company', 'email', 'phone', 'website', 'email_status'];
  const escape = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(r[h])).join(','));
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Usage: node scripts/scrape-leads.js "<search query>" [--count N] [--out file.csv] [--delay ms]');
    process.exit(1);
  }
  if (!process.env.SEARLO_API_KEY) {
    console.error('SEARLO_API_KEY is not set. Get one at https://searlo.tech and add it to .env.');
    process.exit(1);
  }

  console.log(`Searching for: "${args.query}" (target ${args.count} leads) via Searlo API`);
  const websites = await collectSearchResultLinks(args.query, args.count);
  console.log(`Found ${websites.length} candidate business website(s). Visiting each for contact info...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const browserPage = await context.newPage();

  const leads = [];
  for (const site of websites) {
    console.log(`  -> ${site}`);
    const info = await scrapeContactInfo(browserPage, site);
    if (info.email) {
      leads.push({ name: '', company: info.company, email: info.email, phone: info.phone, website: site });
    } else {
      console.log('     no email found, skipping');
    }
    await jitteredDelay(args.delay);
  }

  await browser.close();

  console.log(`\nVerifying ${leads.length} scraped email(s) (syntax + mail server + disposable check)...`);
  const verifications = await emailVerificationService.verifyBatch(leads.map((l) => l.email));
  let validCount = 0;
  let riskyCount = 0;
  const keptLeads = [];
  for (let i = 0; i < leads.length; i++) {
    const v = verifications[i];
    if (v.status === 'invalid') continue; // no mail server, or a disposable domain - not worth keeping
    keptLeads.push({ ...leads[i], email_status: v.status });
    if (v.status === 'valid') validCount += 1;
    else riskyCount += 1;
  }

  const outPath = path.resolve(process.cwd(), args.out);
  fs.writeFileSync(outPath, toCsv(keptLeads));
  console.log(`\nDone. ${keptLeads.length} verifiable lead(s) written to ${outPath}`);
  console.log(`  ${validCount} valid, ${riskyCount} risky (role address like info@ - deliverable, not a named person)`);
  console.log(`  ${leads.length - keptLeads.length} dropped (no mail server found, or a disposable domain)`);
  console.log('\nNote: this only confirms the domain accepts mail - it does not confirm the specific');
  console.log('inbox exists. For higher-confidence verification, run through a paid service (e.g. Clay,');
  console.log('Apollo, Kickbox) before a large send.');
}

main().catch((e) => {
  console.error('Scraper failed:', e);
  process.exit(1);
});
