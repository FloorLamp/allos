# Clinical-result terminology

Status: shipped (#2479 part 1 — the vocabulary and the type and predicate renames;
part 2 — the persisted `"biomarker"` catch-all retirement, migration 185)

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

Nor does it mean "nothing more can be understood here". A questionnaire item is
`assessment` because it is not an analyte, but a whole SET of them may be a
recognisable screening **instrument**, and that has an identity of its own — the
curated instrument score (`instrument` category, canonical `PHQ-9` / `GAD-7` /
`EPDS`), banded and crisis-aware. `lib/instrument-recognize.ts` asks that question
at the import door and `lib/instrument-import.ts` folds a recognised set into one
score row plus `instrument_responses` (#2321). A set that is not recognised — or is
recognised but attributed to another subject, or unattributable in a document naming
more than one patient (#2558), or only partly answered — stays as `assessment` rows
and is refused a score, with a reported drop. Identity is granted to the SCORE, never
to a question.

### `QualitativeResult`

**Axis: quantitation (a property, not a selector).** A property of a
`CanonicalResultDefinition`: a registered entry that reports a **value rather than
a number** — a blood group, a positive/negative serology, a dipstick trace, an ECG
interpretation, an audiologic diagnosis. Classified at read time by
`classifyQualitativeResult` (`lib/reference-range/qualitative.ts`) with
`qualitativePresence` / `screeningRisk` / `qualitativeFlagResolution`.

A value that **states no result** — `See Note`, `SEE COMMENT`, `QNS`, `Cancelled` —
is a fourth thing again, and it moves a row on **none** of the three axes. The
analyte is real, so the row keeps its storage category, its catalog place, its
canonical name, its series, its Coverage candidacy and its retest clock (a test that
produced no answer is if anything more worth redrawing). What it cannot carry is a
**flag**: a flag is a verdict about a value, and there is no value — only a pointer
to the narrative the document files the finding in. `statesNoResult`
(`lib/reference-range/qualitative.ts`) is the vocabulary and
`qualitativeFlagResolution` is its one consumer, which **clears** an out-of-range
flag there instead of preserving it (#2687). It is deliberately narrower than the
neighbouring `SCREEN_INDETERMINATE`: `indeterminate` / `inconclusive` / `equivocal` /
`borderline` are ambiguous **findings**, and overriding a finding is what #549
forbids. Being non-quantitative is not what withholds identity here either — see the
crossing table above.

Four conditions gate that clear, and each one exists because dropping it deletes a
real verdict (#2712). The **value** must be consumed WHOLE by the non-answer
vocabulary — matching a `see` prefix plus a target word anywhere let `See note:
POSITIVE` count as stating no result, and the extractor is instructed to copy the
document's own H/L marker, so the flag beside a printed result is the lab's. The
**flag** must be out of range: this is one transition, never a promotion. The
**notes** must assert nothing recognizable — `classifyQualitativeResult` reads notes
only inside its recognized classes, so an unrecognized analyte's narrative was being
discarded by the very clear that claims to follow the pointer. And the **row** must
not be edit-locked (`isEditLocked`, #133): `updateResult` writes the user's chosen
flag and `edited = 1` and then reconciles on the next line, so without the lock the
save deletes the flag it just stored. The lock gates this clear only; the older
#544/#548 transitions are unchanged.

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
| `RETIRED_MEDICAL_CATEGORIES`     | time     | the values nothing may be FILED under any more (see part 2 below)           |
| `ASSIGNABLE_MEDICAL_CATEGORIES`  | time     | the **derived** complement — what a write may pick                          |

Category membership does **not** settle catalog browsability on its own: within
`vitals`, `listedInResultsCatalog` drops an analyte whose quantity already owns a
`/trends/metric/<slug>` home, and keeps the ones that would otherwise be stranded
(audiogram thresholds, intraocular pressure, visual acuity, periodontal depth).
Browsability is the **conjunction** of the two — the category class, then the
per-analyte refinement — which is how both the row gather
(`app/(app)/results/reading-index.ts`) and the panel facet
(`lib/biomarker-panel-reach.ts`) compose it. Asked alone, the predicate answers
`true` for a PHQ-9: it refines `vitals` and says nothing about a category the
catalog already excludes.

`lib/__tests__/clinical-result-terminology.test.ts` is this file's ratchet, over
the real registry and the real predicates, one representative concept per class.

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

## The retired catch-all (part 2)

`biomarker` was never a class of clinical thing. It is the pre-#1076 bucket, and it
meant **"this is a result and nothing narrower was picked"** — which is why the flat
catalog excludes it (nothing browsable can be defined by the absence of a decision),
why the retest clock reached it only by falling through the `biomarkerRetestStatus`
exemptions, and why several SQL sites still read it as a synonym for `lab`.

It is now a **fourth question** this vocabulary answers, and the only one about TIME
rather than about a row:

| name                            | question                                       |
| ------------------------------- | ---------------------------------------------- |
| `RETIRED_MEDICAL_CATEGORIES`    | may anything still be FILED under this?        |
| `ASSIGNABLE_MEDICAL_CATEGORIES` | the derived complement — what a write may pick |

The retirement is deliberately **one-sided**. Reading, filtering and storing the value
all stay legal, and `MEDICAL_CATEGORIES` still lists it; what no longer exists is a way
to CREATE one.

### The rows: migration 185

`reclassifyLegacyBiomarkerCategory` (`lib/legacy-category-reclass-db.ts`) re-files each
legacy row using the canonical registry's own `category`, matched on the row's identity
— its `canonical_name`, else the printed `name` — by exact NOCASE name against
`canonical_biomarkers`.

That is **not a new policy**. It is the rule the AI ingest path has followed since
#1076 (`lib/medical-extract/normalize.ts`: "the canonical dataset owns the
classification … its category WINS over the model's guess"), applied retroactively to
the rows that predate it, and it generalises migration 090's hand-list of seven names
to the whole registry so the answer cannot drift from the vocabulary.

Three properties make the pass small:

- **Nothing is deleted and no id moves.** It is a single-column UPDATE, so the #2444
  child-link hazard cannot arise — `care_plan_items.source_medical_record_id`,
  `care_plan_items.resolved_by_medical_record_id` and `intake_items.source_record_id`
  all keep pointing at the same rows. There is deliberately **no** `CHILD_LINKS`
  registry in migration 185: a probe guarding a delete that cannot happen is exactly
  the guard-that-covers-nothing #2444 is about.
- **Identity is never removed.** Every target in `RECLASS_TARGET_CATEGORIES` carries
  result identity, so a moved row keeps its registration, its place in
  `getUsedCanonicalNames`, its ★, its dismissals, its coverage entry and its series —
  and there is no side-state sweep to get right, unlike #2318's pass. `assessment` is
  excluded from the targets for precisely that reason.
- **Unclassifiable is a real answer.** A row whose identity the registry does not
  recognise, or whose entry states no category (an ai-coined vocabulary row states
  none), stays exactly where it is and is counted in the pass's `residue`. Nothing is
  guessed, so the `medical_records` CHECK keeps admitting the value — a rebuild that
  dropped it would only be honest if the pass were total, and it is not meant to be.

What the move changes on purpose: the rows the registry calls `lab` / `vitals` /
`genomics` / `scan` **enter the flat Results catalog**, which the bucket had been
hiding them from; and a row re-filed as `vitals` / `instrument` / `derived` /
`reference` stops carrying a lab retest clock it never earned. Nothing else — value,
flag, name, canonical name, document link and provenance are untouched.

### The writers

A migration that moves rows without fixing the writers leaves the bucket refilling
itself, so the same change closes every path:

| path                                                     | closure                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| the extraction prompt's "only if nothing else fits"      | clause deleted; an explicit no-catch-all rule replaces it      |
| the extractor's tool enum and accept-list                | `ASSIGNABLE_MEDICAL_CATEGORIES`                                |
| VO₂ Max from Health Connect, Withings, the fitness check | `vitals` — the registry's own category for it                  |
| `NormVital.category`, `FitnessStore`'s vital arm         | the string is **out of the type**: a writer no longer compiles |
| the manual category picker (`ResultForm`)                | offers the assignable set, plus the row's own retired value    |
| `scripts/seed.ts`                                        | its three legacy analytes file as `lab`                        |

The picker's exception matters: a residue row must keep its category through an
unrelated edit, so the form unions in whatever the row already carries rather than
silently re-filing it onto the first option.

`lib/__tests__/retired-medical-category.test.ts` is the ratchet — a source scan for a
category ASSIGNMENT of a retired value (reads and filters are deliberately not matched)
plus the prompt and enum assertions. `lib/__db_tests__/migration-185-legacy-biomarker-category.test.ts`
covers the pass.

## Still open (#2479)

Proposed by the issue and settled by neither part: `ReadingSource = "lab"` standing in
for broadly clinical document provenance (`lib/reading-model.ts`).

Deliberately NOT renamed by part 2, on the owner's ruling that `Biomarker` and
`Analyte` are retained where clinically accurate: `biomarkerFamily()` and
`getBiomarkerSeries()` are the #482 biomarker identity function and the series drawn
over it. The `Reading` model delegating to them is the word being used correctly, not a
misdescription — renaming them for uniformity would make the code say less.
