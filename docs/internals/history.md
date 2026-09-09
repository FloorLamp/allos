# The record: `/history`

`/history` is the record of what a profile logged. It owns the event feed and
`?day=` view; the retired ledger and `/timeline` routes have no redirects.
Retarget links at their source. The training hub retains its own workout log,
and per-item panels retain bounded recent history with a link to the record.

## Model and ownership

One row is one recorded event: when, kind, what, detail, provenance, and
mutability. Streams, forecasts, and derived absences such as missed doses are
not recorded events. A daily substance total is a rollup, not a use; see
[substances](substances.md) for event storage, correction, notes, and legacy
rows. Alcohol appears under Substances and is excluded from Food so a drink is
counted once.

| Owner                                  | Responsibility                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `lib/history-format.ts`                | `HistoryRow`, kinds/families, clock and detail grammar, filter parsing, rollups |
| `lib/history.ts`                       | Profile-scoped composition of existing domain readers and formatters            |
| `lib/timeline-multi.ts`                | `mergeMemberTimelines`: shared ordering and day grouping                        |
| `lib/hrefs.ts`                         | `historyHref`: URL construction                                                 |
| `app/(app)/history/page.tsx`           | Request authorization, view selection, gathers, and layout                      |
| `HistoryRows.tsx` and `LoggedEventRow` | Row presentation, disclosures, and existing correction forms/actions            |

`historyClock` distinguishes a stated time (`10:07am`) from a filing fallback
(`logged 10:07am`). `detailSegment` joins quantity, context, and source with `·`,
dropping empty segments. Domain composers use their existing unit/time formatters.
Do not truncate strings in the formatter; the row owns visual ellipsis.

Day headers count their rows and stay sticky. Rows sort newest instant first,
with date-only records after timed ones and stable ID tie-breaks. Reuse the
shared grouping engine; do not introduce another interpretation of a local day.
[Day-history matrices](day-history.md) answer group-by-bucket consistency
questions and are a separate analysis substrate.

## Reads and authorization

Every domain read takes the subject's `profileId` and scopes SQL by it.
`lib/history.ts` imports no authentication; the page resolves access before
calling it. `?view=everyone` gathers once for each readable member, preserving
subject-specific visibility rules. A known minor's substance rows are excluded;
logged training data remains visible regardless of whether training products
are offered to that profile.

Correction menus require a row edit payload and write access to that row's
profile. The page passes `writableProfileIds`; each form posts the row's
`profile_id`, and the existing action rechecks it through `gateItemProfile`.
Read access alone cannot authorize a forged write. Correction date ceilings use
each row subject's today, rather than the acting profile's day.

Feed reads end at the subject's today. A requested future `?day` clamps to the
active profile's today, and day navigation has no next arrow or swipe on today.
Future planning belongs to `/upcoming`.

Logs use their own bounded readers. Feed-derived kinds share one bounded
`getTimelineEvents` read and filter it afterward, preserving the presence data
used to offer chips. Consequently a filtered feed kind can have a shallower
history than its own category-specific query; selecting a chip does not enlarge
that read window. Keep this limitation explicit when changing pagination.

## Rows and expansion

Use one-line `LoggedEventRow` list items at every viewport. The trailing action
is either a correction menu or a destination chevron, never both. Reuse each
domain's existing write path.

A row with `detailItems` or `linkedRefs` turns its detail segment into a
disclosure. Its chevron sits outside the truncating span. Expanded content is a
sibling `<li>` so the measured row stays one line. Disclosure state is local
because the content already arrived. Folds and rollup expansion use the URL
because they change the server-rendered row set.

In Everything, high-frequency logs collapse by day and member, keeping rare
events visible. Family-filtered and single-day views show plain rows. A lineage
heading may say “From this visit” only when the gather establishes that visit;
a multi-visit portal export must not imply a single encounter.

## Navigation and URLs

Use `historyHref`, not local query-string assembly:

| Parameter        | Meaning                                                   |
| ---------------- | --------------------------------------------------------- |
| `family`, `kind` | Family or kind; a kind determines its family              |
| `class`, `item`  | Dose class and kind-specific item refinement              |
| `media`          | Rows carrying media, when available                       |
| `day`            | Single-day view                                           |
| `from`, `to`     | Profile-local clock window within `day`; `to` is optional |
| `view=everyone`  | Readable household members                                |
| `open`           | Repeated year/month fold keys                             |
| `expand`         | Repeated day/member rollup keys                           |
| `show`           | Cumulative read bound, clamped by `HISTORY_MAX_SHOW`      |

There are no range chips or numbered pages. At the read ceiling, hide load-more
and state how much is shown. Do not suggest narrowing a kind as a way to fetch
older rows when the bounded query would be unchanged. The feed's
`JumpRailScrubber` owns a gutter via `SCRUBBER_GUTTER_CLASS`; it must not cover
row actions and is absent from the day view.

Invalid kind/family values are ignored; with neither valid, the view is All.
A malformed day falls back to the feed. Invalid closed-vocabulary item filters
drop the item refinement, preserving the kind. Open per-profile vocabularies,
such as dose items and practice names,
are resolved by their readers and can return no rows. An unavailable media
filter falls back to the gathered record. Preserve these distinctions rather
than treating every invalid filter as a 404 or promising an identical fallback.

## Day view

The narrow layout is day bar → chart → add layer → rows. The bar names the day
and record count, including zero. The feed subtitle and per-group day headings
are omitted. The calendar remains a door at every width. The header's History
link returns to the feed, preserving filters, household view, and the read bound.

At 1440px, use the shared rail page width with a fixed `48rem` reading column
and a `minmax(0,760px)` right rail. Keep the rail first in source order for the
stacked layout, positioning it in column two at the breakpoint. The rail is
sticky and capped at `100dvh - 3rem`. The chart sits outside the rail's scroller;
only the layers below it scroll, with scroll chaining at the ends. A full-day
wheel gesture over the chart therefore reaches the page.

The chart chooses compact/wide geometry from its container, not the viewport.
Keep the 9px label floor at the rail threshold and geometry transition; label
size is not monotonic across that transition. See [chart guidance](charts.md)
and `lib/intraday-layout.ts` before changing these dimensions.

Single-subject day views always render the chart card, even with empty data.
It uses the resolved `HistoryGather.dayEvents`, never a second event query, so
ticks share row identities through `timelineEntryAnchorId`. Daylight, weather,
UV, and cycle context belong inside the card; everyone-view days omit this
single-subject context and chart. Daylight is a background band and reserves no
lane. Today's outstanding sleep can add the shared waiting-state copy and an
expected band from typical bed/wake times; past days and received sleep do not
show that wait.

## Adding from a day

Chart zoom supplies a window; at full day, a crosshair supplies only a start.
The add row reflects that selection. Zoom stays local until a kind is chosen,
when its window travels in `from`/`to`. `parseIntradayWindow` snaps to the shared
bucket size and requires a valid minimum span; malformed or inverted windows
are dropped, not repaired. A URL window survives reload and remains under the
open form.

The practice form receives both clocks and may select a practice by its recorded
weekly rhythm and usual duration. Dose, food, body, stool, and substance entries
receive the start through their existing time controls; day-only check-ins and
symptoms ignore it. These are editable defaults, not evidence that an event
happened. The Workouts door opens the shared activity editor for a training
profile with the day/window and no inferred activity type.

At 390px, keep roughly 140px or less of chrome above the first feed record.
An added header control must identify what it replaces. The day chart is content;
the add layer belongs beside the rows it creates.

## Verification

Use existing history gather/format/rollup tests for data and grammar,
`history-cross-profile-correction.actions.test.ts` for denied/read-only/writable
subjects, and `e2e/history-day-view.spec.ts` for day layout. Check relevant
geometry transitions when changing the rail; a source class assertion cannot
prove readable labels. Follow the [change and test policy](../change-policy.md)
and [E2E hygiene](e2e-hygiene.md).
