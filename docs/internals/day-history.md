# Day history

`lib/day-history.ts` and `components/DayHistory.tsx` share a calendar and a
matrix for logged activity. The calendar shows aggregate coverage or quantity;
the matrix shows each group's contribution, ranked by window volume. A column
represents a day or a week. Extend the shared model and renderer for new domains.

## Owners and surfaces

| Concern                                                         | Owner                                          |
| --------------------------------------------------------------- | ---------------------------------------------- |
| Domains, grain, buckets, levels, ranking, folding, leading trim | `lib/day-history.ts`                           |
| Calendar, matrix, filters, selection, and detail panels         | `components/DayHistory.tsx`                    |
| Food and confirmed-dose history                                 | `app/(app)/trends/NutritionSection.tsx`        |
| Workout history                                                 | `app/(app)/training/WorkoutHistorySection.tsx` |
| Cross-practice history                                          | `app/(app)/wellness/page.tsx`                  |
| Dated entry and history destinations                            | `lib/hrefs.ts`                                 |

Protocols use their own bounded adherence heatmap, including outside-window
padding. They are not a cross-group composition domain; do not force them into
this matrix.

## Windows and grain

Nutrition and Training derive history from their shared range. Pass its inclusive
`days` and the lens's day-grain `weeks` to `dayHistoryWindow`. Wellness currently
uses the fixed `WELLNESS_PRACTICE_HEATMAP_WEEKS` window at day grain.

`dayHistoryWindow` chooses day grain through 13 desired weeks, and week grain
strictly above that limit. All-time selects week grain. Day grain keeps the
caller's column count; week grain caps at 53 columns. The desired span comes from
`desiredHistoryWeeks(days)` (`ceil(days / 7)`), before clamping or week alignment.
An aligned 90-day span can touch 14 weeks without exceeding the day-grain limit.
Training's weekly bar-chart cap is separate from this calendar's day-cell cap.

Use the profile's week start throughout. `dayHistoryStart` aligns the query and
calendar window; `historyBuckets` supplies the matrix's matching bucket keys.
`activeHistoryWeeks` trims leading empty weeks using unfiltered values, so
filtering does not resize the window. Keep trailing empty weeks. With no positive
values, retain the requested window.

At week grain:

- Bucket keys are aligned week starts. The aggregate becomes a one-row strip
  through `buildDayHistoryStrip`, which uses the shared day grid.
- The matrix uses month headers and removes intra-week gaps. The today marker
  identifies the current week's bucket.
- `historyBucketCoverage` declares a partial trailing bucket with its elapsed
  days and `through` boundary. Cells, captions, and panels state that partial
  coverage; keep the bucket even when empty.
- Selection opens a week panel. A week does not identify a logging date, so
  “Log for this day” is absent.

## Domain policy and identity

`DAY_HISTORY_DOMAINS` owns units, titles, color ramp, coverage/quantity meaning,
optional detail suffix, day/week levels, and domain links. Select this policy by
key in the client; do not pass functions across the server/client boundary or
repeat level rules in the renderer.

Day matrix levels are 0, 1, 2, 3, and 4+. Workout/practice calendars show quantity;
food/dose calendars show binary coverage at both grains. Their observation ramp
must not imply that recording more food or doses is a better health outcome.
Workout/practice use the activity ramp.

Weekly nonzero levels are domain-specific:

| Domain            | Matrix cell          | Aggregate strip      |
| ----------------- | -------------------- | -------------------- |
| Food              | 1–2 / 3–4 / 5–7 / 8+ | Any / none           |
| Dose              | ≤7 / ≤14 / ≤21 / 22+ | Any / none           |
| Workout, practice | 1 / 2 / 3 / 4+       | ≤7 / ≤14 / ≤21 / 22+ |

Use each domain's own identity:

- Food: catalog slug (`food_daily_totals.group_key`), with catalog labels, icons,
  tier tint, and abbreviations. Unknown slugs fall back to their key.
- Workout: `activityHistoryKey`, gathered by `getWorkoutActivityDays`. A sole
  cardio/sport component can name the activity; otherwise normalize its title
  through `workoutActivityLabel`. Strength components are exercises and must not
  replace the activity identity.
- Dose: intake-item id, not its editable name. Disambiguate labels with product,
  brand, or kind. Confirmed amounts are notes, not quantities to sum together.
- Practice: canonical `practiceIdentity`, labeled by the first-seen spelling.

## Rendering and interaction

Preserve these behaviors in the shared renderer:

- Calendar labels occupy reserved gutters; matrix dates occupy a separate
  header. Labels must not cover data cells. Sticky row labels have an opaque
  surface. Show the visible matrix date span and exact scale buckets.
- Both scrollers open at the recent edge and extend to phone edges. Calendar
  cells grow for short windows and remeasure their container when a detail pane
  opens. At `xl`, calendar and detail share equal-width columns; below that they
  stack. The matrix remains full width. Detail panes use the shared heading,
  summary, and tabular-ledger styles.
- Today shows its day number without an extra data color or ring. Hovered or
  selected dates pin a label over the matching matrix column; competing header
  labels yield. Selection uses the ordinary column emphasis, restored after a
  live hover/focus preview ends.
- Hover state links both charts. A matrix cell emphasizes its row and column;
  a calendar cell emphasizes the matching column. Hit targets include visual
  gaps. Suppress the matrix crosshair for a single-row matrix.
- Row labels are selectable controls. Hover and selection share emphasis;
  selection opens a bounded, newest-first occurrence ledger. With multiple
  rows, row preview projects matching dates onto the aggregate calendar while
  dimming nonmatches. A selected row keeps its live preview until pointer exit;
  then the detail pane owns its summary and the calendar returns to its heading.
- The matrix is an ARIA grid with one roving tab stop. Arrows move through
  groups/buckets; Enter and Space select. Hover, focus, and tap expose the same
  caption detail. Quiet non-future days remain selectable. Selection scrolls
  the matching matrix column into view and opens the shared bucket panel.
- Group filters begin with five chips. Expansion controls precede All/None;
  the visible count describes the filter. Transitioning to one visible group
  automatically selects its ledger; leaving that state clears the automatic
  selection. Explicit selection remains distinct. Fold trailing rows into
  “+N more” only when at least two rows would be hidden.
- Temporary detail can replace the visible matrix title, while its accessible
  name, date span, scale, and layout stay stable. Format displayed dates using
  the login's preferences. Ramp label foregrounds must remain readable at every
  level in both themes.

## Destinations and entry

At day grain, populated workout buckets and workout-row occurrences use
`trainingLogDayHref`. Empty workout buckets and other domains use
`historyDayHref`. At week grain, the general History link opens the bucket's year
and month through `historyHref({ open })`; it does not apply a week filter.
The optional dose-history link currently uses `kind=dose&day=<bucket start>`.
Although the `dayLink` interface receives both bounds, that implementation opens
only the first day of a week bucket.

Callers supply an `AppRoute`-checked `addHref`. `dayHistoryAddHref` adds `date`
for food/workouts, `backfill` for doses, or `log` for practices. The destination
owns its item picker, date bounds, and form. A chart link supplies a date without
inventing an item, practice, workout type, or title. Keep destination-boundary
coverage in `e2e/day-history-backfill.spec.ts` when changing this contract.

## Existing verification

`lib/__tests__/day-history.test.ts` covers domain levels, grain boundaries,
buckets, partial weeks, ranking, folding, trimming, notes, and grid padding.
`lib/__tests__/hrefs.test.ts` covers dated destinations;
`components/__tests__/visual-title-parity.test.tsx` covers title/accessible-name
behavior across grain changes.

The existing DB suites `workout-activity-days.test.ts`, `practice-days.test.ts`,
and `trends-fitness-window.test.ts` cover identity and query windows. Browser
coverage lives in the Nutrition, Training, and Wellness specs plus
`day-history-backfill.spec.ts`. Use those cases for relevant behavior changes;
a prose rewrite does not require new tests.
