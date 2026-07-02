# Outreach Sequencer

Upload a lead list, and each lead is automatically enrolled in a 5-email
outreach sequence sent over ~7.5 weeks (52 days). Built with plain
Node.js/Express, Postgres (via Prisma), and Resend for sending.

Default sequence (fully editable in the app):

| Step | Sends |
|---|---|
| 1 | Immediately when a lead is added |
| 2 | 4 days after step 1 |
| 3 | 10 days after step 2 |
| 4 | 18 days after step 3 |
| 5 | 20 days after step 4 |

The default copy pitches an AI voice agent receptionist to local
businesses (the example from the source video). Rewrite it in the
**Sequence** tab for your own offer.

## Run it locally

Needs a Postgres database. Point `DATABASE_URL` in `.env` at any Postgres
instance (self-hosted, Supabase, Neon, Railway's Postgres plugin, etc).

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to your Postgres connection string
npm run db:push   # creates the tables
npm start
```

Open http://localhost:3000. The app starts in **dry run** mode — no real
emails send, everything just gets logged in the Logs tab. Use this to
add a couple of test leads and read through what each step would send
before turning dry run off.

## Connect Resend (real sending)

1. Create an account at resend.com and verify a sending domain.
2. Get an API key from resend.com/api-keys.
3. Set `RESEND_API_KEY`, `FROM_EMAIL` (must be on your verified domain),
   and `FROM_NAME` in `.env` (or in Railway's environment variables).
4. In the app's **Settings** tab, turn off Dry Run once you're confident
   the copy and timing are right.

**Protect the app before you flip Dry Run off.** There is no login by
default - anyone with the URL can read/delete your leads or trigger real
sends. Set `APP_USERNAME` and `APP_PASSWORD` (locally in `.env`, or in
Railway's Variables tab) to put a login prompt in front of the whole app.
Leave both unset for local testing.

**Bad addresses stop themselves.** If a send to a lead fails 3 times in a
row (bad address, bounce, etc.), that lead is marked `bounced` and stops
retrying automatically instead of hammering Resend every 15 minutes
forever. Fix the address and hit "Resume" on that lead to give it 3 more
attempts.

**Deliverability note (important):** sending from a brand-new domain or
inbox is very likely to land in spam. Warm up your sending domain/inbox
first (there are warm-up tools you can search for), and consider
starting with a mailbox that already has real send/reply history.

## Deploy to Railway

You already have Railway set up, so:

1. Push this folder to a GitHub repo (or use Railway's CLI to deploy
   the folder directly: `railway up` from inside this directory).
2. Create a new Railway project from that repo/folder.
3. In Railway's Variables tab, set: `RESEND_API_KEY`, `FROM_EMAIL`,
   `FROM_NAME`, `APP_URL` (your Railway-provided URL, needed so
   unsubscribe links work), `DRY_RUN=true` to start, and
   `APP_USERNAME`/`APP_PASSWORD` to put a login on the app (recommended -
   see the note above).
4. Deploy. Railway sets `PORT` automatically.

**Persistence:** lead/log data lives in Postgres, not on the app's own disk,
so redeploys are safe regardless of where you host the app. Set
`DATABASE_URL` in Railway's Variables tab to a Postgres instance (Railway's
own Postgres plugin, Supabase, Neon, or a self-hosted instance), then run
`npm run db:push` once (locally, pointed at the production `DATABASE_URL`)
to create the tables before the app's first boot.

## How it works

- **Leads tab** — add a lead manually or upload a CSV (columns: name,
  company, email, phone, website — header names are flexible). New
  leads are deduplicated by email and immediately sent step 1 (or
  logged as a dry run).
- **Sequence tab** — edit the subject/body and delay for each of the 5
  steps, or disable a step entirely. Placeholders: `{{first_name}}`,
  `{{name}}`, `{{company}}`, `{{website}}`. An unsubscribe link is
  appended to every email automatically — you don't need to add one
  yourself.
- **LinkedIn tab** — semi-automated connection outreach. Add prospects
  manually or via CSV (columns: name, company, title, profileUrl), edit
  the note template (placeholders: `{{first_name}}`, `{{name}}`,
  `{{company}}`, `{{title}}`; LinkedIn caps notes at 300 characters), then
  for each prospect: open their profile, copy the drafted note, paste it
  into LinkedIn's own Connect dialog, and click Connect yourself. Mark it
  "sent" afterward. **This app never contacts linkedin.com or automates
  any action there** — every connection request is sent by you, by hand,
  which is what keeps this free of LinkedIn's automation-detection/ban
  risk (full automation, even throttled, still gets accounts restricted).
- **Settings tab** — toggle dry run, set your from name/email/app URL,
  and send yourself a test email.
- **Logs tab** — every send attempt (or dry-run) with status and any
  error.
- A background scheduler checks every 15 minutes for leads whose next
  email is due and sends it. You can also trigger it manually from the
  Leads tab ("Run scheduler now") for testing.

## Finding leads to upload

This app only handles the outreach side. For sourcing leads, there are two
options:

### `scripts/scrape-leads.js`

Finds businesses via the [Searlo](https://searlo.tech) Google SERP API
(not by scraping Google's HTML directly — that gets blocked almost
immediately), then visits each business's own website to look for a
public contact email and phone number.

```bash
# add SEARLO_API_KEY to .env first (get one at https://searlo.tech)
node scripts/scrape-leads.js "dentists in Melbourne" --count 50 --out leads.csv
```

Options: `--count` (how many leads to try to find, default 20), `--out`
(CSV path, default `leads.csv`), `--delay` (ms between site visits, default
2000). Upload the resulting CSV in the Leads tab.

**Emails found this way are unverified** — the script only finds an
address that's publicly listed on the business's own site, it doesn't
confirm it's deliverable. Run the list through an enrichment/verification
step before sending, or you risk tanking your sender reputation.

### Dedicated lead databases (Clay, etc.)

Tools like [Clay](https://clay.com) (and the 150+ data providers it
connects to, e.g. Open Mat) generally return faster, pre-verified results,
especially for niche audiences that aren't well indexed on the web.
Export to CSV and upload the same way.
