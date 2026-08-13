# Internals: the shared freshness vocabulary

"Is this dated reading still current?" is ONE question. Several domains ask it
over different clocks, and before #2023/#2025 each answered it locally — the
fitness check compared `ageDays > cadenceDays` inline, the biomarker retest
classifier compared `daysBetween(...) > retestIntervalDays(...)`, and the two had
independently chosen the same boundary and different words for the result.

`lib/freshness.ts` owns the decision and the counting vocabulary. Each domain
keeps what is genuinely its own: **which interval applies** and **which readings
are exempt from having a clock at all**.

## The vocabulary

```ts
type FreshnessState = "current" | "due" | "not-applicable";
```

- `current` — measured within its interval.
- `due` — measured, past its interval. Still real data; no longer something a
  surface may present as today's value.
- `not-applicable` — no clock applies: no date, no interval, or the domain
  exempted the reading (a value that cannot change has no retest clock).

`not-applicable` is never folded into `due`. An immutable blood type is not
overdue and an unmeasured fitness test is not stale; collapsing the two is how a
surface grows a phantom backlog.

Boundary: **stale strictly after the interval** (`age > interval`). A reading
taken exactly one interval ago is current and comes due tomorrow. This is the
biomarker retest clock's long-standing boundary, which the vocabulary was
extracted from.

`FreshnessTally` (`{ current, due, notApplicable }`) is the counting shape every
consuming aggregate reports in, so "3 of 12 based on older results" and "2 tests
want a re-check" are the same arithmetic.

## Tenants

| Tenant                                                                      | Interval                                                                            | Exemptions                                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Biomarkers — `biomarkerRetestStatus` (`lib/reference-range/qualitative.ts`) | the analyte's curated `retest_days`, else the flat default                          | genomics, non-lab categories, durable immune positives (#516), immutable attributes (#548), QC metrics (#687) |
| Fitness check — `lib/fitness-freshness.ts` via `buildFitnessCheckModel`     | the test's DECLARED policy: the profile's retest cadence, or a per-test fixed clock | an unmeasured test (no reading to date)                                                                       |
| Longevity's optimal-biomarker pillar                                        | —                                                                                   | consumes the biomarker adapter above; mints nothing                                                           |
| Recent labs (`lib/recent-labs.ts`)                                          | the flat `RECENT_LAB_STALE_DAYS` presentation floor (#1216)                         | none — an undatable reading is `not-applicable`, never fresh                                                  |
| Latest vitals (`lib/vitals-latest.ts`)                                      | the per-quantity presentation floor: resting HR 14 days, blood pressure 180 (#2303) | none — an undatable reading is `not-applicable`, never due                                                    |
| Trends chart cards (`lib/trend-metric-freshness.ts`)                        | the per-metric presentation floor, total over `TrendMetricSlug` (#2615)             | none — an undatable reading is `not-applicable`, never due                                                    |

A tenant **adapts** onto the shared decision. It does not fork it, and it does
not re-derive "is this stale" in a component.

`BiomarkerRetestStatus` is an alias of `FreshnessState`, so biomarker readings
and fitness tests can be tallied with the same counter.

## Retest clocks and presentation floors are different questions

The last two tenants ask something the first three do not. "Should this be
re-tested?" and "may this surface present this reading as your CURRENT value?"
are separate questions over the same substrate, and for a vital they resolve
differently: `biomarkerRetestStatus` returns `not-applicable` for
`category === "vitals"` on stated grounds — physiologic vitals are monitored, not
redrawn on a yearly cadence, and nobody schedules a temperature retest — and that
is right. A glance dashboard still may not render a four-year-old blood pressure
as a headline number with a trend arrow.

So a **presentation floor** is glance-framing policy for one surface. It decides
FRAMING, never visibility; it never creates a nudge, an Upcoming row, or a
notification; and it is not per-profile or configurable, exactly as #1216's round
365 is not. It resolves through `freshnessState` like every other tenant, so the
repo holds one staleness decision rather than one per card.

`TREND_METRIC_PRESENTATION_FLOORS` (#2615) is the third, and it is where the
per-quantity argument earns a registry: a fortnight-old body temperature is
history and a fortnight-old adult height is simply your height, so one global
number would have to be wrong for one of them. It is a `Record` over
`TrendMetricSlug`, so a new metric is a **compile error** rather than a silent
default — the `missingFreshnessPolicies` discipline expressed as a type. The three
quantities that already had a floor (`systolic`, `diastolic`, `resting-hr`) take
`VITAL_PRESENTATION_FLOORS` **by reference**, never a copied number, so two
registries cannot come to disagree about how old a blood pressure may be.

## What is deliberately NOT here

**Phrasing.** "Retest due", "wants a re-check" and "based on older results" are
each their own surface's copy over the same three states. A shared verdict does
not mean shared wording — the Longevity pillar's neutral "all based on older
results" and the Fitness header's "2 want a re-check" say different things to
different people about the same underlying state.

## The honesty rule both consumers hang on it

`hasNoCurrentReading(tally)` — an aggregate with nothing current may not be
presented as current.

- The optimal-biomarker pillar renders **neutral** with "based on older results"
  instead of a green share (`lib/longevity-pillars.ts`, `optimalTone`).
- The Fitness check's completion copy counts `coverage.fresh`, not
  `coverage.measured`, and names the stale remainder separately.
- The two glance cards keep the reading at full prominence and change what the
  line under it says: an amber age statement plus a `title` explaining the tint,
  and — on Latest vitals — no trend arrow, since an arrow is a claim about now.
- A Trends body-census chart card keeps its headline number and adds an **as-of
  stamp** naming the day it was read (#2615). The number is the latest reading
  there is; what it may no longer imply is that it is today's.

Both keep the underlying values visible with their provenance. The fix is what
the aggregate CLAIMS, never what it hides.

## Adding a tenant

1. Resolve the interval that applies to your reading, and declare it — a
   registry keyed by identity beats a magic number at the call site, and a
   completeness test over that registry beats a documented default nobody
   re-reads (`missingFreshnessPolicies` is the fitness example).
2. Decide your domain's exemptions and pass them as `exempt`. Never encode
   another domain's exemptions here.
3. Call `freshnessState`, tally with `tallyFreshness`, and phrase the result in
   your own surface's words.
4. If your aggregate can render "current"-shaped copy, gate it on
   `hasNoCurrentReading`.
