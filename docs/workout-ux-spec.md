# Spec: Workout UX — exercise guides, muscle anatomy, routines

Status: **draft** · Owner: TBD

## Problem

The training domain has a strong data spine — a curated lift catalog with
muscle/region/pattern metadata (`lib/lifts.ts`), the unified next-workout
engine (`lib/workout-recommendation.ts`, #221), weekly `frequency_targets`,
and an equipment registry — but almost none of it is surfaced instructionally
or visually:

- **No how-to content anywhere.** A user picking "Romanian Deadlift" from the
  lift picker gets a name and nothing else — no setup, cues, or common
  mistakes.
- **No anatomy visual.** `LiftDef.muscle` is a single display string
  ("Side delts"); nothing shows _where_ that is or how a week of training
  covers (or misses) the body.
- **No notion of a program.** `frequency_targets` says "legs 2×/week" but
  nothing says "here is your Wednesday session" — the recommendation engine
  composes a session ad hoc from gaps and habits, and the user cannot define
  or adopt a structured routine.

## Decisions (recorded)

1. **Finer muscle vocabulary.** A canonical `MuscleId` enum (~22 values, below)
   replaces free-string muscle labels as the identity layer; the existing
   7-value `MuscleRegion` becomes a pure rollup of it.
2. **Guides are static.** How-to content is checked-in JSON, generated once by
   a script and hand-reviewed — no runtime AI dependency, works offline, no
   PHI surface. (Rejected: per-profile editable guides in v1; AI-generated
   guides at request time.)
3. **Adopting a routine replaces training-scope frequency targets** (with
   confirm). Two overlapping target sets would double-nag through Upcoming.
   Replacement touches ONLY `scope_kind IN ('region','group','type')` —
   `food_group` targets (migration 031) are nutrition, not training, and are
   never touched.
4. **Custom-defined workouts are first-class.** Users can author their own
   routine, not just adopt a template. Templates and custom routines share
   ONE runtime representation: adopting a template _copies_ it into
   profile-owned routine tables; the engine only ever reads the DB shape.
   (Rejected: engine reads templates from code with a custom-routine special
   case — two code paths that would drift, the #221 disease.)
5. **Coaching depth ships too (Pillar 4):** per-muscle weekly volume bands,
   mesocycle/deload awareness on routines, and optional RPE logging feeding
   progression. All three stay inside the existing philosophy — informational
   bands and user-owned cycles (never a dynamic priority engine, #559),
   nullable signals that degrade to today's behavior when absent (the
   sleep/resting-HR pattern).

## Pillar 1 — Exercise how-to guides

### Content model

Checked-in `lib/exercise-guides.json` + typed accessor `lib/exercise-guides.ts`,
keyed by `exerciseHistoryKey` so equipment variants share one guide, with
per-equipment overrides where cues genuinely differ:

```ts
interface ExerciseGuide {
  key: string; // exerciseHistoryKey ("curl", "romanian deadlift", …)
  setup: string[]; // ordered setup steps
  execution: string[]; // ordered movement cues
  breathing?: string;
  commonMistakes: string[];
  safetyNotes?: string[]; // informational, never medical advice
  equipmentNotes?: Partial<Record<Equipment, string>>;
  primaryMuscles: MuscleId[];
  secondaryMuscles: MuscleId[];
}
```

Authoring: `scripts/gen-exercise-guides.ts` (mirrors
`scripts/gen-canonical-biomarkers.ts` — AI-assisted at generation time is
fine) produces a first pass over `ALL_LIFT_NAMES`; the output is hand-reviewed
and committed. A CI-checked invariant asserts every catalog
`exerciseHistoryKey` has a guide, so a new catalog lift cannot ship guideless.

### Surface

The app ALREADY has the per-exercise surface: `components/ExerciseDetailPanel.tsx`
renders e1RM trend, strength-standards standing, the coached next-set target,
PRs, and linked goals, and is hosted by `JournalView`, the Training Analyze
section, and `StrengthExplorer`. Guides become a new "How to" section of that
ONE panel — a separate `ExerciseGuideSheet` would be a hand-mirrored second
exercise surface, the exact disease the responsive-surfaces/one-computation
rules exist to prevent.

Entry points that don't already host the panel open the same panel in an
overlay:

- the lift picker in `components/activity-form/StrengthSets.tsx` (the
  strength set editor after the #721 form decomposition) — ⓘ affordance per
  option,
- `StrengthSection` history rows,
- the next-workout recommendation card's exercise list,
- Telegram nudges via deep link (`/training?exercise=…` — two-way principle:
  buttons carry names/ids and deep-link, no new mutation).

Custom (non-catalog) lifts have no guide; the affordance simply doesn't
render. One standard disclaimer line ("form reference, not medical advice")
given the app also carries a medical passport.

## Pillar 2 — Muscle vocabulary + SVG anatomy

### `MuscleId` (the identity layer, #482 applied to muscles)

```ts
type MuscleId =
  | "chest-upper"
  | "chest" // pecs (clavicular head split out)
  | "lats"
  | "traps"
  | "mid-back"
  | "lower-back"
  | "front-delts"
  | "side-delts"
  | "rear-delts"
  | "biceps"
  | "triceps"
  | "forearms"
  | "abs"
  | "obliques"
  | "glutes"
  | "quads"
  | "hamstrings"
  | "hip-adductors"
  | "hip-abductors"
  | "calves"
  | "tibialis"
  | "neck";
```

- `muscleRegion(m: MuscleId): MuscleRegion` is the pure rollup — everything
  keyed on the existing 7 regions (frequency targets, recommendation focus,
  goal scopes) keeps working unchanged.
- Each `LiftDef` gains `primaryMuscles` / `secondaryMuscles: MuscleId[]`; the
  free-string `muscle` stays as the human display label. A pure test pins that
  every lift's primary muscles roll up into its declared `region` (catches
  tagging typos).
- Every new muscle-keyed surface (SVG, coverage math, any future finding
  `dedupeKey`) keys on `MuscleId` — never on the display string. A hand-rolled
  second grouping is the identity-layer disease (#432/#482).

### Anatomy component

`components/MuscleAnatomy.tsx`: **hand-authored** inline SVG (front + back
body outlines) where each `MuscleId` maps to one or more `<path>` groups —
decided over adapting a third-party base, so there is no license/attribution
obligation and the paths are drawn to exactly the `MuscleId` granularity
(a borrowed anatomical illustration would need regrouping anyway). Stylized
and diagrammatic is fine; anatomical-atlas fidelity is not the bar. Inline
and self-contained (no external assets), theme-aware fills, and never
color-only: hover/tap names the muscle, and a text list of primary/secondary
muscles always accompanies the figure. Authoring the SVG is the main real
cost of this pillar.

**The figure is an enhancement, never a blocker.** Every coverage surface is
built list-first: the sorted per-muscle text/bar list (same
`muscle-coverage` result, boring formatter) ships WITH the computation and
remains the accessible rendering permanently. The SVG figure layers on top
when the asset is ready — so if authoring stalls or the first draft isn't
good enough, Phase 2 still ships whole, and the figure follows in its own
PR. Per-exercise mode degrades the same way (the primary/secondary text list
already required above).

Three rendering modes, each fed by one computation:

1. **Per-exercise** (in the `ExerciseDetailPanel` guide section): primary
   saturated, secondary muted. Pure `LiftDef` lookup.
2. **Per-session** (a logged workout / day view): union across the session's
   sets.
3. **Weekly coverage** (Training → Overview): trailing-window set-volume per
   muscle as heat intensity, from a new pure `lib/muscle-coverage.ts`:
   `coverageFromSets(sets, today): Map<MuscleId, { sets, lastTrained }>`,
   keyed through `exerciseHistoryKey`. Per "one question, one computation",
   this same result feeds the SVG heat, any textual "pull untrained for 9
   days" line, and can inform `workout-recommendation.ts` focus — so the
   figure _shows why_ the engine recommends what it recommends.

## Pillar 3 — Routines (templates + custom)

### Constraint

There is NO dynamic priority engine (#559): routines are declarative,
user-owned structures the user adopts or authors. The engine resolves and
fills them; it never invents a program.

### One runtime representation

Profile-owned tables (one append-only migration; all three go into
`lib/owned-tables.ts`; children reach `profile_id` via JOIN to `routines` per
the scoping rule):

```sql
CREATE TABLE routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('template','custom')),
  template_id TEXT,            -- template catalog id when source='template'
  active INTEGER NOT NULL DEFAULT 0,
  started_date TEXT,           -- set on activation
  position INTEGER NOT NULL DEFAULT 0, -- rotation cursor into routine_days
  cycle_weeks INTEGER,         -- mesocycle length; NULL = no cycle (see Pillar 4)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  profile_id INTEGER NOT NULL REFERENCES profiles(id)
);
CREATE TABLE routine_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  ordinal INTEGER NOT NULL,
  label TEXT NOT NULL,         -- "Push day"
  focus TEXT NOT NULL          -- JSON MuscleRegion[]
);
CREATE TABLE routine_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_day_id INTEGER NOT NULL REFERENCES routine_days(id),
  ordinal INTEGER NOT NULL,
  candidates TEXT NOT NULL,    -- JSON string[]: ordered exercise names, first available wins
  sets INTEGER NOT NULL,
  rep_min INTEGER NOT NULL,
  rep_max INTEGER NOT NULL
);
```

`lib/routine-templates.ts` is a checked-in catalog (Full Body 3×, Upper/Lower
4×, Push/Pull/Legs, beginner barbell 5×5-style, minimal-equipment/bodyweight)
in the same declared shape. **Adopting a template copies it into the tables
above** — after that it is indistinguishable from a custom routine, so
"editing an adopted template" is just editing your routine, and the engine has
exactly one input shape.

### Custom workouts

A routine builder UI on `/training` (Routines section):

- name the routine, add days, add slots per day;
- slot candidates picked from the catalog picker OR typed free-text — a
  custom lift name is allowed anywhere a catalog name is (guides/anatomy
  degrade gracefully for it, matching how custom lifts behave everywhere
  else);
- `focus` per day is derived from the slots' regions (editable);
- multiple routines may exist; at most ONE is `active` (enforced in the write
  core: activating one deactivates the rest in the same `writeTx`).

Optional follow-up (out of scope v1): per-profile muscle tagging for custom
lifts (`custom_exercise_meta`) so anatomy coverage can include them.

### Activation replaces training-scope frequency targets

Activating a routine (template-sourced or custom), inside one `writeTx`:

1. deletes the profile's `frequency_targets` rows with
   `scope_kind IN ('region','group','type')` — `food_group` rows untouched;
2. inserts derived targets from the routine's days (e.g. PPL 6× ⇒ region
   targets Push/Pull/Legs 2×/week each; the template/custom shape declares its
   derived targets rather than guessing), so coaching, Upcoming's
   `training:<id>` findings, and the Telegram nudge light up through machinery
   that already exists;
3. sets `active`, `started_date`, resets `position`.

The confirm dialog lists exactly which targets will be replaced, and only
appears when there ARE training-scope targets to replace (a fresh profile —
the #719 onboarding case — activates in one tap). Deactivating a routine
keeps the derived targets (they're now just ordinary targets the user can
edit or delete); this is stated in the confirm copy.

### Today's session stays in the ONE recommendation core

`workout-recommendation.ts` grows a routine-aware path: when an active routine
exists, resolve today's `routine_days` row (rotation `position` + the existing
weekday-habit signal), fill each slot with the first candidate the user can
actually do (reusing `deRankUnavailableLifts` / equipment availability), and
attach the existing next-set seed per lift for concrete "3×8 @ 62.5 kg"
targets. No active routine ⇒ exactly today's behavior. Telegram, dashboard,
and Training overview all render this one result, so they agree by
construction (#221). Completing a session (logging an activity that credits
the day's focus) advances `position` — and ONLY that: skipped days, rest
days, and calendar time never advance it. A routine is a sequence, not a
calendar; a missed Push day is still the next day up. (The mesocycle
week-in-cycle counter in Pillar 4b is deliberately the opposite —
calendar-derived — because a deload schedules recovery in real time, not
after N sessions.)

**What "credits the day" means** is ONE pure, boundary-tested function,
`sessionCreditsDay(sessionRegions, day.focus)` — derived entirely from the
logged data, no hidden link column:

- a strength session credits today's routine day iff the regions of its
  logged sets (via `exerciseHistoryKey` → `LiftDef.region`) overlap the
  day's `focus` at all — so the pre-filled slate credits by construction,
  and an improvised session that genuinely worked the day's focus counts
  too;
- a cardio-focus day is credited by any cardio activity; a strength day is
  never credited by cardio (or vice versa);
- `position` advances at most once per profile-local day, however many
  sessions are logged.

(Rejected: a `routine_day_id` link column on `activities`. It would make
crediting exact for the pre-filled path but wrong for the equally valid
improvised path, and adds a row-ops obligation — re-parenting on merge,
nulling on routine delete — for a question the logged sets already answer.)

A "log this session" action pre-fills the activity form with the resolved
slate — and since the form already has a live mode (#340:
`LiveWorkoutPanel` + rest timer + wake lock), a routine day can go straight
from "here's your session" to working through it at the gym with no new
in-workout machinery.

### Reach tier (#449)

Routine adherence is **coaching tier** — calm, hideable, never the
Needs-attention hero. The only push-tier touch is the existing workout nudge,
which gains richer copy ("Push day: Bench, Overhead Press, Dips") through its
existing dedupe/dismissal key — no new notification.

### Onboarding integration (#719)

The goal-based onboarding issue's Training path offers "starting with a
simple routine" — that IS template adoption, not a parallel feature:

- **One write core.** Onboarding calls the SAME `lib/` adopt/activate core as
  the Training page (`profileId`-first, auth at the calling action) — no
  onboarding-special adoption path. The onboarding step is a thin picker over
  `lib/routine-templates.ts`, `audience: "beginner"` templates first, each
  showing days/week and the equipment it assumes (a no-equipment profile gets
  the bodyweight template up front).
- **Replace-with-confirm collapses on a fresh profile.** The activation
  transaction only raises the confirm dialog when existing training-scope
  `frequency_targets` rows would be deleted; a fresh profile has none, so
  onboarding adoption is one tap — same core, conditional confirm, not a
  second flow.
- **Cold start is a designed state, not an error.** With zero history the
  routine path still produces a complete first session: slot filling needs no
  history, and absent next-set seeds the slate shows sets × rep range with no
  load ("3×8, pick a weight you could do for ~11") — the seed is the same
  nullable signal it is everywhere. Each exercise opens its guide, which is
  exactly what a day-one user needs. This answers #719's requirement to
  "state what history is required before personalized trends or
  recommendations become meaningful": the session prescription works from
  day one; load targets appear after the first logged session of each lift;
  trends/observations state their own windows.
- **Tier placement per #719's state rules:** the adopted routine and derived
  targets are per-profile data (already the case); nothing about onboarding
  writes global state.

The onboarding flow itself (welcome, outcome selection, Today-screen preview)
is #719's scope, not this spec's — Pillar 3 just guarantees the training
branch has a real, reusable primitive to call, and Phase 3 therefore
unblocks #719's "start with a simple routine" option.

## Pillar 4 — Coaching depth

Three additions that close the biggest remaining gaps in the coaching engine
(longitudinal programming and autoregulation) without breaking its designed
ceiling: the engine gates, suggests, and phrases — the user owns the program.

### 4a. Per-muscle weekly volume bands

Builds directly on Pillar 2's coverage math.

- **Bands are checked-in defaults**, `lib/muscle-volume-bands.ts`: a
  `{ low, high }` weekly _working-set_ band per `MuscleId` (large movers
  ~10–20, small/indirect muscles lower). Like the guides, static reference
  content — no per-profile override in v1 (follow-up if wanted).
- **Indirect credit:** a set counts 1.0 toward each of the lift's
  `primaryMuscles` and 0.5 toward each `secondaryMuscles` — ONE constant,
  applied inside `lib/muscle-coverage.ts`, which grows a band verdict per
  muscle: `below | within | above | untrained`. During an active routine's
  deload week (Pillar 4b) the `below` observation is suppressed — the week is
  supposed to be light — via the same week-in-cycle flag the nudge softening
  reads, decided in the ONE gather (the figure still shows real numbers; only
  the finding is held).
- **Surfaces (formatters over the one computation):** the coverage anatomy
  figure tints by verdict (with the text list carrying exact numbers — never
  color-only). Follow the HR-zone precedent from #721 (`lib/training-zones.ts`):
  the verdict is precomputed ONCE and every surface consumes that same
  verdict through one shared palette module, so tints and labels cannot
  drift between the figure, the text list, and the observation. Also a
  coaching-tier observation per sustained shortfall ("side
  delts: 2 sets this week, band floor is 6"), emitted alongside the existing
  training observations with an episodic `dedupeKey` in a new registered
  prefix (`muscle-volume:`), so a dismissal is per-episode (#436) and the
  #448 reflection guard covers it. Calm tier only — never a push
  notification, never the hero.
- **Cold start (#719):** band observations require history before they may
  fire — no `below`/`untrained` finding until the profile has logged strength
  sessions in at least `MIN_BAND_HISTORY_WEEKS` (proposed: 2) distinct weeks
  of the trailing window. A brand-new profile is "not enough data yet", never
  "everything is below target" — an unanswered question is not a negative
  answer. The coverage figure may always render (untrained muscles in a
  neutral empty tint); only the finding is gated.
- **Not a priority engine (#559):** bands inform the coverage display and one
  dismissible observation. They do NOT reorder the recommendation core's
  exercise ranking in v1; at most the routine builder shows a band summary of
  the routine being authored ("this plan gives rear delts ~3 sets/week").

### 4b. Mesocycle & deload awareness on routines

Routines gain an optional, user-owned cycle — declarative, like everything
else about them.

- **Model:** `routines.cycle_weeks` (nullable — NULL means no cycle, all
  current behavior). Convention: the LAST week of the cycle is the deload
  week. Week-in-cycle is calendar-derived, pure:
  `weekInCycle = floor(daysSince(started_date)/7) % cycle_weeks`. Templates
  may declare a cycle (the beginner 5×5-style ships 8+1); the custom builder
  exposes the field.
- **Deload behavior**, all inside existing chokepoints:
  - The next-set engine (`lib/coaching/strength.ts`) gains one pure
    adjustment, `deloadAdjust(nextSet)`: roughly −10% load, −1 working set
    per slot (exact factors are named constants with rationale, pure-tested
    at boundaries). Applied ONLY when the active routine says this is a
    deload week; the recommendation core phrases it ("Deload week: Bench
    3×5 @ 56 kg").
  - Behind-target nudges soften during the deload week (the week is
    _supposed_ to be lighter): the workout nudge keeps firing but with deload
    copy; the frequency-target "behind" finding is suppressed for
    region/group scopes that week — decided in the one gather, not per
    surface.
  - The plateau observation cross-references the cycle: if a deload week is
    ≤2 weeks away, its suggestion says so instead of recommending an ad-hoc
    deload.
- **Pauses re-anchor the cycle.** Naive `started_date` arithmetic puts a
  returning user in an arbitrary cycle week — a three-week break must not
  resume into "deload week." Two mechanisms:
  - _Auto:_ week-in-cycle is computed by a pure
    `effectiveCycleStart(startedDate, creditedDates, today)` — a gap of
    `CYCLE_PAUSE_GAP_DAYS` (proposed: 21) or more with no credited sessions
    re-anchors the cycle to the first credited session after the gap (or to
    `today` while none exists yet), so a returner is always in week 1.
    Deterministic from logged data, no hidden write on a read path,
    boundary-tested like `weekInCycle` itself.
  - _Manual:_ the routine editor gets a "Restart cycle" action (an ordinary
    gated write setting `started_date = today`) for deliberate resets.
- **Explicitly NOT in scope:** auto-inserted deloads from fatigue signals, or
  multi-block periodization (volume→intensity phases). The cycle is a counter
  the user set, not a model of readiness — rest/recovery overrides in
  `lib/coaching` already handle acute fatigue and stay independent.

### 4c. RPE logging → progression

- **Schema:** `exercise_sets` gains nullable `rpe REAL` (append migration;
  `CHECK (rpe IS NULL OR (rpe >= 5 AND rpe <= 10))`, half-point steps
  enforced at the action boundary). Composes with the existing declared
  intent (`target_reps` / `to_failure`) rather than replacing it.
- **UI:** an optional compact selector on the set row in
  `components/activity-form/StrengthSets.tsx`, matching the post-#721 set-row
  ergonomics (steppers, #337) and staying out of the way of live mode's set
  check-off (#340). Blank by default — logging RPE is never required; shown
  on history rows when present.
- **Progression:** the double-progression engine consumes the anchor set's
  RPE when present, as a modifier on its existing verdicts (named constants,
  boundary-tested): top-of-range reps at RPE ≤ 7 ⇒ a larger load increment;
  at RPE ≥ 9.5 while below the rep-range floor ⇒ hold the load (repeat) or,
  when persistent, phrase toward the deload/variation vocabulary the plateau
  finding already uses. **No RPE on the seed ⇒ byte-for-byte today's
  behavior** — the sleep/resting-HR nullable-signal pattern.
- The seed plumbing (`NextSetSeed`, `pickSeedSessions`) carries `rpe`
  through, so every surface that renders a next-set target (editor chip,
  detail panel, coaching card, Telegram) reflects it identically by
  construction.

## Cross-cutting obligations

- **Migrations:** one append-only migration for the three routine tables
  (incl. `cycle_weeks`) and one for `exercise_sets.rpe`
  (+ `versions/index.ts` + `manifest.json` each); routine tables added to
  `lib/owned-tables.ts`.
- **Findings registry:** the volume-band observation registers its
  `muscle-volume:` prefix in `lib/rule-finding-prefixes.ts` and, as a
  findings builder, ships a realistic-fixture DB-tier test (#448) plus the
  reflection-guard coverage that comes with the registry.
- **Auth shape:** routine writes are auth-blind `lib/` write cores
  (`profileId` first); gates live in `app/(app)/training/actions.ts`
  (`requireWriteAccess` → validate → core → `revalidatePath`).
- **Tests per tier:** pure — guide-key resolution, `MuscleId` rollup
  invariants, `muscle-coverage` (incl. secondary-credit and band-verdict
  boundaries), template-day resolution + slot filling at boundaries,
  target-derivation (incl. the food_group non-replacement),
  `sessionCreditsDay` at its overlap/kind/once-per-day boundaries,
  `weekInCycle` / `deloadAdjust` / `effectiveCycleStart` at cycle and
  pause-gap boundaries, RPE-modified progression at its named
  thresholds and the no-RPE identity case, cold-start cases (zero-history
  session slate renders without load targets; `MIN_BAND_HISTORY_WEEKS`
  gating; confirm-free activation when no training-scope targets exist); action tier —
  adopt/activate/deactivate/edit-routine actions incl. the
  targets-replacement transaction, set-save with/without `rpe`; DB tier — if
  routine state feeds a findings builder, it ships a realistic fixture test
  (#448); e2e — the exercise detail panel (with guide section) opens from
  the picker, anatomy figure renders per-exercise and coverage modes,
  adopt-template flow, custom-routine builder round-trip, RPE selector
  round-trips through the activity form.
- **README + seed:** update Training docs/nav in the same PR; seed gains a
  sample active routine so the overview/coverage surfaces render on a fresh
  seed.
- **Content hygiene:** guides and templates are generic reference content —
  no PHI surface; keep it that way (no user data in the JSON).

## Phasing (each independently shippable)

1. **Static guides in the existing `ExerciseDetailPanel`** (+ overlay entry
   points) — content + one panel section, no schema change. Highest
   value/effort ratio.
2. **`MuscleId` enrichment + anatomy SVG** — per-exercise mode first (drops
   into the Phase-1 sheet), then weekly coverage on Overview.
3. **Routines** — schema + engine changes + builder UI; lands after 1–2 so
   its output is legible (a recommended session whose exercises each open a
   guide and light the anatomy figure).
4. **Volume bands** — extends Phase 2's coverage computation + one new
   observation; no schema change.
5. **Mesocycle/deload** — extends Phase 3's routines (`cycle_weeks` ships in
   the Phase-3 migration; this phase adds the engine/nudge behavior).
6. **RPE logging** — independent of 3–5 (own migration + form field +
   progression modifier); can land any time after Phase 1.

## Open questions

- Guide depth for the long tail of equipment variants (start with
  `equipmentNotes` only where cues genuinely differ).
- Volume-band default values and the secondary-credit factor (proposed 0.5)
  — to be justified with sources in the `lib/muscle-volume-bands.ts` header
  before Phase 4 merges.

## Resolved questions

- **SVG source:** hand-author (no third-party base) — see Anatomy component.
- **`position` advancement:** strictly on credited sessions, never on
  skipped/rest days — see Today's session.
- **Deload week vs volume-band observation:** the deload week suppresses the
  `below` finding through the same week-in-cycle flag — see Pillar 4a.
