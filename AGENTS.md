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
the full browser suite in twelve shards. A change with NO RUNTIME SURFACE skips
the browser matrix — prose, `.claude/skills/`, the orchestration tooling under
`scripts/orchestration/`, and the two unit tiers' own directories
(`lib/__tests__/`, `lib/__db_tests__/`, `lib/__action_tests__/`) — none of which
anything in the app or the e2e harness imports. The rest of `scripts/` is not
exempt: `seed.ts`, `notify.ts` and the `gen-*.ts` generators feed the app and its
fixtures. Neither is the rest of `lib/`: the rule keys on PATHS, so a
comment-only edit under `lib/queries/` still runs the matrix, which is the right
conservative answer rather than a gap. Grow that set only against the question
"what imports this" — and only with a guard, because a claim about imports rots
silently. `lib/__tests__/ci-skip-set.test.ts` reads the regex out of the workflow
and fails a test-directory entry the moment a non-test module imports from one. `.github/workflows/e2e-full.yml` provides the manually
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

`db.prepare(...)` COMPILES the statement on every call, and compilation is the
half of the cost nobody counts. A render issues thousands of statements against a
couple of hundred distinct SQL texts, so it pays to compile the same query
hundreds of times: `/household` spent 720ms compiling against 237ms executing, in
a 1288ms render, and `getProfileSetting` alone recompiled its one-line SELECT
10,600 times. A read on a HOT PATH therefore declares its SQL through
`hoistedStatement()` (`lib/db.ts`), which compiles once per connection and reuses
it. Hot means: reached once per profile on a cross-profile surface, reached per
row/day/item inside a loop, or reached through a helper many unrelated callers
share — an age gate, a timezone, a settings key.

Hoisting caches the COMPILED STATEMENT, never the value, so a read-after-write in
the same request still sees the write. That is what makes it safe where `cache()`
is not, and why it is the DEFAULT answer to a repeated read. Request-scoped
`cache()` is the second, narrower tool: reach for it only when the same read
repeats with the SAME arguments and no writer can intervene, and give the reason
beside it (`getUnitPrefs`, `getTimezone`, `getProfileBirthdate` each carry theirs).
A read the surface genuinely needs once per profile is not a duplicate at all —
it is fan-out, and hoisting is its whole fix.

Modules are named after the surface they serve. The Longevity page (`/longevity`)
reads through `lib/queries/longevity.ts` over the pure `lib/longevity-pillars.ts`;
"healthspan" remains the domain term for that model and stays in the persisted
dashboard widget id `healthspan-pillars`.

### Database and migrations

`createDb()` runs `runMigrations(db)` and then `bootTasks(db)`. Migrations in
`lib/migrations/versions/` are ordered, append-only, and **name-keyed**: the
applied set lives in the `schema_migrations` ledger (created by the runner
itself), and the `MIGRATIONS` array in `versions/index.ts` is the single
ordering authority. Migrations 001–185 are the CLOSED numbered era — their ids
are frozen and `PRAGMA user_version` survives only as a monotonic applied-count
tripwire (it makes pre-ledger builds refuse a newer database, and feeds the
backup/restore version gate). Migration 001 is the frozen clean baseline from
the runner's introduction; a fresh database reaches the current schema by
applying that baseline and every later migration. The hash manifest makes
shipped migrations immutable.

For every schema change:

- Add a new table or column with a new migration: a `YYYYMMDD-slug.ts` file
  exporting `{ name: "YYYYMMDD-slug", up }` (no `id` — the runner refuses a
  numbered migration after the name-keyed era began), appended LAST to the
  `MIGRATIONS` array, with its sha256 added to `manifest.json`. Two branches
  adding migrations conflict only in `index.ts`, and the resolution is keeping
  both sides — the merge order becomes the order.
- Grow a `CHECK` enum or add a foreign key with a rebuild migration.
- Put one-shot data moves in a migration, not a settings flag.
- Never edit `001-baseline.ts` or another shipped migration.
- Add a new profile-owned table to `lib/owned-tables.ts`.
- Null dangling links before rebuilding a table to enforce a foreign key.

A one-shot row-move migration that DELETES rows declares the (table, column)
child links that must block a delete, and probes each with `PRAGMA table_info`
so it can run against every historical schema shape. That probe cannot tell "this
database predates the table" from "this pair is a typo", so a misnamed entry drops
out silently and the guard covers nothing while still reading like a guard —
migration 180 shipped with three of four entries naming columns that have never
existed, and deleted rows a live care-plan follow-up still referenced (#2444).
A typo is only visible against the FINAL migrated schema, so that is where it is
checked: `lib/__db_tests__/migration-child-links.test.ts` reads every migration's
link literals, fails an unknown pair, and pins the non-cascading FK parents of
`medical_records`. The frozen entries a hash-locked migration cannot un-name are
allowlisted there with the corrective migration named beside them.

That registry is HALF the delete story, and its silence used to read as coverage
(#2680). It covers the NON-CASCADING parents — the links that must BLOCK a
delete. The CASCADING children are the opposite obligation, clean up rather than
block, and the runner cannot discharge it: migrations apply with
`foreign_keys = OFF` (below), so `ON DELETE CASCADE` fires for NOTHING and a bare
`DELETE FROM parent` inside a migration orphans children the same delete at
runtime would remove. `deleteRowsWithCascade()` (`lib/migrations/cascade-delete.ts`)
is what a row-deleting migration calls instead, and its links are DERIVED from
`PRAGMA foreign_key_list` at apply time rather than transcribed — nothing is
spelled twice, so a #2444 typo is impossible, and when migration N runs the graph
it reads is the graph as of N, which a frozen literal could not be. The same test
file pins the cascading children of `medical_records` and fails a new migration
that deletes from a cascade parent without the helper; migration 118 is the
precedent that did it by hand, and `20260813-cascade-orphan-sweep` clears the
orphans 180 and the BMI migration left — logging the per-link tally, because a
boot-time delete of health records with no backup behind it and no undo has to
leave a record of what it took.

That ratchet is the whole argument for a helper with no production caller, so it
is judged per STATEMENT and FAILS CLOSED. There is no file-level exemption —
importing the module used to excuse every hand-delete in the file, and merely
naming it in a comment did the same — and a `DELETE FROM` whose table the scan
cannot resolve to a literal is a violation, not a skip, because a delete it
cannot read is not a delete it may ignore. It still sees DELETE statements only;
a table rebuild copying a filtered subset into `<t>_new` orphans identically with
no `DELETE` token anywhere, and no lexical rule is complete over that class
(#2703) — a `WHERE`-sniffing rule misses a filtering delete on the NEW table,
which has no inbound foreign keys yet, and a partial guard reading like a total
one is #2444 one level up. So that half is BEHAVIOURAL and lives in the runner:
after each migration it applies, `runMigrations` compares
`PRAGMA foreign_key_check` against the baseline before it and names any migration
that ADDED a dangling reference, whatever shape produced it. A DELTA, because the
pragma legitimately reports `SET NULL` danglers a healthy install keeps, and a
boot complaining about the default posture forever is the standing-alarm shape.
A REPORT, never a refusal: the rows are dead weight rather than corruption, the
migration's transaction has already committed so a throw would only half-upgrade
the database, and the fix is a forward migration calling
`sweepOrphanedCascadeRows()` — prescribed only for the CASCADE links that sweep
can clear, never for the SET NULL ones it deliberately keeps. It costs a fresh
install nothing (190 checks over a database with no rows) and an established one
one check per NEW migration, so it fires where the data actually is: an operator's
install, and a developer's own seeded database.

Three things about the delta are load-bearing and were each wrong first. It is
keyed on the RESOLVED COLUMNS, never on the pragma's `fkid`, which is a POSITION
that an ordinary rebuild renumbers — 33 migrations rebuild a table, and under a
positional key each one re-keys every pre-existing dangler into a fresh accusation
against a migration that deleted nothing. It compares ROW IDENTITY, not counts,
because a migration that repairs one dangler and orphans another nets to zero;
where identity is unavailable (past the cap, or across a rebuild that may reassign
rowids) it falls back to counting and says so rather than guessing. And a probe
that could not be TAKEN answers `null`, which is a GAP: the baseline is re-taken
for the next migration and the boot says so once, because carrying it forward as a
baseline switched the guard off for the rest of the boot in silence.

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

The `biomarker` storage category is RETIRED (#2479 part 2). It was the pre-#1076
catch-all — "a result, and nothing narrower was picked" — and migration 185 re-files
the rows the canonical registry can classify, applying retroactively the rule ingest
has followed since #1076 (a resolved canonical name's registry category wins). A row
the registry cannot classify STAYS and is reported, never guessed, which is why the
value is still legal in the CHECK and still filterable. What no longer exists is a way
to create one: `ASSIGNABLE_MEDICAL_CATEGORIES` is the derived complement of
`RETIRED_MEDICAL_CATEGORIES` and is what the extractor's enum, its accept-list and the
category picker offer, while `NormVital.category` and `FitnessStore` drop the string
from the TYPE so a writer does not compile. The pass deletes nothing and moves no id,
so it declares no `CHILD_LINKS` — a probe guarding a delete that cannot happen is the
#2444 defect, not a guard against it.

Not every dated observation a document carries IS a quantity. A functional-status
finding, the body site a temperature was taken at, one screening question's answer
and a bare result-status word are observations that state no measurement, and a
clinical document files them beside real analytes. They store as the `assessment`
category — dated, viewable on their document, and listed in
`NON_IDENTITY_CATEGORIES` (`lib/medical-categories.ts`), which is what WITHHOLDS
biomarker identity: no `canonical_biomarkers` registration, out of
`getUsedCanonicalNames`, so never a Coverage candidate and never a series. The
predicates that recognize them at the door are `lib/non-analyte-observations.ts`.
Identity runs on the CODE and on the NAME, and a guard on one axis is not a guard
(#2318 was exactly that: `functionalStatusExtractor` nulled the assessment LOINC
and the same rows coined canonical names anyway). An attribute of another entity —
a vaccine's lot number and expiry — is not an observation at all; the entity that
owns it already stores it. Storage category, catalog browsability and identity are
three DIFFERENT axes and quantitation is none of them — a urine dipstick result
states no number and carries full identity, a questionnaire ITEM answer is numeric
and carries none — so `carriesResultIdentity()` is named for what it gates and
`docs/internals/clinical-result-terminology.md` is the map.

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
only the per-lens week caps supplied; and `dayHistoryWindow()`
(`lib/day-history.ts`) resolves it to a GRAIN. A day-history column is a day or a
week, and above `MAX_HISTORY_DAY_WEEKS` it re-grains rather than clamping a
year-scale request back to a quarter (#2413) — read on the UNCLAMPED span, because
asking the already-clamped week count whether it exceeded the cap can only answer
no. Ladders are declared per domain PER GRAIN and the completeness test fails a
missing twin; the coverage domains stay coverage at week grain rather than being
rescaled. The partial trailing week is KEPT and DECLARED (`historyBucketCoverage`),
never dropped and never compared as a whole week. See
`docs/internals/day-history.md`.

### Food regularity

"How often does this group actually show up in this meal window?" is an
OBSERVATION and never a target — `frequency_targets` and the cadence ledger own
"how often should it". `lib/food-regularity.ts` owns the measure: a group's share
of the days that WINDOW was logged at all (not of every day — a day with no
morning log is evidence about logging, not about breakfast), over
`FOOD_REGULARITY_SPAN_DAYS` (21, three whole weeks, strictly inside the ranking's
365-day frecency window). Under `FOOD_REGULARITY_MIN_WINDOW_DAYS` (7) a window
answers `null`, and null means SILENCE — read it as no expectation, never as a
habit broken.

Its one consumer is speed, not insight: the Food tab's "Your usual `<window>`"
button logs the habitual groups that window still has nothing logged for, in one
tap instead of two. It is an OFFER — the user's tap is the write, the app never
logs food on anyone's behalf, and there is no send, no finding and no target
anywhere in it. The label names every group it will write and
`logUsualFoodCore` re-derives the same offer from fresh state and writes only the
intersection, so a stale tap refuses instead of logging a second breakfast.

A group whose counter IS a substance ledger, or which carries an active
cap-direction target, is measured but never presented back as an expectation
(#998's language: reflecting it normalises it). The catalog's `limit` tier is NOT
an exclusion — #1980 ruled tier never moves a group into or out of a fast path.
See `docs/internals/food-regularity.md`.

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
or `occurred_at ?? recorded_at` again — a ledger in
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

A PRESENTATION FLOOR is the other tenancy: not "should this be re-tested?" but
"may this surface still call this reading your CURRENT value?". Three registries
declare one — `RECENT_LAB_STALE_DAYS`, `VITAL_PRESENTATION_FLOORS`, and
`TREND_METRIC_PRESENTATION_FLOORS` (a `Record` over `TrendMetricSlug`, so a new
metric is a compile error) — and the three quantities two of them share are taken
BY REFERENCE, never restated. A floor decides FRAMING, never visibility, and never
mints a Finding, an Upcoming row or a send. How the resulting token READS is one
shared treatment with a per-surface FORM (`lib/glance-age.ts`).

An aggregate with nothing current may not render current-shaped copy
(`hasNoCurrentReading`) — the Longevity optimal pillar goes neutral, the Fitness
check counts fresh rather than measured. Both keep the stale values visible with
their provenance: the fix is what the aggregate CLAIMS, never what it hides.
Phrasing stays per surface. See `docs/internals/freshness.md`.

DORMANCY (`lib/domain-dormancy.ts`, #2652) is the THIRD question over the same
substrate — "has this domain stopped arriving?" — and the only one whose
consequence is HEIGHT: a section whose domain has recorded and then gone quiet
spends one line instead of a card. Its states are `absent` / `current` /
`dormant`, and the first exists so the collapse cannot inherit the onboarding
copy: `absent` means nothing was EVER recorded, and telling a returning weigh-in
logger "No weigh-ins yet" is the defect this removes. The decision is still
`freshnessState`'s. Intervals are 90 days by owner ruling, declared PER DOMAIN with
a completeness test. The HARD BOUND is that a section still showing a stale VALUE
under a presentation floor may never collapse — that floor exists so the value can
stay on screen honestly, and hiding it is the thing the doctrine forbids. So
dormancy reaches only sections whose render is WINDOW-BOUNDED and therefore already
showing nothing (`renderWindowDays`; `dormancyWindowConflicts()` is empty by
construction), which is why `recent-labs` and `vitals-latest` are declared
exemptions rather than domains. A dormant line names the RECORD and its age — never
the body, never a reason. Compression changes HEIGHT, never reach: the line carries
the fix. Anything carrying an OBLIGATION never collapses.

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

`lib/integrations/registry.ts` is the SOURCE registry. Current entries include
Health Connect, Strava, Oura, Withings, Fitbit Takeout, Weather & UV, Calendar
feed, and the planned Garmin integration.

A connected integration is a **source** — `sourceId` in every TypeScript
parameter, field and query API (#2487), matching the user-facing "Connected
sources" wording. `Provider` and `provider_id` are reserved for healthcare
clinicians and organizations, always. The persisted columns still say `provider`
on `integration_connections`, `integration_sync_events`,
`integration_backfill_jobs` and `stream_frontiers`; that rename is deferred to
its own forward migration, so reads select `provider AS source_id` at an
explicitly commented boundary and row shapes expose `source_id`. There is no
wrapper type — see `docs/internals/integrations-sync.md`.

A source also declares its **continuous streams** there — the ones expected to
keep arriving minute after minute while a device is worn — beside
`silenceToleranceMinutes`, read only through `lib/integrations/continuous-streams.ts`.
That tolerance is about the CONNECTION; a stream declaration is about the DATA, and
the two are independent: a phone can keep pushing aggregates while the watch feeding
heart rate is off a wrist. `quietStreamVerdict` (#2146) reports that — stream silent
past its DECLARED dip tolerance _while the source kept syncing ok in that window_,
which is the clause that keeps it disjoint from #1685 staleness — with no stored
state, and it renders on Data → Review only: it is coaching tier and never a send.
A source with no continuous stream declares none and is exempt by construction.

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

A message BODY is composed, never assembled. `lib/notifications/rich-text.ts` owns
emphasis (a builder declares runs and never writes markup; `plainBody()` gives every
other channel the same words), `lib/notifications/message-line.ts` owns the line
grammar as a type with declared parts, and `lib/notifications/glyphs.ts` owns the
glyph vocabulary: every glyph registered once with its meaning, its role (who acts /
what this needs / what it is about / where it stands / what a control does) and ONE
canonical encoding including its variation selector. One concept gets one glyph —
adding a synonym means retiring the incumbent into `RETIRED_GLYPHS`, not sitting
beside it — and a presentation-ambiguous codepoint must declare U+FE0F or U+FE0E, so
the same symbol can never render two ways again. The digest and the weekly recap emit
`RichText` through `formatEmphasizedLine`, which bolds a head only when the line has
qualifiers to be distinguished from. Scope is declared: `MESSAGE_LINE_MODULES` and
`GLYPH_MODULES` register the message builders, and their scans fail a hand-assembled
separator or an emoji literal with a written reason per allowlisted survivor.

Delivery health is stored in `notify_lifecycle` and follows the shared
set/clear/freeze decision in `lib/notifications/delivery-status.ts`. Clear an
error only after a healthy dispatch actually attempted the affected channel.
All outbound Telegram writes go through `lib/notifications/telegram.ts`; it is
the only module allowed to import the raw Telegram API primitives.

Inline notification actions carry IDs only and return typed outcomes. Never
confirm success unconditionally when the underlying write can refuse or no-op.

A profile whose messages reach NOBODY says so. The fan-out's admin exclusion is
correct and untouched, but its consequence used to be invisible — "no channel" is a
non-error to the tick, so nothing anywhere reported it. `unroutable()`
(`lib/household-setup.ts`) is the ONE predicate: the send-source scan × the edge set
× per-login channel presence (`profileRoutingFacts`), timezone-free, and disjoint by
construction from the `notify_lifecycle` failing-channel case (that one needs a
channel to have been attempted). It is a RENDERED AGGREGATE only — Settings →
Notifications and the `/household` setup row — never a send and never the digest.
It is gated on ONE instance-wide fact, `instanceHasAnyChannel()`
(`lib/notifications/routing.ts`): while no channel technology is configured
anywhere on the instance it stays silent for every profile, because "notifications
are not set up yet" is a different state from "notifications are set up, and this
member cannot be reached by them" and only the second is a defect. The gate is a
question about the SERVER, evaluated once — never the fold "every profile came back
unroutable, therefore suppress", which would silence a configured instance whose
members are all unreachable, the loudest true case.
`/household` owns per-member setup health more broadly: five derived checks
(unroutable, never-onboarded, undosed active items, unactioned preventive nudges, a
SUGGEST-only roster question), banded in the EXISTING `FindingTone` vocabulary, with
an episode-scoped dismissal keyed on the failing-check set that the unroutable check
is exempt from entirely. See `docs/internals/findings.md`.

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
- Dueness gates NUDGING, never LOGGING (#2419): every active, unpaused item carries
  its one-tap log control on today's row — a `may` item, an off-cadence row, a
  situation-inactive one — because a log states what happened. The tap creates no
  expectation (adherence is computed from dueness, so no miss, streak or rate moves),
  changes no situation state, and pushes nothing.

Biomarker → supplement is **curated first, AI second** (#2378), exactly as
biomarker → food has been since #577. `lib/supplement-suggest-curated.ts` is a pure
engine over a committed, human-reviewable map
(`scripts/gen-biomarker-supplement-map.ts`), gathered by
`getCuratedSupplementSuggestions` and rendered by one component. It reuses the
EXISTING screens — `screenSuggestionSafety`, `conditionOrSituationMatches`,
`stackFoodDrugHits` — and never declares a second copy of one. The map is
deliberately small, states NO dose, and every entry carries a checkable evidence
line plus a public source; an uncovered family falls through to the AI route
(`lib/supplement-suggest.ts`, now the FALLBACK) and loses nothing, so coverage is
measurable rather than a gate. The two must stay **visibly distinguishable** where
they render — a curated recommendation and a generated one are different claims.

See `docs/internals/supplements.md`.

### Health endpoint

`app/api/health` is public and deliberately coarse. It returns 503 for database,
write, cached-integrity, disk-headroom, or configured backup-staleness failures
without exposing paths, versions, or health data. Keep status composition in
`lib/health-status.ts`; the endpoint itself must stay cheap.

A new reason is a WORD, and the numbers behind it stay server-side — `disk-low`
(#1856) is decided from free bytes, volume size and DB size that the caller never
sees. It must also be a state a healthy install is NOT in: a reason that describes
the DEFAULT deployment posture would pin every default install at 503 forever,
which is why "uploads are in no backup" is an admin-card fact and not a reason
here. Prefer a transient, self-clearing alarm over a standing complaint about how
the operator set the box up.

### Deploys and deployment skew

A deploy leaves open tabs on a build the server no longer serves. The service
worker installs and **waits** rather than taking over, one merged pending state
answers the whole question, only the tab that asked ever reloads, and a
waiting worker for the build the page already runs — found waiting at load, or
installed by the page's own registration just after it — is consumed silently
instead of re-offered. A tab that navigates while still stale hits a deleted chunk; the
top-level error boundary recognises that signature and hard-reloads **once**,
under a rationed `sessionStorage` guard, before rendering any card. A tab that
keeps SAVING while stale fails every Server Action (the ids are build-keyed);
`isStaleActionError` classifies that signature, and `shouldQueueOffline` treats
it like a dead connection so quick-log taps queue and replay through the
build-stable replay route.

Since #2471 the tab does not ASK about any of that — it **takes** the deploy at
the first moment it can prove is safe, and says so afterwards. `autoReloadPlan`
is that proof and its ORDER is the safety argument: ration spent → hold; work
with no durable copy on the page → hold; a form submit still settling → wait;
hidden → reload; input-quiet (pointer/key/wheel/touch/scroll, watched at the
DOCUMENT, not just inside forms) → reload, else wait. Quiet is counted from the
LATER of the last event and `watchingSince`: "nothing has been heard" is not
"the page is quiet" in the first milliseconds of a document, and a tab that
reloads there has taken the page out from under someone mid-gesture. `wait` and `hold` are
different answers because only `hold` may render a bar; a bar during a
two-second scroll pause would be the ask-before gate this removed. The reload is
LOSSLESS BY SEQUENCE, never by hope: every draft is flushed and settled, then the
one-shot resume pointer and toast marker are written, then the ration is spent,
and only then the existing machinery reload runs — any step that throws stops it
and the old banner renders. `useFormDraft` applies the draft with no banner
under that pointer and only under it (`shouldAutoApplyDraft`); everywhere else
the never-apply-without-a-tap rule stands. The manual affordances survive ONLY as
the rationed-failure fallback and call the same routine, so even a manual tap
resumes. The refusal is the feature: a draft-backed form is recoverable, and
anything else holding unsaved input (the #1878 registry's `markUnrecoverableWork`
axis) is not, so settings cards, record forms and uploads keep today's behaviour
rather than being reloaded over. Rations compose but never refill each other —
the worst case of a broken deploy is bounded by the SUM of this ration and
`global-error`'s.

DETECTING a deploy and RESOLVING one are different jobs, and only one thing can
do the first from an already-open tab: the `/api/version` sha read. `public/sw.js`
takes its version from its own URL, so a deploy changes none of its bytes,
`registration.update()` installs nothing, and only a fresh document ever calls
`register()` with the new sha — a waiting worker governs which build a reload
lands on, it cannot notice that a deploy happened. So the sha poll runs wherever
there is a baseline (`sha ? "poll" : "off"`), its first read is on mount, and
`resolveUpdateState` — not a choice of detector — is what keeps one deploy to one
notice. Never gate that poll on service-worker state again (#2329).

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

Both unit tiers run most specs with a **shared module registry** (`isolate:
false`) — one module graph per worker instead of per file, which is where most of
their speed comes from. Writing a spec needs no special knowledge: a spec that
calls `vi.mock()` or `process.chdir()` is routed to the tier's isolated project
automatically by the scan in `vitest.isolation.ts`, where it behaves exactly as
the tier did before. It is only slower, so prefer not to reach for either.

Two things the scan cannot see, both about state that now outlives the file that
set it:

- A module-scope cache fed by DB reads must be reset per file in
  `lib/__db_tests__/setup-shared.ts`. It already resets the timezone memo, the
  #2066 dose-schedule memo, the `next/cache` spies and the acting session. A
  cache that is missed does not fail — it answers the next file with the
  previous file's data, which is worse.
- A module-scope prepared statement must use `hoistedStatement()` from
  `lib/db.ts`, never a bare `db.prepare(...)`. The shared tier swaps the database
  between files, and a statement compiled against the closed connection throws.
  Inline `db.prepare(...)` inside a function is unaffected BY THIS HAZARD — but
  that is a statement about test isolation only, and reading it as a blessing is
  what left the app's most-executed read compiling itself 10,600 times a render.
  Whether an inline prepare is a defect is the COST question in Architecture
  above, decided separately. The owned-table scans read both forms, so scoping
  stays enforced either way — note they are TEXT scans, so `db.prepare()` written
  in a comment fails `profile-scoping.test.ts` as an unverifiable non-literal.

Every rendered UI feature must add or extend a browser test. The E2E harness
seeds a template once, gives each worker its own database and `next start`
server, and freezes the run's clock. Specs import `test` and `expect` from
`./fixtures`, use `workerDbPath()` for direct SQLite access, and use
`frozenNow()` instead of wall-clock time.

Use stable test IDs and the settled interaction helpers in `e2e/helpers.ts`.
Do not add `waitForTimeout`, `networkidle`, or an unmarked `.first()` on a shared
surface. A test owns its fixture data and must not exact-count shared seed rows.
A spec that WRITES to the shared profile also leaves it as it found it, and one
whose precondition is an ABSENCE ("no tracked protein", "never measured") owns
that state rather than trusting the seed to keep it: specs sharing a worker share
its database, so a neighbour's ordinary write silently destroys an absence and
neither spec is wrong alone. Duration-balanced shards decide who those neighbours
are, so a manifest refresh is a co-residency change — and a colliding pair only
collides when both land on the SAME worker, which means a green run at
`--workers=2` proves nothing and `PW_WORKERS=1` is the reproduction.
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
- Last-write-wins is not whole-**ROW**. An edit core takes a PATCH (`Partial` of
  the create input): absent means unchanged, a present `null` still clears, and
  the merge runs INSIDE the transaction and BEFORE `sanitize`, so cross-field
  rules judge the merged whole rather than each field against a row it no longer
  belongs to. A form that buys the same property with hidden inputs is a trap
  whose failure is silent and destructive — add a column, write it from the core,
  forget the hidden input. `updateInjury` (#2359) had the hidden inputs;
  `updateEndurancePlan` (#2573) never had them, so it wrote `notes = null` on
  every edit. The guard is a schema CENSUS, not a list of today's fields:
  enumerate the table via `PRAGMA table_info`, force the fixture to give every
  column a real value, name ONE field in the edit, and require every other column
  byte-identical. A complete editor that genuinely carries every column it writes
  (`saveActivityCore`) is a different shape and stays whole-row.
- `lib/` write cores are auth-blind. They take `profileId` first and never import
  `lib/auth`; the Server Action performs authorization and validation.
- Server Action records pass serializable data only. Do not return a
  `better-sqlite3` row proxy to a client component. That is a TYPE now, not
  review: `Serializable<T>` (`lib/serializable.ts`) is a structural mirror of
  what React's serializer accepts, and every `"use server"` module under `app/`
  is asserted against it as one census in
  `lib/__tests__/serializable-action-returns.test.ts`. A module whose action
  grows a function, a class instance or a statement handle in its resolved value
  fails on its own row, so the compiler names it. A new action module joins the
  census; the scan in the same file fails one that does not. Annotate a
  hand-written return type with `AssertSerializable<…>` when you want the error
  at the signature rather than at the census.
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
- A one-line mutually-exclusive selector is `<SegmentedControl>`, in whichever of
  its **two bindings** fits: `onChange` when the selection is client state
  (`<button>` + `aria-pressed`), an `href` per option when it lives in the URL
  (`<Link>` + `aria-current`). One primitive, two bindings, for the same reason
  `PaginationControls` has them (#2546/#2535) — and the link half exists because
  its absence was an a11y DEFECT, not untidiness: four hand-rolled URL selectors
  all marked the selection with `aria-pressed` on a link, which `role="link"` does
  not support, so no assistive technology announced any selection at all.
  `lib/__tests__/link-aria-pressed-scan.test.ts` fails that combination outright.
  A segment is a plain `<Link>`, not `PendingNavLink` — the nav-row rule above is
  about the sidebar, and a segment has no icon slot to give up to a spinner.
- The "nothing here yet" panel is `<EmptyState>`, never a hand-rolled dashed box.
  Its `data-empty-state` marker is load-bearing (#2531/#2399: an absent chart must
  not reserve the chart's height) and a copy carries no marker. When the copy names
  a destination, pass `action`/`actions` instead of leaving the reader to navigate
  by hand. Padding is exactly two values — the default and `compact`.
  `lib/__tests__/empty-state-panel-scan.test.ts` fails a class carrying both
  `border-dashed` and `text-center`; a surface it cannot serve declares a reason.
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
- A STROKE earns its confidence (#2653 state 5). Every series declares a
  **continuity span** beside its gap — the longest interval between two readings
  across which the line between them is still a fair interpolation. Past it,
  `sparseSeriesVerdict` demotes the plot: solid dots lead, the stroke thins,
  dashes and fades, and a caption states the raw count and span ("3 readings in 3
  years"). The measure is the MEDIAN interval and never a rate, because a rate
  cannot tell a thin series from a dense one with an OUTAGE, and those are
  different states with different treatments. The demotion must be a demotion —
  raw facts only, no verdict word, no chip, stroke strictly weaker on every axis
  — or the treated chart reads as more considered and buys the thin line trust it
  has not earned. A continuity span never sits below that metric's
  `TREND_METRIC_PRESENTATION_FLOORS` day count: the two registries answer
  different questions and are pinned consistent rather than merged.
- MOTION IS INFORMATION or it is not there. Two vocabularies answering different
  questions: `lib/motion.ts` owns a panel ARRIVING (240 ms, enter/exit, a
  `usePresence` unmount window — `docs/internals/overlays.md`), and
  `lib/micro-motion.ts` owns FEEDBACK ON A WRITE (#2654) — a confirm settling into
  its done state, a counter rolling to its new quantity. Four rules hold the second
  one: 150–300 ms; NOTHING LOOPS (a looping animation is an attention claim that
  never stops making itself); reduced motion is the DESIGNED state, so every motion
  declares the end state that arrives instantly instead; and motion is never the
  ONLY carrier, so every motion declares what states the same fact when nothing
  moves. Tokens and a declaration, not a registry engine: a new motion is a
  `MICRO_MOTIONS` row plus a `--motion-<name>` property and a class, and
  `lib/__tests__/micro-motion.test.ts` fails either half on its own. Never
  hand-write a duration, and never animate a property that triggers layout — the
  state change lands on its own frame and the animation only decorates a transition
  already made. See `docs/internals/micro-motion.md`.

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
- **Adult-only content refuses at the CORE**, not only at the surface. #1174 hid
  the substance-use surface from a known minor; #1279 re-checked in every one of
  that surface's actions, because a Server Action is independently POST-callable
  and a UI-only gate is theater. #2107 closed the last hole: the instrument write
  cores are SHARED with the mental-health catalog and update/delete resolve their
  instrument from the targeted ROW, so the calling surface's family was no evidence
  at all about what was being written, and the mental-health twins reached the very
  scores #1279 refuses to touch. `adultOnlyRefusal`
  (`lib/instrument-records.ts`) is the one question each of those cores asks about
  the instrument it resolved; a refused one answers exactly as an unknown row does
  (`null` / `not-found`), mental-health instruments pass unconditionally, and an
  unknown age still passes (`lib/life-stage`'s positive-match-only policy).
  `ADULT_ONLY_WRITE_CORES` (`lib/adult-only-writes.ts`) registers the gated modules
  and its scan fails a new mutating export there that skips the gate — the
  exemption list is empty. Narrowing the known callers is the fix that leaves the
  next caller to rediscover the hole.
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
- **Act, then offer undo** — one lifecycle, not one per surface.
  `components/useUndoableAction.ts` over the pure `lib/undo-offer.ts` owns the
  window (`UNDO_TOAST_MS`), the "Undo" label and the refusal wording;
  `useUndoableDelete` is its delete adapter and the dose confirm its second
  tenant. A write may offer an undo only when its inverse is COMPLETE (children
  and side-state included), LOCAL (nothing was sent, published or delivered) and
  RE-DERIVED server-side — `undoDoseConfirm` proceeds only while the day's ledger
  is still the single taken row the confirm wrote, because the one core's clear is
  a `DELETE` by (dose, date). The gate is per OUTCOME, not per action: an
  `already-taken` tap wrote nothing, so it gets no Undo. **Undo never replaces a
  consequence-stating confirm** on a hard-to-reverse or outward-facing transition
  — obligation demotion, retiring a dose with logs, ending an episode, stopping a
  medication course. See `docs/internals/undo-contract.md`.
- Findings have an explicit reach policy: care findings may reach Upcoming,
  attention surfaces, and notifications; coaching findings stay in calm,
  hideable surfaces. See `docs/internals/findings.md` — which also holds the **attention doctrine**:
  the surface taxonomy (system-initiated sends / rendered aggregates /
  user-initiated access), the contact-consent rule (the system may reduce contact
  unilaterally, never increase it or rewrite user-owned state), which domains can
  carry an obligation at all, and the right-sizing family every "the system
  noticed X" suggestion belongs to.
- The doctrine's other half is **how a feature would learn it should stop**
  (#2385). A feature that claims to change BEHAVIOUR declares three things beside
  its acceptance criteria: what would show it working, what would show it wrong,
  and its **deceptive success** — the measure that improves while the feature does
  harm (food coverage rising while servings-per-window falls). Local queries over
  data the instance already holds; never telemetry, never a user-facing score,
  never on a correctness feature, and never on a safety signal, whose
  justification is not effectiveness. This is prose in the issue and in the module
  header — do not build a registry, a scoring engine or a metrics pipeline for it.
- Its first application is **repeat dismissal read as an answer** (#2386):
  `lib/dismissal-fatigue.ts` counts distinct declined RAISINGS of one topic
  (keyed on the #436 episode anchor, never rows) and de-prioritises, then retires
  from the routine surface — never mutes, never writes, never touches the
  suppression bus, and always still reachable where the user goes looking. The
  safety floor is DERIVED, not listed: `mayQuietOnDismissal` asks
  `isHiddenUnderPolicy`, so quieting can only ever reach a finding a plain dismiss
  would already have silenced. A dose reminder, a missed-dose escalation, the
  crisis finding and an overdue care follow-up are refused before any count is read.
  A finding DECLARES its topic stem — as `supersedes` when it had a pre-anchor key,
  as `episodeFamily` when its key was born anchored (#2543) — and the declaration is
  only honoured when it is a strict PREFIX of the key, which is what stops a producer
  widening a stem to accumulate faster. Three digest lines declare one (`portal-sync`,
  `records-recency`, `digest-time`) and the digest drops anything not `routine`; every
  care-tier line names its SUBJECT rather than an episode of it, has one possible key,
  and is out of reach by construction rather than by exemption.
- **An imported medication nobody has ever logged can be stopped from its own
  reminder** (#2574). `lib/medication-unconfirmed.ts` is the pure detector —
  `kind = medication` AND import provenance AND ZERO lifetime logs AND past the
  occurrence floor — the exact complement of the demotion detector's medication
  refusal, so a dose row gains at most one extra button. It produces no `Finding`, no
  dedupe key and no send: a flag, and a 🏁 Stop beside Take and Skip on the nudge that
  was already going out. The tap RE-DERIVES candidacy before writing, goes through
  `stopMedicationCourses` (the one core the web dialog uses), and renders its typed
  outcome. Detection suggests; the tap writes.

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
