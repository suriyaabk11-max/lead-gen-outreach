# Outreach Sequencer

Upload a lead list, and each lead is automatically enrolled in a 5-email
outreach sequence sent over ~7.5 weeks (52 days). Built with plain
Node.js/Express, a JSON file store (no database setup required), and Resend
for sending.

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

```bash
npm install
cp .env.example .env
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

**Persistence:** lead/log data is stored in `data/db.json` on disk. Railway's
filesystem is reset on every redeploy unless you attach a
[Railway volume](https://docs.railway.com/reference/volumes) mounted at
`/app/data` in this project. Attach one before you rely on this in
production, otherwise a redeploy will wipe your lead list. For heavier
use, swap the storage functions in `server.js` (`loadDb`/`saveDb`) for a
real database like Postgres.

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
- **Settings tab** — toggle dry run, set your from name/email/app URL,
  and send yourself a test email.
- **Logs tab** — every send attempt (or dry-run) with status and any
  error.
- A background scheduler checks every 15 minutes for leads whose next
  email is due and sends it. You can also trigger it manually from the
  Leads tab ("Run scheduler now") for testing.

## Finding leads to upload

This app only handles the outreach side. For sourcing and enriching
leads:

- A general web search/scraping approach (e.g. via an AI coding
  assistant) works reasonably well for businesses that are easy to find
  online (e.g. "dentists in Melbourne"), but emails found this way
  should be verified before sending — unverified addresses are the
  fastest way to tank your sender reputation.
- Dedicated lead databases/enrichment tools (e.g. Clay, or the data
  providers it connects to) generally return faster, more verified
  results, especially for niche audiences that aren't well indexed
  online.

Either way, export to CSV and use the upload button in the Leads tab.
