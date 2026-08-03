# Integrations — setup & sync behavior

Status: **shipped** · descriptive documentation of current behavior, extracted
from the README (#597)

Connect outside services under **Data → Import** so your health data syncs
automatically. Each provider has its own setup page (linked from the Import
tab's "Connect a device or service" card). **Google Health Connect**,
**Strava**, **Oura Ring**, **Withings**, **Fitbit via Google Takeout**,
**Patient portals**, and the keyless **Weather & UV (Open-Meteo)** source
are available today; **Garmin** is scaffolded as "coming soon".

## Google Health Connect

Health Connect is an Android **on-device** API, so data leaves the phone via an
exporter app that POSTs to this app. The integration is **push-based**: you
enable an authenticated ingest endpoint here and point the exporter at it.

1. Go to **Data → Import → Google Health Connect** and click **Generate token &
   enable**. The page shows your **Endpoint URL** and **Bearer token**.
2. Install
   [Health Connect Webhook](https://github.com/mcnaveen/health-connect-webhook)
   on your phone (Android 14+, with Health Connect installed) and grant it the
   health permissions you want to sync.
3. In the app, add a webhook with the **Endpoint URL** and an
   `Authorization: Bearer <token>` header, then pick a sync schedule (a 15–60
   min interval and/or fixed times). Each sync sends new records from a rolling
   48-hour window.
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
| Blood pressure, glucose, SpO₂, body temp, respiratory rate, VO₂ max | **Medical → Results → Biomarkers** (with reference-range flags)                                                                                                                |
| Lean mass, bone mass, BMR, height                                   | **Trends → Body** charts (height also drives a BMI chart)                                                                                                                      |
| Hydration                                                           | **Trends → Body** chart (liters/day)                                                                                                                                           |
| Nutrition                                                           | Calories under **Trends → Body**; macros and fiber under **Trends → Nutrition**                                                                                                |

Ingest is **idempotent**: the rolling 48-hour window means records are resent,
so imports dedup on natural keys (time windows) and never double-count. Manually
entered rows are never overwritten by a sync.

### Sleep Regularity Index (SRI)

Consistency of sleep timing turns out to predict mortality risk _better than
sleep duration_ (Windred et al., "Sleep regularity is a stronger predictor of
mortality risk than sleep duration", _SLEEP_ 2023, UK Biobank; the index itself
is from Phillips et al., _Sci. Rep._ 2017). So beyond the nightly-duration
chart, **Trends → Body** shows a **Sleep Regularity Index** card once you have
enough recorded nights (a rolling 28-night window with a minimum-nights gate).
The SRI runs −100 (fully irregular) to 100 (a perfectly reproducible schedule)
and measures the probability of being in the same sleep/wake state at the same
clock time on consecutive days. Alongside it are two companions — the standard
deviation of your bedtime and wake time, and **social jetlag** (how much your
mid-sleep shifts between weekdays and weekends). All clock math is done in your
**profile timezone**, so DST changes and travel don't distort it, and missing
nights are skipped (never treated as "awake") rather than faked. The current SRI
also rides the **weekly recap**.

Incoming records are also **sanity-checked**: values outside a wide
physiological envelope (e.g. a 5,000 kg weight, a 500 bpm heart rate, negative
steps, an SpO₂ above 100 %) or with an implausible timestamp (before 1900 or
more than a day in the future) are dropped and counted as **skipped** in the
Review feed's "· N skipped" tally, rather than poisoning trends and coaching. (A
row the source re-sends that you had merged away or deleted is likewise held out
and counted **suppressed**, so it can't resurrect.) A single payload is also
capped at 10,000 records (a generous ceiling above any real 48-hour batch); an
over-cap push is rejected with a `400` and a recorded sync failure.

The token is normally managed in the UI (Data → Import → Google Health Connect),
where you can **rotate** it in one click, set an optional **expiry** (90 days /
1 year / never), and see when it was **last used**. `HEALTH_CONNECT_TOKEN` is a
**headless-bootstrap-only fallback** (see `.env.example`) that maps to profile
1; it has no expiry, rotation, or last-used tracking, so prefer generating a
DB-backed token in the UI once the app is reachable. **Keep the token secret** —
anyone with it can post data to your instance.

The calendar `.ics` subscribe feed (Data → Import → "Connect a device or
service" → Calendar feed) shares the same lifecycle controls — rotate the link,
set an optional expiry, and see the last fetch time. Rotating either token
immediately invalidates the previous one, and an expired token is rejected
exactly like an invalid one.

**Customize what the feed contains** (per profile, right on the setup page):
pick which categories become calendar events — medical **appointments** (the
default), plus optional **doses due**, **refills running low**, **planned
care**, **preventive visits & screenings due**, **immunizations due**,
**biomarker retests**, **goal deadlines**, and **training targets** — toggle the
1-day/1-hour **reminders** on or off, and bound the **past window** and optional
**future horizon**. A **minimal ↔ full** detail switch controls PHI for every
category (minimal emits only a neutral label like "Medical appointment"; full
sends the real name/provider/reason). The in-app **Preview** mirrors exactly
what a subscribed calendar will receive at the current settings. Defaults
preserve the historical behaviour (appointments only, reminders on, 30-day past
window), so an existing subscription is unchanged until you opt in.

The same page also offers a **Family calendar** — one consolidated `.ics` feed
(and an in-app preview grouped by date) that merges the upcoming appointments of
**every profile you can access** into a single calendar, each event labeled with
the profile's name. Its token is per **login** (not per profile), so it rides
the same rotate/expiry/last-used lifecycle, and the set of profiles it exposes
is resolved **live on each fetch** from your current grants — losing access to a
profile removes it from the feed at once, and deleting the login kills the feed.
Each profile keeps its **own** detail level, so a profile set to minimal still
shows only "Medical appointment" even inside the shared feed.

## Strava

Connect once with OAuth and your runs, rides, and other activities sync
automatically — with heart rate, elevation, pace, calories, and cycling
power/cadence. A synced activity's **GPS route** (Strava's summary polyline,
which respects your privacy zones) is captured too and drawn on its Journal card
as a small **tile-free SVG route thumbnail** — the route's shape, rendered from
the stored polyline with no basemap and **no map tiles or external requests**
(nothing about where you were leaves the box).

1. Create an API application in your
   [Strava API settings](https://www.strava.com/settings/api) to get a **Client
   ID** and **Client Secret**.
2. Set the shared **Settings → Server → Public app URL** — it's used to build
   Strava's OAuth redirect (the callback carries your session cookie, so it must
   be the URL you're signed in on).
3. Go to **Data → Import → Strava**, enter the Client ID and Secret, then click
   **Connect with Strava** and authorize.
4. Hit **Sync now** to pull recent activities; new ones sync automatically
   afterward. Manually entered rows are never overwritten.

## Oura Ring

Oura's API v2 supports **personal access tokens** — so there's no OAuth app,
redirect, or callback URL to set up. You paste a token and the app pulls your
data from Oura's REST API on the hourly tick (and on demand).

1. Sign in to the
   [Oura developer portal](https://cloud.ouraring.com/personal-access-tokens)
   and **create a personal access token**.
2. Go to **Data → Import → Oura Ring** and paste the token, then click **Connect
   Oura**. The token is validated with an Oura whoami call
   (`GET /v2/usercollection/personal_info`) before it's saved — a bad or expired
   token is rejected up front.
3. Sleep, HRV, resting heart rate, and workouts then sync automatically every
   hour; hit **Sync now** any time. **Disconnect** clears the stored token.

**What gets imported** (mapped from the Oura API v2 responses):

| Oura data                                | Where it lands                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sleep (nightly `long_sleep`)             | **Trends → Body** charts: total per night + a deep/REM/light/awake stage breakdown (attributed to the wake-up day) |
| Nightly HRV (average RMSSD)              | **Trends → Body** (stored per day)                                                                                 |
| Resting heart rate (lowest during sleep) | **Trends → Body** charts                                                                                           |
| Workouts                                 | **Training history** (cardio / strength / sport, with distance + calories)                                         |

The sync is **incremental and idempotent**: a per-profile cursor tracks the
newest synced day, each run re-scans a short trailing window (so a night Oura
finalizes a day late isn't missed), and every row dedups on its natural key (the
sleep bedtime window, or `oura:<workout-id>`) so re-fetches never double-count.
**Manually entered rows are never overwritten**, and a row you've hand-edited is
left untouched on the next sync. Rate limits (HTTP 429) truncate the run and
keep the cursor so the next tick resumes. Naps/rest periods and Oura's
baseline-relative **temperature deviation** are not imported (the latter has no
home in the app's absolute-value metric vocab).

## Withings

Withings makes the clinical home devices — smart **scales**, **blood-pressure
cuffs**, and sleep sensors — and its developer API is open to individual
registration (no partner program), so you can connect it with your own OAuth
app. The app pulls your measurements from Withings' REST API on the hourly tick
(and on demand), so no public webhook is required.

1. Register an application in the
   [Withings developer dashboard](https://developer.withings.com/dashboard/) and
   set its **Callback URI** to the URL shown on the setup page
   (`https://<your-app-domain>/api/integrations/withings/callback`). The
   callback carries your session cookie (SameSite=Lax), so it binds to the
   active profile and requires a live session — it is **not** a public endpoint.
   Set the **Public app URL** in **Settings → Server** first if you're behind a
   reverse proxy, so the callback resolves to a reachable address rather than
   localhost.
2. Go to **Data → Import → Withings**, enter the Client ID and Secret, then
   click **Connect with Withings** and authorize (scope
   `user.metrics,user.activity`).
3. Measurements then sync automatically every hour; hit **Sync now** any time.
   **Disconnect** clears the stored tokens but keeps your entered credentials so
   you can reconnect without re-pasting them.

**What gets imported** (mapped from the Withings measure + sleep APIs):

| Withings data                         | Where it lands                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Weight, body fat %                    | **Trends → Body** charts (stored per day, source `withings`)                       |
| Heart pulse (scale / BP cuff)         | **Trends → Body** resting heart rate                                               |
| Lean & bone mass                      | **Trends → Body** composition charts (`metric_samples`, one reading per weigh-in)  |
| Muscle mass, total body water         | `metric_samples` (`muscle_mass_kg` / `body_water_kg`) — captured per weigh-in      |
| VO₂ max                               | **Medical → Results → Biomarkers** (`medical_records`)                             |
| Blood pressure (systolic + diastolic) | **Medical → Results → Biomarkers**, alongside manually entered blood pressure      |
| SpO₂, body temperature                | **Vitals** (temperature converted °C → °F canonical)                               |
| Sleep (deep / REM / light / awake)    | **Trends → Body** — total per night + stage breakdown (attributed to the wake day) |

The sync is **incremental and idempotent**: measures use Withings' `lastupdate`
cursor (its `updatetime` echo is the next cursor), sleep uses a trailing date
window, and every row dedups on its natural key — `(date, source)` for body
metrics, `withings:<grpid>:<analyte>` for vitals, and the sleep window for sleep
samples — so re-fetches never double-count. **Manually entered rows are never
overwritten**, and a row you've hand-edited is left untouched on the next sync.
Rate limits truncate the run and keep the cursor so the next tick resumes. Blood
pressure lands as vitals and is reference-range flagged exactly like a manual
reading.

## Fitbit (Google Takeout)

Fitbit import is a one-off archive workflow rather than a live connection. It
is also the supported way to recover historical body-composition readings from
a Fitbit-linked scale, because Fitbit does not forward weight or body fat to
Health Connect.

1. Go to **Data → Import → Fitbit (Google Takeout)**.
2. Open [Google Takeout](https://takeout.google.com/) while signed in as the
   account linked to Fitbit. Deselect everything, select only **Fitbit** (it may
   appear as **Google Health**), and request a ZIP export.
3. Upload the downloaded ZIP. If Google split the export into multiple parts,
   upload each part separately.

The import includes weight, body fat, resting and minute-level heart rate,
steps, distance, active calories, sleep, workouts, SpO₂, respiratory rate, skin
temperature, and Fitbit's sleep/readiness scores. Fitbit-authored scores remain
attributed and never feed Allos calculations. Rows that Fitbit received from
Health Connect are skipped so the two sources do not double-count the same
phone data.

The archive is streamed to the server and deleted after processing; only the
imported health records remain. Re-importing a newer export is safe because
records deduplicate on their natural keys, and the result appears in
**Data → Review**.

## Patient portals

The one **external-attended** integration: allos cannot run this sync itself.
Portal sign-in needs a person — two-factor codes, and sessions that idle out in
minutes — so a small companion tool runs on your own computer, signs in the way
you would, downloads the portal's own export, and pushes it in through the
[document upload API](api-tokens.md). Allos never signs in and never holds a
portal address.

It is named for the **document family**, not for one vendor: the CCD/C-CDA
export is a regulatory requirement, so Epic MyChart, Cerner/Oracle Health,
athenahealth and the rest all produce the same thing. MyChart is simply the
first companion tool written against the contract.

Setup, under **Data → Import → Patient portals**. The page renders the thing
itself: **portal → login → patient**, each portal a permanent card from the
moment you add it. Guidance sits on top of that structure rather than replacing
it — a **checklist** (Portal added · API token · First run · patients to map)
runs above the cards until setup is done, then disappears. On a first visit the
checklist unrolls into a five-step guide whose step 1 **is** the add-portal
form; adding the portal materializes its card in place, ticks the step, and
lights the next one. The page is household-wide and says so once; nothing on it
follows the header's active profile. The five steps:

1. **Register each portal** by its display name — "Ochsner MyChart". Allos mints
   the short id the companion tool quotes, so renaming the portal later never
   breaks a machine's config. A portal is recorded **by name only**: its web
   address lives in the companion tool's local config on your machine, and allos
   refuses to store one anywhere, including in the display name. The software it
   runs is a row of chips — MyChart, Cerner, eClinicalWorks, "Something else",
   or the default "Not sure" — only for display and for the tool to sanity-check
   what it has been pointed at, and editable later from the portal's **⋯** menu.
2. **Name the logins, if there are several.** One portal often has more than one
   account in a household — each parent's own — and a portal's patient list is
   shown **per login**, so the same name can mean two different people on two
   accounts. **Add a login** lives in the portal's **⋯** menu; give each one a
   name ("Mom", "Dad") — or the **email address** the login uses, which is often
   the way a household actually tells two logins apart. A name is all allos
   stores: never a password, and never a web address. With one login you never
   meet the concept — the portal card simply is its login; logins appear as
   titled sub-groups only once there are two.
3. **Mint an API token** (Settings → Account & security → API tokens) with the
   _Upload documents_ capability. Give **each computer its own token**, so
   retiring one machine doesn't disturb the others.
4. **Run the tool.** It reports which patients that login covers; they appear as
   amber rows under the login that reported them, waiting to be mapped.
5. **Map each patient to a profile** — tap the household member's **face** in
   the row's avatar-chip picker, then **Map**. Nothing is preselected, ever: the
   choice is made, not merely left alone. The label is bound exactly as the
   portal spelled it — two labels that differ visibly are two different people.
   A pending name that exactly matches a patient already mapped on another login
   gets a **"same person?"** suggestion with a one-tap Map — suggested only,
   never applied for you. **Ignore** (admin-only, durable) and **Not now**
   (clears the prompt until the next report) live in the row's ⋯ menu.

Documents land in **Data → Review** like any other import, with the same
deduplication and the same size and type checks. A document pushed in by the tool
records **which portal it came from** — shown as "Acquired via …" in Review and on
the import's detail page — so two portals serving the same patient stay tellable
apart. A document you uploaded yourself simply says nothing there.

**Everything is edited where it lives.** Every row's verbs sit in a **⋯** menu
at its right edge — rename or remove a portal, edit its software, add or rename
a login, unmap or un-ignore a patient — and the destructive ones ask first.
Changing a mapped patient's profile is one tap on the row's avatar chip: the
picker reopens with the current person pressed, and Save re-points the mapping
atomically, so there is never a moment where the label is unmapped and an
arriving upload would be refused. Feedback appears inline beside whatever you
touched, never in a status line at the bottom. **Patient labels themselves are
deliberately not editable** — the label is the portal's verbatim spelling and
the key every upload resolves against, so an "edited" label would orphan the
mapping; if a portal changes its spelling, the new spelling arrives as a new
pending row and the same-person suggestion carries the old mapping over. The
manual **"pre-bind a patient by hand"** escape hatch survives at the end of each
login's patient list, labelled as one: patients normally appear by themselves
after a run, spelled the way the portal spells them, and a guess is refused
rather than corrected.

**What a member sees.** Members see exactly the logins that cover profiles they
can access, under a note saying so; a first-contact portal that no run has
claimed yet is visible to admins only. Portal and login management is
admin-only, and so is the durable **Ignore** — a member with write access can
map patients onto their own profiles and clear prompts with **Not now**, but
cannot permanently refuse a patient on someone else's login.

**Why the mapping lives here and not in the tool.** If the tool decided which
profile a patient belongs to, that decision would sit in local config on every
machine it runs on — and a stale copy would file one person's records under
another. So the tool reports what the portal told it and allos resolves it,
against a mapping you can see and correct in one place. Anything unmapped is
**refused**, never filed under a guess: a new proxy patient appearing on the
portal surfaces as something to fix, not as records on the wrong person.

**Why the tool tells allos who it saw.** Predicting how a portal renders a name
is a losing game — "SMITH, ALEX" or "Alex Smith" or "Smith, Alex Jr." — so you
never have to. The tool reports the list verbatim at the end of every run, and
you bind what allos was actually told. Refusals still happen for a patient who
appears between runs; they are the safety net, not the setup path.

**Why a quiet run still reports.** A run that checks the portal and finds nothing
new pushes no documents, so it would otherwise leave no trace and "Last checked"
could never move — a healthy quiet week would look identical to a broken one. The
tool therefore reports every run, and a nothing-new result reads as a calm
success. A failure leaves the previous "Last checked" standing so you can see how
long it has really been. Each mapped patient shows its own last-checked line,
because a household with two portals and three patients has more than one answer
to that question.

**The first run, and a portal that breaks before it reaches anyone.** Two kinds
of run belong to a portal login rather than to a person: the very first one,
whose own patient is not mapped yet, and a failure that happens before any
patient is reached ("the portal's login page changed"). Neither can be filed
under a profile, and neither is guessed onto one — but both leave a trace on the
**login's own row**, which carries its last-run status: _"Last run 2026-03-04"_,
or the tool's own failure message. A failure that names a mapped patient still
raises that profile's **Review** failure badge as before; a portal-level one
cannot, because it has no profile to raise it for, and shows on the login row
instead.

**Why there is no Start button.** Allos cannot make an attended sync happen, so
the page doesn't pretend to: it is setup and status. For the same reason this
integration is exempt from the ordinary **staleness warning** — "you haven't
signed in to your hospital portal in three days" is not a fault, and the
broken-sync signal every other integration raises would be describing a failure
that has not happened.

**Asking a person, which is a different thing.** What allos _can_ do is remember
that a run is due and tell whoever runs it — the hard part of stale records is
remembering, not the double-click. Three things raise a **sync request**:

- **Staleness** — a portal login whose last successful check is more than a
  month old.
- **After a visit** — a mapped profile's appointment has just passed, which is
  the moment new records actually appear on a portal, and the most useful nudge
  this feature can send.
- **Asking** — the **Request sync** button on each login's row, for when the
  person who manages allos is not the person whose laptop holds the login.

A request is **never a schedule**: nothing is promised to run at a time, and the
row carries only the portal and login short ids — never an address. It
**expires** after a week rather than sitting there forever, and it **answers
itself**: the next reported run for that login clears it, including a failed one
where somebody was at the machine (they went and did the thing; whether the run
then worked is what the login row's status is for).

**Two reports deliberately do not clear it**, because in both cases nobody
actually checked the portal:

- **A delivery, not a visit.** The companion tool can send records it already has
  on disk without opening a portal at all. Such a report still records its sync
  event, still moves each patient's **"Last synced"** line, and still shows up in
  **Data → Review** and the integrations accounting — the documents genuinely
  arrived. What it does **not** do is answer a request or move the
  checked-the-portal clock, so a login that is only ever pushed to still becomes
  due for a real check.
- **A scheduled run that failed with nobody there.** The device-trust cookie
  expired, or the portal asked for a code — which is exactly when someone _does_
  need to go to the machine. The ask stays, and picks up the reason the run gave:
  _"The scheduled run couldn't finish (passkey prompt) — someone needs to go to
  the machine."_ A scheduled run that **succeeds** clears the request as any run
  does: the records arrived, which is all the request ever wanted.

**A tool may ask what is wanted, but nothing else.** Now that a portal login can
sign itself in unattended, a scheduled pass can read the open requests
(`GET /api/documents/requests`) and run the ones it can run by itself — which is
worth having, because an after-a-visit request fires the moment new records
appear rather than waiting for tomorrow's fixed schedule. The answer is
**short ids only, never an address**, open and unexpired requests only, and only
for the logins that token could file documents for. There is nothing to claim,
nothing to acknowledge, and no way for a tool to create or close a request except
by reporting a run as it always has. Requests still reach a **person** through
Upcoming and the digest, unchanged. If somebody else answers a request between
the tool's asking and its running, nothing goes wrong: the run's own report
closes it, and a second copy of the same document is refused as a duplicate.

**When a portal simply won't hand a patient's records over.** One login often
covers several people, and a portal will sometimes show a proxy their visit list
while offering no download at all. That is a settled answer, not a fault — the
same tomorrow and next month, and nothing anyone running the tool can fix — so
allos records it **per patient**, on that patient's own row: _"the portal doesn't
offer downloads for this proxy — nothing to fix."_ It is said once, quietly. It
raises no failure badge and no notification, and it stops the staleness and
after-a-visit nudges **for that person only** — the others on the same login are
untouched, which is the whole reason it is recorded per patient rather than per
run. It clears itself the first time that patient's records do come through.

**Who hears about it, and how loudly.** The reminder goes to the login whose
token actually reports runs for that portal login — your phone about your portal
— falling back to the people with write access to the mapped patients when no
token has reported yet. It reaches exactly two places: an **Upcoming** item and
one line in the morning digest that already sends. It is dismissible, and
dismissing it silences both. There is **no dedicated notification, ever**, and it
never appears on the dashboard's "Needs attention" panel: portal hygiene is not a
safety signal. A login with no mapped patients raises nothing at all — there
would be nobody to reach, and finishing setup is what the page itself is asking
for.

## Weather & UV (Open-Meteo)

Unlike the device integrations, this one has **no account and no API key** — it
fetches public weather data for the one location you've already set. It turns
your outdoor daylight time (the sunrise/sunset intersection above) into a
**two-sided UV dose**: enough sun for vitamin-D synthesis and circadian light,
but a heads-up before you'd burn.

1. Set your coarse **home location** under **Settings → Health profile**
   (stored at ~11 km — city scale, never a street address). This is the only
   prerequisite.
2. Go to **Data → Import → Weather & UV (Open-Meteo)** and click **Enable**. The
   hourly **UV index**, **solar irradiance** (shortwave/direct/diffuse W/m²) and
   **precipitation** (mm) for that spot then sync automatically every hour via
   [Open-Meteo](https://open-meteo.com/), and you can press **Sync now** any
   time.
3. Optionally add your **skin type (Fitzpatrick I–VI)** under
   **Settings → Health profile** to switch on the **overexposure** side (the
   burn-risk threshold). Left unset, only the "enough sun" side is shown — the
   overexposure heads-up stays silent rather than guessing.

**What else it feeds.** Alongside the hourly UV series, a **daily** series is
cached for the same spot — temperature, pressure, precipitation, air quality and
pollen. That daily data is what powers the **weather situations** (heatwave,
cold snap, pressure swing, high pollen, poor air quality): context that turns
itself on when the weather qualifies, so a situational item — an antihistamine
keyed to "High pollen", say — comes due automatically instead of waiting for you
to remember a toggle. It also lets the app note when a medication you take
interacts with the conditions (sun sensitivity on a bright day, heat tolerance
during a hot spell). Pollen and air quality come from a separate Open-Meteo
feed; if that feed is unavailable, temperature-based features keep working and
the pollen ones simply stay quiet.

**What it feeds.** Your outdoor daylight window is crossed with the UV that
actually occurred during those hours — Open-Meteo's **free historical archive**
backfills the UV for activities you already logged, so a past walk gets a real
dose, not a forecast. The **sufficiency** side (were you out during
meaningful-UV hours, roughly UV ≥ 3?) is a calm coaching signal; the
**overexposure** side (cumulative erythemal dose past your skin type's MED) is a
care-tier heads-up on Upcoming + the dashboard. The Timeline's daylight chip
gains a UV badge for the day's outdoor window.

**Offline / degradation.** Sun features stay fully functional without the
network: the model degrades **live UV → a clear-sky estimate** (Open-Meteo's
`uv_index_clear_sky`, or a sun-elevation ceiling computed locally) **→ the plain
minutes-only behavior**. The overexposure side stays silent without a skin-type
threshold rather than guessing.

**Cache.** The hourly series (UV, irradiance, precipitation) is cached **per
location, shared across profiles** (the weather at a coordinate+hour is one
physical fact), keyed on `(lat, lng, hour_ts)` and deduped on that key — a
re-fetch of the same hour rewrites nothing. The hourly precipitation is what
lets a weather-parked activity say _when_ the rain falls ("heavy rain in the
morning") instead of printing a millimetre total; a day with too few cached
hours simply says nothing about timing. Every sync appends an `integration_sync_events` row under the
acting profile (visible in **Data → Review**).

## Comparing sources & picking a primary one

With more than one source reporting the same metric (say Health Connect **and**
Oura both tracking sleep, HRV, or resting heart rate), every source's stream is
stored side by side — they never overwrite each other — and the app reconciles
them on read:

- **Additive metrics** (steps, calories, sleep minutes) are **never summed
  across sources**: each day keeps one source's total, so two devices can't
  double your step count or produce a 16-hour night.
- **Point metrics** (weight, body fat, resting HR, HRV) keep every source's
  readings for comparison; charts and latest-value readouts resolve to one
  value.
- **Trends → Body** grows a **Compare sources** section as soon as any metric
  has two or more reporting sources: a per-source overlay chart for each such
  metric, with a **Primary source** picker beside it. "Automatic" (the default)
  prefers a manual entry, then Health Connect, then Oura, then Withings, then
  Strava; picking a source makes it authoritative for that metric's totals,
  charts, and latest-value surfaces (with a fallback whenever it has no data).
  The section is invisible until a second source actually shows up.
- **Documents as one source.** A reading extracted from a medical document
  carries that document's own provenance, so each report is its own source. The
  picker also offers **Documents** — a source _class_ covering every document —
  whenever any document reports the metric, and the overlay adds one aggregated
  **Documents** series (across all reports) as soon as two documents do. The
  per-document series and their labels remain; the class is an addition. Electing
  it means "my scans", including the next one, which is a new document.
- **Only this source.** The picker's **Only this source** checkbox turns the
  choice from a preference into an exclusion: days the elected source did not
  cover stay empty instead of falling back, additive rollups count only its rows,
  and a latest-value surface with no reading from it shows the empty state rather
  than another source's number. Unchecking it (or returning to "Automatic")
  restores the fallback behavior exactly. Strict mode plus the Documents class is
  how a profile gets a scans-only chart against a denser everyday source.
