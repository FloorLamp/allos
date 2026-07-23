# Integrations — setup & sync behavior

Status: **shipped** · descriptive documentation of current behavior, extracted from the README (#597)

Connect outside services under **Data → Import** so your health data syncs
automatically. Each provider has its own setup page (linked from the Import tab's
"Connect a device or service" card). **Google Health Connect**, **Strava**,
**Oura Ring**, **Withings**, and the keyless **Weather & UV (Open-Meteo)** source are
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
"· N skipped" tally, rather than poisoning trends and coaching. (A row the source
re-sends that you had merged away or deleted is likewise held out and counted
**suppressed**, so it can't resurrect.) A single payload
is also capped at 10,000 records (a generous ceiling above any real 48-hour batch);
an over-cap push is rejected with a `400` and a recorded sync failure.

The token is normally managed in the UI (Data → Import → Google Health Connect),
where you can **rotate** it in one click, set an optional **expiry** (90 days / 1
year / never), and see when it was **last used**. `HEALTH_CONNECT_TOKEN` is a
**headless-bootstrap-only fallback** (see `.env.example`) that maps to profile 1;
it has no expiry, rotation, or last-used tracking, so prefer generating a
DB-backed token in the UI once the app is reachable. **Keep the token secret** —
anyone with it can post data to your instance.

The calendar `.ics` subscribe feed (Data → Import → "Connect a device or service" → Calendar feed) shares
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
power/cadence. A synced activity's **GPS route** (Strava's summary polyline,
which respects your privacy zones) is captured too and drawn on its Journal card
as a small **tile-free SVG route thumbnail** — the route's shape, rendered from
the stored polyline with no basemap and **no map tiles or external requests**
(nothing about where you were leaves the box).

1. Create an API application in your [Strava API settings](https://www.strava.com/settings/api)
   to get a **Client ID** and **Client Secret**.
2. Set the shared **Settings → Server → Public app URL** — it's used to build
   Strava's OAuth redirect (the callback carries your session cookie, so it must
   be the URL you're signed in on).
3. Go to **Data → Import → Strava**, enter the Client ID and Secret, then click
   **Connect with Strava** and authorize.
4. Hit **Sync now** to pull recent activities; new ones sync automatically
   afterward. Manually entered rows are never overwritten.

### Oura Ring

Oura's API v2 supports **personal access tokens** — so there's no OAuth app,
redirect, or callback URL to set up. You paste a token and the app pulls your data
from Oura's REST API on the hourly tick (and on demand).

1. Sign in to the [Oura developer portal](https://cloud.ouraring.com/personal-access-tokens)
   and **create a personal access token**.
2. Go to **Data → Import → Oura Ring** and paste the token, then click **Connect
   Oura**. The token is validated with an Oura whoami call (`GET
/v2/usercollection/personal_info`) before it's saved — a bad or expired token is
   rejected up front.
3. Sleep, HRV, resting heart rate, and workouts then sync automatically every hour;
   hit **Sync now** any time. **Disconnect** clears the stored token.

**What gets imported** (mapped from the Oura API v2 responses):

| Oura data                                | Where it lands                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sleep (nightly `long_sleep`)             | **Trends → Body** charts: total per night + a deep/REM/light/awake stage breakdown (attributed to the wake-up day) |
| Nightly HRV (average RMSSD)              | **Trends → Body** (stored per day)                                                                                 |
| Resting heart rate (lowest during sleep) | **Trends → Body** charts                                                                                           |
| Workouts                                 | **Training history** (cardio / strength / sport, with distance + calories)                                         |

The sync is **incremental and idempotent**: a per-profile cursor tracks the newest
synced day, each run re-scans a short trailing window (so a night Oura finalizes a
day late isn't missed), and every row dedups on its natural key (the sleep bedtime
window, or `oura:<workout-id>`) so re-fetches never double-count. **Manually entered
rows are never overwritten**, and a row you've hand-edited is left untouched on the
next sync. Rate limits (HTTP 429) truncate the run and keep the cursor so the next
tick resumes. Naps/rest periods and Oura's baseline-relative **temperature deviation**
are not imported (the latter has no home in the app's absolute-value metric vocab).

### Withings

Withings makes the clinical home devices — smart **scales**, **blood-pressure
cuffs**, and sleep sensors — and its developer API is open to individual
registration (no partner program), so you can connect it with your own OAuth app.
The app pulls your measurements from Withings' REST API on the hourly tick (and on
demand), so no public webhook is required.

1. Register an application in the [Withings developer dashboard](https://developer.withings.com/dashboard/)
   and set its **Callback URI** to the URL shown on the setup page
   (`https://<your-app-domain>/api/integrations/withings/callback`). The callback
   carries your session cookie (SameSite=Lax), so it binds to the active profile and
   requires a live session — it is **not** a public endpoint. Set the **Public app
   URL** in **Settings → Server** first if you're behind a reverse proxy, so the
   callback resolves to a reachable address rather than localhost.
2. Go to **Data → Import → Withings**, enter the Client ID and Secret, then click
   **Connect with Withings** and authorize (scope `user.metrics,user.activity`).
3. Measurements then sync automatically every hour; hit **Sync now** any time.
   **Disconnect** clears the stored tokens but keeps your entered credentials so you
   can reconnect without re-pasting them.

**What gets imported** (mapped from the Withings measure + sleep APIs):

| Withings data                         | Where it lands                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Weight, body fat %                    | **Trends → Body** charts (stored per day, source `withings`)                                 |
| Heart pulse (scale / BP cuff)         | **Trends → Body** resting heart rate                                                         |
| Lean & bone mass                      | **Trends → Body** composition charts (`metric_samples`, one reading per weigh-in)            |
| Muscle mass, total body water         | `metric_samples` (`muscle_mass_kg` / `body_water_kg`) — captured per weigh-in                |
| VO₂ max                               | **Vitals** biomarker (`medical_records`) — appears in **Trends → Biomarkers**                |
| Blood pressure (systolic + diastolic) | **Vitals** (`medical_records`) — appears in **Trends → Biomarkers** like manually-entered BP |
| SpO₂, body temperature                | **Vitals** (temperature converted °C → °F canonical)                                         |
| Sleep (deep / REM / light / awake)    | **Trends → Body** — total per night + stage breakdown (attributed to the wake day)           |

The sync is **incremental and idempotent**: measures use Withings' `lastupdate`
cursor (its `updatetime` echo is the next cursor), sleep uses a trailing date
window, and every row dedups on its natural key — `(date, source)` for body metrics,
`withings:<grpid>:<analyte>` for vitals, and the sleep window for sleep samples — so
re-fetches never double-count. **Manually entered rows are never overwritten**, and a
row you've hand-edited is left untouched on the next sync. Rate limits truncate the
run and keep the cursor so the next tick resumes. Blood pressure lands as vitals and
is reference-range flagged exactly like a manual reading.

### Weather & UV (Open-Meteo)

Unlike the device integrations, this one has **no account and no API key** — it fetches
public weather data for the one location you've already set. It turns your outdoor
daylight time (the sunrise/sunset intersection above) into a **two-sided UV dose**:
enough sun for vitamin-D synthesis and circadian light, but a heads-up before you'd
burn.

1. Set your coarse **home location** on **Settings → Profile** (stored at ~11 km — city
   scale, never a street address). This is the only prerequisite.
2. Go to **Data → Import → Weather & UV (Open-Meteo)** and click **Enable**. The hourly
   **UV index** and **solar irradiance** (shortwave/direct/diffuse W/m²) for that spot
   then sync automatically every hour via [Open-Meteo](https://open-meteo.com/), and you
   can press **Sync now** any time.
3. Optionally add your **skin type (Fitzpatrick I–VI)** on Settings → Profile to switch
   on the **overexposure** side (the burn-risk threshold). Left unset, only the "enough
   sun" side is shown — the overexposure heads-up stays silent rather than guessing.

**What it feeds.** Your outdoor daylight window is crossed with the UV that actually
occurred during those hours — Open-Meteo's **free historical archive** backfills the UV
for activities you already logged, so a past walk gets a real dose, not a forecast. The
**sufficiency** side (were you out during meaningful-UV hours, roughly UV ≥ 3?) is a calm
coaching signal; the **overexposure** side (cumulative erythemal dose past your skin
type's MED) is a care-tier heads-up on Upcoming + the dashboard. The Timeline's daylight
chip gains a UV badge for the day's outdoor window.

**Offline / degradation.** Sun features stay fully functional without the network: the
model degrades **live UV → a clear-sky estimate** (Open-Meteo's `uv_index_clear_sky`, or
a sun-elevation ceiling computed locally) **→ the plain minutes-only behavior**. The
overexposure side stays silent without a skin-type threshold rather than guessing.

**Cache.** The hourly UV series is cached **per location, shared across profiles** (UV at
a coordinate+hour is one physical fact), keyed on `(lat, lng, hour_ts)` and deduped on
that key — a re-fetch of the same hour rewrites nothing. Every sync appends an
`integration_sync_events` row under the acting profile (visible in **Data → Review**).

### Comparing sources & picking a primary one

With more than one source reporting the same metric (say Health Connect **and**
Oura both tracking sleep, HRV, or resting heart rate), every source's stream is
stored side by side — they never overwrite each other — and the app reconciles
them on read:

- **Additive metrics** (steps, calories, sleep minutes) are **never summed across
  sources**: each day keeps one source's total, so two devices can't double your
  step count or produce a 16-hour night.
- **Point metrics** (weight, body fat, resting HR, HRV) keep every source's
  readings for comparison; charts and latest-value readouts resolve to one value.
- **Trends → Body** grows a **Compare sources** section as soon as any metric has
  two or more reporting sources: a per-source overlay chart for each such metric,
  with a **Primary source** picker beside it. "Automatic" (the default) prefers a
  manual entry, then Health Connect, then Oura, then Withings, then Strava; picking a source
  makes it authoritative for that metric's totals, charts, and latest-value
  surfaces (with a fallback whenever it has no data). The section is invisible
  until a second source actually shows up.
