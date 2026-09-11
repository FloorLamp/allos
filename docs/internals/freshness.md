# Freshness and dormancy

[lib/freshness.ts](../../lib/freshness.ts) owns the age comparison and counting
vocabulary; adapters choose the interval and exemptions, surfaces the wording.
Never compute staleness in a component.

## Shared decision

`freshnessState(ageDays, intervalDays, { exempt })` returns:

| State            | Meaning                                                    |
| ---------------- | ---------------------------------------------------------- |
| `current`        | Age at or below the interval.                              |
| `due`            | Age strictly greater than the interval; still real data.   |
| `not-applicable` | Exempt, or age/interval missing, nonfinite or nonpositive. |

A reading exactly one interval old is current. Never fold `not-applicable` into
`due`: an immutable attribute has no clock and an unmeasured test is not overdue.
`DormancyState` owns "absent".

`freshnessAgeDays(date, today)` returns whole days, or `null` for an absent or
unparseable date; callers supply the profile-local day. Adapters may parse
differently — the biomarker retest adapter's `daysBetween` reads an unparseable
nonempty date as zero — so do not claim they all reject malformed dates.
`hasNoCurrentReading(tallyFreshness(...))` means `current === 0`, nothing more.

## Different uses of the comparison

| Policy             | Question                                      | Consequence                                                                      |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Retest clock       | Is a result past its retest interval?         | Domain logic may raise a retest finding or reminder.                             |
| Presentation floor | May the latest reading be framed as current?  | Show its age or as-of date; nothing is hidden and no reminder is made.           |
| Dormancy           | Has a recorded domain stopped receiving data? | Replace an empty, window-bounded presentation with a dated statement and action. |
| Attention recency  | Does recency itself claim placement?          | A reading inside the window claims an attention tier, notable or not.            |

Presentation floors are surface policy, never profile settings or grounds for an
Upcoming item or notification.

Attention recency is the fourth question (owner ruling #4232); declare the next
such rule here, not beside its caller. Its first tenant is
`CLINICAL_RESULT_FRESH_DAYS` in [recent labs](../../lib/recent-labs.ts): a result
collected within 30 days is relevant whatever its flags, keyed on the collection
date so a backfilled import claims nothing, released on acknowledgment or lapse.

## One quantity, one interval

Two surfaces asking the same question of the same quantity share the interval by
reference, never as a second number: `TREND_METRIC_PRESENTATION_FLOORS` takes the
vital floors, fitness freshness takes the trend-metric floors for body fat and
resting HR, the dormant-PRN sweep takes `DORMANCY_DEFAULT_DAYS`. A tenant shares
the interval only — the sweep keeps its own "move to past" offer and is not a
`DormancyDomain`, since a section carrying an obligation never collapses. Gathers
follow the same rule: `SUN_EXPOSURE_WINDOW_DAYS` is the one window its sentence
and its queries read.

Intervals that merely agree are not one interval. The recent-labs presentation
floor and the retest default answer different questions, so they keep separate
values and cross-reference comments calling that agreement coincidental.

## Existing adapters

| Owner                                                               | Interval and scope                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Biomarker retest status](../../lib/reference-range/qualitative.ts) | Curated positive `retest_days`, else the [retest default](../../lib/reference-range/retest.ts). Exempts genomics, non-lab categories (`reference`, `vitals`, `instrument`, `derived`), durable immune positives, immutable attributes and QC results. Missing dates are `not-applicable`. |
| [Fitness freshness](../../lib/fitness-freshness.ts)                 | Per battery test: profile retest cadence for performed protocols; body fat and resting HR take the trend-metric floor by reference. An undeclared key falls back to profile cadence. `missingFreshnessPolicies` finds missing declarations, `fitnessFloorsNotShared` restated numbers.    |
| [Recent labs](../../lib/recent-labs.ts)                             | A 365-day presentation floor plus the attention-recency window above. An undatable reading is not fresh.                                                                                                                                                                                  |
| [Latest vitals](../../lib/vitals-latest.ts)                         | Presentation floors of 14 days for resting HR, 180 for blood pressure, resolved per quantity.                                                                                                                                                                                             |
| [Trend metrics](../../lib/trend-metric-freshness.ts)                | `TREND_METRIC_PRESENTATION_FLOORS`, total over `TrendMetricSlug`. Systolic, diastolic and resting HR reuse the vital policies by reference.                                                                                                                                               |
| [BMI paired height](../../lib/growth-series.ts)                     | `PAIRED_HEIGHT_INTERVAL_DAYS`: 92 days for infants; 183 for early childhood, children and adolescents; no clock for adults, older adults or an unknown birthdate.                                                                                                                         |

BMI validates an input rather than framing one: each weigh-in pairs with the
height in effect on or before it; a `due` height drops the point,
`not-applicable` permits the pairing.

## Presentation and aggregates

Keep provenance with old readings. Latest-vital models retain a reading past its
floor and withhold its trend direction unless freshness is `current`; Trends
cards stamp an as-of date. Dormancy is a separate, later decision.

Fitness current-coverage copy uses `coverage.fresh`; `measuredCount` includes
historical readings. The [Longevity optimal-biomarker pillar](../../lib/longevity-pillars.ts)
turns neutral when no reading is current **and at least one is due** — unknown
freshness alone does not. Keep both distinctions when changing aggregate copy.

## Dormancy

[lib/domain-dormancy.ts](../../lib/domain-dormancy.ts) owns the declarations and
maps the shared verdict to `absent`, `current` or `dormant`. A missing or
unparseable last-record date is `absent`; a valid one goes `dormant` strictly
after the interval.

| Domain         | Dormant after | Declared render window |
| -------------- | ------------- | ---------------------- |
| Sleep          | 90 days       | 1 day                  |
| Weight         | 90 days       | 90 days                |
| Blood pressure | 365 days      | 365 days               |
| Resting HR     | 90 days       | 90 days                |

Blood pressure and resting HR are independent domains; silence in one must not
collapse the other. Their floors apply first: resting HR reads old after 14 days
and dormant only after 90.

`collapseAfterDays` must be at least `renderWindowDays`, so a collapse hides no
value the section would still render; `dormancyWindowConflicts()` checks the
declarations, not that callers honor them. Recent labs are excluded: their latest
values stay visible at any age.

The [dashboard](<../../app/(app)/page.tsx>) emits a dormant Standing candidate in
place of the domain's presentation: sleep and weight use `dormantRecordLine`,
both vital rows prefer `dormantRecordSince` with the source month/year. These
describe the record and elapsed time, never why logging stopped; keep history and
the logging action reachable from them. Obligations — doses, refills, care
follow-ups — bypass dormancy entirely.

## Extending a domain

- Declare the interval in the existing adapter, reusing its policy types; if the
  quantity already has one, take it by reference. Do not add a registry just to
  add a caller.
- Resolve profile-local dates and exemptions first; keep the four questions apart.
- Reuse the tally, keeping unknown and exempt readings distinct from overdue ones.
- Verify the boundary and visible consequence with existing coverage before
  adding tests ([change and test policy](../change-policy.md)).
