# Day history — the group×day calendar + matrix substrate

"What did I actually log, day by day, and what was it?" is ONE question with
two halves, answered by one model (`lib/day-history.ts`) and one client
renderer (`components/DayHistory.tsx`):

- the **calendar** (coverage): one cell per day on the shared `dayGrid`
  (#2042), colored by the day's total — how consistently the thing happened;
- the **matrix** (composition): one row per group, one cell per day — what the
  thing was, ranked by window volume with the tail folded into a tappable
  "+N more" row (never a fold of one).

Four surfaces render it: Trends → Nutrition's **Intake history** (food
servings) and **Dose history** (confirmed supplement/med doses), Trends →
Fitness's **Workout history** (sessions by named activity, which replaced the
bespoke #186 `WorkoutHeatmap`), and /wellness's **Practice history** (sessions
by canonical `practiceIdentity`, above the per-practice cards — placed THERE
because #2151 rules that Trends has no practices section; the cross-practice
day axis is the one thing no card can show).

**Protocols are a decided non-goal.** A protocol is a bounded experiment whose
heatmap runs start→end with explicit `outside` padding on BOTH sides, and its
question — adherence within one experiment's window — is per-item, already
answered by the card's `PracticeHeatmap`. A cross-protocol matrix would need a
per-row active-range cell state, for a composition question that rarely means
anything (windows neither align nor commonly overlap). Do not force-fit it.

## Domains are declared, not forked

`DAY_HISTORY_DOMAINS` is the policy registry (the fitness-freshness pattern):
a domain supplies only its unit words, optional hover-detail suffix (workout
minutes), and its two level ladders. Every matrix cell ladder is the shared
1/2/3/4+ `intensityLevel`; the CALENDAR ladders differ per domain because day
totals live on different scales (a food day runs 3–10 servings, a dose day
5–15 confirms — the wider ladders keep them from saturating). A fifth domain
(symptoms is the obvious candidate) is a registry entry plus a gather, not a
fork. Level policy lives in the model, not the component, because the filter
chips are client state: the client re-runs the pure builders on every toggle,
so policy is selected by domain key — never a function prop across the
server→client boundary.

## Identity per domain

- **Food** rows key on the catalog slug (`food_log.group_key`); labels, icons
  (`FoodGroupIcon` + tier tint), and the chip abbreviations
  (`foodGroupShortName`, the curated `FOOD_GROUP_SHORT` map beside the emoji
  map — the SAME vocabulary the Telegram food nudge's buttons and tally use)
  all come from the one catalog. An unknown/retired slug still renders,
  labeled by its key.
- **Workouts** key on `activityHistoryKey` (#1931) with identity resolved in
  `getWorkoutActivityDays`: a cardio/sport row's SOLE component names the
  activity itself ("Cycling" — a Strava ride titled "Pizza Hut" must not be a
  row), otherwise `workoutActivityLabel(title)` (time-of-day prefix, "N Min"
  infix and "Session" suffix stripped, so "Push day" and "Afternoon Push Day"
  land together). A STRENGTH row never takes the component path — its
  components are exercises, not the activity.
- **Doses** key on the intake item's name; the confirmed amount rides along as
  a cell note for hover copy, never summed.
- **Practices** key on `practiceIdentity` (the canonical key the wellness
  surfaces bind user-owned spellings through), labeled by the first-seen
  spelling.

## Windowing

The window is the hub's shared `DateRange` through `lensWindow` with per-lens
week caps (`NUTRITION_HISTORY_WEEK_CAPS`, `FITNESS_WEEK_CAPS`), aligned to the
profile's week start; `dayHistoryStart` gives both halves — and the query —
one identical day list. `activeHistoryWeeks` then trims LEADING all-empty
weeks (the `day-fill` doctrine at week grain), computed on the UNFILTERED
values so a chip toggle never reflows the grid; trailing emptiness is kept —
a quiet recent stretch is the live signal.

## Renderer contracts

- Cells use `chartActivityRamp` (the one blessed ramp; the class scan fails a
  hand-rolled ladder). Today's cells carry a persistent sky ring, echoed in
  the legend.
- Month/weekday/day-of-month labels are OVERLAID pills, not gutter rows, so
  cells get the full width; the matrix's day numbers slide UNDER its sticky
  row labels (z per use). The matrix adds an extra gap at each week boundary.
- Both scrollers bleed edge-to-edge on phones and open at the RECENT edge;
  calendar cells grow from 24px toward 34px when the window is short.
- Hover, focus, and TAP all push a cell summary into the shared caption —
  `title` never fires on touch. Populated calendar days deep-link into the
  Timeline (`timelineDayHref`). Hovering a MATRIX cell draws a crosshair: the
  cell rings, its row (tinted, label included) and its column stay full, and
  every other cell dims.
- Matrix cells are `aria-hidden` behind a per-row composed `aria-label` (the
  `PracticeHeatmap` precedent); per-cell keyboard navigation is a decided
  non-goal for now.

## Tests

`lib/__tests__/day-history.test.ts` (model: ladders, ranking, folding, trim,
notes, grid padding), `lib/__db_tests__/workout-activity-days.test.ts` +
`practice-days.test.ts` + `trends-fitness-window.test.ts` (identity + windowing
over real SQL), and the Nutrition/Fitness/Wellness specs in `e2e/` (rendering,
the Timeline link shape, chip filtering, the cross-practice rows).
