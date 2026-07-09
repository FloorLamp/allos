<p align="center">
  <img src=".github/allos-logo.svg" alt="Allos" width="240" />
</p>

<h1 align="center">Allos</h1>

<p align="center"><em>allostasis</em> (n.) — the body's way of maintaining stability <em>through</em> change: continually adjusting heart rate, hormones, and metabolism to meet whatever the day demands. Not a fixed set point, but balance kept in motion.</p>

**Allos** is a self-hosted health tracking and coaching app for you and your family — login-gated and multi-profile — built with **Next.js** (App Router) and a **SQLite** backend. It brings your whole health picture into one place — day-to-day activity, body metrics, and supplements alongside a full medical record of labs, biomarkers, immunizations, and scans that you can import straight from MyChart, Epic, or Apple Health — so you can see it together and steer it.

## Features

- **Timeline** — day-by-day health history across activity, body metrics, labs, medications, documents, visits, and goals
- **Training** — workout history, goals, strength analysis, cardio records, sport summaries, and per-exercise history
- **Trends** — charts and analysis in one place, tab by tab: **Body** (weight, body fat %, resting heart rate, plus a **Log vitals** quick-add for blood pressure, glucose, SpO₂, temperature, sleep, and HRV — the same measures the Health Connect exporter syncs, so manual and synced readings share one home), **Fitness**, **Biomarkers** (including a **Trajectory watch** that warns before a reading crosses a line — a value projected to cross its reference/optimal boundary, a persistent non-optimal pattern, or a fast decline/rise), **Compare**, and Claude-powered **Insights** (daily analysis of your activity, metrics, and goals)
- **Goals** — set targets, track progress bars, mark achieved/archived
- **Benchmarks** — estimated 1-rep maxes (Epley) and strength standards relative to bodyweight
- **Medical** — vitals, labs, genomics, biomarkers, conditions, allergies, procedures, family history, immunizations, visits, a Passport summary, and an offline **Emergency Card**. Standard **derived indices** (Non-HDL cholesterol, triglyceride/HDL ratio, HOMA-IR, and race-free CKD-EPI 2021 eGFR) are computed from your existing labs and shown alongside them, marked "derived" with their formula (eGFR/HOMA-IR only appear when the needed labs and age/sex are on file)
- **Immunizations** — record vaccines and doses, track them against the CDC schedule (due / overdue / up to date), and see immunity titers pulled from your labs
- **Health-record import** — pull immunizations, labs, and vitals straight from a MyChart “Download Summary” (CCD/XDM), a SMART Health Card, or an Epic / Apple Health FHIR bundle
- **Supplements & medications** — schedule intake and check it off each day, with adherence and refill tracking
- **AI activity log** — every AI call and failure recorded to a file and streamed live in Settings → AI logs
- **Audit log** — a durable record of who accessed or modified which profile's data (logins in/out, profile switches, medical-file and share-link views, document uploads/deletes, and admin/family changes), reviewable with filters under **Settings → Audit** (admin only); identifiers only, never medical content, retained 90 days
- **Data hub** — bring data in (upload documents, paste logs, connect a device or service) under **Data → Import**, review what background integrations synced under **Data → Review** (recent imports, plus any integration that's currently failing — surfaced with a badge on the profile menu; admins can also expand a per-sync **View raw** to inspect the exact provider payload), then browse and export everything you've logged under **Data → Manage & Export**; integrations available today are **Google Health Connect** and **Strava** (Garmin planned)

## Emergency card (offline)

**Medical → Emergency Card** is a terse, printable summary of the facts a first
responder needs when you can't speak for yourself: allergies (worst first),
active medications with doses, major conditions, blood type, and an emergency
contact — with an "as of" date so a reader knows how fresh it is. It reuses the
same records as the Passport, so it never disagrees with them. Print it with the
**Print** button (it has its own print stylesheet).

Because the moment you most need it is often the moment you have no signal, the
card can be kept **offline**: enable **Settings → Profile → Emergency card → "Keep
an offline copy on this device"** and the card is cached (in this browser's
localStorage) on each visit while online, so it stays readable with no network.
When you're offline, the app's reconnect screen offers a **View emergency card**
button instead of dead-ending.

Offline caching is **off by default** and strictly opt-in, per profile: a cached
card is readable on that device _without logging in_ — which is the whole point in
an emergency, but also the trade-off if the phone is lost while unlocked. The
offline copy is wiped automatically on logout and when you switch profiles, and it
refreshes on your next online visit so a medication or allergy change propagates.
Set your blood type and emergency contact on **Settings → Profile → Emergency
card** (the blood type there overrides one derived from lab records).

## Requirements

- **Node.js ≥ 24** (Next.js 14 requires ≥ 18.17; this repo is pinned to Node 24 via `.nvmrc`)

```bash
nvm use            # picks up Node 24 from .nvmrc
```

## Setup

```bash
npm install        # install dependencies
npm run seed       # (optional) load ~3 weeks of realistic sample data
npm run dev        # start the dev server at http://localhost:3000
```

The SQLite database is created automatically at `data/allos.db` on first run
(the `data/` directory is gitignored). Delete that file to start fresh.

## Signing in

The app is login-gated and multi-user. On first boot it creates a single **admin
login** and a matching **profile**. Set **`ADMIN_PASSWORD`** (and optionally
**`ADMIN_USERNAME`**, default `admin`) before that first boot to choose the
credentials; if you don't set a password, a random one is generated and printed
to the log **once** — capture it from the console/`docker logs`.

> **Which log?** The bootstrap runs in whichever process opens the database
> first. In the Docker setup that is usually the **notify sidecar** (it opens
> the shared DB at startup, while the web app only touches it on its first
> request) — so if the password isn't in the app container's log, check
> `docker logs allos-notify`. After logging in, change the password in
> Settings → Preferences so the logged value stops mattering.

Two concepts:

- **Logins** are login identities (username + password). Roles are **admin** or
  **member**; admins can access every profile and the admin screens.
- **Profiles** are the people whose data is tracked. A profile needs no login —
  adding a family member (e.g. a kid) is just a name.

Once signed in as an admin, manage everyone under **Settings → Family**: add or
rename profiles, create logins, reset passwords, and grant each member login
access to specific profiles (admins see all automatically). Any login can
change its own password under **Settings → Preferences**.

## Configuration

Configuration is read from environment variables. The easiest way is a
**`.env.local`** file in the project root — it is loaded automatically by both
the app and the `npm run seed` script, and is gitignored:

```bash
cp .env.example .env.local   # then edit in your values
```

| Variable               | Description                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_USERNAME`       | Optional. Username for the bootstrap admin login created on first boot (default `admin`). Read only when no login exists yet.                                                               |
| `ADMIN_PASSWORD`       | Password for the bootstrap admin login. If unset on first boot, a random one is generated and printed to the log **once** — capture it. Read only when no login exists yet.                 |
| `ANTHROPIC_API_KEY`    | Enables Claude-powered insights and medical-document extraction. Optional when `AI_BASE_URL` points at a local server that ignores keys.                                                    |
| `AI_BASE_URL`          | Optional. Point the app at a self-hosted / local inference server exposing an Anthropic-compatible API (Ollama, a proxy, …) for zero external egress. Set alone, or with a key it forwards. |
| `HEALTH_AI_MODEL`      | Optional. Override the AI model (defaults to `claude-sonnet-4-6`).                                                                                                                          |
| `HEALTH_AI_MAX_TOKENS` | Optional. Max output tokens for document extraction (default `16000`).                                                                                                                      |
| `LOG_LEVEL`            | Optional. `debug`/`info`/`warn`/`error` (default `info`).                                                                                                                                   |
| `LOG_FORMAT`           | Optional. `text` or `json`. Defaults to `text` in dev, `json` in prod.                                                                                                                      |
| `AI_LOG_PROMPTS`       | Optional. Set `0` to keep prompts/responses out of the AI activity log.                                                                                                                     |
| `PORT`                 | Optional (Docker). Host port to expose (container listens on `3000`).                                                                                                                       |
| `TZ`                   | Optional. Timezone is DB-backed — the instance default under **Settings → Server**, per-profile under **Settings → Profile**; a `TZ` env only seeds the instance default on first boot.     |
| `DATA_DIR`             | Optional (Docker). Host path for persistent data — see **Deploy with Docker**.                                                                                                              |

You can also `export` these directly instead of using a file.

## Logging & the AI activity log

The app logs to stdout/stderr via a small leveled logger (`LOG_LEVEL`,
`LOG_FORMAT`), so `docker logs` captures everything. Every AI call (extraction,
suggestions, insights) and its outcome is also appended to
`data/logs/ai.jsonl` — readable directly on the host and streamed live in
**Settings → AI logs**. Failures surface there (and inline where you triggered
them), not just in the console.

For debugging integration syncs, each sync can capture the raw provider payload
(the Health Connect POST body, the Strava activity JSON) under
`data/integration-payloads/<profileId>/`. These are byte-capped, retained
newest-N per provider, and gitignored (part of `/data`). They're **admin-only**
and profile-scoped: expand **View raw** on a sync in **Data → Review** to fetch
one through an admin-gated route — members never see the affordance or the data.

## AI Insights

Insight generation works out of the box with a built-in offline summary. Set
`ANTHROPIC_API_KEY` (see **Configuration**) to enable **Claude-powered**
coaching analysis, then use **Trends → Insights → Generate analysis**.

Uploaded medical documents (**Data → Import**) are extracted into
structured records by the same API; without a key the file is still stored but
extraction is skipped.

### Local / self-hosted inference (zero external egress)

For a fully private setup, point the app at a **local inference server** that
exposes an Anthropic-compatible API (Ollama and others, or a translating proxy)
by setting `AI_BASE_URL` (e.g. `http://localhost:11434`). Then **no request ever
leaves your machine beyond that endpoint** — the SDK talks only to the configured
base URL. Local servers usually ignore the API key, so `ANTHROPIC_API_KEY` is
optional when `AI_BASE_URL` is set (a placeholder is sent to satisfy the SDK);
AI counts as configured when **either** is present.

The endpoint and model are **environment-driven only** — the active endpoint,
model, and configured/offline status are shown read-only under **Settings →
Server → AI** (not editable in the UI, so no endpoint or credential is stored in
the database). Each entry in the AI activity log is tagged with the backend host
so you can tell which endpoint produced it.

Quality trade-off: coaching **insights** and supplement **suggestions** work
well on capable local models, but **medical-document extraction** is demanding
(long documents, structured tool output) — a small local model may extract less
reliably than Claude. Everything still degrades gracefully: with neither
`ANTHROPIC_API_KEY` nor `AI_BASE_URL` set, insights fall back to the offline
summary and uploads are stored but not extracted.

## Integrations

Connect outside services under **Data → Import** so your health data syncs
automatically. Each provider has its own setup page (linked from the Import tab's
"Connect a device or service" card). **Google Health Connect** and **Strava** are
available today; **Garmin** is scaffolded as "coming soon".

### Google Health Connect

Health Connect is an Android **on-device** API, so data leaves the phone via an
exporter app that POSTs to this app. The integration is **push-based**: you enable
an authenticated ingest endpoint here and point the exporter at it.

1. Go to **Data → Import → Google Health Connect** and click **Generate token &
   enable**. The page shows your **Endpoint URL** and **Bearer token**.
2. Install [Health Connect Webhook](https://github.com/mcnaveen/health-connect-webhook)
   on your phone (Android 14+, with Health Connect installed) and grant it the
   health permissions you want to sync.
3. In the app, add a webhook with the **Endpoint URL** and an `Authorization:
Bearer <token>` header, then pick a sync schedule (a 15–60 min interval and/or
   fixed times). Each sync sends new records from a rolling 48-hour window.
4. Tap **Sync Now** to test.

**What gets imported** (mapped from the app's native payload):

| Health Connect data                                                 | Where it lands                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Weight                                                              | **Trends → Body** (one imported weigh-in per day)                                                                          |
| Body fat, resting HR                                                | **Trends → Body** charts (kept lossless even on days without a weigh-in)                                                   |
| Steps, distance, calories                                           | **Trends → Body** charts (daily totals)                                                                                    |
| Sleep                                                               | **Trends → Body** charts: total per night + a stacked deep/REM/light/awake stage breakdown (attributed to the wake-up day) |
| Heart rate (continuous)                                             | Bucketed to 1-minute averages → daily + intraday HR charts                                                                 |
| Heart rate variability                                              | Stored per day                                                                                                             |
| Exercise sessions                                                   | **Training history** (cardio or sport activities)                                                                          |
| Blood pressure, glucose, SpO₂, body temp, respiratory rate, VO₂ max | **Medical / Biomarkers** (with reference-range flags)                                                                      |
| Lean mass, bone mass, BMR, height                                   | **Trends → Body** charts (height also drives a BMI chart)                                                                  |
| Hydration                                                           | **Trends → Body** chart (liters/day)                                                                                       |
| Nutrition                                                           | **Trends → Body** charts: calories + a protein/carbs/fat macros breakdown                                                  |

Ingest is **idempotent**: the rolling 48-hour window means records are resent, so
imports dedup on natural keys (time windows) and never double-count. Manually
entered rows are never overwritten by a sync.

The token is normally managed in the UI (Data → Import → Google Health Connect),
where you can **rotate** it in one click, set an optional **expiry** (90 days / 1
year / never), and see when it was **last used**. `HEALTH_CONNECT_TOKEN` is a
**headless-bootstrap-only fallback** (see `.env.example`) that maps to profile 1;
it has no expiry, rotation, or last-used tracking, so prefer generating a
DB-backed token in the UI once the app is reachable. **Keep the token secret** —
anyone with it can post data to your instance.

The calendar `.ics` subscribe feed (Data → Integrations → Calendar feed) shares
the same lifecycle controls — rotate the link, set an optional expiry, and see the
last fetch time. Rotating either token immediately invalidates the previous one,
and an expired token is rejected exactly like an invalid one.

### Strava

Connect once with OAuth and your runs, rides, and other activities sync
automatically — with heart rate, elevation, pace, calories, and cycling
power/cadence.

1. Create an API application in your [Strava API settings](https://www.strava.com/settings/api)
   to get a **Client ID** and **Client Secret**.
2. Set the shared **Settings → Server → Public app URL** — it's used to build
   Strava's OAuth redirect (the callback carries your session cookie, so it must
   be the URL you're signed in on).
3. Go to **Data → Import → Strava**, enter the Client ID and Secret, then click
   **Connect with Strava** and authorize.
4. Hit **Sync now** to pull recent activities; new ones sync automatically
   afterward. Manually entered rows are never overwritten.

## Deploy with Docker

Run the app as a container with Docker + Compose. By default Compose **pulls a
pre-built image** from the GitHub Container Registry
(`ghcr.io/floorlamp/allos`) — the deploy box never builds:

```bash
cp .env.example .env          # set ANTHROPIC_API_KEY, DATA_DIR, …
docker login ghcr.io          # only if the package is private
docker compose up -d --pull always  # pull + start
```

Pin a specific build by exporting `IMAGE` (defaults to `:latest`):

```bash
IMAGE=ghcr.io/floorlamp/allos:<git-sha> docker compose up -d --pull always
```

To **build from source** locally instead of pulling, layer on the build
override:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The app is served at `http://localhost:3000` (set `PORT` to change the host
port). The SQLite schema is created automatically on first boot — no migration
step. On the very first boot set **`ADMIN_PASSWORD`** in `.env` so you know the
admin login; if you don't, a random one is printed **once** to the logs (usually
the `allos-notify` container’s — see **Signing in**).

**Persistent data.** The SQLite DB, uploaded documents, and the AI log live
under `/app/data` in the container, bind-mounted from `DATA_DIR` (default
`./data`) so they're directly readable on the host. No manual `chown` is needed:
the container starts as root, the entrypoint chowns the data dir to the app user
(uid `1000`), then drops privileges. Files written there end up owned by `1000`.

Prefer a managed **named volume** if you don't need direct host access — see the
commented block in `docker-compose.yml`.

### Published images

`.github/workflows/deploy.yml` builds the image on every push to `main` (and via
a manual **Run workflow**) and pushes it to GHCR as `ghcr.io/<owner>/<repo>`,
tagged with both `:latest` and the commit `:<sha>`, authenticating with the
built-in `GITHUB_TOKEN` (no extra registry secret). The in-image `next build`
(which runs tsc) is the CI gate: a type error fails the job and nothing is
pushed, so the published `:latest` always builds cleanly.

Deploying is up to you: on the box, `docker compose pull && docker compose up -d`
picks up the new `:latest` (pin a `:<sha>` tag instead for a fixed version). Run
it by hand or from a host cron/systemd timer. If the GHCR package is private,
`docker login ghcr.io` with a token that has `read:packages` first.

## Notifications

Reminders (supplements due in a window, and a workout nudge when you're behind on a
weekly target) are delivered over Telegram. Configure the bot token and mode under
**Settings → Server** (global, admin-only); enable notifications, set the chat id,
and choose per-slot send times per person under **Settings → Profile**.

One-tap "✅" buttons reach the app one of two ways (pick under **Button taps**):

- **Polling** (default) — the notify service long-polls Telegram's `getUpdates`, so it
  works without the app being publicly reachable. The Docker `allos-notify` service
  runs the poller automatically; without Docker, keep `npm run notify -- poll` running.
- **Webhook** — Telegram POSTs taps to `<public URL>/api/telegram/webhook`. Set the
  shared **Settings → Server → Public app URL** (also used for Strava OAuth callbacks
  and the Health Connect ingest endpoint), then register the webhook from
  **Settings → Server**. Telegram requires HTTPS.

Sending is driven by a tick that runs **every hour**. Each tick sends whatever is scheduled
for the current hour (supplement windows at their configured hours; the workout reminder on
your inferred training days/time) and not already sent today, deduped per day/slot so a retry
never double-sends. Timing follows the per-profile timezone you pick in **Settings → Profile**
(stored in the DB and shared with the notifier; new profiles inherit the **Settings → Server**
instance default), defaulting to UTC until set.

**Docker (default):** the `allos-notify` service in `docker-compose.yml` runs the tick on the hour
automatically — no host crontab needed — and keeps the Telegram button-tap poller running
alongside it (idle unless polling mode is selected). It shares the app's image and database; bring it up
with the rest of the stack (`docker compose up -d`). Remove that service if you'd rather drive
the tick yourself.

**Without Docker / external scheduler:** add an hourly cron entry instead:

```cron
0 * * * * cd /app && npm run notify
```

Manual sends for testing: `npm run notify -- morning|midday|evening|bedtime|workout` (in the running
container: `docker compose exec allos-notify node dist/notify.cjs workout`).

## Backups

The hourly tick takes a **nightly SQLite snapshot** of the database via
`VACUUM INTO` (a compact single-file copy, safe against the live connection).
Configure it in **Settings → Server → Automated backups** (admin only): enable/disable,
the hour (in the instance timezone), and retention (keep _N_ dailies + _M_ weeklies,
default 7/8). Snapshots are written to `data/backups/allos-<YYYY-MM-DD-HHmm>.db`, older
ones are pruned only after a successful new snapshot, and the card shows the last backup's
time/size (plus any failure) with a **Back up now** button.

**Integrity verification.** Each fresh snapshot is opened read-only and checked with
`PRAGMA integrity_check`; the result is written to a JSON sidecar next to it
(`allos-<stamp>.db.json`). A snapshot that **fails** the check is kept for forensics but is
**not** counted as a successful backup and older good snapshots are **not** pruned, so a
corrupt copy never rotates a healthy one away. The same tick also runs a **weekly**
`integrity_check` on the live database (gated by a stored marker), logging the result loudly
on failure.

Snapshots live under `DATA_DIR` (the Docker bind mount, outside the checkout) and are
**never served by any route** — they contain multi-profile health data.

> **Uploads caveat:** uploaded medical files (`data/uploads/`) and captured integration
> payloads (`data/integration-payloads/`) live on disk, _not_ in the database, so the
> snapshot does **not** include them. For a complete backup, copy the whole `DATA_DIR`
> (database + `uploads/` + `integration-payloads/`).

### Scheduling without the notify sidecar

Backups are driven from the hourly notify tick by default. If you removed the notify
sidecar, drive them with the standalone entrypoint instead — it applies the same
schedule/retention/verification and is safe to run hourly by cron:

```cron
0 * * * * cd /app && npm run backup
```

`npm run backup -- now` forces an immediate (verified) snapshot regardless of the schedule.

### Restore

Use the restore tool (`npm run restore`) — it lists snapshots with their integrity status,
verifies the chosen one before trusting it, copies the current live DB aside as a rollback
(`allos.db.pre-restore-<timestamp>`), then copies the snapshot into place and clears any
stale `-wal`/`-shm` sidecars.

```bash
npm run restore                       # list snapshots + integrity status
npm run restore -- allos-<stamp>.db   # restore that snapshot (prompts to confirm)
npm run restore -- allos-<stamp>.db --yes    # skip the confirmation prompt
npm run restore -- allos-<stamp>.db --force  # also override safety refusals
```

**Stop the container/app before restoring.** The tool makes a best-effort check for a live
DB connection and refuses if it detects one, but in WAL mode an _idle_ connection may not be
detected, so always stop the app first. `--force` overrides both the running check and a
failed-integrity refusal. Restore `data/uploads/` too if you're recovering from a
full-directory backup.

You can still restore by hand if you prefer: stop the container, `cp
data/backups/allos-<stamp>.db data/allos.db`, delete any `data/allos.db-wal` /
`data/allos.db-shm`, and start it again.

### Health endpoint

The container healthcheck hits `GET /api/health`, which probes both that the DB is
**readable** and that `data/` is **writable** (a full or read-only disk answers reads but
fails writes). It returns `{ status, reason?, lastBackupAgeHours }` and flips to HTTP **503**
(`status: "degraded"`) when a probe fails, so the Docker healthcheck marks the container
unhealthy. `lastBackupAgeHours` reports hours since the last successful backup (null when
never backed up), so a stalled schedule is visible.

## Scripts

| Command            | Description                                        |
| ------------------ | -------------------------------------------------- |
| `npm run dev`      | Start the development server                       |
| `npm run build`    | Production build                                   |
| `npm start`        | Run the production build                           |
| `npm run seed`     | Seed the database with sample data                 |
| `npm run notify`   | Send due notifications for the current hour (cron) |
| `npm test`         | Pure unit tests (vitest)                           |
| `npm run test:e2e` | Playwright browser tests (isolated seeded DB)      |

## Tech

- Next.js 14 (App Router, Server Actions)
- better-sqlite3 (synchronous SQLite, schema auto-migrated on boot)
- Tailwind CSS
- Recharts for charts
- @anthropic-ai/sdk for AI insights

## License

Allos is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
See [LICENSE](LICENSE) for the full text.
