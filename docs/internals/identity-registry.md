# Identity registry

Status: shipped

The **identity-family convention** (#482) says: when several stored names/codes
answer ONE question, there is exactly ONE pure function that collapses them, and
EVERY surface — the dedup partition, the series/`is_latest` grouping, the
starred/pinned store, the retest/plateau clock, and the `dedupeKey` of any
dismissal — keys on it, never on the raw name. A hand-rolled second grouping is
the "one question, one computation" disease at the identity layer.

This file is the index of those canonical identity functions, so a new
name-keyed signal reaches for its domain's existing function instead of inventing
a parallel grouping.

## The canonical identity functions

| Subject                                                                            | Function(s)                                                                                                              | Location                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Biomarker / lab analyte (total vs D2/D3 vitamin D, A1c ↔ eAG)                      | `biomarkerFamily()`, its SQL finite-preimage `biomarkerFamilyKey()`, and the name-keyed re-key `biomarkerDismissalKey()` | `lib/canonical-name.ts`, `lib/queries/medical.ts` |
| Exercise / lift (a lift and its equipment variants — Barbell/Dumbbell Curl → Curl) | `exerciseHistoryKey()` (over `baseLiftName()`), with `exerciseHistoryNames()` as the `IN (...)` finite-preimage          | `lib/lifts.ts`                                    |
| Muscle → region rollup (`MuscleId` → coarse `MuscleRegion`)                        | `muscleRegion()`                                                                                                         | `lib/lifts.ts`                                    |
| Symptom (curated + custom, spelling/case variants)                                 | `normalizeSymptomName()`, `isCustomSymptomKey()`, `isCuratedSymptom()`                                                   | `lib/symptoms.ts`                                 |
| Drug ingredient identity (combination drug ↔ its ingredient CUIs)                  | `parseRxcuiIngredients()` (`lib/rxnorm.ts`), `itemRxcuis()` (`lib/drug-interactions.ts`)                                 | `lib/rxnorm.ts`, `lib/drug-interactions.ts`       |

Two disciplines every one of these shares:

- **Exclusion discipline.** Distinct assays/fractions/specimens/metabolites,
  distinct equipment where the load genuinely differs, distinct symptoms — stay
  APART. Over-collapsing grants a wrong "all-clear"; over-expanding multiplies
  entries. (Example: the #836 catalog keeps a trap-bar deadlift and a Smith bench
  as their OWN `exerciseHistoryKey`, separate from the barbell base, rather than
  folding them in as merged variants.)
- **Name-keyed re-key.** Because names/codes recycle (integer ids never do), a
  star/dismiss keyed by name must re-key to the canonical family so it covers the
  family and does not drift as which member is newest.

## The reflection-guard convention

An identity/prefix registry is only trustworthy if nothing can ship a key outside
it. So each namespace carries a **reflection guard** — a test that enumerates the
real emitters and asserts every emitted key parses against the known registry:

- `lib/rule-finding-prefixes.ts` is the finding-`dedupeKey` prefix registry, and
  `lib/__db_tests__/rule-findings-builders.test.ts` asserts every builder-emitted
  `dedupeKey` parses against it — a new engine cannot ship an un-guardable key
  namespace.
- The exercise-guides completeness test (`lib/__tests__/exercise-guides.test.ts`)
  derives its key set from `exerciseHistoryKey` over the catalog, so a new lift
  automatically joins the invariant (a guide per key, tags equal to the catalog).

A new findings engine or name-keyed signal adds its prefix/identity to the
registry and its own reflection guard, rather than a bespoke second grouping.
