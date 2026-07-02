// Generates the two short AI-written lines used in the Step 1 cold email
// template (a "positive note" and a "personalized observation"). Uses
// Gemini (generous free tier - keeps a live campaign cheap) rather than
// Claude; deliberately separate from aiProviderService.js (the heavier AI
// Sales OS pipeline, which needs a website crawl first) - this only needs
// name/company/city/website, so it can run inline right before a send.
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GENERATION_TIMEOUT_MS = 20000;

let client = null;
function getModel() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client.getGenerativeModel({ model: MODEL });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI personalization timed out')), ms)),
  ]);
}

// Generic but natural-sounding, never a broken/empty placeholder - used
// whenever there's no API key, a bad response, or a timeout.
function fallback(lead) {
  const company = lead.company || 'your business';
  return {
    positiveNote: `what you're building at ${company}`,
    observation: 'there is likely room to save time on repetitive day-to-day tasks',
  };
}

// Never throws - always resolves to { positiveNote, observation }. This runs
// inline before a send (see processLead in server.js), so a hang or crash
// here must never block or take down the whole send batch - same lesson as
// the Resend timeout fix.
async function generateOpeningLines(lead) {
  const model = getModel();
  if (!model) return fallback(lead);

  const prompt = `Write two short lines for a cold outreach email to a business.

Business name: ${lead.company || 'Unknown'}
Contact name: ${lead.name || 'Unknown'}
City: ${lead.city || 'Unknown'}
Website: ${lead.website || 'Unknown'}

Return ONLY valid JSON with these exact keys, no other text, no markdown code fences:
{
  "positiveNote": "a short (under 15 words) genuine-sounding positive observation about their business, written to fit after 'I noticed you're doing a great job with'",
  "observation": "a short (under 20 words) plausible operational pain point, written to fit after 'One thing I also noticed is that'"
}

If you don't have enough real information to say something specific and credible, write something generic but still natural-sounding rather than inventing false specifics.`;

  try {
    const result = await withTimeout(model.generateContent(prompt), GENERATION_TIMEOUT_MS);
    const text = result.response.text();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback(lead);
    const data = JSON.parse(match[0]);
    if (!data.positiveNote || !data.observation) return fallback(lead);
    return {
      positiveNote: String(data.positiveNote).slice(0, 200),
      observation: String(data.observation).slice(0, 200),
    };
  } catch (err) {
    console.error('Opening personalization generation failed, using fallback:', err.message);
    return fallback(lead);
  }
}

module.exports = { generateOpeningLines };
