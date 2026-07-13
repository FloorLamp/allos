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

One `ExerciseGuideSheet` client component (slide-over), reachable everywhere a
catalog exercise name appears:

- the activity-form lift picker (ⓘ affordance per option),
- `StrengthSection` / `StrengthExplorer` history rows,
- the next-workout recommendation card's exercise list,
- Telegram nudges via deep link (`/training?exercise=…` — two-way principle:
  buttons carry names/ids and deep-link, no new mutation).

The sheet is also the natural home for per-exercise data the app already
computes — next-set seed (`lib/exercise-window.ts`), e1RM trend, PRs,
`StrengthStandards` — making it a proper exercise-detail surface.

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

`components/MuscleAnatomy.tsx`: hand-authored inline SVG (front + back body
outlines) where each `MuscleId` maps to one or more `<path>` groups. Inline
and self-contained (no external assets), theme-aware fills, and never
color-only: hover/tap names the muscle, and a text list of primary/secondary
muscles always accompanies the figure. Authoring the SVG (or adapting a
permissively-licensed base, with attribution recorded here) is the main real
cost of this pillar.

Three rendering modes, each fed by one computation:

1. **Per-exercise** (in the guide sheet): primary saturated, secondary muted.
   Pure `LiftDef` lookup.
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

The confirm dialog lists exactly which targets will be replaced. Deactivating
a routine keeps the derived targets (they're now just ordinary targets the
user can edit or delete); this is stated in the confirm copy.

### Today's session stays in the ONE recommendation core

`workout-recommendation.ts` grows a routine-aware path: when an active routine
exists, resolve today's `routine_days` row (rotation `position` + the existing
weekday-habit signal), fill each slot with the first candidate the user can
actually do (reusing `deRankUnavailableLifts` / equipment availability), and
attach the existing next-set seed per lift for concrete "3×8 @ 62.5 kg"
targets. No active routine ⇒ exactly today's behavior. Telegram, dashboard,
and Training overview all render this one result, so they agree by
construction (#221). Completing a session (logging an activity that credits
the day's focus) advances `position`.

A "log this session" action pre-fills the activity form with the resolved
slate.

### Reach tier (#449)

Routine adherence is **coaching tier** — calm, hideable, never the
Needs-attention hero. The only push-tier touch is the existing workout nudge,
which gains richer copy ("Push day: Bench, Overhead Press, Dips") through its
existing dedupe/dismissal key — no new notification.

## Cross-cutting obligations

- **Migration:** one append-only migration for the three routine tables
  (+ `versions/index.ts` + `manifest.json`); tables added to
  `lib/owned-tables.ts`.
- **Auth shape:** routine writes are auth-blind `lib/` write cores
  (`profileId` first); gates live in `app/(app)/training/actions.ts`
  (`requireWriteAccess` → validate → core → `revalidatePath`).
- **Tests per tier:** pure — guide-key resolution, `MuscleId` rollup
  invariants, `muscle-coverage`, template-day resolution + slot filling at
  boundaries, target-derivation (incl. the food_group non-replacement);
  action tier — adopt/activate/deactivate/edit-routine actions incl. the
  targets-replacement transaction; DB tier — if routine state feeds a findings
  builder, it ships a realistic fixture test (#448); e2e — guide sheet opens
  from the picker, anatomy figure renders per-exercise and coverage modes,
  adopt-template flow, custom-routine builder round-trip.
- **README + seed:** update Training docs/nav in the same PR; seed gains a
  sample active routine so the overview/coverage surfaces render on a fresh
  seed.
- **Content hygiene:** guides and templates are generic reference content —
  no PHI surface; keep it that way (no user data in the JSON).

## Phasing (each independently shippable)

1. **Exercise detail sheet + static guides** — content + one component, no
   schema change. Highest value/effort ratio.
2. **`MuscleId` enrichment + anatomy SVG** — per-exercise mode first (drops
   into the Phase-1 sheet), then weekly coverage on Overview.
3. **Routines** — schema + engine changes + builder UI; lands last so its
   output is legible (a recommended session whose exercises each open a guide
   and light the anatomy figure).

## Open questions

- SVG source: hand-author vs adapt a permissively-licensed base (license and
  attribution to be recorded here before Phase 2 merges).
- Whether `position` should also advance on a skipped/rest day or strictly on
  credited sessions (proposed: strictly on credited sessions; a routine is a
  sequence, not a calendar).
- Guide depth for the long tail of equipment variants (start with
  `equipmentNotes` only where cues genuinely differ).
