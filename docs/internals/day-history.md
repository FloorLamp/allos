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
a domain supplies only its unit words, titles, ramp, calendar meaning, optional
hover-detail suffix (workout minutes), and its level policy. Every matrix cell
ladder is the shared 1/2/3/4+ `intensityLevel`; workout/practice calendars retain
that quantity while food/dose calendars deliberately encode coverage. A fifth domain
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
week caps (`NUTRITION_HISTORY_WEEK_CAPS`, `FITNESS_WEEK_CAPS`), aligned to the
profile's week start; `dayHistoryStart` gives both halves — and the query —
one identical day list. `activeHistoryWeeks` then trims LEADING all-empty
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
- Calendar month/weekday labels remain compact overlays. The matrix has a REAL
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
- Sticky matrix row labels use padded, 70%-opaque surfaces that fade to
  transparent at the cell edge; they remain readable over horizontal scroll
  without ending in a hard rectangular slab. Hovering a row label drives the
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

`lib/__tests__/day-history.test.ts` (model: ladders, ranking, folding, trim,
notes, grid padding), `lib/__db_tests__/workout-activity-days.test.ts` +
`practice-days.test.ts` + `trends-fitness-window.test.ts` (identity + windowing
over real SQL), and the Nutrition/Fitness/Wellness plus
`day-history-backfill.spec.ts` specs in `e2e/` (rendering, domain-ledger and
dated-entry link shapes, destination prefills/bounds, chip filtering, and the
cross-practice rows).
