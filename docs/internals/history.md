# The record: `/history`

Status: **phase 1 shipped** (#3958). One page is the app's record of what a
profile logged. It absorbed the four standalone ledger routes — the two dose
doors, the food door and the practice door — and the shared event-ledger frame
they mounted (`EventLedgerFrame`, #3484) went with them. `/timeline` is phase 2.

**There are no redirects.** The old routes are deleted, every inbound door was
retargeted at its source, and a surviving reference to one is a bug to fix
there. `git grep` for those paths is the acceptance criterion.

## The unit

One row = one recorded event: **(when, kind, what, detail, provenance,
mutability)**. Streams are not events; derived absences ("missed dose") are never
rows — the page states what was recorded, never a verdict; and there are no
forecasts, because a prediction is not something that happened.

Phase 1's kinds are the Logs family's: **doses · food · practices · substances ·
body**. Sleep and symptoms join in phase 2 with the Training, Clinical and Life
families.

## Structure

Day headers, sticky, counting their day. **No per-row date cell exists** — that
is most of what buys the one-line row. Within a day: instant descending,
date-only rows sinking below timed ones, same-instant rows tie-breaking on id so
the order is byte-stable across renders (one usual-routine tap writes six rows in
one minute).

That ordering is **not** implemented here. `mergeMemberTimelines`
(`lib/timeline-multi.ts`) already answered it for the multi-view timeline, so the
record composes it — generalized over its row type by #3958, which is a type
parameter and not a fork. One grouping engine for one member and for five, and
day bucketing therefore inherits #3428's resolution with no second answer.

## The grammar

`lib/history-format.ts` is pure and owns three things once:

- **the row model** (`HistoryRow`),
- **the clock** (`historyClock`) — a stated time renders bare ("10:07am"), a
  filing-time fallback renders "logged 10:07am", one meridiem style page-wide.
  This retires the shipped drift, where the food ledger said "Ate 2:03 PM" and
  the dose ledger said "recorded 12:02pm" in the same app,
- **the detail segment** (`detailSegment`) — quantity → context → source, joined
  with "·", empties dropped, and **never truncated at the string level**: a
  string-level cap cannot know the viewport, so overflow belongs to the row's CSS
  ellipsis.

`detailSegment` joins and knows nothing about a dose or a serving. The per-kind
**composers** live beside their reads in `lib/history.ts` and go through the
domain formatters that already exist (`fmtWeight`, `formatMinutes`,
`formatClockValue`). One grammar, many composers — the `formatDateShape`
architecture.

## The read

`lib/history.ts` composes the readers each ledger already used
(`getIntakeDoseLedgerPage`, `getFoodLedgerPage`, `getPracticeLedgerPage`,
`getAllSubstanceDailyTotals`, plus the `body_metrics` rows the metric detail
pages render). Every read takes `profileId` first and is scoped by it in SQL; the
module imports no auth.

`?view=everyone` calls the same gather **once per member**, so every visibility
rule — the substance age gate included — is inherited per row rather than
re-derived across a widened query. The page cannot show this login more than each
member's own pages do.

**The record ends at now.** Rows dated after the subject's today are dropped in
the gather, and a future `?day` clamps to today. The timeline's future fold is
not inherited: the future belongs to `/upcoming`.

## The rows

One line at **every** viewport (owner ruling), on #3891's `LoggedEventRow`
primitive — a deliberate exception to the #3671 compact-card default, argued from
what the surface is for: scanning many rows. There is no tap-to-disclose, so the
rows are `<li>`s rather than a `ResponsiveTable`, whose card mode exists to stack
a row onto several lines.

The trailing affordance is **⋯ or ›, exclusively**. Every phase-1 kind is
user-logged, so every row is a ⋯ row — and every branch posts to the Server
Action that domain already had. **No new write paths.** In `?view=everyone` the
⋯ renders only on the acting profile's own rows, because those actions resolve
their subject from the session.

## Navigating time

No 7D/30D chips, no From/To card, no window note, no numbered pages. #2657's
month/year **folds** with URL-carried open state, plus **load-more** (`?show`),
bound the read; the **jump rail** (`components/JumpRailScrubber.tsx`) scrubs the
fold spine and owns a lane via `SCRUBBER_GUTTER_CLASS` rather than overlaying a
row's action column. The rail is shared with `/timeline` until phase 2 retires
that route — which is what closed #2816: the overlay chokepoint's rule 5 could
only see `addEventListener` recognizers, and a JSX-prop one had landed unlisted.

## The URL

`lib/hrefs.ts`'s `historyHref` owns the whole grammar: `?family`, `?kind` (which
implies its family), `?class` (the old two-door dose pre-filter), `?item`,
`?media`, `?day`, `?view=everyone`, `?open` (repeatable), `?show`. There is **no**
`from`/`to`/`range`/`page` — those concepts died with the range row and the pager.

An invalid `?kind`, `?family` or `?day` **falls back to All**. A record surface
that 404s on a hand-edited URL is a record you cannot get back to.

## Chrome budget

≤ ~140px above the first record at 390px, and it is an acceptance criterion. What
buys it: no h1/subtitle below `sm` (the nav names the page), ONE filter row, no
range chrome at all, sticky day headers, and the Add bar as the only other
chrome. **A proposed addition to the header stack has to name what it displaces.**

## What is deliberately elsewhere

Per-item panels keep their bounded recent window plus a door (`DoseHistoryPanel`,
the metric detail page's readings — #3505/#3959). `lib/day-history.ts`'s
group×bucket matrices answer "how consistently?", which is analysis, not a
record. The training hub keeps its own log.
