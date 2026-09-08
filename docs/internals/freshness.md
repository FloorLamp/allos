# Freshness and dormancy

[lib/freshness.ts](../../lib/freshness.ts) owns the age comparison and counting
vocabulary. Domain adapters choose the interval and exemptions; surfaces choose
wording. Reuse those owners instead of calculating staleness in a component.

## Shared decision

`freshnessState(ageDays, intervalDays, { exempt })` returns:

| State            | Meaning                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `current`        | The age is at or below the applicable interval.                                                            |
| `due`            | The age is strictly greater than the interval. The reading remains real data.                              |
| `not-applicable` | The reading is exempt, the age is missing/nonfinite, or the interval is missing, nonfinite or nonpositive. |

A reading exactly one interval old is current. Do not fold `not-applicable` into
`due`: an immutable attribute has no retest clock, and an unmeasured test is not
an overdue reading.

`freshnessAgeDays(date, today)` returns the signed difference in whole days, or
`null` for absent/unparseable dates. Date-based callers supply the profile-local
day. An adapter may preserve different parsing behavior: the biomarker retest
adapter uses its existing `daysBetween`, which treats an unparseable nonempty
date as zero days. Do not describe every adapter as rejecting malformed dates.

`tallyFreshness` returns `{ current, due, notApplicable }`.
`hasNoCurrentReading(tally)` means exactly `current === 0`; it does not establish
that any reading is overdue.

## Different uses of the comparison

| Policy             | Question                                                 | Consequence                                                                               |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Retest clock       | Is a measured result past its retest interval?           | Domain logic may produce a retest finding or reminder.                                    |
| Presentation floor | May the latest reading be framed as current?             | Show its age or as-of date; the floor itself does not hide the value or create reminders. |
| Dormancy           | Has a previously recorded domain stopped receiving data? | Replace an empty, window-bounded presentation with a dated statement and an action.       |

A vital can be exempt from the lab retest clock while still needing an as-of
statement. Presentation floors are surface policy, not profile settings or a
reason to emit an Upcoming item, nudge or notification.

## Existing adapters

| Owner                                                               | Interval and scope                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Biomarker retest status](../../lib/reference-range/qualitative.ts) | Curated positive `retest_days`, otherwise the [retest default](../../lib/reference-range/retest.ts). Exempts genomics and non-lab categories (`reference`, `vitals`, `instrument`, `derived`), plus recognized durable immune positives, immutable attributes and QC results. Missing dates are `not-applicable`. |
| [Fitness freshness](../../lib/fitness-freshness.ts)                 | Declared per battery test: profile retest cadence for performed protocols; fixed clocks for body fat (60 days) and resting HR (30 days). An undeclared key falls back to profile cadence; the existing completeness check detects missing declarations.                                                           |
| [Recent labs](../../lib/recent-labs.ts)                             | A 365-day presentation floor. An undatable reading is not fresh.                                                                                                                                                                                                                                                  |
| [Latest vitals](../../lib/vitals-latest.ts)                         | Presentation floors of 14 days for resting HR and 180 for blood pressure, resolved separately for each quantity.                                                                                                                                                                                                  |
| [Trend metrics](../../lib/trend-metric-freshness.ts)                | `TREND_METRIC_PRESENTATION_FLOORS` is total over `TrendMetricSlug`. Systolic, diastolic and resting-HR entries reuse the vital policies by reference.                                                                                                                                                             |
| [BMI paired height](../../lib/growth-series.ts)                     | `PAIRED_HEIGHT_INTERVAL_DAYS`: 92 days for infants; 183 for early childhood, children and adolescents; no clock for adults, older adults or an unknown birthdate.                                                                                                                                                 |

BMI uses freshness to validate an input. Each weigh-in pairs with the height in
effect on or before that date, with life stage resolved at the weigh-in. A `due`
height drops the BMI point; `not-applicable` permits the pairing. This is separate
from a presentation floor, which changes the framing of an existing value.

## Presentation and aggregates

Keep provenance with old readings. Latest-vital models retain a reading past its
presentation floor and suppress its trend direction unless freshness is
`current`; dormancy is a separate later decision. Trends chart cards use an
as-of date when the headline reading is old.

Fitness current-coverage copy uses `coverage.fresh`; `measuredCount` includes
historical readings. The [Longevity optimal-biomarker pillar](../../lib/longevity-pillars.ts)
consumes the biomarker adapter. Its tone becomes neutral when no reading is
current **and at least one is due**. Unknown freshness alone does not trigger
that stale-data treatment. Keep these distinctions when changing aggregate copy.

## Dormancy

[lib/domain-dormancy.ts](../../lib/domain-dormancy.ts) owns the declarations and
maps the shared verdict to `absent`, `current` or `dormant`. A missing or
unparseable last-record date maps to `absent`. A valid date becomes `dormant`
strictly after the domain's interval; equality remains `current`.

| Domain         | Dormant after | Declared render window |
| -------------- | ------------- | ---------------------- |
| Sleep          | 90 days       | 1 day                  |
| Weight         | 90 days       | 90 days                |
| Blood pressure | 365 days      | 365 days               |
| Resting HR     | 90 days       | 90 days                |

Blood pressure and resting HR are independent domains. Silence in one must not
collapse the other. Their presentation floors apply before dormancy: resting HR
can be old after 14 days but does not become dormant until after 90.

`collapseAfterDays` must be at least `renderWindowDays`, so collapse cannot hide
values that the section would still render. `dormancyWindowConflicts()` checks
those declarations; it does not prove that every caller honors its stated
window. Recent labs are excluded because their latest values remain visible at
any age. Hiding those values would need a separate design that keeps them
reachable.

The [dashboard](<../../app/(app)/page.tsx>) emits a dormant Standing candidate in
place of the domain's current presentation. Sleep and weight use
`dormantRecordLine` with an age in days. Both vital rows prefer
`dormantRecordSince` with the source month/year, falling back to a day count.
These statements describe the record and elapsed time, without claiming why
logging stopped or what happened to the person's health.

Keep history and the relevant logging action reachable from the dormant
presentation. Obligations such as doses, refills and care follow-ups bypass
dormancy and retain their normal placement.

## Extending a domain

- Find its existing adapter and declare the interval there. Reuse existing
  policy types and tables; do not introduce a new registry or scanner merely
  to add a caller.
- Resolve profile-local dates and domain exemptions before calling the shared
  decision. Keep retest policy, presentation framing and dormancy separate.
- Reuse the tally for aggregates, preserving unknown and exempt readings as
  distinct from overdue ones.
- Verify the boundary, exemptions and visible consequence with existing
  coverage first. Follow the [change and test policy](../change-policy.md)
  before adding tests.
