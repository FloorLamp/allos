# AGENTS.md

This is the operating guide for coding agents working in this repository.
`CLAUDE.md` is a symlink to this file.

## Product and access model

**Allos** is a multi-user, login-gated health tracking and coaching app built
with Next.js 16 App Router, Server Actions, and synchronous `better-sqlite3`.
It covers training, body metrics, nutrition, supplements and medications, a
medical passport, Timeline, Trends, Upcoming, notifications, imports, and
optional Claude-powered analysis.

The live Trends tabs are **Overview, Fitness, Nutrition, and Insights** — four
since #1644 merged the Body tab into Overview, and permanent by owner ruling
(there is no all-tabs endpoint; a fifth merge needs a new decision). The Overview
landing surface is a trending digest, then the cross-domain **starred grid** (the
only curated area — nothing renders there unconditionally), then the **body
census**, which streams under its own `Suspense` boundary so the head never waits
on it. `lib/trends-tabs.ts` owns the tab set; `lib/trends-sections.ts` owns the
landing surface's two anchors. A body deep link is `trendsSectionHref("body")` →
`/trends#body`; `?tab=body` is retired with no shim (it falls through to the
default view, which renders that census). Labs, imaging, and genomics live under
Medical → Results, not a Trends tab.

### Logins and profiles are different

- A **profile** is a data subject. Every profile-owned table carries
  `profile_id`; a profile does not need a login.
- A **login** is an authentication identity with an `admin` or `member` role.
  Members reach profiles through `login_profiles`; admins can reach every
  profile.
- A session has one active profile. The header switcher changes it through
  `setActiveProfile()`.
- A login may designate an accessible profile as its own through
  `logins.own_profile_id`. Caregiver-only logins may leave this unset.

`lib/auth.ts` owns sessions and access checks. Request paths use the async
scrypt helpers in `lib/password.ts`; the synchronous hash helper is for
bootstrap and seed work only. The bootstrap admin and first profile are created
by `bootstrapAuth()` in `lib/migrations/boot-tasks.ts`, not by `lib/db.ts`.

`middleware.ts` is only a coarse Edge check for cookie presence. Node code must
still call `requireSession()`, `requireAdmin()`, or the appropriate write-access
gate. Keep the session-free route list centralized in `lib/public-paths.ts`;
do not duplicate it in middleware or documentation.

### Profile scoping

Single-profile business functions take `profileId` as their first argument.
Pages and actions resolve it at the auth boundary. Every SQL statement touching
a profile-owned table must filter by `profile_id`; child tables scope through a
join to their parent. `lib/__tests__/profile-scoping.test.ts` enforces this, and
legitimate exceptions require a documented allowlist entry.

Cross-profile pages resolve `requireScope()` once and pass the resulting
`ProfileScope` down as data. It contains:

- `actingProfileId`
- persisted, access-validated `viewIds`
- the accessible `ids` and disambiguated `profiles`
- access by profile
- the access-validated `ownProfileId`, or `null`

A cross-profile reader takes the already-authorized `ids: number[]` as its
first argument and does not import `lib/auth`. Set-based
`WHERE profile_id IN (…)` SQL must use `profileIdsIn(ids)` inside a module
registered in `CROSS_PROFILE_SQL_MODULES`. Per-profile context such as timezone,
age gates, and week mode is still evaluated separately for each profile.
`ProfileScope` is data, not a substitute for a write authorization check.

## Commands

Node 24 is required and pinned in `.nvmrc`.

```bash
npm run dev              # development server on http://localhost:3000
npm run seed             # realistic sample data
npm run build            # production build and TypeScript gate
npm run lint             # ESLint
npm run typecheck        # next typegen && tsc --noEmit

npm test                 # pure unit tests
npm run test:watch       # pure unit tests in watch mode
npm run test:coverage    # pure unit tests with their coverage floor
npm run test:db          # DB integration and Server Action tests
npm run test:db:coverage # DB/action tests with their coverage floor
npm run test:e2e         # Playwright browser tests

npm run format           # Prettier write
npm run format:check     # Prettier check
npm run schema:dump      # print the migrated sqlite_master schema
```

Run an individual pure test with:

```bash
npx vitest run lib/__tests__/strength.test.ts
npx vitest run -t "estimate1RM"
```

CI runs formatting, lint, type checking, PHI scanning, a non-blocking full
dependency audit plus a blocking high-severity audit gate, both coverage-gated
test tiers, changed Playwright specs repeated three times at zero retries, and
the full browser suite in four shards. Documentation-only changes skip the
browser matrix. `.github/workflows/e2e-full.yml` provides the manually
dispatched full-suite census. Pre-commit runs Prettier through lint-staged and
`phi-scan --staged`.

## Architecture

Business logic lives in `lib/`; App Router pages, route handlers, and Server
Actions live in `app/`; shared UI lives in `components/`. The `@/*` alias maps
to the repository root.

- `lib/db.ts` opens SQLite and orchestrates boot.
- `lib/types.ts` is the source of truth for shared record shapes.
- `lib/queries.ts` is a compatibility barrel over domain modules in
  `lib/queries/`.
- `app/**/actions.ts` owns request-boundary writes, validation, unit conversion,
  authorization, and cache revalidation.

Server Components normally read through the query layer and pass data to client
components. SQL remains inline through `db.prepare(...)`; there is no
repository or ORM layer.

Modules are named after the surface they serve. The Longevity page (`/longevity`)
reads through `lib/queries/longevity.ts` over the pure `lib/longevity-pillars.ts`;
"healthspan" remains the domain term for that model and stays in the persisted
dashboard widget id `healthspan-pillars`.

### Database and migrations

`createDb()` runs `runMigrations(db)` and then `bootTasks(db)`. Migrations in
`lib/migrations/versions/` are ordered, append-only, and keyed by
`PRAGMA user_version`. Migration 001 is the frozen clean baseline from the
runner's introduction; a fresh database reaches the current schema by applying
that baseline and every later migration. The hash manifest makes shipped
migrations immutable.

For every schema change:

- Add a new table or column with a new migration.
- Grow a `CHECK` enum or add a foreign key with a rebuild migration.
- Put one-shot data moves in a migration, not a settings flag.
- Never edit `001-baseline.ts` or another shipped migration.
- Add a new profile-owned table to `lib/owned-tables.ts`.
- Null dangling links before rebuilding a table to enforce a foreign key.

The runner applies migrations in individual immediate transactions, guards
against a newer database being opened by older code, and temporarily disables
foreign-key enforcement for safe SQLite table rebuilds. Per-boot work such as
auth bootstrap, canonical biomarker reconciliation, cleanup, and timezone
seeding belongs in `boot-tasks.ts`, outside the versioned runner.

See `docs/versioned-migrations-spec.md` for the design and history.

### Observation-shaped data

A new dated reading or observation should reuse an existing store:
`symptom_logs`, `metric_samples`, `body_metrics`, or `medical_records`. Do not
create a parallel table for a vocabulary extension.

Every observation ingest and read path must use the shared substrate:

- `isEditLocked` so sync cannot overwrite a manual correction
- `classifyUpsert` and `tallyUpsert` for inserted/updated/unchanged accounting
- `latestByGroup` with the domain's canonical identity function

`lib/__tests__/observation-substrate.test.ts` guards this boundary.

Reading a dated reading is a question about a QUANTITY, not about a table. One
`Reading` shape keyed by #482 identity spans `body_metrics`, `metric_samples`, and
`medical_records` (`lib/reading-model.ts`, presented by `lib/queries/readings.ts`),
and one lookup — `metricJudgment(identity, subject)` — resolves the clinical
knowledge for it whatever store it came from. Every registered metric declares its
knowledge source, or an explicit `none` with a reason, in `METRIC_KNOWLEDGE`.

WRITING one is the same question. `placeReading()` (`lib/reading-placement.ts`)
decides the physical store from the identity plus whether the reading carries
clinical provenance — provenance forces `medical_records`, otherwise a registered
stream, otherwise `medical_records`, and no identity is refused rather than
defaulted. `lib/reading-writes.ts` executes it and owns the ONE editability
contract: edit and delete route by a `ReadingTarget` taken from the row, not by
the surface's own key. A surface names a quantity or a row; it does not name a
table. Neither phase changes schema — the physical merge is a separate, later
decision. See `docs/internals/reading-model.md`.

### Weekly cadence

"How did this target do in week W?" is ONE question over `frequency_targets`, keyed
on `target.id`. `lib/queries/cadence-ledger.ts` is its only reader; the current-week
rollup, the completed-week history and both substance reads are adapters over it,
distinguished by declared options, not by forked modules. `lib/cadence.ts` owns the
axes: `CADENCE_SCOPES` (source, grain, direction), total over `FREQUENCY_SCOPE_KINDS`
by the type, and the floor/cap verdict vocabulary.

Substance caps are a `direction: "cap"` TENANT, not a fork. The #998 anti-nudge rule
lives in the vocabulary now: a cap verdict has no to-go or pace state, under-cap is
its success state, and `cadenceToGo` is null for it. Select tenants by direction —
never by subtracting a scope kind. See `docs/internals/cadence-ledger.md`.

Calendar grids and lens windows are the same discipline one level down:
`dayGrid()` (`lib/day-grid.ts`) lays days on a 7×N grid for every heatmap and
calendar, with the payload and level function supplied by the caller; `lensWindow()`
(`lib/trends.ts`) resolves the Trends hub's shared `DateRange` to one anchor, with
only the per-lens week caps supplied.

### Instants and days

"When did this happen?" (an INSTANT) and "which day does it count for?" (a
profile-local `date`) are DIFFERENT questions, and a day is not a lesser instant
— #94's day attribution is what dose, adherence, cadence and the digest key on,
and `date` semantics are untouched by the time-model work.

An instant is stored as `2026-07-15T20:02:03Z` — UTC, second resolution,
explicit `Z` — and `lib/date.ts` is the only place an app write path may produce
one: `utcInstant` for a column on that convention, `utcSqlString` for one still
on SQLite's bare shape, with `instantNow`/`sqlNow` as the `lib/clock.ts` seam
wrappers. Never hand-build a timestamp string and never let SQL's own
`datetime('now')` write or compare a converted column — comparison is LEXICAL,
so a bare value and a `Z` value in one column answer wrong while every query
still looks right. `lib/__tests__/instant-writer-scan.test.ts` is the ratchet;
its `CANONICAL_INSTANT_COLUMNS` registry is grown by the migration that converts
a column, in the same change as that column's readers. See
`docs/internals/time-model.md`.

READING a row's time is a question about the ROW, not about a column.
`lib/time-columns.ts` declares what every temporal column means (semantic, grain,
convention) and is verified against the migrated schema, so a new table with an
undeclared temporal column fails CI and the published index
(`docs/internals/time-columns.md`, `npm run gen:time-columns`) cannot rot.
`lib/row-instants.ts` asks the question over it: `eventInstant`, `recordInstant`,
`bestKnownInstant`, `rowLocalDay`. Never hand-roll `COALESCE(recorded_at, taken_at)`
or `eaten_at ?? logged_at` again — a ledger in
`lib/__tests__/time-columns.test.ts` freezes the ones that remain.
`eventInstant` NEVER falls back to the record instant: a row that states no event
time returns an explicit absence with a reason, because answering it with the tap
stamp is what turns a distribution of eating times into one of tapping times. A
caller that genuinely wants the best available instant calls `bestKnownInstant`,
which reports which column it used. `localDayOf` stays the single instant→day
path.

INGESTING one is a third question, asked at the door before any destination is
known. `lib/source-time.ts` owns it: both clinical-document parsers return a
`SourceTime` — `day`, `instant` (a time AND an offset), or `local` (a time with
NO offset, which a `string | null` return can never express) — and the
DESTINATION narrows, through `sourceDay` or `sourceInstant`. Preserve at the
source's own grain; narrow per the grain the destination declares. A day-grained
destination takes the source's own stated digits and never the offset:
`20260101003000+0900` is the day 2026-01-01 AND the instant 2025-12-31T15:30:00Z,
and both are right. A `local` source leaves an instant column NULL — never
resolve a zoneless clinical clock against the profile's timezone.
`lib/__tests__/ingest-narrowing-scan.test.ts` is the ratchet: a frozen ledger of
the ingest parsers that still narrow, each with a reason, whose count may only
shrink.

### Freshness

"Is this dated reading still current?" is ONE question too. `lib/freshness.ts`
owns the decision (`FreshnessState` = `current` / `due` / `not-applicable`, stale
strictly after the interval) and the counting shape (`FreshnessTally`). A domain
supplies only what is genuinely its own: WHICH interval applies and WHICH readings
are exempt from carrying a clock at all. `biomarkerRetestStatus` is the biomarker
adapter (its category grammar and #516/#548/#687 exemptions stay there);
`lib/fitness-freshness.ts` is the fitness-battery adapter, where every test
DECLARES its policy and a completeness test fails an undeclared one. Never
re-derive staleness in a component, and never fold `not-applicable` into `due`.

An aggregate with nothing current may not render current-shaped copy
(`hasNoCurrentReading`) — the Longevity optimal pillar goes neutral, the Fitness
check counts fresh rather than measured. Both keep the stale values visible with
their provenance: the fix is what the aggregate CLAIMS, never what it hides.
Phrasing stays per surface. See `docs/internals/freshness.md`.

### Settings and units

Settings have three storage tiers:

- global `settings`: server-wide configuration such as provider credentials,
  bot configuration, public URL, AI configuration, and instance defaults
- `login_settings`: display preferences and delivery channels that belong to a
  person/device, including Telegram enablement, chat ID, and push preferences
- `profile_settings`: health facts, timezone, schedules, content preferences,
  and other data-subject settings

The UI is topic-first, not tier-first. `lib/settings-groups.ts` is the single
registry for Settings navigation. `adminOnly` hides navigation but never
replaces `requireAdmin()` on the page or action.

Settings → Notifications is intentionally mixed-scope: delivery channels are
login-scoped, schedules and message content are primarily profile-scoped, and
the instance Telegram bot configuration is server-scoped. Save login Telegram
configuration through `saveLoginTelegram`; the old profile-scoped Telegram
channel keys were retired by migration 105.

Canonical storage uses kilograms, kilometers, and the documented time units.
Convert only at the boundaries: `toKg`/`toKm` on write and the helpers in
`lib/units.ts` on display. Unit preferences belong to the login.

The kilogram and kilometer halves of that rule are **types**, not review. `Kg` and
`Km` (`lib/units.ts`) are compile-time brands, `toKg`/`toKm` are their ONLY minters,
and the storage writers demand them: `NormBodyMetric.weight_kg`,
`DocBodyMetric.weight_kg`, `NormActivity.distance_km`, the manual activity path's own
`distance_km`, and `recordReading`'s `value` whenever its `unit` is `"kg"` or `"km"`.
A surface handing display-unit pounds to storage does not compile. There are three
ways to satisfy a branded field, all of them a minter call: convert a display value
(`toKg(entered, unit)`); declare an already-canonical number canonical — a value read
back out of the database, a provider payload the API documents in kg —
(`toKg(v, "kg")`, the identity conversion, free at runtime); or re-mint a value
derived by ARITHMETIC from canonical ones, since summing erases the brand. Never
reach for a cast. Reads stay unbranded: a value coming out of storage is canonical by
construction, and the brands guard the direction where the mistake is silent.
`lib/__tests__/canonical-unit-brands.test.ts` holds the minters' unit tests and one
`@ts-expect-error` per narrowed writer.

### Biomarkers and AI

Canonical biomarker ranges come from `lib/canonical-biomarkers.json`.
`reconciledFlag()` derives flags, and the boot tasks use
`lib/canonical-flags-version.ts` to reprocess existing records when canonical
ranges or flag logic change.

A curated `CANONICAL_ALIASES` route is never inert. `buildCanonicalIndex` lets a
real entry win a key collision, and an ai-coined vocabulary row counts as one —
so the spelling a document taught the vocabulary used to shadow the very route
added to retire it (#2306). `mergeSupersededCanonicalNames` retires an `ai` row
the vocabulary has superseded (shadowed by another entry, or blocking a route)
and re-points its stored readings AND everything keyed on that name — the ★
save, the retest/flag dismissals, a biomarker goal, a coverage gap, a protocol
outcome. It runs both as migration 174 (the drift already on disk) and as a boot
task after `seedCanonicalBiomarkers` (aliases ship without schema changes). A
`seed` row is untouchable and a route with no target is never followed.

AI insights and extraction use `@anthropic-ai/sdk`. The default
`HEALTH_AI_MODEL` is `claude-sonnet-5`. Missing credentials must degrade
gracefully. Medical document ingestion is orchestrated by
`lib/medical-pipeline.ts`; extraction internals are exposed through
`lib/medical-extract.ts`.

AI events go to `data/logs/ai.jsonl` with login/profile context when available.
The viewer is admin-only under Settings → Logs & audit → AI logs. Medical
uploads are stored per profile, served with both row ID and `profile_id`
scoping, and deduplicated per profile.

See `docs/ai.md` for provider, logging, and extraction details.

### Integrations

`lib/integrations/registry.ts` is the provider registry. Current entries include
Health Connect, Strava, Oura, Withings, Fitbit Takeout, Weather & UV, Calendar
feed, and the planned Garmin integration.

A provider also declares its **continuous streams** there — the ones expected to
keep arriving minute after minute while a device is worn — beside
`silenceToleranceMinutes`, read only through `lib/integrations/continuous-streams.ts`.
That tolerance is about the CONNECTION; a stream declaration is about the DATA, and
the two are independent: a phone can keep pushing aggregates while the watch feeding
heart rate is off a wrist. `quietStreamVerdict` (#2146) reports that — stream silent
past its DECLARED dip tolerance _while the provider kept syncing ok in that window_,
which is the clause that keeps it disjoint from #1685 staleness — with no stored
state, and it renders on Data → Review only: it is coaching tier and never a send.
A provider with no continuous stream declares none and is exempt by construction.

Sync and import behavior must remain idempotent:

- deduplicate on natural source keys
- never overwrite a manually edited imported row
- record every sync with inserted/updated/unchanged counts
- keep Data → Review and its failure badge consistent with sync events

See `docs/internals/integrations-sync.md`.

### Notifications

The notification tick (every 5 minutes in the Docker sidecar — an operator
choice, offered in divisors of 60; any steady rhythm
up to hourly works — it observes its own cadence) can deliver through Telegram,
Web Push, Home Assistant, and email (login-scoped, content-free by default —
see `docs/internals/email.md`). It evaluates dates and slots in each profile's
stored timezone; slot times are minutes of day, stored as `"HH:MM"`, and a slot
gets exactly two due attempts a day, an hour apart, at every tick rate
(`slotAttempt`, `lib/notifications/schedule.ts`).

Refill, preventive, and workout nudges share the Upcoming suppression bus and
use the same `dedupeKey` as their visible finding. Dose reminders and missed-dose
escalations are safety signals and must never be silenced by an Upcoming
dismissal. Suppression policy flows through `isHiddenUnderPolicy`.

Every `notify_*` send marker is declared in `SEND_MARKER_REGISTRY`
(`lib/notifications/send-markers.ts`) with its class, cadence, settings tier and
the sweep that clears it; a source scan fails any undeclared `notify_` key, and a
key whose tail is interpolated must mint through a builder there. The send /
freeze / self-healing-sweep decision is `planNudgeCadence`
(`lib/nudge-cadence.ts`) — the refill, preventive, illness-care and follow-up
planners are adapters over it, not four copies.

Delivery health is stored in `notify_lifecycle` and follows the shared
set/clear/freeze decision in `lib/notifications/delivery-status.ts`. Clear an
error only after a healthy dispatch actually attempted the affected channel.
All outbound Telegram writes go through `lib/notifications/telegram.ts`; it is
the only module allowed to import the raw Telegram API primitives.

Inline notification actions carry IDs only and return typed outcomes. Never
confirm success unconditionally when the underlying write can refuse or no-op.

A tick is not a request, so `cache()` (`lib/request-cache.ts`) is identity in it.
Per-tick memoization goes through `lib/tick-cache.ts`: `scripts/notify.ts` opens
one scope per profile, and a repeated heavy gather declares `tickCached` beside
its `cache()`. Do not reach for a TTL memo here — a scope, not a duration, is
what lets a safety counter be memoized at all.

See `docs/internals/notifications.md`.

### Supplements and medications

Supplements and medications share `intake_items`; do not split their common
dose, adherence, refill, interaction, or warning machinery. Supplements render
at `/nutrition?tab=supplements`; medications render at `/medications`. The
former combined `/medicine` route is gone and 404s. Use `intakeHref(kind)` for
kind-to-surface links.

One user-owned field, **`obligation`** (`must`/`should`/`may`), decides push and
adherence; it replaced both `priority` and `as_needed` in migration 124. `must`
reminds and escalates, `should` reminds and counts but never escalates, `may` has
no dueness at all — never pushed, never missed, tracked in the ledger and always
one tap away. `kind` decides CLINICAL identity (which safety engine, which
surface, passport inclusion), not pushability; medications default to `must` and
moving one lower needs an explicit consequence-stating confirm.

Important invariants:

- A `may` item is never scheduled-due (it absorbed PRN).
- Editing a dose must not rewrite adherence history.
- A removed dose with logs is retired rather than deleted.
- Confirming a dose snapshots the amount onto the log.
- `markDoseTaken` may refuse retired doses or paused items; callers render its
  typed outcome.
- Obligation is declared only, forever: context gates dueness but never invents
  obligation, and nothing writes the field without a user action. The demotion
  engine detects and SUGGESTS; the user's tap is the write.
- A `may` item is COLLAPSED on aggregates, never filtered out — removing it would
  make an accepted demotion indistinguishable from a deletion.

See `docs/internals/supplements.md`.

### Health endpoint

`app/api/health` is public and deliberately coarse. It returns 503 for database,
write, cached-integrity, or configured backup-staleness failures without
exposing paths, versions, or health data. Keep status composition in
`lib/health-status.ts`; the endpoint itself must stay cheap.

### Deploys and deployment skew

A deploy leaves open tabs on a build the server no longer serves. The service
worker installs and **waits** rather than taking over, one merged pending state
raises one "Update ready" bar, only the tab that tapped ever reloads, and a
waiting worker for the build the page already runs — found waiting at load, or
installed by the page's own registration just after it — is consumed silently
instead of re-offered. A tab that navigates while still stale hits a deleted chunk; the
top-level error boundary recognises that signature and hard-reloads **once**,
under a rationed `sessionStorage` guard, before rendering any card. A tab that
keeps SAVING while stale fails every Server Action (the ids are build-keyed);
`isStaleActionError` classifies that signature, `shouldQueueOffline` treats it
like a dead connection so quick-log taps queue and replay through the
build-stable replay route, and the activity editor keeps its local draft (live
mode included) and banners the reload instead of erroring in place.

Every one of those decisions is pure and lives in `lib/sw-update.ts` (with the
theme half in `lib/theme.ts`, which `app/global-error.tsx` needs because it
replaces the root layout and its theme-boot script). Do not re-derive
"is an update pending" or "is this skew" in a component.

See `docs/internals/deploy-skew.md`.

## Testing conventions

The repository has three execution tiers:

1. Pure tests in `lib/__tests__/` run through `npm test`. They do not open a
   database or use the network.
2. DB and Server Action tests in `lib/__db_tests__/` and
   `lib/__action_tests__/` run together through `npm run test:db`.
3. Browser tests in `e2e/*.spec.ts` run through Playwright against isolated,
   seeded SQLite databases.

Extract pure decision logic into `lib/`. Add a DB-tier test for SQL, migrations,
query composition, or a Server Action write/auth path. Every findings builder
must have a realistic DB fixture that asserts its end-to-end output and
registered dedupe-key prefix.

Every rendered UI feature must add or extend a browser test. The E2E harness
seeds a template once, gives each worker its own database and `next start`
server, and freezes the run's clock. Specs import `test` and `expect` from
`./fixtures`, use `workerDbPath()` for direct SQLite access, and use
`frozenNow()` instead of wall-clock time.

Use stable test IDs and the settled interaction helpers in `e2e/helpers.ts`.
Do not add `waitForTimeout`, `networkidle`, or an unmarked `.first()` on a shared
surface. A test owns its fixture data and must not exact-count shared seed rows.
Do not write redundant assertions or defensive assert checks for conditions
already proven by types or prior control flow.
See `docs/internals/e2e-hygiene.md`.

## Implementation conventions

### Writes and concurrency

- Use `writeTx`, never raw `db.transaction`, for application writes. It begins
  `IMMEDIATE`, retries only transaction acquisition, and keeps callbacks
  synchronous.
- Use `readTx` when several reads must share one snapshot.
- Ordinary edit forms are last-write-wins. Counter-like, lifecycle, and
  access-control fields need atomic transitions or compare-and-swap.
- `lib/` write cores are auth-blind. They take `profileId` first and never import
  `lib/auth`; the Server Action performs authorization and validation.
- Server Action records pass serializable data only. Do not return a
  `better-sqlite3` row proxy to a client component.
- Never call `router.refresh()` after awaiting a Server Action that revalidates:
  any `revalidatePath`/`revalidateTag` makes the action response carry a freshly
  rendered current page, so the refresh is a second full fetch. A refresh is only
  correct when no action response backs it — a route-handler `fetch`, a poll, a
  user gesture, or an action that deliberately skips revalidation while still
  writing what the page shows. Survivors carry a one-line reason.
  See `docs/internals/server-action-refresh.md`.

### Forms and UI

- Settings autosave on blur/change through the existing save-status helpers.
  Record forms use explicit submission.
- Free-text notes render through `<NotesText>`.
- Nav rows are `<PendingNavLink>`, not a bare `<Link>`. `(app)` ships no
  `loading.tsx` (see the layout comment and #530), so a router transition has no
  Suspense boundary to reveal and a tap has no visible consequence until the
  whole destination has rendered — which is what made people tap again, and each
  extra tap discards the render already in flight. The row reports
  `useLinkStatus()` and absorbs a repeat tap; `lib/nav-click.ts` owns which
  clicks count as repeats (never a modified or middle click).
  See `docs/internals/nav-pending.md`.
- An icon-only button carries both `aria-label` (specific accessible name) and
  `title` (short hover tooltip); `lib/__tests__/icon-button-tooltip-scan.test.ts`
  enforces it.
- Pages that cap width use `<PageContainer>` and its named widths — never a
  hand-written `mx-auto max-w-*` and never a `max-w-*` smuggled through its
  `className`; `lib/__tests__/page-width-scan.test.ts` enforces it and reads
  the vocabulary out of the component.
- Responsive variants share one content component; do not maintain separate
  desktop/mobile copies of the same feature.
- Chart colors come from `lib/chart-colors.ts`, and charts use the shared
  scaffolding in `components/chart-scaffold.tsx`. See
  `docs/internals/charts.md`.
- A DAY-GRAIN series is densified to the CALENDAR before it is plotted
  (`lib/day-fill.ts`, the day twin of `lib/weekly-fill.ts`): on a recharts
  category axis x is the array INDEX, so a missing day that is not in the array
  compresses away and a multi-day outage renders as consecutive days. Leading
  empty days are trimmed, trailing ones to the window's end are KEPT — that run
  of nulls is the live outage. Whether a filled day is a `null` hole or a real
  `0`, and whether the mark bridges it, is a per-SERIES declaration beside the
  mark decision in `lib/trend-sparkline.ts` (`metric:` / `bio:` keys); a surface
  passes `gapFill={{ seriesKey, from, to }}` and never a policy of its own.

### Routes and APIs

- New route-handler errors use `{ ok: false, error }` with an appropriate status.
  HTTP 500 messages shown to clients stay generic; log the detailed cause through
  `createLogger()`.
- Internal route fields and props use `AppRoute`. Add an href helper only when
  it owns routing policy; otherwise use the typed literal.
  `lib/__tests__/typed-route-props.test.ts` fails any `href`/`…Href` field
  left as `string`, with an allowlist for external URLs and live pathnames.
  `AppRoute` only HAS a route union when Next's generated `.next/types/routes.d.ts`
  exists — it falls back to `string & {}` silently, accepting every dead literal —
  and `/.next/` is gitignored. So `npm run typecheck` generates the route types
  before it runs `tsc` (#2293), at a measured ~1s. Do not strip it back to a bare
  `tsc`, and if a route literal ever stops being checked, look there first.
- A directory under `app/(app)/` implies a served route. Components and Server
  Actions for a surface live under the route that renders them (or in
  `components/` when several surfaces share them) — never under the name of a
  route that no longer exists.
- Cache revalidation goes through `revalidateRoute` (`lib/revalidate.ts`), never
  Next's raw `revalidatePath`. The wrapper's parameter is Next's generated route
  union, so every target — single, interpolated, or inside an array fan-out — is
  compile-checked, and a dead one fails `npm run build` at the call site instead
  of reaching production as a silent no-op refresh (#1636/#2149). A list declared
  away from its call site is typed `readonly RevalidateTarget[]`; a dynamic
  route's `[param]` literal is stored through `revalidateTarget`, the same
  check-then-widen pattern `lib/hrefs.ts` uses for dynamic hrefs. The old text
  sweep in `lib/__tests__/nav-routes.test.ts` is demoted to one assertion: nothing
  outside the wrapper imports `revalidatePath`.
- Removing or merging a route does not earn a compatibility redirect. The legacy
  redirect table was deleted in #1635 and `next.config.js` ships none; a retired
  URL 404s, and adding a redirect back is a per-case product decision, not the
  default. Auth-flow and tab-default redirects are current-IA plumbing, not
  compatibility shims, and stay.

### Shared behavior and data integrity

- One question gets one computation. If pages, widgets, and notifications show
  the same value, they format one pure `lib/` result.
- Row merge, reassign, delete, and restore operations must also handle children,
  nullable links, provenance, tombstones, saved/dismissed side-state, and
  filesystem artifacts.
- Every table written by document import must stay represented in imported-row
  cleanup, document reassignment, and extracted-count accounting.
- A **day counter** — one row per (profile, date, identity) holding a running
  amount — goes through `dayCounterLedger` (`lib/day-counter-ledger.ts` +
  `-db.ts`), never a hand-written copy. The ledger owns the additive upsert, the
  guarded clamped decrement, the drop-at-zero, and the authoritative re-select as
  one thing; the call site keeps catalog validation, typed outcomes, its event
  rows, and its `writeTx`. `DAY_COUNTERS` declares the tables (`food_log`,
  `substance_log`, `protein_log`); the undo path builds its ledger from the same
  `CounterSpec` the undo registry declares, so the write side and the undo side
  cannot drift.
- Identity families use one canonical pure function everywhere (movement facts
  key on `exerciseHistoryKey`; load-sensitive strength facts on
  `strengthLoadKey`/`movementLoadKey`; biomarker identity on `biomarkerFamily`,
  which SQL reaches through the `biomarker_family()` user function). Labels must
  include the attribute that actually distinguishes otherwise identical choices.
- Additive writes may stay plain; **lifecycle writes render from state**. A
  one-tap affordance over a transition (period start, episode close, live
  session, supply counter) renders a shared offer state so its label names the
  write it will perform, and its write core enforces the same conditions with
  typed refusals. `lib/stateful-writes.ts` (`STATEFUL_WRITE_TABLES`) registers
  the gated tables; the scan in `lib/__tests__/stateful-writes.test.ts` fails any
  raw `INSERT`/`UPDATE`/`DELETE` reaching past a registered core. The scan
  guarantees no silent corruption; the audit upgrades refusals into good UX. Do
  not "upgrade" genuinely additive affordances (weight, food servings). See
  `docs/internals/stateful-affordances.md`.
- Findings have an explicit reach policy: care findings may reach Upcoming,
  attention surfaces, and notifications; coaching findings stay in calm,
  hideable surfaces. See `docs/internals/findings.md` — which also holds the **attention doctrine**:
  the surface taxonomy (system-initiated sends / rendered aggregates /
  user-initiated access), the contact-consent rule (the system may reduce contact
  unilaterally, never increase it or rewrite user-owned state), which domains can
  carry an obligation at all, and the right-sizing family every "the system
  noticed X" suggestion belongs to.

## Repository hygiene

- Run Prettier before handing off changes; ESLint uses the flat
  `eslint.config.mjs`.
- Keep matching docs current in the same change as a feature, route, setting, or
  integration.
- Every `docs/*-spec.md` file has an honest top-level `Status:` line:
  `draft`, `partial (...)`, or `shipped`.
- Never put real PHI in the repository. Fixtures must use clearly fictional or
  reserved data. `phi-scan` runs in CI and pre-commit, but the scanner is not a
  substitute for review.
- Never put a realistic-looking credential in a fixture, including in a test
  that exercises redaction — `redactSecrets()` keys off the FIELD NAME, so an
  obviously-fake low-entropy placeholder proves the same behavior. The secret
  scan runs `gitleaks git --log-opts="--all"`, i.e. over every ref in the
  checkout, so one such value in one commit on one branch fails the gate on
  every open PR in the repo until that commit leaves the remote.
- When adding a domain, start from the default shapes in
  `docs/internals/design-doctrine.md` — new data is an instance of an existing
  substrate before it is a new table — and update seed data and the relevant
  registries, import cleanup lists, navigation, and tests together.

## Deploy

Production runs in Docker. `docker-compose.yml` pulls
`ghcr.io/floorlamp/allos`; `.github/workflows/deploy.yml` publishes `latest`
and commit-SHA tags on pushes to `main` and on manual dispatch. Deployment on
the host is a manual or scheduled `docker compose pull && docker compose up -d`.

Persistent data lives under `/app/data`, bind-mounted from `DATA_DIR`. Keep that
directory outside the checkout. See README **Quick start with Docker** for the
operator setup.
