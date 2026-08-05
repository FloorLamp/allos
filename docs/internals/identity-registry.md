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

| Subject                                                                                             | Function(s)                                                                                                                                                                                                                                                          | Location                                                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Biomarker / lab analyte (total vs D2/D3 vitamin D, A1c ↔ eAG)                                       | `biomarkerFamily()`, its SQL twin `biomarkerFamilyKey()` (which CALLS it through the `biomarker_family` SQLite user function, #1401), and the name-keyed re-keys `biomarkerDismissalKey()` / `biomarkerFlagDismissalKey()`                                           | `lib/canonical-name.ts`, `lib/queries/medical.ts`, `lib/sql-functions.ts`, `lib/dismissal-keys.ts` |
| Biomarker PANEL (which clinical order an analyte belongs to)                                        | `panelForCanonicalName()`, its SQL twin `biomarkerPanelKey()` (the `biomarker_panel` SQLite user function, #1629 — a family's members share one panel by construction)                                                                                               | `lib/biomarker-panels.ts`, `lib/queries/medical.ts`, `lib/sql-functions.ts`                        |
| Lab result LIFECYCLE (is this re-import a re-issue of a value already read?)                        | `supersedesReading()` + `normalizeResultStatus()`                                                                                                                                                                                                                    | `lib/lab-result-lifecycle.ts`                                                                      |
| Exercise / lift (a lift and its equipment variants — Barbell/Dumbbell Curl → Curl)                  | `exerciseHistoryKey()` (over `baseLiftName()`), with `exerciseHistoryNames()` as the `IN (...)` finite-preimage                                                                                                                                                      | `lib/lifts.ts`                                                                                     |
| Strength LOAD CONTEXT (two registry machines logged under ONE exercise name — non-comparable loads) | `equipmentLoadLane()` and its two composers `strengthLoadKey()` (exact variant + lane, for seeds) and `movementLoadKey()` (`exerciseHistoryKey` + lane, for progression series and plateau dedupe keys); `loadContextLabel()` names a lane on screen                 | `lib/lifts.ts`                                                                                     |
| Muscle → region rollup (`MuscleId` → coarse `MuscleRegion`)                                         | `muscleRegion()`                                                                                                                                                                                                                                                     | `lib/lifts.ts`                                                                                     |
| Cardio / sport ACTIVITY name (case + whitespace variants of one logged effort)                      | `activityHistoryKey()` — the cardio twin of `exerciseHistoryKey`; the stats grouping, the outdoor-plan key and the PR dismissal key (`prCardioDismissalKey()`) all resolve through it (#1931)                                                                        | `lib/activities-catalog.ts`, `lib/dismissal-keys.ts`                                               |
| Personal-record celebration (which record a dismissal silences)                                     | `prStrengthDismissalKey()` (over `movementLoadKey`) / `prCardioDismissalKey()` (over `activityHistoryKey`), with `prDismissalKeysLosingBacking()` as the no-orphan sweep arithmetic (#1931)                                                                          | `lib/dismissal-keys.ts`                                                                            |
| Symptom (curated + custom, spelling/case variants)                                                  | `normalizeSymptomName()`, `symptomSlugs()`, `isCuratedSymptom()`, `isCustomSymptomKey()`                                                                                                                                                                             | `lib/symptoms.ts`                                                                                  |
| Drug ingredient identity (combination drug ↔ its ingredient CUIs)                                   | `parseRxcuiIngredients()`, `itemRxcuis()`                                                                                                                                                                                                                            | `lib/rxnorm.ts`, `lib/drug-interactions.ts`                                                        |
| Condition (a coded problem ↔ its display-name variants — "Type 2 diabetes"/"T2DM"/E11.9)            | `conditionCollapseKey()` (code beats name), mirrored by the SQL `CONDITION_REPRESENTATIVE_IDS` grouping (built from the `conditions` registry row below)                                                                                                             | `lib/icd10.ts`, `lib/queries/clinical.ts`                                                          |
| Vaccine / immunization (a combo dose ↔ its component catalog codes — the #482 example)              | `normalizeVaccineName()` + component expansion; the name-keyed dismissal `immunizationDismissalKey()` and its no-orphan sweep `immunizationCodesLosingBacking()`                                                                                                     | `lib/immunization-catalog.ts`, `lib/dismissal-keys.ts`                                             |
| Provider (a clinician ↔ spelling/punctuation variants of the printed name)                          | `normalizeProviderName()`                                                                                                                                                                                                                                            | `lib/providers.ts`                                                                                 |
| Allergen (a documented allergy ↔ its IgE-sensitization name — "Peanut"/"Peanut IgE")                | `allergenKey()`, with `allergenFromIgEName()` lifting an IgE analyte to its allergen                                                                                                                                                                                 | `lib/allergy-ige.ts`                                                                               |
| Nutrient (a supplement/med name ↔ its UL-bearing DRI nutrient key)                                  | `resolveNutrientKey()` → `nutrientByKey()`                                                                                                                                                                                                                           | `lib/dri.ts`                                                                                       |
| Dated READING (the same quantity in `body_metrics` / `metric_samples` / `medical_records`, #1997)   | `readingIdentity()` (which IS `biomarkerFamily`, applied one level up) plus `READING_IDENTITY_MAP` — the ONE declaration (#2086) both halves derive from: `STREAM_READING_SOURCES` (stream ↔ canonical) and `CONTINUOUS_READING_METRIC` (canonical → metric surface) | `lib/reading-identity-map.ts`, `lib/reading-model.ts`, `lib/reading-cadence.ts`                    |
| REPRESENTATIVE row across overlapping documents (one entry stored once per uploaded CCD, #2035)     | `representativeIds()` / `representativeCte()` over the `REPRESENTATIVE_SPECS` registry — one collapse identity plus one named `PREFERENCE_SQL` axis per table; `latestByGroup()` is the pure twin of its `recency` axis                                              | `lib/representative-ids.ts`, `lib/latest-per-group.ts`                                             |

Two disciplines every one of these shares:

- **Exclusion discipline.** Distinct assays/fractions/specimens/metabolites,
  distinct equipment where the load genuinely differs, distinct symptoms — stay
  APART. Over-collapsing grants a wrong "all-clear"; over-expanding multiplies
  entries. (Example: the #836 catalog keeps a trap-bar deadlift and a Smith
  bench as their OWN `exerciseHistoryKey`, separate from the barbell base,
  rather than folding them in as merged variants; `conditionCollapseKey` never
  collapses a coded row with an uncoded same-name one.)
- **Name-keyed re-key.** Because names/codes recycle (integer ids never do), a
  star/dismiss keyed by name must re-key to the canonical family so it covers
  the family and does not drift as which member is newest. When the subject that
  backed a name-keyed row is deleted or renamed, the leftover key is swept
  (`immunizationCodesLosingBacking` is the pattern — clear only the keys this
  deletion actually un-backed, never every unbacked code).

One subject can need TWO identities on different axes, and the strength domain is
the worked example (#1610). `exerciseHistoryKey` answers **which movement** — it
merges a lift's catalog variants and owns regions, routine matching, coverage,
staleness and navigation. `equipmentLoadLane` answers **which implement** — two
registry machines both serialize as the exact same logged name, so no name-derived
key can tell a home chest press from a hotel one whose stack geometry makes 50 kg
the right load. Load-sensitive facts (seeds, top weight/e1RM/PRs, comparison series,
plateau signals, weight-goal progress) key on a COMPOSER of both; movement-wide
facts keep the movement key alone. Two rules make the pair safe:

- a NULL `exercise_sets.equipment_id` is an explicit **unassigned lane**, never a
  wildcard — history that names no implement never seeds, PRs or plateaus a machine;
- a NULL `goals.equipment_id` is the opposite: an **undeclared scope**, so a goal
  that names no machine stays movement-wide (what every goal stored before the
  column means). An observation with no implement is a distinct fact; a scope with
  no implement is simply not narrowed.

Any surface that SPLITS by lane must label the lanes with `loadContextLabel()`;
#1610 forbids duplicate unlabeled rows, which is what an unlabeled split renders.

## The cross-cutting identity registries

Three registries carry identity at a layer above a single domain. Each is a
closed set with its own reflection guard (below), the same discipline as the
domain functions.

- **Reason codes (#656).** `REASON_CODES` (backing the `ReasonCode` union) in
  `lib/reasons.ts` is the closed set of "why" kinds a `Finding`/`UpcomingItem`
  carries — identity at the EXPLANATION layer, so the page, the digest, and a
  reminder render the SAME reason from one computation, never a second
  derivation.
- **Dataset identity strategies (#860 Track B).** The curated-dataset framework
  resolves a query to an entry via a pluggable `MatchStrategy`
  (`lib/datasets/matcher.ts`): `nameStrategy` / `slugStrategy` / `fieldStrategy`
  for single-key identity, and `multiValueStrategy()` / `pairStrategy()` /
  `compositeStrategy()` for synonyms/aliases/RxCUI-sets/`gene|allele` pairs.
  Each dataset declares its `identity.keys` in its envelope;
  `canonical-biomarkers` keys on the exact canonical `name` (which curated row —
  distinct from `biomarkerFamily`, which collapses ACROSS names; different
  layers). Full spec: `docs/internals/datasets.md`.
- **Biomarker goals: family for FACTS, canonical row for the ANCHOR (#1853).**
  A goal stores the analyte name the user PICKED (`goals.biomarker_name`), and the
  picker dedupes its rows on `normalizeCanonicalKey` like every other biomarker
  field — collapsing rows on family would make the vitamin-D D2/D3 fractions
  unpickable (#482). The READINGS that advance the goal reach it through
  `biomarkerFamily`, because `getBiomarkerSeries` is what gathers them, so an A1c
  goal is advanced by the eAG re-expression of the same draw and shows on the
  detail page that charts them. Family is how facts REACH a row; it is not what a
  row IS.
- **Findings dedupeKey registry (#448 → #860 Track A).** `RULE_FINDING_REGISTRY`
  in `lib/rule-finding-prefixes.ts` binds every finding-producing builder's
  dedupeKey PREFIX to its reach TIER (`FindingTier` care/coaching) and its
  declared reason codes. `dedupeKeyHasKnownPrefix()`,
  `findingRegistryEntryFor()`, and `tierForDedupeKey()` read it. Full policy:
  `docs/internals/findings.md`.
- **Dismissal-key CLASSES (#1931).** `DISMISSAL_KEY_REGISTRY` in
  `lib/dismissal-classes.ts` answers the orthogonal question the prefix registry
  above does not: for every `upcoming_dismissals.signal_key` namespace, WHAT
  stops the key from re-attaching to a subject the user never silenced. Each
  namespace declares one `DismissalKeyClass` — `id-keyed` (ids never recycle),
  `catalog` (fixed vocabulary; the topic IS the subject), `anchored` (a
  date/period/episode anchor bounds re-attachment), `name-keyed-swept` (a
  recyclable name PLUS a named de-orphan sweep), `name-keyed-open` (recyclable,
  unswept, residual risk stated), or `legacy` (no longer minted). Read with
  `dismissalKeyEntryFor()`.

  This is the **name-keyed re-key discipline made enforceable** rather than
  re-audited by hand every time the class resurfaces (#203/#283/#327 biomarkers,
  #376 immunizations, #1399/#1610 training observations, #1931 personal records).
  `lib/__tests__/dismissal-classes.test.ts` asserts the registry and
  `SUPPRESSION_DISPLAY_PREFIXES` are the same set, requires a named sweep for
  every `name-keyed-swept` entry and a stated risk for every open/legacy one, and
  scans lib/ so that every `export const *_PREFIX = "…"` literal is either
  classified or listed in `NON_DISMISSAL_PREFIXES` with what it actually keys.
  A namespace that is BOTH spelled inline and absent from the display resolver
  still escapes both teeth — noted in the module header, because that combination
  already renders as an unnameable orphan row in Snoozed & dismissed.

## The reflection-guard convention

An identity/prefix registry is only trustworthy if nothing can ship a key
outside it. So each namespace carries a **reflection guard** — a test that
enumerates the real emitters and asserts every emitted key parses against the
known registry:

- The finding-`dedupeKey` registry (`lib/rule-finding-prefixes.ts`) is enforced
  by `lib/__db_tests__/rule-findings-builders.test.ts`: every builder-emitted
  `dedupeKey` parses against it AND resolves the tier the code actually travels
  (a coaching builder registered `care`, or vice versa, fails CI), and every
  attached reason code is one the prefix declared — a new engine cannot ship an
  un-guardable or mis-tiered key namespace.
- The curated-dataset framework (`lib/__tests__/datasets-framework.test.ts`)
  runs the harness over every registered dataset — citation present, every entry
  resolves by its own identity, an absent query refuses — so a dataset can't
  join the registry without a working identity strategy.
- The exercise-guides completeness test
  (`lib/__tests__/exercise-guides.test.ts`) derives its key set from
  `exerciseHistoryKey` over the catalog, so a new lift automatically joins the
  invariant (a guide per key, tags equal to the catalog).

A new findings engine or name-keyed signal adds its prefix/identity to the
registry and its own reflection guard, rather than a bespoke second grouping —
and adds a row to the table above (the doc guard keeps this index honest, but it
can only verify the symbols named here still exist, not that a NEW identity
function was added; that discipline stays a review convention).
