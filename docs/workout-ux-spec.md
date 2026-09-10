# Workout UX: guides, anatomy, routines, and progression

Status: **shipped**.

Routines are programs people adopt or author; recommendations resolve those
programs and suggest loads. The app does not invent a program or infer a training
cycle from fatigue.

Use the [development guide](development.md) and
[change and test policy](change-policy.md) for implementation scope and checks.

## Exercise guides

[Exercise guides](../lib/exercise-guides.ts) read committed reference content
from `lib/exercise-guides.json`. Lookup uses `exerciseHistoryKey`, so equipment
variants share a base guide, with equipment-specific notes where needed. The
accessor has no database, network, or runtime AI dependency. The authoring script
is `scripts/gen-exercise-guides.ts`; review its generated content before committing.
The existing guide tests check catalog coverage.

[ExerciseGuideSection](../components/ExerciseGuideSection.tsx) owns guide
rendering: setup, movement cues, breathing, common mistakes, optional safety and
equipment notes, and muscles worked. `ExerciseDetailPanel` embeds it; the
activity editor's `ActivityPartsList` opens it in the shared modal host for the
selected implement. Reuse this section for other hosts. The detail panel leaves
a new lift's guide open and keeps a familiar lift's guide available behind a
How to disclosure. Training deep links use `/training?exercise=…`.

A custom lift with no guide has no guide affordance. Guide content is generic
form reference, never profile data.

## Muscle identity and coverage

[`MuscleId` and `LiftDef`](../lib/lifts.ts) own muscle identity and exercise
attribution. Each catalog lift has primary and secondary muscle IDs; its
human-readable muscle label is display text. `muscleRegion` rolls IDs up to the
coarse regions used by targets, routine focus, and recommendations. New
muscle-keyed features use these IDs and rollups.

[Muscle coverage](../lib/muscle-coverage.ts) attributes working sets to catalog
muscles: one credit for each primary muscle and `SECONDARY_CREDIT` (0.5) for each
secondary muscle. Warmups and unresolved custom lifts contribute no credit.
`coverageFromSets` optionally restricts reads to a trailing window ending on the
supplied local day; future rows are excluded in that mode. With no window it
attributes the supplied session rows. It returns credited sets and last-trained
date per muscle; `musclesWorked` supplies the session union.

[MuscleAnatomy](../components/MuscleAnatomy.tsx) renders exercise, session, and
coverage modes from these shared inputs. Its hand-authored SVG paths live in
`lib/muscle-anatomy-paths.ts`. Keep the accompanying muscle names and coverage
list accessible; color and the figure supplement the text.

[Volume bands](../lib/muscle-volume-bands.ts) own the checked-in working-set
ranges, verdicts, and presentation palette. The coverage list, anatomy, and
findings consume that shared interpretation. `buildMuscleVolumeFindings` in
`lib/rule-findings/training.ts` gathers the seven-day coverage and history context.
Shortfall findings require at least two distinct training weeks in the history
window and a positive trained volume below the band. They are suppressed during
deload weeks and for regions excluded by an active injury. Untrained muscles
remain visible in coverage without becoming shortfall findings.

These are calm, dismissible observations under `muscle-volume:` with a monthly
episode key. They do not create push notifications or reorder exercise ranking.
Per-profile band overrides and a routine-builder band summary are not part of
this model.

## Routines and activation

[Routine cores](../lib/routines.ts) own profile-scoped reads and writes over
`routines`, `routine_days`, and `routine_slots`. Template adoption copies the
catalog's days and slots into those tables; the session engine reads that saved
shape for both template and custom routines. Read the current types in
`lib/types.ts` and builder inputs in [routine-derive](../lib/routine-derive.ts)
instead of maintaining a second schema in documentation.

The Training Routines tab supports naming a routine, arranging days and slots,
choosing ordered exercise candidates, and editing sets, rep ranges, and day
focus. Custom exercise names are allowed. `deriveFocusFromCandidates` seeds
editable focus from resolved catalog regions. A day with empty focus is treated
as cardio by the session engine.

Multiple routines may exist; activation makes at most one active. Inside one
transaction, `activateRoutine`:

1. Deactivates the profile's other routines.
2. Unlinks protocols from the training targets being replaced, then deletes
   targets in the `region`, `group`, and `type` scopes. Nutrition's `food_group`
   targets are preserved.
3. Inserts targets from `deriveRoutineTargets`: a recognized template uses its
   declared catalog targets; a custom routine or missing template derives region
   frequency from its days' focus.
4. Sets the start date to the profile-local day and resets the rotation cursor.

Training actions authorize and validate at the request boundary before calling
these cores. The activation UI lists targets to be replaced and asks for
confirmation only when that list is nonempty. Deactivation keeps derived targets
as ordinary editable frequency targets.

Fitness onboarding uses the same adoption and activation cores, offering
beginner templates and prioritizing bodyweight when no equipment is registered.
A fresh profile can receive sets and rep ranges immediately; suggested loads
remain absent until the relevant lift has history.

## Session resolution and credit

[The workout recommendation core](../lib/workout-recommendation.ts) resolves the
active routine through `resolveTodayRoutineDayIndex` and `resolveRoutineSession`.
The cursor selects a day modulo the number of days. Equipment availability ranks
each slot's candidates, preserving the first listed candidate when equipment is
unknown. An unavailable-equipment ranking is not a hard exclusion. Existing lift
history supplies nullable next-set seeds.

Training, coaching, and notification consumers use this shared result. Log this
session passes the resolved slate to the existing activity form and live workout
flow. With no active routine, the core uses its target and habit path.

`sessionCreditsDay` compares logged work with the current day: a strength day
requires overlapping strength regions; an empty-focus cardio day requires
cardio. Improvised sessions can qualify. `creditRoutineSession` advances the
cursor at most once per profile-local day, with its advance marker checked under
the write lock. Rest days, skipped days, and calendar time do not advance it.
Routine copy enriches the existing workout nudge and its dismissal key.

## Cycles and suggested loads

An optional `cycle_weeks` defines a calendar cycle whose last week is the deload
week. [Mesocycle helpers](../lib/mesocycle.ts) calculate the zero-based week from
an effective start; this clock is separate from the session rotation cursor.
A gap of at least `CYCLE_PAUSE_GAP_DAYS` (21) between credited sessions re-anchors
the cycle to the first session after the gap. An ongoing gap anchors it to today.
This is derived on reads. Restart cycle explicitly changes the start date and
leaves the rotation position intact.

`getRoutineCycleStatus` supplies shared cycle context. During deload, region and
group frequency shortfalls are suppressed; type targets can still appear.
Workout nudges use deload copy, and plateau guidance can mention an approaching
deload instead of suggesting another one.

[Strength progression](../lib/coaching/strength.ts) owns load adjustments.
`deloadAdjust` removes one working set per slot, with a minimum of one, and
reduces suggested load by about 10%, rounded to a loadable increment. Missing,
bodyweight, and loadless next-set targets keep their load behavior. Rendered load
suggestions pass through `contextualNextSet`, which applies recovery tempering
before deload. In the free editor, `getFormDeloadContext` limits the routine's
deload adjustment to exercises found in its slots.

[RPE](../lib/rpe.ts) is an optional per-set rating from 5 to 10 in half points.
`lib/rpe-tracking.ts` supplies the profile's opted-in control; opting out hides
the column without deleting stored ratings. `canonicalRpe` handles submitted
values at the write boundary. RPE complements target reps and to-failure intent.

In heuristic double progression, an anchor at the top of its rep range with RPE
at most 7 earns two load increments; an anchor below the rep floor with RPE at
least 9.5 holds the load with repeat guidance. Target-driven and bodyweight
branches retain their own behavior. An absent RPE leaves progression unchanged.
