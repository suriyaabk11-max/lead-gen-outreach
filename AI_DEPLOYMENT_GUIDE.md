# AI-Powered Sales OS - Deployment & Operations Guide

## Quick Start

### 1. Install Dependencies

```bash
npm install
npm run db:push  # Creates new tables for AI features
```

### 2. Configure Environment Variables

Add to `.env`:

```env
# Claude API (required for AI features)
ANTHROPIC_API_KEY=sk-your-key-here
AI_MODEL=claude-opus-4-1
AI_MAX_TOKENS=1000
AI_MONTHLY_TOKEN_BUDGET=1000000

# Redis (required for background jobs)
REDIS_HOST=localhost
REDIS_PORT=6379

# Existing variables (unchanged)
DATABASE_URL=postgresql://...
RESEND_API_KEY=...
FROM_EMAIL=...
FROM_NAME=...
```

### 3. Start Redis

```bash
# Using Docker (recommended)
docker run -d -p 6379:6379 redis:latest

# Or locally
redis-server
```

### 4. Start Application

```bash
npm start
```

The app will now have all AI features enabled.

---

## How the AI Pipeline Works

### Lead Lifecycle

```
Lead Added
    ↓
[CRAWL] Website Crawler
  - Extracts company info
  - Detects tech stack
  - Finds contact info
    ↓
[AUDIT] Website Audit
  - Scores mobile responsiveness
  - Measures SEO quality
  - Checks performance metrics
  - Calculates overall score (0-100)
    ↓
[SCORE] Lead Scoring
  - Weights 8 factors
  - Produces score (0-100)
  - Assigns qualification (hot/warm/cold)
    ↓
[PERSONALIZE] AI Personalization
  - Generates subject line
  - Creates opening sentence
  - Identifies pain points
  - Crafts value proposition
    ↓
[SEND] Email Sequence
  - Step 1 uses personalized content
  - Existing sequence logic unchanged
    ↓
[CRM] Track Engagement
  - Log replies
  - Create opportunities
  - Track pipeline stages
```

---

## API Endpoints Reference

### Lead Intelligence

#### Start Full Pipeline
```bash
POST /api/leads/{leadId}/pipeline
# Queues: crawl → audit → score → personalize
Response: { jobs: { crawl, audit, score, personalization } }
```

#### Individual Operations
```bash
POST /api/leads/{leadId}/crawl
POST /api/leads/{leadId}/audit
POST /api/leads/{leadId}/score
POST /api/leads/{leadId}/personalize

# Get full intelligence for a lead
GET /api/leads/{leadId}/intelligence
```

#### Batch Operations
```bash
POST /api/leads/batch/pipeline
Body: { leadIds: ["id1", "id2", ...] }
```

### Analytics

```bash
# Overall summary
GET /api/analytics/summary
Returns: { summary, qualification, engagement, pipeline, ai }

# Score distribution
GET /api/analytics/score-distribution
Returns: { byQualification, byRange }

# Website quality rankings
GET /api/analytics/website-quality?limit=50
Returns: { topPerformers, averageScore, count }

# Pipeline stats
GET /api/analytics/pipeline
Returns: { stages, totalPipelineValue }
```

### Opportunities (CRM)

```bash
# List opportunities
GET /api/opportunities?stage=contacted&salesOwner=john&limit=50

# Convert lead to opportunity
POST /api/opportunities
Body: { leadId, stage?, estimatedValue?, salesOwner?, notes? }

# Update opportunity
PUT /api/opportunities/{id}
Body: { stage?, estimatedValue?, salesOwner?, notes? }

# Log activity
POST /api/opportunities/{id}/activity
Body: { type, description }
# Types: email_sent, email_replied, call, meeting, note, opportunity_created, stage_changed, assigned, value_updated

# Add note
POST /api/opportunities/{id}/notes
Body: { content, author? }

# Get timeline
GET /api/opportunities/{id}/timeline
```

### Providers

```bash
# List available providers
GET /api/providers
Returns: { providers: [{ name, priority, configured }] }

# Search via provider
POST /api/providers/{name}/search
Body: { query, limit? }
Returns: { provider, count, leads }

# Supported providers: "searlo", "csv"
```

### Job Queue

```bash
# Get job status
GET /api/jobs/{jobId}

# Get queue statistics
GET /api/jobs/stats
```

---

## Configuration & Customization

### Adjust Lead Scoring Weights

Edit `services/leadScoringService.js`:

```javascript
this.weights = {
  websiteQuality: 0.25,     // Change to 0.30 for more weight
  completeness: 0.15,
  techMaturity: 0.15,
  // ... adjust as needed
  // Must sum to 1.0
};
```

### Customize AI Personalization Prompts

Edit `services/aiProviderService.js` - `buildPersonalizationPrompt()` method.

### Set Cost Limits

Edit `services/aiProviderService.js`:

```javascript
this.monthlyTokenBudget = parseInt(process.env.AI_MONTHLY_TOKEN_BUDGET || '1000000');
// When limit exceeded, personalization falls back to template
```

### Configure Job Queue Concurrency

Edit `services/jobQueueService.js` - `setupProcessors()`:

```javascript
this.crawlQueue.process(5, ...);      // 5 concurrent crawl jobs
this.auditQueue.process(3, ...);      // 3 concurrent audit jobs
this.scoreQueue.process(10, ...);     // 10 concurrent score jobs
this.personalizationQueue.process(5); // 5 concurrent personalization jobs
```

---

## Monitoring & Troubleshooting

### Check Redis Connection
```bash
redis-cli ping
# Should return: PONG
```

### Monitor Job Queue
```bash
GET /api/jobs/stats
# Returns job counts for each queue
```

### View AI Usage
```bash
GET /api/analytics/summary
# Shows tokens used and estimated cost this month
```

### Check Job Status
```bash
GET /api/jobs/{jobId}
# Returns: { status, data, result, error, retries }
# Status: pending, processing, completed, failed
```

### Debug Issues

#### Website won't crawl
- Check that website is accessible and not blocking bots
- Check timeout in `websiteCrawlerService.js` (default: 20s)
- Check Playwright installation: `npm list playwright`

#### Audit scoring low
- Adjust thresholds in `websiteAuditService.js`
- Check if website requires JavaScript (Playwright handles this)

#### Personalization generating generic content
- Check `ANTHROPIC_API_KEY` is valid
- Check `AI_MODEL` is available in Claude API
- Review generated prompt in `aiProviderService.js`

#### Jobs queued but not processing
- Check Redis connection
- Check job queue concurrency settings
- Check logs for error messages

---

## Database Migrations

### Add Custom Fields to Lead Score

If you want to add new scoring factors:

1. Update Prisma schema:
```prisma
model LeadScore {
  // ... existing fields
  customFactor Int @default(0)
}
```

2. Run migration:
```bash
npx prisma migrate dev --name add_custom_factor
npx prisma generate
```

3. Update `leadScoringService.js` to calculate the new factor

---

## Performance Tuning

### For High Volume (1000+ leads/day)

1. **Increase Job Queue Workers**
   ```javascript
   // 10 concurrent crawls, 5 audits, 20 scores, 10 personalizations
   this.crawlQueue.process(10, ...);
   this.auditQueue.process(5, ...);
   this.scoreQueue.process(20, ...);
   this.personalizationQueue.process(10, ...);
   ```

2. **Reduce Crawl Timeout** (if websites are fast)
   ```javascript
   this.timeout = 10000; // 10 seconds instead of 20
   ```

3. **Use Redis Cluster** for high availability
   ```javascript
   const queueOptions = {
     redis: {
       cluster: [
         { host: 'node1.redis', port: 6379 },
         { host: 'node2.redis', port: 6379 },
       ],
     },
   };
   ```

4. **Add Database Connection Pooling**
   ```env
   DATABASE_URL="postgresql://...?connection_limit=20&pool_timeout=45"
   ```

---

## Extending with New Providers

### Add a New Lead Provider (e.g., Clay)

1. Create `providers/clayProvider.js`:
```javascript
const LeadProviderInterface = require('./leadProviderInterface');

class ClayProvider extends LeadProviderInterface {
  constructor(config = {}) {
    super('clay', { priority: 9, ...config });
    this.apiKey = config.apiKey || process.env.CLAY_API_KEY;
  }

  async search(query, options = {}) {
    // Implement Clay API integration
  }

  isConfigured() {
    return !!this.apiKey;
  }
}

module.exports = ClayProvider;
```

2. Register in `providers/providerRegistry.js`:
```javascript
register(new ClayProvider());
```

3. Use via API:
```bash
POST /api/providers/clay/search
Body: { query: "saas companies in NYC", limit: 50 }
```

---

## Cost Tracking & Budgeting

### Monitor AI Spending

```bash
# View monthly usage
GET /api/analytics/summary
# Response includes: tokensUsedThisMonth, estimatedCostThisMonth

# Check token budget status
const budget = await aiProviderService.checkTokenBudget();
// Returns: { monthlyBudget, tokensUsed, remaining, percentageUsed }
```

### Estimate Costs

- Claude Opus: ~$3 per 1M input tokens, ~$15 per 1M output tokens
- Average personalization: ~500 tokens = ~$0.002
- With 1000 leads: ~$2-3/month

### Set Limits

```env
# Only allow 10,000 tokens/month = ~$0.04
AI_MONTHLY_TOKEN_BUDGET=10000

# Or set to unlimited
AI_MONTHLY_TOKEN_BUDGET=10000000
```

When budget exceeded, personalization falls back to template.

---

## Backup & Recovery

### Backup AI Data

```bash
# Backup new AI tables
pg_dump DATABASE_URL --table=CompanyProfile,WebsiteAudit,LeadScore,AIPersonalization > ai_backup.sql

# Restore
psql DATABASE_URL < ai_backup.sql
```

### Recovery Procedures

1. **Lost website crawl data**: Requeue crawl jobs for affected leads
   ```bash
   POST /api/leads/batch/pipeline
   Body: { leadIds: ["id1", "id2"] }
   ```

2. **Lost scores**: Requeue scoring jobs
   ```bash
   POST /api/leads/:id/score
   ```

3. **Lost personalization**: Requeue personalization jobs
   ```bash
   POST /api/leads/:id/personalize
   ```

---

## Deployment Checklist

- [ ] Install and configure Redis
- [ ] Add `ANTHROPIC_API_KEY` to environment
- [ ] Run `npm install` and `npm run db:push`
- [ ] Test website crawler with a test lead
- [ ] Test personalization with Claude API
- [ ] Configure cost limits in `AI_MONTHLY_TOKEN_BUDGET`
- [ ] Set up monitoring for job queue (`GET /api/jobs/stats`)
- [ ] Configure backups for new AI tables
- [ ] Test full pipeline with 10 leads
- [ ] Monitor token usage and costs
- [ ] Document any custom configurations
- [ ] Train team on new features

---

## Support & Debugging

### Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "Redis connection failed" | Check Redis is running: `redis-cli ping` |
| "ANTHROPIC_API_KEY not configured" | Add to `.env` and restart app |
| "Website crawl timeout" | Increase `this.timeout` in websiteCrawlerService.js |
| "Jobs stuck in pending" | Check job processor error logs, restart app |
| "Low website audit scores" | Adjust scoring thresholds in websiteAuditService.js |
| "Personalization not generating" | Check token budget, review Claude API response |

### Logs to Monitor

- Job processor errors (crawl, audit, score, personalization)
- API usage and token counts
- Website crawl timeouts and failures
- Claude API rate limit errors
- Database connection issues

---

## Next Steps

1. **Add custom scoring factors** based on your ICP
2. **Integrate with CRM** (HubSpot, Salesforce, etc.)
3. **Build dashboard UI** using `/api/analytics/*` endpoints
4. **Create Slack alerts** for hot leads
5. **Add email automation** triggers based on scores
6. **Implement lead assignment** rules

---

## Support

For issues or questions:
1. Check logs in your app console
2. Review this guide's troubleshooting section
3. Check API responses for detailed error messages
4. Monitor `/api/jobs/stats` for queue health
