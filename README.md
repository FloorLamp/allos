<p align="center">
  <img src=".github/allos-logo.svg" alt="Allos" width="240" />
</p>

<h1 align="center">Allos</h1>

<p align="center"><em>allostasis</em> (n.) — the body's way of maintaining stability <em>through</em> change: continually adjusting heart rate, hormones, and metabolism to meet whatever the day demands. Not a fixed set point, but balance kept in motion.</p>

**Allos** is a self-hosted health tracking and coaching app for you and your family — login-gated and multi-profile — built with **Next.js** (App Router) and a **SQLite** backend. It brings your whole health picture into one place — day-to-day activity, body metrics, and supplements alongside a full medical record of labs, biomarkers, immunizations, and scans that you can import straight from MyChart, Epic, or Apple Health — so you can see it together and steer it.

## Features

- **Dashboard** — your health at a glance, attention-first. A pinned **Needs attention** banner leads every visit with one severity-ordered strip (**Overdue / Today / This week / For review**) that merges everything needing you today — due doses, newly-flagged labs, low supply, upcoming appointments, care-plan items, failing integrations, and review-inbox items — rendered from the same signals the Telegram digest and the **Upcoming** list use, so nothing drifts; snooze or dismiss any item right there (it stays hidden on Upcoming and in the digest too), and an empty banner is a quiet "all clear". Below it, a login that reaches more than one profile gets a **household strip** of their other people with a per-profile attention count, one tap to switch and view. The rest is a **customizable widget grid** — reorder and show/hide per profile (the banner itself can't be hidden) — surfacing medical differentiators (**recent labs**, **next appointment**, **care plan due**) alongside fitness widgets and the coaching next-workout suggestion; a widget whose domain has no data yet shows a one-tap **setup CTA** (import labs, connect Health Connect, add an appointment) so the dashboard doubles as the onboarding checklist. A **Healthspan pillars** widget surfaces a row of evidence-backed longevity signals — VO₂ Max percentile, sleep regularity, biological age, and the share of tracked biomarkers in their **optimal** range ("31 of 38 markers optimal") — deliberately as separate pillars (never a single invented score); each pillar deep-links to its detail surface and appears only when its data exists
- **Timeline** — day-by-day health history across activity, body metrics, labs, medications, documents, visits, goals, protocol start/end, and milestones
- **Protocols** — run an **N-of-1 experiment**: name a dated intervention (creatine, a sauna block, Zone 2 emphasis, time-restricted eating), pick the **outcome metrics** you care about (any tracked biomarker, resting HR / weight / body-fat, or a derived index like **PhenoAge** or the **Sleep Regularity Index**), and Allos compares a **baseline window** against the **intervention window** on its detail page — an honest mean/median shift with the n per window ("resting HR −3.2 bpm vs the 8 weeks prior"), no p-value theater; sparse labs fall back to the nearest draw before/during. Starting a protocol can **activate a situation** (reusing the supplements situations wiring so its situational stack surfaces), and start/end land on your **Timeline**. A protocol's delete/end reverses that situation activation. Informational only, not medical advice
- **Upcoming** — one forward-looking list of everything due soon, bucketed by urgency (**Overdue / Today / This week / Later**): supplement/medication doses, low refills, **supplement intake-limit** warnings (a nutrient whose stack total exceeds its NIH upper limit), scheduled appointments, **planned care** (provider-ordered or manually entered **care-plan items** with a planned date — e.g. an imported "colonoscopy in March" — surfaced from the **Care plan** page, with an inline **Mark done** that completes the item), **preventive well-visits & screenings** (age/sex-appropriate checkups and screenings from curated general guidelines — mark one **done**, or set it **not applicable** / **declined**, or hit **Book** to open the appointment form prefilled with the visit's reason, kind, and a suggested date — informational only, and shown only once a birthdate is on file; a matching record already on file **satisfies a screening/visit automatically** — a coded or named colonoscopy/mammogram/DEXA, a lab result (cholesterol, A1c, glucose), a blood-pressure reading, or a completed physical/dental/eye visit is detected and clears the reminder without a manual mark-done; once you **book a matching visit** (an appointment whose **Kind** matches — e.g. a dental appointment for the dental reminder) the item quiets to a **Scheduled** state instead of nagging, and completing that kind-tagged visit offers to record the preventive care as done; the smoking-related screenings (low-dose CT lung screening, abdominal aortic aneurysm ultrasound) activate once a **smoking history** is recorded under **Settings → Profile → Smoking history**, seeded automatically from an imported CCD's tobacco status), immunizations due, biomarker retests, goal deadlines, and training targets. Any item can be **snoozed** or **dismissed** (and restored later), and the same list feeds the optional Telegram "what's due" digest and the calendar feed
- **Training** — workout history, goals, strength analysis, cardio records, sport summaries, and per-exercise history; a workout's **⋯ → Merge with…** menu folds two of that day's activities into one for duplicates no auto-detector caught (undoable) — and when the two genuinely disagree on a field (e.g. duration 42 vs 51 min) a quick preview lets you pick which value to keep per field. Manually logged activities also get an **estimated calorie burn** — computed from a baked MET (metabolic-equivalent) table, the activity's type/intensity/duration, and your nearest bodyweight — which auto-fills on the activity form (editable, so you can override it) and rolls into the weekly recap; it's always shown as an estimate (`≈`) and kept separate from device-measured calories (imported activities keep their device value)
- **Trends** — charts and analysis in one place, tab by tab: **Body** (weight, body fat %, resting heart rate, plus a **Log vitals** quick-add for blood pressure, glucose, SpO₂, temperature, sleep, and HRV — the same measures the Health Connect exporter syncs, so manual and synced readings share one home — and for the **functional-fitness markers** grip strength (kg), 30-second chair-stand (reps), and single-leg balance (seconds)), **Fitness** (a GitHub-style **workout-density heatmap** — one cell per day over the trailing 12 months, shaded by how many sessions you logged, with each active day deep-linking to its Timeline view; plus strength/cardio/sport progress and a **training-intensity distribution** — weekly heart-rate-zone minutes, weekly **Zone 2** volume vs a configurable target, and the easy/hard **polarization split**, computed from per-minute HR scoped to your workout windows; zones use Karvonen heart-rate-reserve when a resting HR is known, else % of max HR, with the formula shown and a manual max-HR override in **Settings → Profile**), **Biomarkers** (including a **Trajectory watch** that warns before a reading crosses a line — a value projected to cross its reference/optimal boundary, a persistent non-optimal pattern, or a fast decline/rise, plus an optional AI **lab-trend interpretation** that reads recent movements against your medications and conditions; **VO₂ Max and the functional-fitness markers** — grip strength, chair-stand, single-leg balance — also get an **age/sex percentile** and an inverse **fitness age** on the biomarker detail page and inline in the Biomarkers table, computed from published population norms — VO₂ Max from the **FRIEND registry** (Kaminsky et al., _Mayo Clin. Proc._ 2015), grip strength from **Dodds et al.** (_PLoS ONE_ 2014), chair-stand from the **Rikli & Jones** Senior Fitness Test, and balance from **Springer et al.** (_J. Geriatr. Phys. Ther._ 2007) — baked into `lib/fitness-norms.json` (regenerated with `npm run gen:fitness-norms`); informational only, and shown only for an adult profile with sex and birthdate on file), **Compare**, and Claude-powered **Insights** (a daily analysis of your activity, metrics, and goals, plus **weekly/monthly recap** narratives)
- **Household** — for any login that can reach more than one profile (an admin, or a caregiver **member** granted several profiles), a cross-profile overview: one card per person showing today's **attention items** — supplement/medication doses due, low refills, and the next scheduled visit — alongside at-a-glance stats. **Confirm** a due dose for anyone straight from their card **without switching profiles** (the button shows only where you have write access; a read-only grant sees the card but no actions), or tap a card to open that profile. Hidden for single-profile logins.
- **Goals** — set targets, track progress bars, mark achieved/archived
- **Benchmarks** — estimated 1-rep maxes (Epley) and strength standards relative to bodyweight
- **Medical** — vitals, labs, genomics, biomarkers, conditions, allergies, procedures, family history, immunizations, visits, a Passport summary, and an offline **Emergency Card**. Standard **derived indices** (Non-HDL cholesterol, triglyceride/HDL ratio, HOMA-IR, race-free CKD-EPI 2021 eGFR, and Levine **PhenoAge** — a biological-age estimate in years) are computed from your existing labs and shown alongside them, marked "derived" with their formula (eGFR/HOMA-IR/PhenoAge only appear when the needed labs and age/sex are on file; PhenoAge requires a full nine-analyte draw and an adult profile). PhenoAge is also surfaced as a **biological-age card** pinned above the Biomarkers table: your estimated biological age, how it compares to your calendar age (younger is better), your pace of aging across draws, and the nine inputs it's built from — with a checklist prompt when the panel is incomplete. It's framed as a population-level estimate (Levine 2018, NHANES-validated adults ~20–84), is hidden for child profiles, and is also available as an opt-in **Biological age** dashboard widget (Customize)
- **Allergies** — documented allergies merged with allergen-specific IgE sensitizations detected from your labs (RAST / ImmunoCAP), plus informational **cross-reactivity** notes from a curated reference dataset of well-established families (birch-pollen oral allergy syndrome, latex-fruit, crustacean/mollusk shellfish, cashew-pistachio & walnut-pecan tree nuts, mammalian milk). Shown on the Allergies page and the Passport, framed as "commonly cross-reacts with" — reference only, never a diagnosis
- **Immunizations** — record vaccines and doses, track them against the CDC schedule (due / overdue / up to date), and see immunity titers pulled from your labs
- **Health-record import** — pull immunizations, labs, and vitals straight from a MyChart “Download Summary” (CCD/XDM), a SMART Health Card, or an Epic / Apple Health FHIR bundle
- **Supplements & medications** — schedule intake and check off each dose as **taken**, **skipped**, or clear (a tri-state — a deliberate skip is a decision, not a missed dose), with adherence and refill tracking. Skips are excluded from the adherence percentage and shown as their own count, never decrement your on-hand supply, and never trigger a missed-dose escalation; each reminder (web and Telegram) offers a **✅ take** and a **⏭ skip** beside each dose. The page also checks your **stack totals against safe upper limits** — it sums the active stack's daily dose per nutrient (across products, e.g. two magnesium forms) and warns when a total exceeds the NIH **Tolerable Upper Intake Level (UL)** for your age/sex ("800 mg supplemental magnesium/day — the UL is 350 mg"), respecting whether each UL is defined over _supplemental_ intake (magnesium, niacin, folic acid) or _total_ intake from all sources (vitamin A, D, calcium, iron). It's informational ("discuss with your clinician", never prescriptive) and the same warning surfaces as a dismissible **Upcoming** finding. Reference values are a baked, public-domain dataset from the NIH Office of Dietary Supplements / National Academies DRI tables (`lib/dri.json`, regenerated with `npm run gen:dri`)
- **Undo delete** — deleting an activity, body-metrics entry, biomarker record, or supplement/medication offers a one-tap **Undo** toast; the row (and its children) is held for 24 hours and restored intact if you undo, then purged
- **AI activity log** — every AI call and failure recorded to a file and streamed live in Settings → AI logs
- **Audit log** — a durable record of who accessed or modified which profile's data (logins in/out, profile switches, medical-file and share-link views, document uploads/deletes, and admin/family changes), reviewable with filters under **Settings → Audit** (admin only); identifiers only, never medical content, retained for a configurable window (default **24 months**, set under **Settings → Server → Audit-log retention**; the hourly notify tick prunes older events)
- **Data hub** — bring data in (upload documents, paste logs, connect a device or service) under **Data → Import**, then see everything that has ever imported in one place under **Data → Review**: a single chronological **feed** that merges uploaded documents, pasted/CSV jobs, and background integration syncs (each entry showing what it produced and linking to its detail/verify view — a run of routine "nothing new" syncs from a device that checks in every hour collapses into one "No new data" line so it can't drown out real imports), plus **possible duplicates** — a Strava run and a manual/Health Connect run on the same day, two same-source imports of one workout (upstream double-feeding, e.g. Strava ingesting the same session from both Garmin and Health Connect), or two body-metric rows that would double-count, detected across sources and resolved by **Merge**, **Keep both**, or **Dismiss** (Merge shows a per-field preview when the two rows disagree on a value), with the decision remembered so a later re-sync won't undo it; plus any integration that's currently failing — all surfaced with a badge on the profile menu (admins can also expand a per-sync **View raw** to inspect the exact provider payload). Finally, browse and export everything you've logged under **Data → Manage & Export** — the "Export all my data" download is one portable ZIP (every dataset as JSON + CSV, the clinical passport as a FHIR bundle, and copies of your uploaded files), captured as a consistent point-in-time snapshot; it is a **portability artifact you can read or take elsewhere, not the restore path** — restoring an instance uses the [server backups](#backups) (`npm run restore`), not this ZIP. Integrations available today are **Google Health Connect** and **Strava** (Garmin planned)

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

## Offline quick-log queue

Logging often happens exactly where the signal doesn't: a set at a gym with dead
reception, a dose on a flight, a weigh-in during an outage. For a small set of
**idempotent quick-logs** — confirming a **dose taken** or **skipped** (Supplements &
Meds), a **body-metric** weigh-in (Trends → Body), and a **vitals** entry (Trends → Body) —
the app no longer fails when you're offline: it **queues the entry on your device**
(in this browser's IndexedDB) and shows a "Saved offline — will sync when you
reconnect" confirmation plus a **pending badge** counting the queued writes.

On reconnect the queue **replays automatically** — on the browser's `online` event,
on the next page load, and (on Chromium/Android, where it's supported) via the
Background Sync API even if the tab was closed. Each queued write carries a
client-generated key and the **date you captured it**, so a late sync lands on the
right day and can never double-log: replays are applied exactly once and build on
the existing per-dose/day and per-metric dedup. If your session expired while you
were away, the queue is **kept** and you're prompted to log back in — nothing is
silently dropped. As with the emergency card, the queue is cleared on logout and
profile switch.

Everything else still needs connectivity: this is a queue for a few one-tap logs,
not a general offline mode. Forms with server-derived state (anything that reads or
computes against your existing data) stay online-only, and page navigation while
offline still shows the reconnect screen.

## Requirements

- **Node.js ≥ 24** (Next.js 15 requires ≥ 18.18; this repo is pinned to Node 24 via `.nvmrc`)

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
change its own password and turn on **two-factor authentication (2FA)** under
**Settings → Preferences**.

**Two-factor authentication (TOTP).** Any login can add a time-based one-time
code from an authenticator app (Google Authenticator, Authy, 1Password, …) as a
second step at sign-in — strongly recommended for admins. Enrolling shows an
`otpauth://` URI + manual key and, after you verify one code, **8 one-time
recovery codes** shown once (save them). At sign-in, a correct password then
prompts for a code before any session is created. Passwords must be at least 10
characters with a mix of character classes. If an admin is ever locked out (lost
authenticator **and** recovery codes), the operator can set `ALLOS_DISABLE_2FA`
(below) to bypass 2FA for that username at the next login — logged loudly and
audited.

Each grant carries an **access level**: **read & write** (the default — the
member can view _and_ edit that profile) or **read-only** (view everything, but
can't add, edit, upload, or delete). Pick the level per profile in the
**Settings → Family** access matrix. A read-only member gets a "read-only" badge
in the profile menu, and the boundary is enforced on the server — every mutating
action is rejected for a read-only grant, not merely hidden in the UI. Admins
always have full read/write on every profile.

## Configuration

Configuration is read from environment variables. The easiest way is a
**`.env.local`** file in the project root — it is loaded automatically by both
the app and the `npm run seed` script, and is gitignored:

```bash
cp .env.example .env.local   # then edit in your values
```

| Variable               | Description                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_USERNAME`       | Optional. Username for the bootstrap admin login created on first boot (default `admin`). Read only when no login exists yet.                                                                                                                                                                                        |
| `ADMIN_PASSWORD`       | Password for the bootstrap admin login. If unset on first boot, a random one is generated and printed to the log **once** — capture it. Read only when no login exists yet.                                                                                                                                          |
| `ALLOS_DISABLE_2FA`    | Optional bootstrap-recovery escape hatch. Comma-separated username(s) whose TOTP second factor is **skipped** at login (for an admin locked out after losing their authenticator + recovery codes). Every bypass is logged loudly and audited (`login.2fa-bypass`). Remove it and re-enroll once access is restored. |
| `ANTHROPIC_API_KEY`    | Enables Claude-powered insights and medical-document extraction. Optional when `AI_BASE_URL` points at a local server that ignores keys.                                                                                                                                                                             |
| `AI_BASE_URL`          | Optional. Point the app at a self-hosted / local inference server exposing an Anthropic-compatible API (Ollama, a proxy, …) for zero external egress. Set alone, or with a key it forwards.                                                                                                                          |
| `HEALTH_AI_MODEL`      | Optional. Override the AI model (defaults to `claude-sonnet-5`).                                                                                                                                                                                                                                                     |
| `HEALTH_AI_MAX_TOKENS` | Optional. Max output tokens for document extraction (default `16000`).                                                                                                                                                                                                                                               |
| `LOG_LEVEL`            | Optional. `debug`/`info`/`warn`/`error` (default `info`).                                                                                                                                                                                                                                                            |
| `LOG_FORMAT`           | Optional. `text` or `json`. Defaults to `text` in dev, `json` in prod.                                                                                                                                                                                                                                               |
| `AI_LOG_PROMPTS`       | Optional. Set `0` to keep prompts/responses out of the AI activity log.                                                                                                                                                                                                                                              |
| `PORT`                 | Optional (Docker). Host port to expose (container listens on `3000`).                                                                                                                                                                                                                                                |
| `TZ`                   | Optional. Timezone is DB-backed — the instance default under **Settings → Server**, per-profile under **Settings → Profile**; a `TZ` env only seeds the instance default on first boot.                                                                                                                              |
| `DATA_DIR`             | Optional (Docker). Host path for persistent data — see **Deploy with Docker**.                                                                                                                                                                                                                                       |
| `BACKUP_DEST_DIR`      | Optional. A **second mounted directory** to copy each verified snapshot to (and mirror `data/uploads/` to), so backups survive loss of the `DATA_DIR` volume — see **[Backups → Off-volume backups](#off-volume-backups-backup_dest_dir)**.                                                                          |

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

Beyond the single-day insight, two AI **narratives** read across your history:

- **Weekly / monthly recap** (**Trends → Insights**) — a narrative of your
  training, adherence, and body-metric trends over the last week or month,
  grounded in the same recap facts the dashboard **Weekly recap** card shows.
- **Lab-trend interpretation** (**Trends → Biomarkers**) — an optional read of
  your recent biomarker movements _in context_ (medication start/stop dates and
  conditions), so a change reads as "LDL up since the statin was stopped" rather
  than a bare number. Observations, not diagnoses — it points you at what to
  raise with a clinician.

Both are stored (like daily insights) and regenerate on demand. Without a key
they fall back to a deterministic offline summary. Their per-profile daily cap is
`AI_DAILY_NARRATIVE_LIMIT` (default 30).

Uploaded medical documents (**Data → Import**) are extracted into
structured records by the same API; without a key the file is still stored but
extraction is skipped. Each upload then appears in the **Data → Review** feed —
click through to verify what it produced, reprocess it, or see the extraction
error.

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

| Health Connect data                                                 | Where it lands                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weight                                                              | **Trends → Body** (one imported weigh-in per day)                                                                                                                              |
| Body fat, resting HR                                                | **Trends → Body** charts (kept lossless even on days without a weigh-in)                                                                                                       |
| Steps, distance, calories                                           | **Trends → Body** charts (daily totals)                                                                                                                                        |
| Sleep                                                               | **Trends → Body** charts: total per night + a stacked deep/REM/light/awake stage breakdown (attributed to the wake-up day), plus a **Sleep Regularity Index** card (see below) |
| Heart rate (continuous)                                             | Bucketed to 1-minute averages → daily + intraday HR charts                                                                                                                     |
| Heart rate variability                                              | Stored per day                                                                                                                                                                 |
| Exercise sessions                                                   | **Training history** (cardio or sport activities)                                                                                                                              |
| Blood pressure, glucose, SpO₂, body temp, respiratory rate, VO₂ max | **Medical / Biomarkers** (with reference-range flags)                                                                                                                          |
| Lean mass, bone mass, BMR, height                                   | **Trends → Body** charts (height also drives a BMI chart)                                                                                                                      |
| Hydration                                                           | **Trends → Body** chart (liters/day)                                                                                                                                           |
| Nutrition                                                           | **Trends → Body** charts: calories + a protein/carbs/fat macros breakdown                                                                                                      |

Ingest is **idempotent**: the rolling 48-hour window means records are resent, so
imports dedup on natural keys (time windows) and never double-count. Manually
entered rows are never overwritten by a sync.

### Sleep Regularity Index (SRI)

Consistency of sleep timing turns out to predict mortality risk _better than sleep
duration_ (Windred et al., "Sleep regularity is a stronger predictor of mortality
risk than sleep duration", _SLEEP_ 2023, UK Biobank; the index itself is from
Phillips et al., _Sci. Rep._ 2017). So beyond the nightly-duration chart, **Trends →
Body** shows a **Sleep Regularity Index** card once you have enough recorded nights
(a rolling 28-night window with a minimum-nights gate). The SRI runs −100 (fully
irregular) to 100 (a perfectly reproducible schedule) and measures the probability
of being in the same sleep/wake state at the same clock time on consecutive days.
Alongside it are two companions — the standard deviation of your bedtime and
wake time, and **social jetlag** (how much your mid-sleep shifts between weekdays
and weekends). All clock math is done in your **profile timezone**, so DST changes
and travel don't distort it, and missing nights are skipped (never treated as
"awake") rather than faked. The current SRI also rides the **weekly recap**.

Incoming records are also **sanity-checked**: values outside a wide physiological
envelope (e.g. a 5,000 kg weight, a 500 bpm heart rate, negative steps, an SpO₂
above 100 %) or with an implausible timestamp (before 1900 or more than a day in
the future) are dropped and counted as **skipped** in the Review feed's
"· N skipped" tally, rather than poisoning trends and coaching. A single payload
is also capped at 10,000 records (a generous ceiling above any real 48-hour batch);
an over-cap push is rejected with a `400` and a recorded sync failure.

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

**Customize what the feed contains** (per profile, right on the setup page): pick
which categories become calendar events — medical **appointments** (the default),
plus optional **doses due**, **refills running low**, **planned care**, **preventive
visits & screenings due**, **immunizations due**, **biomarker retests**, **goal
deadlines**, and **training targets** — toggle the
1-day/1-hour **reminders** on or off, and bound the **past window** and optional
**future horizon**. A **minimal ↔ full** detail switch controls PHI for every
category (minimal emits only a neutral label like "Medical appointment"; full sends
the real name/provider/reason). The in-app **Preview** mirrors exactly what a
subscribed calendar will receive at the current settings. Defaults preserve the
historical behaviour (appointments only, reminders on, 30-day past window), so an
existing subscription is unchanged until you opt in.

The same page also offers a **Family calendar** — one consolidated `.ics` feed (and
an in-app preview grouped by date) that merges the upcoming appointments of **every
profile you can access** into a single calendar, each event labeled with the
profile's name. Its token is per **login** (not per profile), so it rides the same
rotate/expiry/last-used lifecycle, and the set of profiles it exposes is resolved
**live on each fetch** from your current grants — losing access to a profile removes
it from the feed at once, and deleting the login kills the feed. Each profile keeps
its **own** detail level, so a profile set to minimal still shows only "Medical
appointment" even inside the shared feed.

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
weekly target) are delivered over two channels — **Telegram** and **Web Push** — that
share the same schedule and per-day/slot dedup. Enable either, or both; a profile with
both configured gets each reminder on both.

Beyond reminders, two opt-in retention nudges ride the same channels: a **weekly recap**
— a quiet once-a-week summary of your week (workouts + volume, PRs, supplement
adherence, a body-weight trend, and streak status), covering the same "this week" your
routine counters use per your **week mode** (a calendar week or a rolling seven days —
**Settings → Profile**), set the send day/hour under
**Settings → Profile**; and **milestone alerts** — a brief note when you cross a
milestone (your 10th/50th/100th/… workout, a 7/30/100/365-day streak, a completed goal, or
a 7/30-day adherence run). Both are rule-based and work with **no AI configured**.
Milestones are always recorded to your **Timeline** (under the **Milestone** filter)
regardless of the alert toggle. The recap is also available as an off-by-default
**Weekly recap** dashboard card (enable it from the dashboard's **Customize** control).

Newly-due **preventive care** (an age/sex-appropriate checkup or screening) also sends a
single proactive nudge, so a due mammogram/colonoscopy/lipid panel doesn't wait to be
noticed in the "what's due" digest. It's deduped **once per due episode** (not once a
day): the ping fires when an item first becomes due or overdue and stays quiet until the
item is satisfied or ages out, then re-fires when the next interval comes due. The whole
domain is a per-profile toggle — **Settings → Profile → Preventive-care reminders** (on by
default). Turning it off suppresses both the nudge and the preventive lines in the
digest; due items still appear on your **Upcoming** page either way (that's a pull view,
not a push). Informational only — not medical advice.

**Dismiss once, silence everywhere.** Snoozing or dismissing a **refill**,
**preventive-care**, or **training-target** item on the **Upcoming** page (or the
dashboard attention banner) now also silences its **push nudge**, not just the page and
digest lines — the reminder and the nudge share the same identity, so one "I've decided
about this" hides both. For the workout nudge that means dismissing every behind
training target quiets the "today's workout" reminder (a still-behind target keeps it
coming). A snooze
resumes nudging after its date; restoring the item brings the nudge back. Safety-critical
reminders are deliberately **not** silenceable this way — scheduled **dose reminders** and
**missed-dose escalations** keep firing on their own per-day dedup regardless of a page
dismissal.

### Telegram

Configure the bot token and mode under **Settings → Server** (global, admin-only);
enable notifications, set the chat id, and choose per-slot send times per person under
**Settings → Profile**.

One-tap "✅" buttons reach the app one of two ways (pick under **Button taps**):

- **Polling** (default) — the notify service long-polls Telegram's `getUpdates`, so it
  works without the app being publicly reachable. The Docker `allos-notify` service
  runs the poller automatically; without Docker, keep `npm run notify -- poll` running.
- **Webhook** — Telegram POSTs taps to `<public URL>/api/telegram/webhook`. Set the
  shared **Settings → Server → Public app URL** (also used for Strava OAuth callbacks
  and the Health Connect ingest endpoint), then register the webhook from
  **Settings → Server**. Telegram requires HTTPS.

### Web Push (browser notifications)

No Telegram account needed: subscribe a browser under **Settings → Preferences → Web
Push notifications** and reminders arrive as native OS/browser notifications, opening
the app when tapped. Notes:

- **HTTPS required.** Web Push needs a service worker, which browsers only run over
  HTTPS (or `localhost`). It works on the deployed/installed app, **not** over plain
  `http://` on a LAN IP, and not in local `next dev` (the service worker is disabled
  there).
- **Per browser, per login.** A subscription belongs to the browser you enable it on
  and to your login — enable it on each device you want notified. A subscribed browser
  receives reminders for every profile that login can access.
- **Browser support.** Chrome/Edge/Firefox (desktop + Android) and, on **iOS 16.4+**,
  Safari **only after you install the app to the Home Screen** (Add to Home Screen).
- **Zero setup.** The instance's VAPID keypair is generated automatically the first
  time anyone enables push; the private key stays on the server. Payloads carry only a
  title + short body (the same text Telegram would show) and a link — no record detail.

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
on failure **and caching the verdict** — a failed live check makes the health endpoint report
unhealthy (see [Health endpoint](#health-endpoint)) so the container healthcheck flips.

Snapshots live under `DATA_DIR` (the Docker bind mount, outside the checkout) and are
**never served by any route** — they contain multi-profile health data.

### Off-volume backups (`BACKUP_DEST_DIR`)

> **Same-volume caveat:** by default snapshots land in `data/backups` — the **same** bind
> mount as the live database. A disk or volume loss destroys the database **and** every
> snapshot together, and uploaded medical files (`data/uploads/`) aren't in a snapshot at
> all. On-volume backups are not a durability story on their own.

Set **`BACKUP_DEST_DIR`** to a **second mounted directory** — a NAS, another disk, or a
synced folder the operator controls — and after each verified snapshot the app copies it
(and its `.json` verify sidecar) there, prunes that destination to the same retention, and
**mirrors `data/uploads/`** to `BACKUP_DEST_DIR/uploads`. The uploads mirror is incremental
and append-only: because uploaded files are content-hashed and immutable, only new files are
copied each night, so it stays cheap. Keep the destination **operator-controlled** — it holds
multi-profile PHI, so no cloud/network target is wired up (mount your own if you want one).

The **Settings → Server → Automated backups** card shows whether `BACKUP_DEST_DIR` is
configured and the time of the last off-volume copy (or its last error). Off-volume failures
are recorded under their own marker and never fail the primary snapshot.

```bash
# docker-compose: mount a second host directory and point the env at it
#   volumes:
#     - "${DATA_DIR:-./data}:/app/data"
#     - "/mnt/nas/allos-backup:/backup"     # second, independent volume
#   environment:
#     BACKUP_DEST_DIR: /backup
```

> **Uploads caveat (no second mount):** without `BACKUP_DEST_DIR`, uploaded medical files
> (`data/uploads/`) and captured integration payloads (`data/integration-payloads/`) live on
> disk, _not_ in the database, so the snapshot does **not** include them. For a complete
> backup then, copy the whole `DATA_DIR` (database + `uploads/` + `integration-payloads/`).

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

# Restore from an OFF-VOLUME copy (BACKUP_DEST_DIR mirror):
npm run restore -- --from /backup                     # list snapshots on the mirror
npm run restore -- --from /backup allos-<stamp>.db    # restore one from the mirror
npm run restore -- --from                             # bare --from uses BACKUP_DEST_DIR
```

**Stop the container/app before restoring.** The tool makes a best-effort check for a live
DB connection and refuses if it detects one, but in WAL mode an _idle_ connection may not be
detected, so always stop the app first. `--force` overrides both the running check and a
failed-integrity refusal.

**Putting uploads back.** A snapshot restores only the database. When recovering from an
off-volume mirror (or any full-directory backup), also copy the uploaded medical files back
so `medical_documents` rows aren't left pointing at missing files — `--from` prints the exact
command, e.g. `cp -a /backup/uploads/. data/uploads/`.

You can still restore by hand if you prefer: stop the container, `cp
data/backups/allos-<stamp>.db data/allos.db`, delete any `data/allos.db-wal` /
`data/allos.db-shm`, and start it again.

### Health endpoint

The container healthcheck hits `GET /api/health`. It returns
`{ status, reason?, lastBackupAgeHours }` and flips to HTTP **503**
(`status: "degraded"`) for any of the following, so the Docker healthcheck marks the
container unhealthy:

- **`db-failed`** — the DB is not readable.
- **`write-failed`** — `data/` is not writable (a full or read-only disk answers reads but
  fails writes).
- **`integrity-failed`** — the cached weekly live-DB `integrity_check` (above) last found
  **corruption**. The endpoint only reads this cached verdict; it never runs the expensive
  `integrity_check` itself, so it stays cheap enough for a frequent uptime poll.
- **`backup-stale`** — backups are enabled and the newest snapshot is older than the
  staleness threshold (**48h** by default; override with the `backup_staleness_hours`
  global setting). A never-backed-up instance (fresh install, or backups just enabled) is
  **not** flagged, so this only catches a schedule that ran and then silently died.

The body stays deliberately coarse (a `status`, a single `reason`, and `lastBackupAgeHours`)
with no paths, versions, or PHI, since the endpoint is unauthenticated — details go to the
server logs. `lastBackupAgeHours` reports hours since the last successful backup (null when
never backed up).

**Notification delivery failures.** A failed Telegram/push send is also persisted as a
global marker (`notify_last_error`, cleared on the next successful send) and surfaced on
**Settings → Server → Telegram bot**, so a revoked bot token or wrong chat id is visible
instead of only appearing as a notify-tick exit code. The per-profile **Send test** button
on **Settings → Profile** is the remediation path — a successful test clears the marker.

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

- Next.js 15 (App Router, Server Actions)
- better-sqlite3 (synchronous SQLite, schema auto-migrated on boot)
- Tailwind CSS
- Recharts for charts
- @anthropic-ai/sdk for AI insights

## License

Allos is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
See [LICENSE](LICENSE) for the full text.
