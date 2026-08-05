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

| Tenant | Interval | Exemptions |
| --- | --- | --- |
| Biomarkers — `biomarkerRetestStatus` (`lib/reference-range/qualitative.ts`) | the analyte's curated `retest_days`, else the flat default | genomics, non-lab categories, durable immune positives (#516), immutable attributes (#548), QC metrics (#687) |
| Fitness check — `lib/fitness-freshness.ts` via `buildFitnessCheckModel` | the test's DECLARED policy: the profile's retest cadence, or a per-test fixed clock | an unmeasured test (no reading to date) |
| Longevity's optimal-biomarker pillar | — | consumes the biomarker adapter above; mints nothing |

A tenant **adapts** onto the shared decision. It does not fork it, and it does
not re-derive "is this stale" in a component.

`BiomarkerRetestStatus` is an alias of `FreshnessState`, so biomarker readings
and fitness tests can be tallied with the same counter.

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
