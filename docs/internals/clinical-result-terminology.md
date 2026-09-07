# Clinical-result terminology

Status: shipped.

Use these terms to distinguish what an observation stores, where it appears,
and whether it participates in canonical identity. Follow the
[change and test policy](../change-policy.md) when changing the model; reuse its
existing predicates and readers.

## Independent questions

| Question           | Owner                                                           | Meaning                                                                        |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Storage category   | `MEDICAL_CATEGORIES`, `MedicalCategory`, and the database CHECK | The supported class of clinical observation.                                   |
| Catalog visibility | `RESULTS_CATALOG_CATEGORIES` plus `listedInResultsCatalog`      | Whether the flat Clinical results catalog lists the observation.               |
| Identity           | `NON_IDENTITY_CATEGORIES` and `carriesResultIdentity`           | Whether the category permits canonical naming, Coverage candidacy, and series. |

[medical-categories.ts](../../lib/medical-categories.ts) owns the category sets.
`ASSIGNABLE_MEDICAL_CATEGORIES` aliases the supported categories for writers and
pickers. `NON_RESULTS_CATALOG_CATEGORIES` derives the catalog complement.
`carriesResultIdentity` is an exclusion predicate, not category validation; use
the supported category vocabulary at input boundaries.

Quantitation is a separate property. Numeric values do not automatically earn
identity, and a missing number does not remove it:

| Example                                | Numeric? | Identity?                | Flat catalog?                             |
| -------------------------------------- | -------- | ------------------------ | ----------------------------------------- |
| LDL Cholesterol                        | Yes      | Yes                      | Yes                                       |
| Blood Pressure Systolic                | Yes      | Yes                      | No; it has a Trends metric home.          |
| A questionnaire item                   | Often    | No; it is an assessment. | No                                        |
| PHQ-9 total score                      | Yes      | Yes                      | No; it belongs in its instrument surface. |
| Urine dipstick or qualitative serology | No       | Yes                      | Yes when in a catalog category.           |
| Blood type                             | No       | Yes                      | No; it is a reference fact.               |

## Terms and owners

**`CanonicalResultDefinition`** is a registry definition of a reportable result
and its interpretation knowledge. It can describe a quantity, instrument score,
scan, genomic result, or qualitative reference fact. Units, ranges, contextual
range overrides, direction, retest cadence, and explanatory fields may be absent.
A definition is not a dated observation.

The current names are `canonical_result_definitions`,
`CanonicalResultDefinition`, and the `canonical-result-definitions` dataset.
Use [the shared types](../../lib/types/medical.ts),
[dataset accessor](../../lib/datasets/canonical-result-definitions.ts), and
[LOINC lookup](../../lib/canonical-result-loinc.ts). Do not maintain another
registry shape in documentation or introduce legacy namespace aliases.

**Clinical result** is the presentation umbrella for the mixed Results catalog,
its APIs, components, filters, and copy. Its rows include qualitative observations
as well as quantities, so a numeric-only `Reading` cannot represent the whole
catalog.

**`ClinicalObservation`** is a stored `medical_records` row. It carries the
reported value, range, flag, provenance, and document/encounter/provider links.
It may be numeric or qualitative and may belong to a category without identity.

**`Reading`** is a dated numeric quantity with canonical identity, spanning
`body_metrics`, `metric_samples`, and `medical_records`. Its `value` is a number;
qualitative observations stay outside that shape. Use the
[reading model](reading-model.md) for identity mapping, series folding,
interpretation, placement, and corrections. Its normalized `ReadingSource`
value `clinical` describes clinical provenance independently of physical storage;
it does not rename raw provider or import source strings.

**Assessment** is an observation deliberately excluded from result identity.
`NON_IDENTITY_CATEGORIES` contains `assessment`; `report` is not in that set.
Assessment rows remain visible with their document, but do not register canonical
names, enter `getUsedCanonicalNames`, contribute series points, or provide backing
readings for stars and retest-dismissal cleanup. Both name and code paths must
respect this exclusion. [Non-analyte recognition](../../lib/non-analyte-observations.ts)
owns recognition at import.

Questionnaire items remain assessments, including numeric item answers.
[Instrument recognition](../../lib/instrument-recognize.ts) and
[instrument import](../../lib/instrument-import.ts) can turn a complete,
recognized, correctly attributed set into an identity-bearing instrument score
and `instrument_responses`. Partial, unrecognized, wrong-subject, or ambiguous
multi-patient material must not acquire a score; refused imports retain their
assessment representation and report the refusal.

**Qualitative result** describes a reported value such as a blood group,
positive/negative serology, or dipstick trace. It is not another storage category
or an identity exclusion. [The qualitative classifier](../../lib/reference-range/qualitative.ts)
interprets supported result classes through `classifyQualitativeResult`,
`qualitativePresence`, and `screeningRisk`.

**Biomarker** and **analyte** remain appropriate for their narrower subjects.
Keep established owners such as `biomarkerFamily`, SQL's `biomarker_family`,
`getBiomarkerSeries`, `biomarker_panels`, and `biomarkerRetestStatus`. The broad
presentation term is Clinical results; terminology cleanup must not replace
precise domain names merely for uniformity.

## Catalog visibility and category review

The flat catalog admits `lab`, `vitals`, `genomics`, and `scan`. Within `vitals`,
[listedInResultsCatalog](../../lib/trend-metric-analytes.ts) excludes identities
with an existing Trends metric home and retains those without one. It uses the
canonical name when present, otherwise the printed name.

Apply category membership and the per-analyte predicate together.
`listedInResultsCatalog` alone returns true for non-vitals categories, including
instrument scores that category membership excludes. The Results row gather in
`app/(app)/results/clinical-result-index.ts` and panel reach in
`lib/biomarker-panel-reach.ts` compose both decisions. Exclusion from the catalog
does not withhold identity or a dedicated domain surface.

The category value `biomarker` is retired. Current writers and the schema accept
supported categories; unresolved legacy rows use `category = NULL` as an explicit
review state. Results lets the person choose a supported category while retaining
row identity, revisions, source links, saved identity, and related state.
Canonical registry evidence owns classification when recognized at import;
absence of evidence must not create another catch-all category.

[Persisted vocabulary](persisted-vocabulary.md) owns durable names and migration
compatibility. Historical migrations retain the names valid at their version;
current readers, writers, and portable exports use the resulting vocabulary.

## Qualitative flags and retest clocks

`qualitativeFlagResolution` returns a flag to replace it, `null` to clear it, or
`undefined` to preserve it. These outcomes are distinct. Its current rules are:

- A recognized bad-polarity result promotes an unflagged/normal row to
  `abnormal`; an existing specific flag is preserved.
- A recognized good durable-immunity result resolves to `immune`.
- Other classified neutral or good results can clear an out-of-range flag.
  An edit lock prevents this clear when `valueIndependent` says the verdict is
  about the analyte rather than the reported value.
- Without a classification, a no-result statement clears only when the whole
  value matches `statesNoResult`, the flag is out of range, notes assert no
  recognizable finding, and the row is not edit-locked. Otherwise it is preserved.

A pointer such as `See Note` is not the same as an ambiguous finding such as
`equivocal`. A pointer followed by a result must not be consumed as a non-answer.
No-result handling changes neither category nor canonical identity, catalog
eligibility, or retest eligibility.

The edit lock is row-wide. Editing a value can therefore preserve an existing
flag even if the person never touched the flag selector. It protects the
no-result clear and value-independent clear; it does not block value-dependent
reclassification or immunity/bad-polarity promotion. `immutable` answers a
different question: whether the retest clock applies. Do not use it as a proxy
for flag ownership.

`biomarkerRetestStatus` owns cadence and its category, immutable-value,
quality-control, and durable-immunity exemptions. Keep those decisions separate
from catalog visibility and flag correction. Numeric reconciliation has its own
flag vocabulary in `lib/queries/medical/flags.ts`; the
[reading model's flag contract](reading-model.md#flag-ownership-and-missing-context)
owns that behavior rather than a second list here.
