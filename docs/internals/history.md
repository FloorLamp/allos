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

**Alcohol is a substance here, and the food kind excludes it** (`excludeAlcohol` on
`getFoodLedgerPage` — named for what it drops, since that clause has only ever
dropped the one group). Three reasons, in the order that decides it:

1. **The age gate.** The substance kind is gated on `isMinor`; the food kind is not,
   and correctly is not. Measured before the change: a known minor's `?kind=food`
   returned that drink as a row titled "Alcohol" while `?kind=substance` returned
   nothing — so the gate was decorative for exactly the rows it exists to cover.
2. ~~The record's day count is a count of things that **happened**, and one drink is
   one thing.~~ **Amended 2026-09-04 — see below.** The count is still a count of
   things that happened; what changed is that the thing is the EVENT, so the count
   is derived from the events rather than read off a day total.
3. The substance row describes the act in the person's own terms.

## A consumable is an event (owner ruling, 2026-09-04)

**Substances are consumables, like food and intake, and behave the same way.** A
drink, a cigarette or a joint is an EVENT with an instant, exactly as a food serving
or a dose is; the day total is a **rollup**, not the editable thing.

This **amends** the 2026-08-29 consequence that a day's drinks are one editable **day
count**. They are not. One record row per event:

- **One row per drink**, read through `getFoodLedgerPage` — the food gather's own
  reader, asked for the one group the food gather excludes, so there is no second
  query shape and no second idea of what a serving row is. A day with drinks at 21:00
  and 23:00 shows **two rows and two ticks**.
- **Corrected where a serving is corrected.** The row carries the FOOD edit payload
  addressed to its own event, so `HistoryRows` mounts `FoodServingForm` and the ⋯
  delete runs `removeFoodServing` — re-time, re-file, delete. `correctionGroups`
  already keeps a row that is IN a substance group able to name its own group, so
  that plumbing was built for this and needed nothing.
- **It stays a `substance` row.** Reasons 1 and 3 above are NOT amended, so the drink
  keeps the substance kind, its chip, its glyph and its life-stage gate. `edit.kind`
  is the correction _door_; `kind` is what the thing _is_. The ruling asks for exactly
  that split, and it is why a drink files under Substances while correcting like food.
- **The day total does not disappear** — `food_daily_totals` is still the cap's
  substrate and still what the substance card counts. It is simply no longer what the
  record renders.

**The row's clock and the rail's minute are different questions**, and this file's
practice loop had already ruled on it. The ROW reads `bestKnownInstant`, so an untimed
drink says "logged 23:50" exactly as the serving row beside it does — the `logged`
prefix is the grammar admitting the clock is a filing time. The CHART reads the EVENT
instant only: a drink backfilled at 23:50 for last Tuesday would otherwise draw on
Tuesday's rail at a minute that describes the typing and nothing else, which is the
whole argument `EXCLUDED_TICK_CATEGORIES` makes about an insight's `created_at`. A
drink with no event instant draws nothing.

**Nicotine, cannabis and custom substances are event rows too, since #3295 phase 2
(#5026 items 2 and 3).** They were day rows — date-only, sinking below the day's timed
rows, corrected through the day-count form — because `substance_daily_totals` is UNIQUE
per (profile, date, substance) and declares no event column. `substance_log_events` is
that column, so the branch that emitted a `sortTime: null` day row is gone and this
loop is the drinks loop with its own ledger and its own correction door. The trap it
closes is worth keeping in mind: `bestKnownInstant` on the COUNTER answers with
`recorded_at`, the filing stamp, which would hand a day a minute it never claimed.

**Every substance can state its minute (#3295 phase 1; every key since phase 2).** The
substance add door offers the shared `WhenControl` (`grain="minute"`), gated by
`judgeStatedAt` at the action — not future, and on the entry's own day — and the
statement rides every unit of the entry as `occurred_at` with `time_source = 'stated'`.
Nothing invents one: a use nobody timed keeps a NULL instant, so its row says "logged"
and it draws no tick.

**And every substance corrects on its own row.** `edit.kind: "substance"` addresses an
EVENT and moves the two things a use has — its day and its stated minute. Neither the
day's amount nor the day's note is on that door: one event is one unit, and a note
describes the sitting rather than any use in it (#5077 owns where a day note lives now).
A drink's row carries the FOOD payload instead and corrects through the serving's form,
which is the same shape through a door that already existed.

**Everything logged before phase 2 became rows rather than disappearing.** The record
reads events, so a counter row with none behind it would count on the substance card
and against the weekly cap while showing nothing here. Migration
`20260905-substance-event-rows` derives the missing events on both ledgers — the whole
uses each substance day is SHORT, and the alcohol day's shortfall (item 3, the state
#5085 measures from the other side) — with `occurred_at` NULL, because a day total
declares no instant and inventing one would be worse than the gap. A shortfall, not a
count: a day that already carries real taps is topped up rather than doubled, and the
subtraction is floored so a fraction can never round a use up into the record. So a legacy day shows one row
per use, each reading "logged HH:MM" off the day's own filing stamp, and draws nothing.

**The drink does not disappear, and the totals do not move.** The food door writes
the `food_daily_totals` counter as well as the event, and both the cap and the
substance card read that counter — so a serving logged from Nutrition still reaches
the record, once, under Substances. What changes for a reader is where they find it.
Food _totals_ and the nutrition arithmetic are untouched: this is the record's row set.

## The read

`lib/history.ts` composes the readers each ledger already used
(`getIntakeDoseLedgerPage`, `getFoodLedgerPage`, `getPracticeLedgerPage`,
`getSubstanceLedgerPage`, plus the `body_metrics` rows the metric detail
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

**On a wide screen that stack becomes two columns** (#4974). The day bar runs across
the top; beneath it the rows keep the reading measure in the left column and a
**sticky rail** on the right holds, top to bottom, the chart card and the add layer
— `grid-template-columns: 48rem minmax(0, 760px)`, the page capped
at their sum plus the gap (`PageContainer width="rail"`, 97rem). The reading column is
the right width for one-line rows and the wrong one for the day's map: it left half
the viewport empty and capped the chart inside it, and reading the rows took the map
off screen. With the rail sticky, a tick tap scrolls the rows beside a chart that
stays put.

**Below the threshold nothing changes** — no grid, the same source order, the same
widths. The rail comes FIRST in the document and is placed into column 2 explicitly, because
source order is what the stacked layout reads and there the chart and the add layer
belong above the rows they map and create. The left track is a fixed `48rem` rather
than `minmax(0, 48rem)`: two flexible tracks share free space evenly, which at the
threshold would hand the rows 568px and call it a reading column. Measured rail
widths, content minus the column and the gap: **208px at 1280, 337 at 1409, 368 at
1440, 528 at 1600, 760 at 1832** (the ceiling, where the page cap takes over).

**The threshold is 1440px, ruled off a measurement — #4974 rules `xl`, and `xl`
cannot pay for it.** The rail is `viewport - 1072` and the chart's card spends a
further 42px of padding, so the DRAWING gets `viewport - 1114`. Each chart geometry
computes its label size from the narrowest container it declares, so the type clears
#1518's 9px floor there and nowhere narrower (`lib/intraday-layout.ts`). Since #4973
the chart picks its geometry from THAT box rather than from the viewport, so the
binding floor is the compact one: `11 × container ÷ 360`, which needs 294.55px.

The table below is what the RAIL ARRANGEMENT would hand the chart at each viewport —
that is the question the threshold answers, so it has to be asked at widths where the
rail does not open. Rows at and above the threshold are measured in the browser; the
rows beneath it are the derivation, and they are why the rail does not open there. At
those widths the shipped page has no rail at all and the chart takes the whole reading
column instead (726px, 12.60px measured), so do not read them as a description of what
1409 renders today.

| viewport                 | drawing container | variant | smallest label                        |
| ------------------------ | ----------------- | ------- | ------------------------------------- |
| 1280 (`xl`), derived     | 166px             | compact | 5.07px                                |
| 1400, derived            | 286px             | compact | 8.74px                                |
| 1409, derived            | 295px             | compact | 9.01px — the first width that pays    |
| **1440** (the threshold) | 326px             | compact | **9.96px**                            |
| 1600                     | 486px             | compact | 12.83px                               |
| **1634**                 | 520px             | wide    | **9.03px** — the tightest width above |
| 1832                     | 718px             | wide    | 12.47px                               |

1409 pays the floor by 0.014px, and every term is an integer this page or the shell
owns — one pixel on the gap, the page gutters or the card's padding would put it
under. So the threshold is **1440**, which is #4974's own acceptance criterion and
carries 0.96px; laptops between 1409 and 1439 keep the stack, which the owner accepted
as the cost of that margin (ruling 2026-09-04).

**The floor is not monotonic above the threshold**, so 1440 is not the width to
re-check after a change to any term. Compact type grows with the container to 12.83px
at 1600; then the box reaches `INTRADAY_VARIANTS.wide.minContainerPx` and the wide
geometry takes over at 1634 with a 9.03px label. `e2e/history-day-view.spec.ts` drives
the pair either side of the boundary — 1439 stacked, 1440 railed — and measures the
labels at 1440 rather than trusting the arithmetic.

**The rail's chart is the COMPACT geometry**, which is where #4974's premise — "the
rail simply gives it 760px" — is wrong: at 1440 it gives 326. Wide needs 520px of
container and so a 1634px viewport; below that the container query in
`components/IntradayChart.tsx` picks compact, and the type is _larger_ for it. That
compact drawing between 1440 and 1633 IS the ruled design (2026-09-04); the rail does
not have to hold the wide one. `xl` is payable by neither geometry — a 166px drawing
is under the compact variant's own 300px floor too.

**The calendar is a door at every width** (#5359, returning to #4102's answer). It
is a door because the grid could not spend the ~140px chrome budget above the first
record, and the trigger in the pinned cluster stands at 390px and at 2000px alike.

#4974 mounted the grid OPEN in the rail instead, on the reasoning that beside the rows
it spends none of that budget — and it shipped without a width. `MonthCalendar`
renders no root element by design; it fills whatever it is given, and every other host
gives it the 264-288px it is drawn for (the door's own `w-72` panel, `DateField`,
`WhenControl`). The rail card was a block child of a track that reaches 760px, so the
grid drew at 736: 28px day discs 105px apart, a weekday header spread across the width
of the chart. The owner read it at ~2000px on 2026-09-05 and ruled the open mount out;
this supersedes #4974's item 2, which is recorded here rather than by editing #4974.
Capping the rail card at the door's width was considered and rejected — a 288px card
alone in a 760px rail — as was filling the width with more months. `MonthCalendar` is
one cursor by design (#3744).

With one host again, the `EventMonthGrid` export that existed to keep the popover and
the rail from drifting into two answers is folded back into `EventCalendar`.
`MonthCalendar`'s `href` is a function, which a Server Component cannot hand across
the RSC boundary, so that binding still lives client-side.

**The rail cannot outgrow the viewport.** A sticky element taller than the screen pins
its top and strands its own bottom, unreachable at any page scroll, so it is capped at
`100dvh` minus its two `1.5rem` insets and scrolls past that. The scroll chains at the
ends rather than being contained, so reaching the bottom keeps scrolling the page.

**But the chart's box is outside that scroll container** (owner ruling, 2026-09-04),
which is why the cap and the overflow sit on two elements: the rail caps its height
and lays its children out in a column, and only the layers BELOW the chart scroll
(`history-day-rail-scroll`). A wheel goes to its nearest scrollable ancestor, so with
the chart inside the scrolling box a reader aiming at the largest, most pointed-at
thing in the rail scrolled the rail instead of the page — and the chart's own
full-day wheel hand-off (#4852) was handed to the rail rather than to the page it was
written for. Over the chart the wheel is the page's. The **jump-rail scrubber does not exist on the day view at all** —
`windowed` is null when `?day=` is set, so there are no ticks and `railGutter` is
empty there; the rail spends no lane of its own.

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

**The add row opens on the window the chart is already showing** (#4950, as amended).
There is no mode to arm and no second selection: the chart's two existing interactions
ARE the window. Zoomed, the view is the window and the row reads `Add at 19:10–20:40`;
at full day a crosshair is a start alone and it reads `Add at 19:10`; with neither it
reads `Add`. Zoom itself stays ephemeral — the URL learns the window only when a kind
chip is tapped, and the chips carry it as `?from=HH:MM&to=HH:MM` (`to` optional) on top
of the params `chipHref` already decided. `lib/intraday-window.ts` parses the pair back:
it snaps to `INTRADAY_BUCKET_MINUTES`, requires `to` to follow `from` by at least
`MIN_ZOOM_MINUTES`, and REFUSES rather than repairs — a malformed or inverted pair is
dropped. With a window in the URL the chart draws it from the server render, so it stays
under the open form and survives a reload.

Each kind's form then opens on it, through the time control it already had. The
practice form takes both clocks; a dose, a serving, a body sitting and a movement take
the start (one stated instant, built once by the door, so they cannot disagree about
what `19:10` on this day means — and a serving's meal follows that hour as it does
anywhere else). A check-in and a symptom have a day and no event instant, so there is
nothing for a window to open and they ignore it; a substance use takes the start too,
since #3295 phase 2 gave it an instant to state. The
practice picker also opens on the practice whose weekly rhythm predicts the window's
weekday and hour, tie-broken by the usual duration nearest its length — habit matching
and never physiology, and a practice with no rhythm can never fit. Every one of these is
a DEFAULT the person changes or confirms; a stated window is a stated time, not a claim
about what happened.

**And a `Workouts` door joins that row on the day view** — the training hub keeps its
own log (below), so this opens the shared activity editor with the day and the window
rather than adding a tenth kind. It carries no activity type: heart rate cannot tell a
run from a sauna. A profile that does not train sees no door.

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
`?media`, `?day`, `?from`/`?to`, `?view=everyone`, `?open` (repeatable), `?show`.
There is **no** `range`/`page` — those concepts died with the range row and the pager,
and `?from`/`?to` are not their return: they are a WINDOW WITHIN ONE DAY (#4950, below),
profile-local `HH:MM` clocks on the `?day=` in view, meaningless without it and dropped
on the feed.

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
record. The training hub keeps its own log — the day view has a DOOR onto its editor
(#4950 item 5), which is not the same thing as the record carrying workouts.
