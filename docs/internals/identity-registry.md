# Identity registry

Status: shipped

The **identity-family convention** (#482) says: when several stored names/codes
answer ONE question, there is exactly ONE pure function that collapses them, and
EVERY surface — the dedup partition, the series/`is_latest` grouping, the
starred/pinned store, the retest/plateau clock, and the `dedupeKey` of any
dismissal — keys on it, never on the raw name. A hand-rolled second grouping is
the "one question, one computation" disease at the identity layer.

This file is the index of those canonical identity functions (Track D of #860),
so a new name-keyed signal reaches for its domain's existing function instead of
inventing a parallel grouping. Every entry below is verified against the code by
`lib/__tests__/identity-registry-doc.test.ts` (an anti-rot guard — a renamed or
deleted symbol named here fails CI).

## The canonical domain-identity functions

| Subject                                                                                  | Function(s)                                                                                                                                                      | Location                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Biomarker / lab analyte (total vs D2/D3 vitamin D, A1c ↔ eAG)                            | `biomarkerFamily()`, its SQL finite-preimage `biomarkerFamilyKey()`, and the name-keyed re-keys `biomarkerDismissalKey()` / `biomarkerFlagDismissalKey()`        | `lib/canonical-name.ts`, `lib/queries/medical.ts`, `lib/dismissal-keys.ts` |
| Exercise / lift (a lift and its equipment variants — Barbell/Dumbbell Curl → Curl)       | `exerciseHistoryKey()` (over `baseLiftName()`), with `exerciseHistoryNames()` as the `IN (...)` finite-preimage                                                  | `lib/lifts.ts`                                                             |
| Muscle → region rollup (`MuscleId` → coarse `MuscleRegion`)                              | `muscleRegion()`                                                                                                                                                 | `lib/lifts.ts`                                                             |
| Symptom (curated + custom, spelling/case variants)                                       | `normalizeSymptomName()`, `symptomSlugs()`, `isCuratedSymptom()`, `isCustomSymptomKey()`                                                                         | `lib/symptoms.ts`                                                          |
| Drug ingredient identity (combination drug ↔ its ingredient CUIs)                        | `parseRxcuiIngredients()`, `itemRxcuis()`                                                                                                                        | `lib/rxnorm.ts`, `lib/drug-interactions.ts`                                |
| Condition (a coded problem ↔ its display-name variants — "Type 2 diabetes"/"T2DM"/E11.9) | `conditionCollapseKey()` (code beats name), mirrored by the SQL `CONDITION_REPRESENTATIVE_IDS` grouping                                                          | `lib/icd10.ts`, `lib/queries/clinical.ts`                                  |
| Vaccine / immunization (a combo dose ↔ its component catalog codes — the #482 example)   | `normalizeVaccineName()` + component expansion; the name-keyed dismissal `immunizationDismissalKey()` and its no-orphan sweep `immunizationCodesLosingBacking()` | `lib/immunization-catalog.ts`, `lib/dismissal-keys.ts`                     |
| Provider (a clinician ↔ spelling/punctuation variants of the printed name)               | `normalizeProviderName()`                                                                                                                                        | `lib/providers.ts`                                                         |
| Allergen (a documented allergy ↔ its IgE-sensitization name — "Peanut"/"Peanut IgE")     | `allergenKey()`, with `allergenFromIgEName()` lifting an IgE analyte to its allergen                                                                             | `lib/allergy-ige.ts`                                                       |
| Nutrient (a supplement/med name ↔ its UL-bearing DRI nutrient key)                       | `resolveNutrientKey()` → `nutrientByKey()`                                                                                                                       | `lib/dri.ts`                                                               |

Two disciplines every one of these shares:

- **Exclusion discipline.** Distinct assays/fractions/specimens/metabolites,
  distinct equipment where the load genuinely differs, distinct symptoms — stay
  APART. Over-collapsing grants a wrong "all-clear"; over-expanding multiplies
  entries. (Example: the #836 catalog keeps a trap-bar deadlift and a Smith bench
  as their OWN `exerciseHistoryKey`, separate from the barbell base, rather than
  folding them in as merged variants; `conditionCollapseKey` never collapses a
  coded row with an uncoded same-name one.)
- **Name-keyed re-key.** Because names/codes recycle (integer ids never do), a
  star/dismiss keyed by name must re-key to the canonical family so it covers the
  family and does not drift as which member is newest. When the subject that
  backed a name-keyed row is deleted or renamed, the leftover key is swept
  (`immunizationCodesLosingBacking` is the pattern — clear only the keys this
  deletion actually un-backed, never every unbacked code).

## The cross-cutting identity registries

Three registries carry identity at a layer above a single domain. Each is a
closed set with its own reflection guard (below), the same discipline as the
domain functions.

- **Reason codes (#656).** `REASON_CODES` (backing the `ReasonCode` union) in
  `lib/reasons.ts` is the closed set of "why" kinds a `Finding`/`UpcomingItem`
  carries — identity at the EXPLANATION layer, so the page, the digest, and a
  reminder render the SAME reason from one computation, never a second derivation.
- **Dataset identity strategies (#860 Track B).** The curated-dataset framework
  resolves a query to an entry via a pluggable `MatchStrategy`
  (`lib/datasets/matcher.ts`): `nameStrategy` / `slugStrategy` / `fieldStrategy`
  for single-key identity, and `multiValueStrategy()` / `pairStrategy()` /
  `compositeStrategy()` for synonyms/aliases/RxCUI-sets/`gene|allele` pairs. Each
  dataset declares its `identity.keys` in its envelope; `canonical-biomarkers`
  keys on the exact canonical `name` (which curated row — distinct from
  `biomarkerFamily`, which collapses ACROSS names; different layers). Full spec:
  `docs/internals/datasets.md`.
- **Findings dedupeKey registry (#448 → #860 Track A).** `RULE_FINDING_REGISTRY`
  in `lib/rule-finding-prefixes.ts` binds every finding-producing builder's
  dedupeKey PREFIX to its reach TIER (`FindingTier` care/coaching) and its
  declared reason codes. `dedupeKeyHasKnownPrefix()`, `findingRegistryEntryFor()`,
  and `tierForDedupeKey()` read it. Full policy: `docs/internals/findings.md`.

## The reflection-guard convention

An identity/prefix registry is only trustworthy if nothing can ship a key outside
it. So each namespace carries a **reflection guard** — a test that enumerates the
real emitters and asserts every emitted key parses against the known registry:

- The finding-`dedupeKey` registry (`lib/rule-finding-prefixes.ts`) is enforced by
  `lib/__db_tests__/rule-findings-builders.test.ts`: every builder-emitted
  `dedupeKey` parses against it AND resolves the tier the code actually travels
  (a coaching builder registered `care`, or vice versa, fails CI), and every
  attached reason code is one the prefix declared — a new engine cannot ship an
  un-guardable or mis-tiered key namespace.
- The curated-dataset framework (`lib/__tests__/datasets-framework.test.ts`) runs
  the harness over every registered dataset — citation present, every entry
  resolves by its own identity, an absent query refuses — so a dataset can't join
  the registry without a working identity strategy.
- The exercise-guides completeness test (`lib/__tests__/exercise-guides.test.ts`)
  derives its key set from `exerciseHistoryKey` over the catalog, so a new lift
  automatically joins the invariant (a guide per key, tags equal to the catalog).

A new findings engine or name-keyed signal adds its prefix/identity to the
registry and its own reflection guard, rather than a bespoke second grouping —
and adds a row to the table above (the doc guard keeps this index honest, but it
can only verify the symbols named here still exist, not that a NEW identity
function was added; that discipline stays a review convention).
