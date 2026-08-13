# Day history — the group×bucket calendar + matrix substrate

"What did I actually log, day by day, and what was it?" is ONE question with
two halves, answered by one model (`lib/day-history.ts`) and one client
renderer (`components/DayHistory.tsx`):

- the **calendar** (coverage): one cell per day on the shared `dayGrid`
  (#2042), colored by the day's total — how consistently the thing happened;
- the **matrix** (composition): one row per group, one cell per day — what the
  thing was, ranked by window volume with the tail folded into a tappable
  "+N more" row (never a fold of one).

A column is a **bucket**, and a bucket is a day or a week — see
[Grain](#grain-follows-the-window) below. Everything except the aggregate
half's cell shape is the same code at both grains.

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

## Grain follows the window

Day cells do not scale past a quarter, so a year-scale request used to be
CLAMPED back to the day cap: 1Y and All-time rendered the most recent 13 weeks
and the range pill did nothing above a quarter, quietly breaking the hub's
one-shared-range promise (#2413). The answer is not more day columns — the
**grain follows the window, automatically**. There is no toggle: the range
picker already asks the question, and a second control would be a second answer
to it.

`dayHistoryWindow()` is the decision, and it is the third instance of the
repo's grain discipline (`dayGrid` lays days on a 7×N grid; `lensWindow`
resolves the hub's `DateRange` to one anchor; this resolves it to a grain):

- its input is the **UNCLAMPED** span (`desiredHistoryWeeks`, the lens's own
  `ceil(days / 7)` minus the clamp). Asking `lensWindow`'s already-clamped
  `weeks` whether the request exceeded the cap can only ever answer "no" — that
  IS the defect. It is deliberately NOT the week-ALIGNED `weekSpan`: a
  Wednesday-anchored 90 days touches 14 calendar weeks, so an aligned measure
  would read 14 > 13 and flip the hub's own 90D default to week grain;
- **strictly above** `MAX_HISTORY_DAY_WEEKS` (13) → week grain, capped at
  `MAX_HISTORY_WEEK_COLUMNS` (53, the trailing-12-months convention). A range
  resolving to exactly the cap keeps its day cells;
- an all-time window always re-grains;
- at day grain the lens's clamped column count passes through **unchanged**, so
  a 90D window renders exactly what it always did.

The 13-week day cap is the SUBSTRATE's, not a lens's: "day cells don't scale
past a quarter" is a fact about a 7×N grid of 24px squares and is equally true
on both surfaces. It coincides with `NUTRITION_HISTORY_WEEK_CAPS`; the Fitness
lens's own 53-week cap is about its weekly BAR charts, where 53 bars read fine
and 53×7 day cells do not, so `WorkoutHistorySection` takes the substrate cap
and the tab's other weekly builders keep their shared count untouched.

At week grain:

- a bucket is identified by its **week start** on the profile's week-start
  alignment — the same alignment `dayHistoryStart` and `dayGrid` already use,
  so the two halves can never disagree about where a week begins.
  `historyBuckets` is the one list both read;
- the calendar collapses to a single-row **week strip** (`buildDayHistoryStrip`,
  still an adapter over `dayGrid` — nothing re-derives week arithmetic). The
  7-row day-of-week shape is meaningless when every cell IS a week, and
  `ActiveDaysStrip` is the in-app precedent;
- the matrix keeps its geometry with **no intra-week gap** (every boundary is a
  week boundary), and its reserved header prints **month names** above the weeks
  that open a month instead of a date per column;
- the day panel becomes the **week panel**: "Week of …", the Timeline link spans
  the week (`timelineRangeHref`), and the dose ledger link takes the same span —
  `dayLink.href` takes a `(from, to)` pair, which at day grain is the same day
  twice. "Log for this day" is **withheld**: it seeds a DATE into a writer, and
  seeding a week's first day would file the entry on a day the reader never
  picked;
- the today marker is the **current week's** cell;
- `activeHistoryWeeks` (leading trim) applies unchanged — it already thinks in
  weeks.

### The partial trailing week

The last bucket of a week-grain window is normally partial: on a Wednesday the
current week is four days old. That is a fact about the WINDOW, not a gap in the
data, so it is

- **kept** — trailing emptiness is the live signal, exactly as `lib/day-fill`
  keeps trailing empty days rather than letting a multi-week outage render as
  adjacent weeks; and
- **declared** — `historyBucketCoverage` reports `days`/`partial`, and the cell,
  the caption and the panel all say "4 days so far", so a half-elapsed week's
  smaller total is never read as a decline. The strip cell carries
  `data-partial`.

The Timeline link for a partial week stops at the window's end rather than
claiming days that have not happened.

## Domains are declared, not forked

`DAY_HISTORY_DOMAINS` is the policy registry (the fitness-freshness pattern):
a domain supplies only its unit words, titles, ramp, calendar meaning, optional
hover-detail suffix (workout minutes), and its level policy. Every matrix cell
ladder is the shared 1/2/3/4+ `intensityLevel`; workout/practice calendars retain
that quantity while food/dose calendars deliberately encode coverage.

Ladders are declared **per domain per grain**, the same split as
`calendarLevel`/`cellLevel`: `weekCellLevel`, `weekStripLevel`,
`weekLevelLabels` and `weekCalendarTitle` are required, and the completeness
test in `lib/__tests__/day-history.test.ts` fails a domain that declares a day
ladder and forgets its week twin. The week ladders are TUNED, not rescaled by
reflex — a ladder that saturates on an ordinary week says nothing:

| domain   | week cell            | week strip            |
| -------- | -------------------- | --------------------- |
| food     | 1–2 / 3–4 / 5–7 / 8+ | coverage (any / none) |
| workout  | 1 / 2 / 3 / 4+       | ≤7 / ≤14 / ≤21 / 22+  |
| dose     | ≤7 / ≤14 / ≤21 / 22+ | coverage (any / none) |
| practice | 1 / 2 / 3 / 4+       | ≤7 / ≤14 / ≤21 / 22+  |

The coverage decision is **restated at week grain, not rescaled**: a
twelve-serving week must not glow better than a three-serving one for exactly
the reason a twelve-serving day must not. `weeklyIntensityLevel` is the shared
×7 ladder for the quantity domains. A fifth domain
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
- **Doses** key on `intake_items.id`, never the user-owned name. Distinct items
  may legitimately share a name; their labels use product/brand/kind to
  disambiguate while the confirmed amount rides along as a cell note, never
  summed.
- **Practices** key on `practiceIdentity` (the canonical key the wellness
  surfaces bind user-owned spellings through), labeled by the first-seen
  spelling.

## Windowing

The window is the hub's shared `DateRange` through `lensWindow` with per-lens
week caps (`NUTRITION_HISTORY_WEEK_CAPS`, `FITNESS_WEEK_CAPS`), then through
`dayHistoryWindow` for its grain, aligned to the profile's week start;
`dayHistoryStart` gives both halves — and the query — one identical day list. `activeHistoryWeeks` then trims LEADING all-empty
weeks (the `day-fill` doctrine at week grain), computed on the UNFILTERED
values so a chip toggle never reflows the grid; trailing emptiness is kept —
a quiet recent stretch is the live signal.

## Renderer contracts

- Workout/practice cells use `chartActivityRamp`; observational food/dose cells
  use the royal-blue `chartObservationRamp`, so a larger recorded quantity never
  reads as a green health verdict. Food and dose CALENDARS are binary coverage;
  their matrices retain quantity. Each ramp also declares its theme-aware label
  foreground, validated at 4.5:1 against every step. Today prints its day-of-month
  in the calendar cell; it adds no ring, matrix rail, fill, or second data color.
- Calendar axis labels sit in RESERVED gutters — a 16px header row for month
  names, a 30px left column for all seven weekday names — never on the grid
  (#2582). In a heatmap the cell's fill level IS the data, so anything translucent
  on a cell makes a covered day read as a lower level than it has: a 16px month
  chip hung 6px above the grid reached into the first row's cells, and a "Mon"
  chip was wider than a 24px cell. All seven weekdays are labelled now — the old
  alternating rows were an artifact of that collision, not a choice. The week
  strip's month names ride the same reserved header. The matrix has a REAL
  reserved date header (`Jul 26`, `Aug 2`, …), including month names because it
  scrolls independently, plus an extra gap at each week boundary. A hovered or
  selected day prints its day-of-month inside the calendar cell and pins its
  compact date above the exact matrix column; weekly labels in that marker's
  collision zone yield until the hover/selection moves.
- At desktop `xl` widths, an active day or row detail shares an equal-width
  two-column band with the calendar; both stack at narrower widths and the
  matrix remains full-width below. The detail is a companion pane, not a card;
  stacked layouts use one dividing rule instead of boxed chrome. The calendar
  observes its own container so opening or closing that detail remeasures its
  cells without a window resize. Both panes share one text grammar: visible
  14px semibold headings, 12px muted summaries, and 12px ledger rows with
  tabular quantities.
- Both scrollers bleed edge-to-edge on phones and open at the RECENT edge;
  calendar cells grow from 24px toward 34px when the window is short.
- Sticky matrix row labels use a padded, FULLY OPAQUE surface with a hairline
  right rule. A frozen first column necessarily sits over cells at any scroll
  offset past zero, and those cells stay reachable by scrolling — but the former
  70%-opacity fade left them dimly visible, i.e. showing a level they do not have
  (#2582). Hidden is honest; washed out is not. Hovering a row label drives the
  same row emphasis and detail text as hovering that row's cells. The label is
  a pointer-marked control: selecting it persists the row emphasis and opens a
  reading-width, vertically bounded, newest-first ledger of occurrence dates
  and per-date quantities. Hover and selection share one treatment (bold label,
  row tint, and dimmed peers); labels never underline.
- When the matrix has multiple rows, hovering or selecting a row also projects
  its occurrence days onto the aggregate calendar. Matching days keep their
  ordinary calendar color while non-matching days recede strongly; the row name
  and aggregate quantity across active days replace the calendar heading and
  summary during a live preview, and the per-day match is exposed to assistive
  technology. Selecting a still-hovered row does not prematurely end that live
  preview. Once the pointer leaves, the neighboring row panel owns the row
  summary, so the calendar returns to its own heading and aggregate instead of
  repeating it. A single-row matrix suppresses the projection because the row
  adds no distinction.
- Hover, focus, and TAP all push a cell summary into the shared caption —
  `title` never fires on touch. The matrix is an ARIA grid with one roving tab
  stop; arrows traverse group/day and Enter/Space select. Hover state is SHARED
  across the two charts,
  keyed on the day: hovering a matrix cell draws a crosshair (cell ringed, row
  tinted, column full, everything else dimmed — suppressed at one row, where
  the row IS the matrix) and echoes onto its calendar day; hovering a calendar
  day highlights that column in the matrix. Calendar and matrix hit targets own
  the visual gaps to their right and below (including the matrix's wider week
  separator), so the date/crosshair never drops while the pointer crosses
  whitespace.
- Every non-future calendar day is selectable, including a quiet day. Selection
  opens the day panel, scrolls the matching matrix column into view and keeps
  the domain ledger one link away: populated workout days and workout-row
  occurrences use `trainingLogDayHref`, while empty workout days and the other
  domains use `timelineDayHref`. Matrix selection opens the SAME panel. Its
  persistent matrix cue is the exact date pinned over that column plus the
  ordinary day-hover emphasis (selected column saturated, other columns dimmed)
  whenever no live hover/focus preview is active—no fill, rail, or repeated
  outline around the cells. A live preview temporarily takes priority; selection
  returns when it leaves. The matrix header also states its currently visible
  date span without decorating every calendar cell as though it were selected.
- The day panel also closes the gap-to-action loop (#2420). Each surface passes
  an AppRoute-checked `addHref`; `dayHistoryAddHref` appends the selected day
  using the destination's declared parameter (`date`, `backfill`, or `log`).
  The resulting “Log for this day →” opens the existing writer rather than a
  chart-owned form: Food selects the day inside its seven-day picker (or states
  that bound and falls back to today), Supplements opens a top-level item picker
  over the shared historical-dose form (any past day, never future), Wellness
  opens its shared detailed practice form after a practice picker (previous 30
  days), and Training opens the activity editor with only its date seeded. A
  date link never fabricates an item, practice, workout type, or title.
- Long group vocabularies start at five chips. The counted “+N more” / “Show
  less” action sits inline after those data chips and immediately before the
  dashed All/None actions; “Viewing N of M groups” keeps filter state visible
  without pretending any action is a data group. Any filter transition into
  exactly one visible group temporarily selects that row and opens its companion
  ledger. Expanding from one group to two (or All), or clearing it with None,
  removes that automatic selection; an explicit row selection remains distinct.
- The visible scale names every exact bucket (`0 1 2 3 4+ sessions/servings/...`)
  rather than implying an unexplained “Less / More” and sits at the matrix
  header's top right beside its visible date span. The aggregate summary lives
  under the calendar heading instead of consuming a matrix footer. Hover,
  focus, or tap detail temporarily replaces the visible “By …” label on the
  left; the accessible section name, date span, scale, and surrounding layout
  stay fixed. Dates in panels and cell names honor the login's display-format
  preference.

## Tests

`lib/__tests__/day-history.test.ts` (model: ladders at both grains and their
completeness, the grain decision at the cap boundary, week bucketing, the strip,
the partial trailing week, ranking, folding, trim, notes, grid padding), `lib/__db_tests__/workout-activity-days.test.ts` +
`practice-days.test.ts` + `trends-fitness-window.test.ts` (identity + windowing
over real SQL), and the Nutrition/Fitness/Wellness plus
`day-history-backfill.spec.ts` specs in `e2e/` (rendering, domain-ledger and
dated-entry link shapes, destination prefills/bounds, chip filtering, and the
cross-practice rows).
