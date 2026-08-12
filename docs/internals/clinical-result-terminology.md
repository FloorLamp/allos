# Clinical-result terminology

Status: partial (#2479 part 1 shipped — the vocabulary, the type and predicate
renames; part 2, the persisted `"biomarker"` catch-all retirement, is still open)

One word, "biomarker", used to name four unrelated things: the canonical
definition registry, the identity a dated reading is keyed on, the flat catalog
at Medical → Results, and a legacy `medical_records.category` value that means
"nothing else fit". This file is the contract that separates them. Each term
below states what it covers, what it does **not** cover, and which axis it lives
on.

## The three axes

The defect this vocabulary exists to fix is that two of these were routinely read
as one. They are independent questions with independent mechanisms, and a row's
answer to one says nothing about its answer to another.

| axis                     | question                                                         | mechanism                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **storage category**     | which class of clinical thing is this row?                       | `MEDICAL_CATEGORIES` (11 values) and the `medical_records.category` CHECK                                                 |
| **catalog browsability** | may the flat Results catalog list it?                            | `RESULTS_CATALOG_CATEGORIES` (4) — and inside `vitals`, decided **per analyte** by `lib/trend-metric-analytes.ts` (#2365) |
| **identity**             | may it coin a canonical name, be a Coverage candidate, a series? | `NON_IDENTITY_CATEGORIES` and `carriesResultIdentity()`                                                                   |

**Quantitation — "does this report a number?" — is a property, not one of these
axes.** It is a real distinction (see `QualitativeResult` below), but nothing
selects on it, and using it as a stand-in for identity is exactly the error #2479
was opened with. In this codebase the two cross in both directions:

|                 | identity-bearing                                                                                                                                                                                | identity withheld                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **numeric**     | LDL Cholesterol, Grip Strength (`lab`, `vitals`)                                                                                                                                                | a screening questionnaire's ITEM answer — typically 0–3, stored `assessment` |
| **non-numeric** | urine dipstick (Protein / Glucose / Ketones / Bilirubin / Blood / Nitrite / Leukocyte Esterase, `lab`), serology (HBsAg, Anti-HCV, `lab`), ABO Blood Group / Rh Type / Blood Type (`reference`) | a functional-status finding, a temperature's body site (`assessment`)        |

Read the bottom-left cell before writing any rule of the form "if it has no
number then …": seven dipstick analytes, two serologies and the three blood-type
facts are registered, browsable-or-passport, fully identity-bearing entries that
report a word.

## The terms

### `CanonicalResultDefinition`

**Axis: none — it is the registry entry itself.** The row shape of the
`canonical_biomarkers` table and of the committed `lib/canonical-biomarkers.json`
that seeds it: a **definition of a reportable clinical result plus the knowledge
needed to interpret it** — `unit`, `ref_low/high` with sex, age-band, reproductive
status and cycle-phase overrides, `optimal_low/high`, `direction`, `retest_days`,
`panel`, `note`, `source`.

It does **not** cover: a stored reading (that is a `Reading` or a
`ClinicalObservation`), and it is not a claim that the entry is a laboratory
analyte or even a quantity — 68 of its 324 entries are not lab, 63 carry no unit
and 98 carry no reference range.

Named for the shipped user-facing noun: **Medical → Results** is already where
labs, imaging and genomics live. Alternatives were ruled out on evidence, not
taste — `CanonicalQuantity`/`CanonicalMeasure` (blood group is not a quantity),
`CanonicalAnalyte` (68 non-lab entries), `CanonicalReference` (`reference` is
already a category **value** inside the registry, held by those same three
blood-type entries — an umbrella cannot share a name with one of its members),
`CanonicalClinicalConcept` (says nothing about ranges or a retest clock, and
invites anything clinical to be filed there).

### `Reading`

**Axis: identity.** A dated numeric quantity keyed on the #482 canonical family,
spanning `body_metrics`, `metric_samples` and `medical_records`
(`lib/reading-model.ts`, `docs/internals/reading-model.md`). A question about a
QUANTITY, never about a table.

Does **not** cover a stored observation that reports no number — a `Reading` has a
`value: number` by construction.

### `ClinicalObservation`

**Axis: storage.** The stored `medical_records` row, quantities and
non-quantities alike, with its document / encounter / provider links, the lab's
own printed range, the flag and the provenance. Already the shipped word (47
files; `getClinicalObservations` in 31) and unchanged by #2479.

Does **not** imply identity: an `assessment` row is a `ClinicalObservation` too.

### `Assessment`

**Axis: identity.** A dated observation the app **deliberately denies biomarker
identity**: no `canonical_biomarkers` registration, absent from
`getUsedCanonicalNames`, never a Coverage candidate, never a series, no backing
reading for the ★ / retest de-orphan sweeps. Viewable on its own document, which
is the point — the observation is not hidden, only refused an identity.

The reason is #2318: identity runs on the CODE **and** on the NAME, and a guard on
one axis is not a guard. `functionalStatusExtractor` nulled the assessment LOINC
and the same rows coined canonical names anyway.

`NON_IDENTITY_CATEGORIES = ["assessment"]` is the mechanism; `carriesResultIdentity()`
is the predicate. The recognisers at the import door are
`lib/non-analyte-observations.ts`.

Does **not** mean "non-quantitative" — see the crossing table above. A
questionnaire item answer is numeric and is stored `assessment` precisely so it
cannot coin a name; a urine dipstick result is non-numeric and is fully
identity-bearing.

### `QualitativeResult`

**Axis: quantitation (a property, not a selector).** A property of a
`CanonicalResultDefinition`: a registered entry that reports a **value rather than
a number** — a blood group, a positive/negative serology, a dipstick trace, an ECG
interpretation, an audiologic diagnosis. Classified at read time by
`classifyQualitativeResult` (`lib/reference-range/qualitative.ts`) with
`qualitativePresence` / `screeningRisk` / `qualitativeFlagResolution`.

It sits on a **different axis from `Assessment`**, and the map says so explicitly
because conflating the two is the mistake #2479's body made. A `QualitativeResult`
is registered, browsable where its category allows, and carries full identity; an
`Assessment` carries none, whatever its shape.

### `Biomarker` / `Analyte`

**Retained only where clinically accurate.** #2479 is a de-conflation, not a purge:
`biomarkerFamily()` (the #482 identity function), `biomarker_family()` in SQL,
`biomarker_panels`, `biomarkerRetestStatus`, the lab-scoped trajectory grammar and
the user-facing **Results › Biomarkers** section all keep the word, because those
genuinely are about biomarkers. What was retired is the word standing in for
"clinical result of any kind".

`Analyte` already existed (47 files) and already meant what it should: the
substance or property being measured. Unchanged.

## The constants and predicates

| name                             | axis     | what it selects                                                             |
| -------------------------------- | -------- | --------------------------------------------------------------------------- |
| `MEDICAL_CATEGORIES`             | storage  | every legal `medical_records.category`                                      |
| `RESULTS_CATALOG_CATEGORIES`     | catalog  | `lab \| vitals \| genomics \| scan` — the classes the flat catalog may list |
| `NON_RESULTS_CATALOG_CATEGORIES` | catalog  | the **derived** complement; never hand-listed, so the two cannot drift      |
| `listedInResultsCatalog(row)`    | catalog  | the per-analyte `vitals` refinement (#2365) on top of the category answer   |
| `NON_IDENTITY_CATEGORIES`        | identity | the classes denied a canonical name, Coverage candidacy and a series        |
| `carriesResultIdentity(cat)`     | identity | its predicate — pure; SQL reads the array directly                          |

Category membership does **not** settle catalog browsability on its own: within
`vitals`, `listedInResultsCatalog` drops an analyte whose quantity already owns a
`/trends/metric/<slug>` home, and keeps the ones that would otherwise be stranded
(audiogram thresholds, intraocular pressure, visual acuity, periodontal depth).

## Not renamed, on purpose

- **`canonical_biomarkers`, the table**, and the accessors that name it —
  `seedCanonicalBiomarkers`, `getCanonicalBiomarker`, `canonicalBiomarkerForName`,
  `CANONICAL_BIOMARKERS`, `CanonicalBiomarkerEntry`, the `canonical-biomarkers`
  dataset id and the committed JSON. Part 1 ships **no persisted change**; a
  function named for the table it reads is honest, and renaming it away from that
  table would make the code say less, not more.
- **`biomarkerFamily`, `getBiomarkerSeries`, `biomarker_panels`, `biomarkerRetestStatus`**
  and the rest of the genuinely-biomarker surface (see above).
- **`ClinicalObservation` and `Analyte`** — already correct, already shipped.

## Still open (#2479)

Part 2 is the persisted catch-all retirement, behind a forward migration, and is
deliberately untouched here:

- the legacy `medical_records.category = "biomarker"` rows — the pre-#1076
  catch-all, now emptied of real labs but still a legal category value;
- the extraction prompt's "use `biomarker` when nothing else fits";
- VO₂ Max being written as category `biomarker` by several integrations and
  fitness paths.

Also proposed by the issue and not settled by either part: `ReadingSource = "lab"`
standing in for broadly clinical document provenance (`lib/reading-model.ts`).
