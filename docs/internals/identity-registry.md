# Identity registry

Choose an identity for the question being answered, then reuse its existing
owner across grouping, history, stars and dismissal keys. One subject can have
several identities: a movement, its load context and a particular recorded set
are different questions. Identity keys do not replace profile scoping.

This guide locates the owners and explains distinctions that callers must
preserve. It is not a second registry of every exported function.

## Domain owners

| Subject                             | Existing owner and entry points                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Biomarker family                    | [canonical-name.ts](../../lib/canonical-name.ts): `biomarkerFamily`, `normalizeCanonicalKey`. Family facts and canonical dataset rows are different identities.                                                                                                                |
| Biomarker panel                     | [biomarker-panels.ts](../../lib/biomarker-panels.ts): `panelForCanonicalName`.                                                                                                                                                                                                 |
| Lab result lifecycle                | [lab-result-lifecycle.ts](../../lib/lab-result-lifecycle.ts): `supersedesReading`, `normalizeResultStatus`. Determines whether a reissued result supersedes an earlier reading.                                                                                                |
| Exercise movement                   | [lifts.ts](../../lib/lifts.ts): `exerciseHistoryKey`, `baseLiftName`, `exerciseHistoryNames`. The latter supplies the finite set of catalog names for SQL reads.                                                                                                               |
| Strength load context               | [lifts.ts](../../lib/lifts.ts): `equipmentLoadLane`, `strengthLoadKey`, `movementLoadKey`, `loadContextLabel`. See the separate load axes below.                                                                                                                               |
| Muscle region                       | [lifts.ts](../../lib/lifts.ts): `muscleRegion` maps a muscle to its coarse region.                                                                                                                                                                                             |
| Cardio or sport activity            | [activities-catalog.ts](../../lib/activities-catalog.ts): `activityHistoryKey` matches case and whitespace variants.                                                                                                                                                           |
| Personal-record dismissal           | [dismissal-keys.ts](../../lib/dismissal-keys.ts): `prStrengthDismissalKey`, `prCardioDismissalKey`, `prDismissalKeysLosingBacking`.                                                                                                                                            |
| Symptom                             | [symptoms.ts](../../lib/symptoms.ts): `normalizeSymptomName`, `resolveSymptomKey`, `symptomSlugs`, curated/custom predicates and `symptomLabel`.                                                                                                                               |
| Substance                           | [substance-use.ts](../../lib/substance-use.ts): `normalizeSubstanceName`, `resolveSubstanceKey`, curated/custom predicates, `substanceLabel` and `substanceDef`.                                                                                                               |
| Shared vocabulary matching          | [vocabulary-fold.ts](../../lib/vocabulary-fold.ts): `foldVocabularyName`, `sameVocabularyName`, `matchFoldedVocabulary`; [vocabulary-store.ts](../../lib/vocabulary-store.ts) resolves profile-owned spellings.                                                                |
| Drug ingredients                    | [rxnorm.ts](../../lib/rxnorm.ts): `parseRxcuiIngredients`; [drug-interactions.ts](../../lib/drug-interactions.ts): `itemRxcuis`.                                                                                                                                               |
| Condition                           | [icd10.ts](../../lib/icd10.ts): `conditionCollapseKey`; [clinical queries](../../lib/queries/clinical.ts) use the corresponding representative-row grouping.                                                                                                                   |
| Vaccine                             | [immunization-catalog.ts](../../lib/immunization-catalog.ts): `normalizeVaccineName` and component expansion; [dismissal keys](../../lib/dismissal-keys.ts) own `immunizationDismissalKey` and `immunizationCodesLosingBacking`.                                               |
| Provider                            | [providers.ts](../../lib/providers.ts): `normalizeProviderName`.                                                                                                                                                                                                               |
| Allergen                            | [allergy-ige.ts](../../lib/allergy-ige.ts): `allergenKey`, `allergenFromIgEName`.                                                                                                                                                                                              |
| Nutrient                            | [dri.ts](../../lib/dri.ts): `resolveNutrientKey`, `nutrientByKey`.                                                                                                                                                                                                             |
| Reading across storage tables       | [reading-model.ts](../../lib/reading-model.ts): `readingIdentity` uses biomarker-family identity. [READING_IDENTITY_MAP](../../lib/reading-identity-map.ts) supplies the shared stream/canonical mapping used by reading adapters and [cadence](../../lib/reading-cadence.ts). |
| Representative row across documents | [representative-ids.ts](../../lib/representative-ids.ts): `representativeIds`, `representativeCte`, `REPRESENTATIVE_SPECS` and named preference axes. [latest-per-group.ts](../../lib/latest-per-group.ts) owns the pure recency comparison.                                   |

## Preserve the correct distinctions

**Family and canonical row.** A biomarker goal stores the analyte the person
picked. Picker rows use `normalizeCanonicalKey`; readings that advance the goal
use `biomarkerFamily`. Collapsing the picker by family would remove separately
selectable fractions. Family identity groups facts; it does not redefine which
curated row the person chose.

[Medical query helpers](../../lib/queries/medical/common.ts) expose
`biomarkerFamilyKey` and `biomarkerPanelKey`. They call the pure family/panel
functions through the SQLite functions registered in
[sql-functions.ts](../../lib/sql-functions.ts). Reuse these expressions instead
of reconstructing a second SQL grouping.

**Exclusions.** Preserve distinctions declared by the domain: different assays,
specimens or metabolites are not automatically aliases. The lift catalog keeps
trap-bar deadlift and Smith bench separate from their barbell counterparts.
`conditionCollapseKey` prefers a nonblank code and never merges a coded row with
an uncoded row solely because their names match.

**Movement and load.** `exerciseHistoryKey` groups catalog variants for
movement-wide history and matching. Load-sensitive facts need the relevant
additional axis:

- `strengthLoadKey` combines the exact logged variant with an equipment lane for
  seeds and recent-session fills.
- `movementLoadKey` combines movement identity with the lane for aggregate
  progression and plateau keys.
- A null set `equipment_id` is the explicit unassigned lane, not a wildcard.
  Unassigned history must not silently seed a named machine.
- A null goal `equipment_id` leaves its scope undeclared and movement-wide.
  It does not mean “only unassigned observations.”

Use `loadContextLabel` whenever a surface splits results by lane, so separate
implements do not produce indistinguishable rows.

## Free-text vocabularies

Symptoms and substances share matching rules; they retain their own domain
normalizers and labels. `foldVocabularyName` compares already-normalized names.
Its result is for matching, never storage or display.

`profileVocabulary` reads the profile's spellings in first-seen order, and
`resolveProfileVocabularyKey` reuses the first matching spelling for typed
writes. This order answers which spelling to keep, not which suggestion was used
most recently. Existing rows that differ only by case are not silently rewritten.
Explicit renames resolve their old and new names without adopting the stored
spelling, so a deliberate case-only rename remains possible.

Do not reproduce matching with SQLite's built-in `LOWER` or `COLLATE NOCASE`:
the JS fold handles Unicode while those built-ins fold ASCII. Sorting is a
separate concern. If SQL must perform the identity match, use the established
SQLite user-function pattern rather than another normalization rule.

## Registries above a domain

| Owner                                                          | Responsibility                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [reasons.ts](../../lib/reasons.ts)                             | `REASON_CODES` / `ReasonCode` identify the explanations carried by findings and upcoming items.                                                                                                                              |
| [Dataset matcher](../../lib/datasets/matcher.ts)               | Existing name, slug, field, multi-value, pair and composite strategies implement each dataset envelope's declared identity. See [datasets](datasets.md). A canonical dataset row remains distinct from its biomarker family. |
| [rule-finding-prefixes.ts](../../lib/rule-finding-prefixes.ts) | `RULE_FINDING_REGISTRY` associates finding prefixes with care/coaching tiers and permitted reason codes. See [findings](findings.md).                                                                                        |
| [dismissal-classes.ts](../../lib/dismissal-classes.ts)         | `DISMISSAL_KEY_REGISTRY` classifies namespaces by how they avoid reattaching an old dismissal to a different subject.                                                                                                        |

Dismissal classes distinguish nonrecycling IDs, fixed catalog subjects, anchored
episodes, swept names, unswept names and legacy keys. Names can be reused. A
name-keyed dismissal must follow the canonical identity, and its declared sweep
must clear keys that lose their backing on deletion or rename. Clear only keys
that the operation actually unbacked. Open and legacy classes state their
remaining risk; classification does not itself provide a sweep.

## Verification

Use existing behavioral coverage for grouping exclusions, SQL/JS agreement,
profile-owned vocabulary resolution, load-lane separation and dismissal cleanup.
The finding-builder, dataset and exercise-guide tests also exercise their
existing registries against emitted keys or catalog entries.

Registry scans have bounded coverage. The dismissal scan recognizes exported
prefix literals and the display resolver's namespaces; a prefix absent from both
can escape it. A document index cannot establish exhaustive runtime coverage.

For a new caller, reuse the owner before adding code. For a new identity, explain
which existing identity cannot answer its question and extend the appropriate
owner and meaningful tests. Do not automatically add a scanner or a second
registry. Follow the [change and test policy](../change-policy.md).
