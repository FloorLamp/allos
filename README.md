<p align="center">
  <img src=".github/allos-logo.svg" alt="Allos" width="240" />
</p>

<h1 align="center">Allos</h1>

<p align="center"><em>allostasis</em> (n.) — the body's way of maintaining stability <em>through</em> change: continually adjusting heart rate, hormones, and metabolism to meet whatever the day demands. Not a fixed set point, but balance kept in motion.</p>

**Allos** is a self-hosted health tracking and coaching app for you and your family — login-gated and multi-profile — built with **Next.js** (App Router) and a **SQLite** backend. It brings your whole health picture into one place — day-to-day activity, body metrics, and supplements alongside a full medical record of labs, biomarkers, immunizations, and scans that you can import straight from MyChart, Epic, or Apple Health — so you can see it together and steer it.

## Philosophy

Five commitments run through every feature. They explain most of Allos's design decisions, and they're the contract you can hold it to:

1. **Health is steering, not scoring.** Allostasis is balance kept in motion, and the app is built around that idea: it shows real signals side by side — labs, training, sleep regularity, the inputs to a biological-age estimate — and never collapses them into a single invented score. Where a number is an estimate, it says so ("≈", "derived", an honest mean shift over a window — no p-value theater).
2. **Nothing leaves the box unless you send it.** Interaction checking, reference ranges, screening schedules, solar math, and derived indices all run on-box against bundled public-domain datasets — detection works with no network at all. Every egress is optional, user-initiated, disclosed, and minimal: the RxNorm name lookup sends one drug name, a maps link sends one address from your own browser, and the AI endpoint is whatever you configure (point `AI_BASE_URL` at a local model for zero external egress). Nothing is ever sent automatically.
3. **Informational, never prescriptive.** Allos flags, notes, and cites — it does not diagnose or direct. Warnings say "discuss with your clinician"; a low supplemental intake is described as what your supplements contribute, never "you are deficient"; the absence of a flag is never presented as safety. Curated, cited public-domain data drives all clinical logic; AI output is labeled and descriptive only. Allos is not a medical device and nothing in it is medical advice.
4. **Calm by default, loud only for safety.** Observations are dismissible, coaching stays off your notification channels, a booked screening stops nagging, and a clear day is a quiet "all clear". The one deliberate exception: medication dose reminders and missed-dose escalations can never be silenced by a page dismissal — a convenience feature must not be able to mute a safety signal.
5. **You outrank the algorithm.** Your priority order is the sort order — never re-ranked by the app; a skipped dose is a decision, not a failure; a hand-corrected record survives the next integration sync; and any nudge can be snoozed, dismissed, or restored. Profiles — the people — outlive logins: deleting an account never deletes a person's history.

## Features

The short tour — [docs/features.md](docs/features.md) is the full guide, with every behavior, caveat, and data source spelled out.

- **Dashboard** — attention-first: a pinned, mobile-friendly **Needs attention** banner (globally capped, with explicit next actions, and driven by the same computation as Upcoming so the numbers always reconcile); while anyone you can reach has an open illness episode, a pinned **illness hero** (above the customizable grid, the first content block on mobile) — each patient's sick-day cockpit (day count · fever trend, the one-tap symptoms + temperature bar, the next-dose window, "feeling better"), with the profile you're acting as expanded and other household members as one-line accordions ("Mia · day 3 · 38.5° · last ibuprofen 4:02pm") that expand in place so you can log a symptom/temperature/dose for them **without switching profiles**, collapsible to their headline (never hideable while open); then a household strip for multi-profile logins, and a streamlined customizable grid of distinct summaries — recent labs, next appointment, coaching, weight trend, combined goals & habits, a **Log a PRN dose** quick-log widget (one-tap logging for as-needed meds, now or a retro time), and **Healthspan pillars** (VO₂ max percentile, strength standard, sleep regularity, biological age — separate signals, never one invented score)
- **Timeline** — day-by-day history across activity, body metrics, labs, medications, documents, visits, goals, protocols, symptoms, **illness episodes**, and milestones, with locally-computed sunrise/sunset chips once a home location is set; selecting a single day opens a one-tap symptom entry for that day (retro backfill)
- **Symptom log** — a standalone, day-by-day record of how you feel: one tap per symptom from a curated vocabulary (fever, cough, sore throat, headache, nausea, …) plus your own custom names, each at a 1–4 severity (a re-tap keeps the day's worst; lowering is an explicit edit). The Dashboard **Symptoms** slot is the illness front door: when you're well it's a single calm **"Feeling sick?"** line, and one tap activates the built-in **Illness** situation — whereupon the full sick-day cockpit (symptoms + temperature) jumps up to the pinned **illness hero** above the grid (the Symptoms slot itself then renders nothing, so there's no duplicate card). (Any of your own situations, "Migraine", "Kid sick", can still opt in as symptom containers from the Situations bar on Nutrition → Supplements — which now confirms an activation with a one-line "N situational items now active" acknowledgment so you can see the dose list changed shape; the "Feeling sick?" front door is hideable from Customize like any other widget.) The card also carries a one-step **body-temperature** quick log (°C/°F, with an optional reading time): each reading is timestamped and joins the same vitals series as a synced thermometer, so repeat readings build a fever curve and a fever flags out-of-range like any lab. And it offers a **"Taking something for it?"** inline OTC quick-add so reaching for ibuprofen is one collapse away from the fever entry. (The Trends → Body **Log vitals** form also takes an optional temperature reading time.) Symptoms are associated with an illness **episode** derived from when that situation was active — no separate bookkeeping. That episode gets its own **story view**: a Timeline card ("Illness · day 4 · fever trending down · 3 symptoms · ibuprofen 3×") opens a page that stitches the whole run together — the per-symptom severity series, the fever curve, the PRN doses given, and any bridged condition — which you can **print** or hand to a clinician as a revocable **share link** (QR-friendly, no login required). One tap **promotes the episode to a Condition** (onset/resolved from the range; undoable). Each episode is a durable record you can act on: **log symptoms and temperatures right on its page** (the same one-tap card as the dashboard, with a day picker for backfilling a past illness), **edit its start/end dates** (flagged a day late? fix it — retro-create or merge flap-split runs too), add a free-text **note** and an **outcome**, and end it from the page with **"Feeling better."** The page also lists the **clinical events that happened during the illness** — visits, appointments, medication courses, and documents that fall in its date range — with a **during-illness chip** linking back from a visit; shows the **next-dose window** for as-needed meds; and, while open, a calm **"day 5 — your last 3 illnesses ran 4–6 days"** comparison. Every past illness is browsable under **Medical → Illness episodes** (date range, duration, peak temperature, symptom set, outcome). While an episode is open it also surfaces on **every** household login's Dashboard illness hero (grants-scoped — you only see profiles you can already reach) as a per-patient accordion cockpit, so the last-dose/next-window line ("last ibuprofen 4:02pm") is unmissable on both parents' dashboards — the two-parent double-dose worry covered passively, no notification — and as a "sick day N" chip on the Household page (which gains a **worsening ↑** marker when the trend is up — a visibility arrow, no medical claim). When a logged symptom crosses a **cited** duration/trajectory line (e.g. a fever logged more than three days), an **illness-care check** surfaces on Upcoming, the Needs-attention hero, and an optional Telegram nudge — it states the logged fact, the label/guideline line, and the source, and is **informational, never a diagnosis** (no symptom-combination triage, no age thresholds beyond what the cited source publishes); dismiss it once and it's silenced everywhere. A **single scary temperature reading** gets its own cited, age-banded red flag at the moment you log it and as a care-tier check (any fever under 3 months, or 104 °F at any age → the source's "contact a clinician now" — AAP-grade, single readings only, never a computed judgment). While a fever runs, a **school-return countdown** ("fever-free 18h — last reading 99.1 °F · last ibuprofen 6:00pm — the common school/daycare guideline is fever-free for 24h without a fever reducer") shows on the hero, the episode page, and the household line (the threshold is per-profile, default 24h; informational). You can attach **dated symptom photos** (rash progression) to a day — camera-first on mobile — shown as a strip on the episode page (photos are **excluded from share links and the printable by default** — PHI-cautious). And because everything now hangs off an "open" episode, a forgotten-open one gets a **suggest-only "Still sick? End as of <last activity day>?"** nudge after a few quiet days — one tap backdates the end; nothing ever auto-closes
- **Protocols** — dated N-of-1 experiments: compare a baseline window against an intervention window on the outcome metrics you pick, with templates, situation activation, practice-adherence tracking, and a **direct supplement/medication link** so the intervention (e.g. creatine) is first-class instead of routed through a situation. A protocol's run also **shades as a window** on the trend charts — the Body and Compare tabs, and an outcome biomarker's own chart (so "did the statin move my LDL" reads at a glance) — behind the same annotation toggle as medications/appointments/situations. An optional, Customize-enabled **Active protocols** dashboard widget shows each ongoing experiment's days elapsed, this-week practice adherence, and whether the primary outcome has moved
- **Upcoming** — one forward-looking list of everything due (doses, refills, appointments, planned & preventive care, immunizations, biomarker retests, goal deadlines, training targets, illness-care checks, condition-review suggestions, **finding follow-ups**), risk-stratified by your history and risk factors (and a recorded screening result — HPV, HIV, hepatitis — advances the matching screening's cadence, the way an immune titer advances a vaccine), snooze/dismissable — the same list feeds the Telegram digest and the calendar feed. A **finding follow-up** links a flagged finding to the follow-up that resolves it: track a follow-up on an imaging study (an incidental "6 mm nodule, recheck in 12 months") and it becomes a legible, dated item ("Follow-up CT — for the 6 mm RLL nodule"); when a later matching study lands it **offers** to mark the finding resolved / stable / changed against it (you confirm, nothing auto-resolves); an **overdue** safety follow-up escalates to the Needs-attention hero and resists a blanket dismiss (it can still be snoozed) so it never silently ages out
- **Training** — workout history, goals, **routines** (adopt a template — full-body, upper/lower, push/pull/legs, 5×5, bodyweight — or build a custom one with your own days, exercise slots, and rep ranges; activating a routine sets your weekly training targets, at most one active at a time; a routine can declare an optional **mesocycle** — its last week is a **deload** week, where the "Today's session" slate lightens automatically (~10% load, one fewer set), the workout nudge softens instead of nagging, and you can "Restart cycle" any time) with a routine-aware **"Today's session"** card that resolves the current rotation day into a filled slate and hands it straight to the live workout mode, strength/cardio/sport analysis, per-exercise **how-to guides** (setup, cues, common mistakes, safety — reachable from the exercise detail panel and an ⓘ in the set editor), a live in-gym workout mode with a rest timer (that, once you start a session, stays visible as an **app-wide minimized dock** — a compact bottom bar carrying the elapsed time from every page, one tap back into the live editor, so an in-progress workout is never lost behind another screen; a session gone quiet for a while gets a gentle "still working out? finish or discard" suggest, never an auto-finish), an optional per-set **RPE** rating (5–10) that fine-tunes the next-set target (a top-of-range set at low RPE nudges the increment up; a hard grind at high RPE holds or backs off), a coached **next-set suggestion** in the set editor that lightens on a routine deload week (matching the "Today's session" slate) plus one-tap **"repeat last session"** fills from the Recent panel and a calm inline **plateau hint** when a lift has been flat for ~6 weeks (dismissible, and shared with the Training-watch card), an Overview weekly muscle-coverage list (sets per muscle over the last 7 days, primary movers counted in full and assisting muscles at half, each shown against its weekly volume band with a below/in-band/above verdict chip) with a front/back muscle-anatomy figure alongside it (each muscle tinted by that same band verdict; the same figure highlights primary/secondary muscles in each exercise's how-to guide, and marks the muscles a logged strength session worked on its Journal card), calm "Training watch" observations (including a below-band per-muscle volume nudge once you have a couple of weeks of history), duplicate merge with per-field conflict resolution, and estimated calorie burn
- **Equipment** — a gear registry with usage stats and retirement (history survives); owned gear gently shapes exercise suggestions
- **Trends** — Overview, Body (vitals quick-add, probable-error data checks), Fitness (a 12-month workout heatmap, HR-zone / Zone 2 / polarization analysis), Biomarkers (a trajectory watch, food-first suggestions for diet-responsive markers — a curated, NIH-ODS-cited **eat-more** answer for a flagged-low nutrient (selenium→brazil nuts, zinc, iodine, calcium, copper, iron, magnesium, folate, B12, potassium, omega-3, vitamins A/D/E) and a calm **cut-back** answer for a flagged-high core-panel marker (high LDL/ApoB → less fried/processed meat, high glucose/A1c → less added sugar & refined grains, high urate → less alcohol & organ meats, high sodium → less processed food); an elevated mercury reading tempers the app's own fatty-fish encouragement toward low-mercury species — age/sex percentiles & fitness age, pediatric reference ranges), Compare, and AI Insights
- **Household** — a cross-profile overview card per person (with a "sick day N" chip when someone has an open illness episode, and a compact "mid-workout · N min" chip while someone's in a live session); confirm a due dose for anyone without switching profiles
- **Goals** — targets and progress bars with calm pacing observations and a safe-rate caution
- **Nutrition** — a two-tab umbrella (**Food** | **Supplements**). The Food tab is a one-tap food-group serving log (habit tier by design, not a calorie counter) with a today/yesterday backfill toggle, weekly habit targets (paced on-track / on-pace / behind), food-first suggestions from flagged labs — both **eat-more** (a low nutrient → its curated food sources) and **cut-back** (a high core-panel marker → the limit-tier foods to reduce) — and a **protein-adequacy** card that compares your intake (an integration's tracked protein when present, otherwise an estimate summed from your logged food-group servings — a floor, since untracked foods add more) against a goal-scaled g/kg target band (general / active / muscle-gain / cut, preferring lean body mass when known); informational, never prescriptive, and optionally loggable from Telegram (Settings → Profile)
- **Benchmarks** — estimated 1RMs placed on bodyweight- and sex-specific strength standards, one shared computation behind every "Level" surface
- **Medical** — the full passport: vitals, labs, biomarkers, **structured genomic variants** (gene / variant / genotype / ACMG significance, extracted from clinical genetics & pharmacogenomic reports — factual, never editorialized), **imaging studies** (modality / body region / laterality / contrast + the radiologist's impression, extracted from radiology reports; numeric imaging metrics still trend as biomarkers) with a **contrast-safety cross-check** (a planned contrast study — a care-plan item, appointment, or future imaging order — flags a contrast/iodine/gadolinium allergy or CKD on file as an informational, ACR-cited pre-procedure note, never prescriptive) and a **Track follow-up** action (turn an incidental finding into a dated, resolvable follow-up on Upcoming — see Upcoming above), conditions (with ICD-10 suggestions — and a positive infection lab result, HIV/HCV/HBsAg/syphilis or a high-risk prenatal screen, surfaces a **suggest-only "add to conditions" review item** on Upcoming and the Needs-attention hero, deduped against what's already on your problem list; you confirm it, nothing is ever silently added), allergies, procedures, family history, immunizations, **medications**, visits & appointments, care plan, a providers directory, coverage gaps, and derived indices (non-HDL, HOMA-IR, eGFR, **PhenoAge** biological age)
- **Allergies** — documented allergies merged with IgE sensitizations detected from labs, plus curated cross-reactivity notes
- **Immunizations** — doses tracked against the CDC schedule, with titer-aware immunity status
- **Health-record import** — MyChart CCD/XDM "Download Summary", SMART Health Cards, and Epic / Apple Health FHIR bundles (scheduled appointments included; a bundle's `ImagingStudy` resources and radiology `DiagnosticReport` impressions import as structured **imaging studies** — deterministic, no AI)
- **Supplements & medications** — split across **Nutrition → Supplements** (supplement stacks, NIH UL/RDA checks, adherence-pattern observations, AI suggestions) and a standalone **Medications** page. The Medications page leads with a **time-aware Today panel** (scheduled dose check-offs + PRN log rows — the daily job first; rows ordered by time-of-day bucket the same way Upcoming is, a past-bucket unresolved dose flagged, and a quiet "All done today" line once every due dose is resolved), a safety strip, scannable medication **rows** each opening a per-med **detail page** (`/medications/[id]` — courses, side effects, stop/restart, administration history, a **month adherence calendar**, interactions, refill, explainer, prescriber/Rx), and a **"From your records"** bridge that offers to track imported prescriptions you're not tracking yet (suggest-only, dismissible — and a dismissed suggestion is recoverable from a collapsed "dismissed" list). The current-medication list can be **printed or shared** as a read-only link (the "bring your medication list" artifact) from the Current section. Each medication wears an **Rx or OTC** badge, and the prescriber / pharmacy / Rx-number fields show only for a prescription (a "this is a prescription" toggle flips an over-the-counter med). Adding a med uses a **medication-aware name picker** — **one entry per medication** labeled `Generic (Brand, Brand)`, where typing a brand still finds it and prefills the brand — and an **OTC quick-add** collapses the common over-the-counter case to name → label-default prefill → confirm (same row the full form creates), reachable from the Medications page and inline on the dashboard symptom card. Both surfaces share tri-state dose confirms (taken / skipped / clear), **per-administration logging for as-needed (PRN) meds** (multiple times a day with real/retro times — from the Today panel, the dashboard quick-log widget, or the Telegram `/dose` command; shows "2 today · last 4:02pm", and a mis-tapped dose is removable with undo — it restores the supply count and redose window), an opt-in **PRN redose notice** (a one-time reminder when the minimum interval passes after a dose — "6h since Ibuprofen — 2 of 4 today", overnight-capable for the 3am fever case; the interval/max pre-fill from cited OTC-label defaults but are your own confirmed numbers, and an over-max day surfaces a dismissible care note), **pediatric label dosing** (reproduces the OTC weight-band chart from a child's recorded weight + age — bands only, never a mg/kg calculation, with hard "ask a doctor" age gates and mg-first amounts; mL only once you pick your product's concentration), adherence & refill tracking (a low-supply med shows its projected **run-out date** and a one-tap **"Refilled"** action that tops up the count by your last fill size), drug–drug / supplement–drug / food–drug interaction warnings, a **pharmacogenomics (PGx) cross-check** (a stored PGx result flags affected meds with CPIC-cited, informational guidance — never prescriptive), and context-aware scheduling (pre/post-workout, rest-day, situational). Cross-kind interaction/PGx warnings show on both surfaces; the old `/medicine` link redirects to the Supplements tab
- **Emergency card** — a terse, printable first-responder summary that can be kept offline per device (strictly opt-in) and stays readable with no login and no network; while an illness episode is open it gains an **active-illness section** (day count, today's medications with times, latest temperature — the ER "what have they taken today?" answer)
- **Offline quick-log queue** — dose confirms, weigh-ins, and vitals queue on-device when you're offline and replay exactly once on reconnect; anything that can't be applied lands in a review panel, never silently dropped
- **Undo delete** — deleting an activity, body-metric entry, biomarker record, or supplement/medication offers a one-tap 24-hour Undo
- **AI activity log** — every AI call and failure recorded to a file and streamed live in **Settings → AI logs** (admin-only)
- **Server error log** — unexpected server errors (an unhandled action exception, a route 500, a crashed background task) persisted to a size-capped file and shown under **Settings → Errors** (admin-only); clients only ever see a generic error
- **Audit log** — a durable record of who accessed or modified which profile's data, identifiers only, with configurable retention (**Settings → Audit**, admin-only)
- **Data hub** — bring data in (uploads, pasted logs, devices) under **Data → Import**, review every sync, resolve duplicates, and one-click-correct probable unit mislabels (a lab whose printed reference range gives away a 10× wrong unit) under **Data → Review**, and take everything with you via the **Export all my data** ZIP (JSON/CSV + FHIR passport + your files)

## Deploy with Docker

Run the app as a container with Docker + Compose. By default Compose **pulls a
pre-built image** from the GitHub Container Registry
(`ghcr.io/floorlamp/allos`) — the deploy box never builds:

```bash
cp .env.example .env          # set ANTHROPIC_API_KEY, DATA_DIR, …
docker compose up -d --pull always  # pull + start
```

Pin a specific build by exporting `IMAGE` (defaults to `:latest`):

```bash
IMAGE=ghcr.io/floorlamp/allos:<git-sha> docker compose up -d --pull always
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

**Updating.** On the box, `docker compose pull && docker compose up -d`
picks up the new `:latest` (pin a `:<sha>` tag instead for a fixed version). Run
it by hand or from a host cron/systemd timer.

## Configuration

Configuration is read from environment variables. The easiest way is a
**`.env.local`** file in the project root — it is loaded automatically by both
the app and the `npm run seed` script, and is gitignored:

```bash
cp .env.example .env.local   # then edit in your values
```

| Variable                    | Description                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_USERNAME`            | Optional. Username for the bootstrap admin login created on first boot (default `admin`). Read only when no login exists yet.                                                                                                                                                                                                              |
| `ADMIN_PASSWORD`            | Password for the bootstrap admin login. If unset on first boot, a random one is generated and printed to the log **once** — capture it. Read only when no login exists yet.                                                                                                                                                                |
| `ALLOS_DISABLE_2FA`         | Optional bootstrap-recovery escape hatch. Comma-separated username(s) whose TOTP second factor is **skipped** at login (for an admin locked out after losing their authenticator + recovery codes). Every bypass is logged loudly and audited (`login.2fa-bypass`). Remove it and re-enroll once access is restored.                       |
| `ALLOS_DEMO_MODE`           | Optional. Set to `1` to run this instance as a **public read-only demo** — login-page demo credentials, a persistent "synthetic data — do not enter real health information" banner on every page, and every non-admin write refused. Leave **unset** for any real deployment. See **[docs/demo.md](docs/demo.md)**.                       |
| `ANTHROPIC_API_KEY`         | Enables Claude-powered insights and medical-document extraction. Optional when `AI_BASE_URL` points at a local server that ignores keys.                                                                                                                                                                                                   |
| `AI_BASE_URL`               | Optional. Point the app at a self-hosted / local inference server exposing an Anthropic-compatible API (Ollama, a proxy, …) for zero external egress. Set alone, or with a key it forwards.                                                                                                                                                |
| `HEALTH_AI_MODEL`           | Optional. Override the AI model (defaults to `claude-sonnet-5`).                                                                                                                                                                                                                                                                           |
| `HEALTH_AI_MAX_TOKENS`      | Optional. Max output tokens for document extraction (default `16000`).                                                                                                                                                                                                                                                                     |
| `AI_DAILY_EXTRACTION_LIMIT` | Optional. Max medical-document extractions per day (default `50`).                                                                                                                                                                                                                                                                         |
| `AI_DAILY_INSIGHT_LIMIT`    | Optional. Max AI insight generations per day (default `100`).                                                                                                                                                                                                                                                                              |
| `AI_EXTRACTION_CONCURRENCY` | Optional. How many document extractions run at once (default `3`).                                                                                                                                                                                                                                                                         |
| `AI_EXTRACTION_QUEUE_MAX`   | Optional. Max extractions queued behind the running ones (default `100`).                                                                                                                                                                                                                                                                  |
| `EXTRACTION_LEASE_MINUTES`  | Optional. How long a claimed extraction lease is held before it can be reclaimed (default `30`).                                                                                                                                                                                                                                           |
| `LOG_LEVEL`                 | Optional. `debug`/`info`/`warn`/`error` (default `info`).                                                                                                                                                                                                                                                                                  |
| `LOG_FORMAT`                | Optional. `text` or `json`. Defaults to `text` in dev, `json` in prod.                                                                                                                                                                                                                                                                     |
| `AI_LOG_PROMPTS`            | Optional. Set `0` to keep prompts/responses out of the AI activity log.                                                                                                                                                                                                                                                                    |
| `PORT`                      | Optional (Docker). Host port to expose (container listens on `3000`).                                                                                                                                                                                                                                                                      |
| `TRUST_PROXY`               | Optional. Set (`1`/`true`/`yes`) when the app runs **behind a reverse proxy** that sets `X-Forwarded-For`. Only then does the Telegram-webhook rate limiter trust that header to key its per-client budget; left unset (direct-to-Node exposure) the header is spoofable, so all webhook traffic shares one bucket. Has no effect on auth. |
| `TZ`                        | Optional. Timezone is DB-backed — the instance default under **Settings → Server**, per-profile under **Settings → Profile**; a `TZ` env only seeds the instance default on first boot.                                                                                                                                                    |
| `DATA_DIR`                  | Optional (Docker). Host path for persistent data — see **Deploy with Docker**.                                                                                                                                                                                                                                                             |
| `BACKUP_DEST_DIR`           | Optional. A **second mounted directory** to copy each verified snapshot to (and mirror `data/uploads/` to), so backups survive loss of the `DATA_DIR` volume — see **[Backups → Off-volume backups](docs/backups.md#off-volume-backups-backup_dest_dir)**.                                                                                 |

You can also `export` these directly instead of using a file.

## Signing in

The app is login-gated and multi-user. On first boot it creates a single **admin login** and a matching **profile** — set **`ADMIN_PASSWORD`** (and optionally **`ADMIN_USERNAME`**, default `admin`) before that first boot; if unset, a random password is generated and printed to the log **once**. In the Docker setup the bootstrap usually runs in the **notify sidecar**, so check `docker logs allos-notify` if it isn't in the app container's log.

Two concepts:

- **Logins** are login identities (username + password). Roles are **admin** or **member**; admins can access every profile and the admin screens.
- **Profiles** are the people whose data is tracked. A profile needs no login — adding a family member (e.g. a kid) is just a name.

Admins manage everyone under **Settings → Family**: add or rename profiles, create logins, reset passwords, and grant each member login access to specific profiles. Each grant is **read & write** or **read-only** — enforced on the server (every mutating action is rejected for a read-only grant), not merely hidden in the UI.

### First profile setup

A newly created profile starts with a short, page-by-page setup that can be left
and resumed at any time. It is built around one or two outcomes: medical records,
medications, fitness, metrics and labs, preventive care, or caregiving. The choices
seed that profile's initial Dashboard and prioritize connecting a supported app or
device before offering import and manual-entry fallbacks. The Fitness path can also
adopt and activate a beginner routine immediately (bodyweight first when no
equipment is registered), using the same editable routine templates and weekly
targets as Training. These choices do not disable any other feature, and the full
Dashboard customizer remains available afterward.

Only facts that immediately change behavior are requested up front: the profile's
display name, known birthdate or approximate age, sex used for applicable
clinical reference ranges, timezone, and the signed-in login's unit preferences.
Unknown health facts may remain blank. A profile can leave setup at any time and
resume it from the Dashboard. The data step prioritizes connected services and
brings the user back with a setup banner, but a slow sync never blocks progress.
Setup previews the proposed dashboard cards and notification preference before landing
inside the real Dashboard with a dismissible next-steps checklist. Notification
delivery is never enabled merely by choosing a preference; a channel must still be
deliberately configured under **Settings → Profile**.

Self and caregiver setup are explicit paths, and creating a profile still does
not create a login. A login opening an already-populated profile receives a short,
per-login orientation explaining its access and existing data instead of the
empty-profile flow. Server readiness and infrastructure configuration remain an
admin-only concern under **Settings → Server**. Seeded sample data opens directly
on the populated Dashboard.

Each login also picks its own **display units** under **Settings → Preferences** — weight (kg/lb), distance (km/mi), and temperature (°F/°C) — a per-login choice that follows you across every profile; storage stays canonical (kg/km/°F) and only the display converts. Any login can change its own password (minimum 10 characters, mixed character classes) and enroll **TOTP two-factor authentication** under **Settings → Preferences** — strongly recommended for admins; 8 one-time recovery codes are shown once at enrollment. If an admin loses both the authenticator and the recovery codes, the `ALLOS_DISABLE_2FA` env var (see **Configuration**) is the loudly-logged, audited escape hatch.

## AI

AI is optional and degrades gracefully: with nothing configured, insights fall back to a deterministic offline summary and uploaded documents are stored but not extracted. Configure it two ways (see **Configuration**):

- **`ANTHROPIC_API_KEY`** enables Claude-powered daily insights, **weekly/monthly recap narratives**, **lab-trend interpretation** (biomarker movements read in the context of your medications and conditions — observations, not diagnoses), and **medical-document extraction** (labs and vitals plus the full clinical narrative: conditions, allergies, procedures, visits, family history, care plan).
- **`AI_BASE_URL`** points the app at a local Anthropic-compatible inference server (Ollama, a proxy, …) instead, for **zero external egress**; the endpoint and model are env-driven only and shown read-only under **Settings → Server → AI**.

Proactive runs (supplement suggestions + a refreshed daily insight) can be put on a per-profile **cadence** (off / on document upload / daily / weekly / monthly) with an admin-set daily ceiling. Every AI call is appended to `data/logs/ai.jsonl` and streamed live under **Settings → AI logs** (admin-only), with per-call token usage and a today / 7-day rollup by feature × profile. Drug-interaction checking runs entirely **on-box** — the optional, user-initiated RxNorm name lookup is its only network egress (one drug name out, candidate codes back, nothing else).

The full guide — insights & narratives, recommendation runs, the extraction pipeline, local-inference setup and its quality trade-offs, logging, and the exact privacy posture — is [docs/ai.md](docs/ai.md).

## Integrations

Connect devices and services under **Data → Import**:

- **Google Health Connect** — push-based: an authenticated ingest endpoint here, fed by a phone exporter app on a rolling 48-hour window (weight, body composition, steps, sleep + stages, continuous HR, HRV, exercise sessions, vitals, nutrition, and more — including a **Sleep Regularity Index** card once enough nights accumulate)
- **Strava** — OAuth; runs/rides with HR, pace, elevation, power, and a GPS route thumbnail rendered locally from the stored polyline (no map tiles, no external requests)
- **Oura Ring** — a pasted personal access token; sleep + stages, nightly HRV, resting HR, workouts
- **Withings** — your own OAuth app; scale and BP-cuff measurements, body composition, SpO₂, temperature, sleep
- **Calendar feed** — an outbound `.ics` subscription per profile (choose which categories it carries and how much PHI each event shows), plus a consolidated per-login **family calendar**
- **Garmin** — planned

**Food tracking rides on Health Connect.** MyFitnessPal, Cronometer, Lose It!, and Yazio have no usable direct API, but they can all write your logged meals to Health Connect — so that's the supported way to get nutrition into Allos. Turn on Health Connect sync in your food app, connect **Google Health Connect** here, and your daily calories and protein/carbs/fat land on **Trends → Body → Macros**. Logged protein also becomes the tracked basis for the protein-adequacy card on **Nutrition** — an exact figure in place of the floor estimated from your logged food-group servings.

Every sync is **incremental and idempotent**: rows dedup on natural keys so re-fetches never double-count, incoming values are sanity-checked against a physiological envelope, **manually entered rows are never overwritten**, and a row you've hand-edited survives the next sync. When two sources report the same metric, additive metrics are never summed across sources, and a **Compare sources** section (**Trends → Body**) appears with a per-metric **primary source** picker.

Per-provider setup guides and import-mapping tables: [docs/integrations.md](docs/integrations.md).

## Notifications

Reminders (doses due, a workout nudge, newly-due preventive care, an illness-care check when a logged symptom crosses a cited duration/trajectory line, a single-reading temperature red flag) are delivered over three channels that share one hourly tick and per-day/slot dedup — enable any or all per profile:

- **Telegram** — with one-tap action buttons (✅ take / ⏭ skip a dose, ✅ Done / 🚫 Not applicable / ⏰ Remind later on a screening, 📦 Ordered on a refill, ✅ Confirmed taken on an escalation); a **`/dose` command** lists your active as-needed (PRN) meds as one-tap "log a dose now" buttons; a **`/symptom` command** shows your ranked symptoms as buttons → a severity picker, and a **`/temp` command** prompts you to reply with a reading ("38.5", or "101F"), logging it (with the same single-reading red-flag note when it crosses one); the **morning digest leads with any open illness episode**; an **opt-in food-log nudge** (Settings → Profile) can ride the same morning/midday/evening times with one-tap buttons for your most-eaten food groups; button taps and slash commands reach the app by long-polling (default, no public URL needed) or a webhook
- **Web Push** — native browser notifications, zero setup (HTTPS required; on iOS 16.4+ after Add to Home Screen)
- **Home Assistant** — a webhook per profile so HA can announce doses on the right room's speaker, flash lights on a missed critical dose, or hold a message until someone's home ([recipes](docs/home-assistant-notifications.md))

Opt-in **weekly recap** and **milestone alerts** ride the same channels (rule-based, no AI needed). **While an illness episode is open, coaching goes quiet** — the "you're behind on legs" routine-gap nags and the workout reminder are held (rest and safety reminders are untouched), so a sick week isn't nagged to train; when the episode closes you get a single, gentle **"ease back in"** re-entry note (a light session or easy Zone 2), and the weekly recap reads a sick week as a sick week, not a failed one. When you **finish a workout**, any due post-workout supplement is reminded **right then** — at the finish, not at the next fixed reminder slot — so the timing actually lands (the scheduled slot stays the fallback if the finish wasn't seen). **Quiet hours** hold non-urgent nudges to a per-profile waking window, and **"dismiss once, silence everywhere"** links a page dismissal to its push nudge — while **dose reminders, missed-dose escalations, and the PRN redose notice are deliberately never silenceable** by a dismissal or quiet hours: an escalation at 2am for a missed critical med — or a redose reminder at 3am for a child's fever — is the feature working. Docker's `allos-notify` sidecar drives the tick automatically; without it, cron `npm run notify` hourly.

Channel setup, button behavior, digests, and scheduling details: [docs/notifications.md](docs/notifications.md).

## Backups

The hourly tick takes a nightly, **integrity-verified** `VACUUM INTO` snapshot of the database (schedule and retention under **Settings → Server → Automated backups**; a snapshot that fails verification never rotates a good one away, and a weekly live-DB integrity check feeds the health endpoint). Snapshots land on the **same volume** as the live DB, so for real durability set **`BACKUP_DEST_DIR`** to a second mounted directory: each verified snapshot is copied there and `data/uploads/` is mirrored incrementally. The destination requires a one-time **Verify destination** click (a sentinel file, so a missing mount fails honestly instead of "backing up" into a container layer), and a mirror that goes stale degrades the health endpoint.

Restore with `npm run restore` — it lists snapshots with integrity status and schema version, keeps an atomic rollback aside, and refuses a newer-schema snapshot without `--force`. To migrate hosts, copy the whole `DATA_DIR` (the export ZIP is a portability artifact, not a restore image).

Full guide — off-volume setup, what the mirror covers, restore walkthrough, moving to a new server: [docs/backups.md](docs/backups.md).

### Health endpoint

`GET /api/health` (unauthenticated — it's the Docker healthcheck) returns a deliberately coarse `{ status, reason?, lastBackupAgeHours }` and flips to HTTP **503** when the DB is unreadable, `data/` is unwritable, the cached weekly integrity check found corruption, or backups are stale / have never run — each reason is documented in [docs/backups.md](docs/backups.md#health-endpoint). Notification delivery failures surface separately as a channel-aware marker on **Settings → Server**, cleared by a successful **Send test**.

## Development

Everything above is the self-hoster's manual; this section is for working on Allos itself. `AGENTS.md` is the contributor/agent guide (architecture, conventions, test tiers), with deep-dives under `docs/internals/`.

### Requirements

- **Node.js ≥ 24** (Next.js 16 requires ≥ 20.9; this repo is pinned to Node 24 via `.nvmrc`)

```bash
nvm use            # picks up Node 24 from .nvmrc
```

### Run from source

```bash
npm install        # install dependencies
npm run seed       # (optional) load ~3 weeks of realistic sample data
npm run dev        # start the dev server at http://localhost:3000
```

The SQLite database is created automatically at `data/allos.db` on first run
(the `data/` directory is gitignored). Delete that file to start fresh.

### Building & publishing images

To **build from source** locally instead of pulling the published image, layer on the build
override:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`.github/workflows/deploy.yml` builds the image on every push to `main` (and via
a manual **Run workflow**) and pushes it to GHCR as `ghcr.io/<owner>/<repo>`,
tagged with both `:latest` and the commit `:<sha>`, authenticating with the
built-in `GITHUB_TOKEN` (no extra registry secret). The in-image `next build`
(which runs tsc) is the CI gate: a type error fails the job and nothing is
pushed, so the published `:latest` always builds cleanly.

### Demo instance

`ALLOS_DEMO_MODE=1` runs a public, **read-only demo** (login `demo`/`demo`, every write refused server-side, nightly `npm run demo-reset`) — setup, nightly-reset cron, and the isolation warning are in [docs/demo.md](docs/demo.md). Never co-host a demo with a real instance.

### Scripts

| Command                    | Description                                               |
| -------------------------- | --------------------------------------------------------- |
| `npm run dev`              | Start the development server                              |
| `npm run build`            | Production build                                          |
| `npm start`                | Run the production build                                  |
| `npm run seed`             | Seed the database with sample data                        |
| `npm run demo-reset`       | Wipe + reseed a demo instance (nightly cron)              |
| `npm run notify`           | Send due notifications for the current hour (cron)        |
| `npm test`                 | Pure unit tests (vitest)                                  |
| `npm run test:db`          | DB-tier + server-action tests (in-memory SQLite)          |
| `npm run test:db:coverage` | DB-tier + server-action tests under a coverage floor (CI) |
| `npm run test:e2e`         | Playwright browser tests (isolated seeded DB)             |

### Tech

- Next.js 16 (App Router, Server Actions)
- better-sqlite3 (synchronous SQLite, schema auto-migrated on boot)
- Tailwind CSS
- Recharts for charts
- @anthropic-ai/sdk for AI insights

## License

Allos is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
See [LICENSE](LICENSE) for the full text.
