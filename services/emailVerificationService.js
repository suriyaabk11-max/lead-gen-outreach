// Free email verification: syntax + MX record lookup + disposable/role-based
// checks. No third-party API, no per-lead cost - deliberate, since this app
// targets a ~$5/month Railway budget. This catches typos and made-up
// addresses (the exact risk called out when scraping emails off a website)
// but it is not a full mailbox-existence check like Clay/Apollo/Kickbox
// provide - it can't tell you a specific inbox is full or disabled.
const dns = require('dns').promises;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MX_LOOKUP_TIMEOUT_MS = 5000;

// Domains that hand out throwaway inboxes - never worth enrolling.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
  'sharklasers.com', 'getnada.com', 'dispostable.com', 'fakeinbox.com',
  'maildrop.cc', 'mintemail.com', 'mohmal.com', 'moakt.com', 'spam4.me',
  'tempinbox.com', 'emailondeck.com', 'mailnesia.com', 'mytemp.email',
  'discard.email', 'mailcatch.com', 'mailtemp.info', 'tmpmail.org',
]);

// Not disposable, but not a named person either - deliverable, lower
// personalization value, worth flagging rather than silently rejecting.
const ROLE_PREFIXES = new Set([
  'info', 'admin', 'support', 'sales', 'contact', 'hello', 'help', 'office',
  'noreply', 'no-reply', 'webmaster', 'postmaster', 'marketing', 'billing',
  'enquiries', 'inquiries', 'team', 'mail',
]);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function hasMxRecord(domain) {
  try {
    const records = await withTimeout(dns.resolveMx(domain), MX_LOOKUP_TIMEOUT_MS);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

// status: 'invalid' (do not send - bad syntax, no mail server, or disposable),
// 'risky' (deliverable but a role address, not a named person),
// 'valid' (deliverable, looks like a real person).
async function verifyEmail(email) {
  const trimmed = String(email || '').trim();
  const result = { email: trimmed, syntaxValid: false, hasMx: false, isDisposable: false, isRoleBased: false, status: 'invalid' };

  if (!EMAIL_RE.test(trimmed)) return result;
  result.syntaxValid = true;

  const domain = trimmed.slice(trimmed.lastIndexOf('@') + 1).toLowerCase();
  const localPart = trimmed.slice(0, trimmed.lastIndexOf('@')).toLowerCase();

  result.isDisposable = DISPOSABLE_DOMAINS.has(domain);
  if (result.isDisposable) return result;

  result.hasMx = await hasMxRecord(domain);
  if (!result.hasMx) return result;

  result.isRoleBased = ROLE_PREFIXES.has(localPart);
  result.status = result.isRoleBased ? 'risky' : 'valid';
  return result;
}

// Runs verifications with limited concurrency so a big CSV doesn't fire
// hundreds of simultaneous DNS lookups at once.
async function verifyBatch(emails, concurrency = 8) {
  const results = new Array(emails.length);
  let next = 0;

  async function worker() {
    while (next < emails.length) {
      const i = next++;
      results[i] = await verifyEmail(emails[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length) }, worker));
  return results;
}

module.exports = { verifyEmail, verifyBatch };
