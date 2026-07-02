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
 * This is a thin CLI wrapper around services/leadFinderService.js, which is
 * also used by the scheduled/unattended lead finder in server.js.
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
const leadFinderService = require('../services/leadFinderService');
const emailVerificationService = require('../services/emailVerificationService');

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
  const leads = await leadFinderService.findLeads(args.query, args.count, {
    delayMs: args.delay,
    onProgress: (p) => {
      if (p.phase === 'searching') console.log('Searching...');
      else if (p.phase === 'scraping' && p.site) {
        console.log(`  [${p.visited}/${p.total}] ${p.site}${p.emailFound ? '' : ' (no email found, skipping)'}`);
      } else if (p.phase === 'scraping') {
        console.log(`Found ${p.total} candidate business website(s). Visiting each for contact info...`);
      }
    },
  });

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
