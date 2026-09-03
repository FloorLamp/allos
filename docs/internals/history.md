# The record: `/history`

Status: **phase 2 shipped** (#3958). One page is the app's record of what a
profile logged. It absorbed the four standalone ledger routes — the two dose
doors, the food door and the practice door — and the shared event-ledger frame
they mounted (`EventLedgerFrame`, #3484) went with them. Phase 2 added the
Training, Clinical and Life families with the sleep, symptom and cycle gathers
and the Everything rollups, then took `/timeline` itself: the route is deleted,
its day view is `?day=`, and its nav and mobile-dock slots are the record's
(#3343 Q5, `trainingRelevant ? TRAINING : HISTORY`).

**What phase 2d brought across.** `lib/timeline.ts` computes `linkedRefs` (#662
visit→document lineage) and `detailItems` (lab panel breakdowns, activity set
summaries, a symptom-day's per-symptom severities); their only renderer was the
deleted page's `EventCard`, so between phase 2c and 2d the record gathered them
and showed them nowhere. The feed rows carry them now and the row's **disclosure**
draws them — see The rows.

**Per-event `tone` was never in that gap, and this document said it was.** Its
renderer is `IntradayTick`: `lib/intraday.ts` reads `event.tone` off the same
resolved event set the day list is built from, and `components/IntradayChart.tsx`
colours each tick by it. That has been live on `?day=` since phase 2c. The claim
here was inherited from the phase-2c commit body and was wrong when it was
written — the kind of assertion that goes stale silently because its truth rested
on a behaviour somewhere else.

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

## One act, one row

A standard drink is stored as one serving of the curated `alcohol` food group
(#860/#944) — a **storage** decision, and not a claim that a drink is a meal. The
record reads both stores, so before the ruling of 2026-08-29 one drink appeared
twice: a `food` row ("Alcohol · Evening") and a `substance` row ("Alcohol · 1
standard drink"), and the day header counted **2 records** for one act.

**Alcohol is a substance here, and the food kind excludes it**
(`excludeSubstanceGroups` on `getFoodLedgerPage`). Three reasons, in the order that
decides it:

1. **The age gate.** The substance kind is gated on `isMinor`; the food kind is not,
   and correctly is not. Measured before the change: a known minor's `?kind=food`
   returned that drink as a row titled "Alcohol" while `?kind=substance` returned
   nothing — so the gate was decorative for exactly the rows it exists to cover.
2. The record's day count is a count of things that **happened**, and one drink is
   one thing.
3. The substance row describes the act in the person's own terms.

**Two consequences follow from the ruling and are decided, not accidents.** A day's
drinks are one editable **day count**, so a single mistyped drink can no longer be
corrected or deleted on its own from the record; that correction lives on the substance
surface, which owns the counter. And a drink stated no time at all, so the row rendered
**date-only** and sank to the bottom of its day.

**The second consequence is now conditional (#3295 phase 1).** The substance add door
offers alcohol the shared `WhenControl`, so a drink CAN state its minute — stored on the
serving event as `occurred_at` with `time_source = 'stated'`, which is the column
`food_daily_totals` never had. `SubstanceDailyTotal.statedAt` is the day's **earliest**
such statement, read through the declared `food_log_events` event column, and the row
takes a stated clock from it and — as category `substance`, at that minute — a tick on
the day chart's rail. A day nobody stated a time for still renders date-only and sinks,
and so does every nicotine, cannabis and custom row for ever: `substance_daily_totals`
is UNIQUE per (profile, date, substance) and declares no event column. That last part is
the trap — `bestKnownInstant` on that table answers with `recorded_at`, the FILING stamp,
which would put a use on the chart at the hour somebody typed it. The read asks for the
EVENT instant and takes null for an answer.

**The drink does not disappear, and the totals do not move.** The food door writes
the `food_daily_totals` counter as well as the event, and the substance read is over
that counter — so a serving logged from Nutrition still reaches the record, once,
under Substances. What changes for a reader is where they find it. Food _totals_ and
the nutrition arithmetic are untouched: this is the record's row set.

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
what the surface is for: scanning many rows. The rows are `<li>`s rather than a
`ResponsiveTable`, whose card mode exists to stack a row onto several lines.

**The disclosure is the detail cell**, and the row's own grammar is what chose it.
A row that carries `detailItems` or `linkedRefs` renders its detail segment as the
toggle, with a chevron outside the truncating span; every other row renders the
same segment as plain text. The trailing cell was not available — #3958 rules the
trailing affordance exclusive (⋯ or ›, never both) — and the leading chevron is the
rollup line's. What was left is the cell the issue itself points at: _"what
truncates first; long detail lives behind the row's disclosure"_. So the control
sits where the truncation is, costs no width, and is the same on a ⋯ row and a ›
row.

The open panel is the row's **sibling** `<li>`, not its child: a row `<li>` is
`flex items-center` on the shared primitive and the page's geometry assertions
measure it, so growing it into a column when a reader opens one would move the
thing they measure. The rollup's revealed rows are siblings for the same reason.
Open state is **client** state, unlike the folds and the rollups — the split is a
rule: URL-carried when expanding changes what the server must render, client state
when the content already arrived on the row.

The lineage panel's heading claims exactly what the gather had (#2920): _"From this
visit"_ for rows carrying a real encounter link, the document wording only where the
import document stands for a single visit. A multi-visit portal export sets neither,
because a reference chip that cannot honestly name its visit says nothing.

The trailing affordance is **⋯ or ›, exclusively**. Every phase-1 kind is
user-logged, so every row is a ⋯ row — and every branch posts to the Server
Action that domain already had. **No new write paths.** In `?view=everyone` the
⋯ renders only on the acting profile's own rows, because those actions resolve
their subject from the session.

## Navigating time

No 7D/30D chips, no From/To card, no window note, no numbered pages. #2657's
month/year **folds** with URL-carried open state, plus **load-more** (`?show`),
bound the read. `?show` is clamped at `HISTORY_MAX_SHOW`, and AT that ceiling the
control stops rendering and the page says how much it is showing — a button whose URL
changes and whose page does not is worse than no button.

**It names no escape, and that is the correction of one.** It briefly said "narrow to
one kind, or open a day", and the first half was false: `limit` is applied PER KIND
inside the gather, so the All view already reads every kind to `show` and the chip
carries `show` across — the narrowed view returns the identical rows. A sentence that
sends the reader back to where they are spends their trust as well as their tap. The
day view is where "further back" gets a real answer.

**`limit` is per kind for the LOGS kinds only.** Each has its own reader, gated by
`wants()` before it runs. The sixteen feed kinds share ONE `getTimelineEvents` read
that is deliberately NOT narrowed — the chips a reader is offered must not depend on
the filter they already set — so a feed-kind view reads the newest `show` events across
all sixteen and keeps the matching ones. On a dense profile that window is far
shallower than the same filter reached on `/timeline`, which pushed the category into
the query. Open on #3958.

## The day view

`?day=YYYY-MM-DD` is the app's one "that day" anchor, and the same mount: the page
server-selects the day presentation rather than routing anywhere. Rows are flat — a day
view lists everything, so no rollups. It carries what `/timeline`'s single-day view
carried: the **intraday panel** (#1068), the day's **context** (daylight, UV, weather,
cycle phase — see below), and **prev/next nav** with its swipe (#1425). It carries no
symptom bar: #4851 retired that card, so symptom is an add-door kind everywhere and
the day's Add row offers it beside its siblings.

**Order, top to bottom** (#4918): day bar → chart → add layer → rows. The chart is
CONTENT the day view inherits — #3958 lists it beside the rows — so moving it above
the add layer does not spend the chrome budget below; what it fixes is that the day's
own content had the weakest position on its own page, under three frames of three
styles. The add layer sits directly above the rows it creates, offers first (#4832).

**The day bar names the day** (#4918): `TimelineDayNav` prints
`Wed, September 3 — 15 records` between its arrows, in the #3958 header grammar and
with "0 records" on an empty day. The per-group `<h2>` is the FEED's only — on the day
view it rendered once per group of rows, so a day with none named no day at all, and a
day with rows named it below the chart as a link to the page already open. `next` is
optional and absent on today, so neither the arrow nor the leftward swipe exists there;
the arrow's comment had claimed that since #4168 while the code passed today's own
href. The page subtitle ("Everything recorded, newest first.") describes the feed and
is not rendered on the day view.

Two rules decide what it draws. Context is **single-subject**: daylight, UV, weather
and cycle phase are one body's, so `?view=everyone&day=` lists the rows and draws no
chips. And the panel reads the **resolved row set** (`HistoryGather.dayEvents`), never
a second query, so a tick can never name something the list below does not show; the
ticks carry the row's own `feed:`-namespaced anchor, built by the same
`timelineEntryAnchorId` the row is.

**The chart card owns the day's context now** (#4918 ruling 3). The standalone
`history-day-context` strip retired: `DaylightChip`, `CyclePhaseChip` and the weather
line moved into `IntradayPanel`'s own context area, under the title and above the
plot — each chip stays quiet by default, so a quiet day still draws nothing there.
Sunrise→sunset (`lib/sun.ts`'s `solarDay`) also feeds the chart itself, as a subtle
background band on the plot (`lib/intraday-layout.ts`'s `daylightBandX`) — a
BACKGROUND fact, not a row: it reserves no lane, so adding or removing it never moves
the row stack, the axis ticks or any x-projection.

**The chart card always renders on a day view** (single-subject; the owner's
2026-09-03 ruling on the empty-day gap #4923 found). `getIntradayDay` now always
returns a model — a day with no HR, sleep, workout or clock-timed event gets one
whose four data layers are simply empty, so the card still draws the daylight band
and its context line; only the rows are missing.

**Today names its own sleep wait, in words and on the plot** (#4918 ruling 7). On
`day === todayStr`, `getSleepWaitingState` decides whether last night is still
outstanding; when it is, the context line states the headline and its detail (the
freshness sentence stays — the two lines say different things), and the chart draws
the profile's `typicalBedTime` → `typicalWakeTime` window (the same pair the
dashboard's usual band reads, #3253) as a hatched **expected** band in the sleep
lane. The band shares that lane with a real session — it reserves the row the moment
either exists — and draws only while waiting: never on a day whose session is in
hand, and never on a past day (the window is clock-relative and means nothing there).

A future `?day=` clamps to today and the nav cannot advance past it — the record ends
at now.

The **jump rail** (`components/JumpRailScrubber.tsx`) scrubs the
fold spine and owns a lane via `SCRUBBER_GUTTER_CLASS` rather than overlaying a
row's action column. The rail was shared with `/timeline` while both pages
scrubbed one fold spine; phase 2 retired that route, so the record is its only
host — which is what closed #2816: the overlay chokepoint's rule 5 could
only see `addEventListener` recognizers, and a JSX-prop one had landed unlisted.

## The URL

`lib/hrefs.ts`'s `historyHref` owns the whole grammar: `?family`, `?kind` (which
implies its family), `?class` (the old two-door dose pre-filter), `?item`,
`?media`, `?day`, `?view=everyone`, `?open` (repeatable), `?show`. There is **no**
`from`/`to`/`range`/`page` — those concepts died with the range row and the pager.

An invalid `?kind`, `?family`, `?day`, `?item` or an unsatisfiable `?media` **falls
back to All**. The item axis
degrades only where the vocabulary is CLOSED — food groups and the three body measures
— because that is where a pure layer can answer; `?kind=food&item=alcohol` is the case
the alcohol ruling created, and it degrades rather than rendering an empty page that
asserts there is nothing. `?media=1` degrades on the same rule and for a reason that will expire on its
own: no phase-1 kind carries row media, so the filter is asked of the ROWS the gather
produced rather than of the phase — the day a kind carries media it starts working with
no edit, and until then the page shows the record instead of asserting it is empty. Dose items and practice names are open per-profile
vocabularies whose membership is a DB question, so their readers answer it by returning
nothing. A record surface
that 404s on a hand-edited URL is a record you cannot get back to.

## Chrome budget

≤ ~140px above the first record at 390px, and it is an acceptance criterion. What
buys it: no h1/subtitle below `sm` (the nav names the page), ONE filter row, no
range chrome at all, sticky day headers, and the Add bar as the only other
chrome. **A proposed addition to the header stack has to name what it displaces.**

On the day view the day bar's name displaces the per-group header it replaced — the
trade #4918 names honestly: the bar was already on screen, and the header it retired
was the one that self-linked.

## What is deliberately elsewhere

Per-item panels keep their bounded recent window plus a door (`DoseHistoryPanel`,
the metric detail page's readings — #3505/#3959). `lib/day-history.ts`'s
group×bucket matrices answer "how consistently?", which is analysis, not a
record. The training hub keeps its own log.
