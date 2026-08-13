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
| BMI's paired height (`lib/growth-series.ts`, #2646)                         | `PAIRED_HEIGHT_INTERVAL_DAYS` by LIFE STAGE: 92 days infant, 183 child/adolescent   | adults and older adults, and an unknown birthdate — no clock, so an old height still pairs                    |

A tenant **adapts** onto the shared decision. It does not fork it, and it does
not re-derive "is this stale" in a component.

The BMI tenant is the one whose reading is an **input** rather than a result.
`bmiSeriesDatePaired` pairs each weigh-in with the height in effect on or before it
(#407, so early history is not inflated by a recent height); #2646 bounds how far
back "in effect" may reach, because BMI is kg/m² and a months-old height turns a
growing child's growth into apparent fatness — always in that direction. A `due`
verdict drops the point rather than plotting a wrong one, and `not-applicable` (an
adult, or an unknown age) is the KEEP case, which is exactly why it must never fold
into `due`. Age is resolved as of the weigh-in, never today (#2090).

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

## Dormancy is a third question (#2652)

`lib/domain-dormancy.ts` asks something neither of the above asks: **has this
domain stopped arriving?** It is a claim about the PIPELINE, not about a reading,
and it is the only one of the three with a consequence in HEIGHT.

|                    | asks                           | consequence                             |
| ------------------ | ------------------------------ | --------------------------------------- |
| Retest clock       | should this be re-tested?      | a finding, a nudge                      |
| Presentation floor | may this read as my value NOW? | an as-of stamp; the value stays put     |
| **Dormancy**       | has anything arrived at all?   | the section spends one line, not a card |

Three states, and the third exists so the first two cannot be conflated:

```ts
type DormancyState = "absent" | "current" | "dormant";
```

- `absent` — nothing has EVER been recorded. The onboarding case, with its own
  first-run copy. `not-applicable` from `freshnessState` maps here, never to
  `dormant`: telling somebody with a year of weigh-ins that they have never
  weighed themselves is the defect this exists to remove, and the dashboard's
  weight card did exactly that, because its own render window is 90 days and an
  empty window read as an empty domain.
- `current` — something arrived inside the interval.
- `dormant` — something did arrive, and then stopped.

The DECISION is still `freshnessState`'s, so the boundary is the shared one
(dormant strictly after the interval). What each domain supplies is its interval
and the noun its line uses.

**Intervals.** 90 days by owner ruling (2026-08-13), declared per domain with a
completeness test.

**Where dormancy STOPS, and this is the hard bound.** A presentation floor exists
precisely so a stale value can stay on screen honestly — "still your latest reading,
but not a current one" — and the doctrine above says the fix is what an aggregate
CLAIMS, never what it hides. So a section that is showing a real value under a floor
may never be collapsed. Dormancy is available only where there is nothing to hide: a
section whose populated render is **window-bounded**, and which therefore already shows
nothing once its domain goes quiet. `DormancyDeclaration.renderWindowDays` names that
window and `dormancyWindowConflicts()` is empty by construction, so a domain cannot be
added whose interval elapses while its section could still be rendering points.

That is why only **weight** (a 90-day chart) and **sleep** (last night) are domains.
`recent-labs` and `vitals-latest` render their latest reading at any age and are
exemptions with that reason written beside them; collapsing either would need a FOLD
that keeps its rows reachable in place (the #2685 URL-state pattern), not a line.

**What a dormant line may say.** The RECORD, and how long — "No weigh-in recorded
in 150 days". Never the body, and never a guess at why: a domain is quiet either
because nothing was logged or because nothing happened, and only the first is
knowable from here.

**What dormancy may never do.** Change reach. The collapsed line carries the fix and
everything it replaced is one tap away. Nothing is removed by adaptation. Anything
carrying an OBLIGATION never collapses: doses, refills and care follow-ups reach the
dashboard through the pinned attention hero, which is not data-aware and so cannot be
flagged dormant by construction.

**Tenants.** The dashboard's data-aware widget band (`lib/dashboard-widgets.ts`).
Every `dataAware` widget either declares a `dormancyDomain` or is named in
`DORMANCY_EXEMPT_WIDGETS` with its reason. `widgetDisplayState` owns the precedence —
dormant outranks empty, and a widget that declares neither capability can be flagged
for neither.

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
