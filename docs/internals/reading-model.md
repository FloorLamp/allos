# The reading model

Status: partial (phases 1 and 2 shipped — one read model and one write core over
the existing three stores; the physical merge is a separate, later decision)

The app stores dated numeric readings in three places, and before #1997 every
consumer knew which one it was reading:

| store             | shape                                              | what it carries                                                                              |
| ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `body_metrics`    | WIDE — one row per day, up to three measures on it | value, day, `source`, the #133 edit lock, shared notes, a stated `occurred_at` (#2235)       |
| `metric_samples`  | TALL — `metric`/`value`, one row per sample        | value, day, an absolute start/end instant, `source`, the edit lock                           |
| `medical_records` | OBSERVATIONS — one row per reported result         | value, day, canonical name, the lab's own range, flag, document / encounter / provider links |

That coupling is the root of a family of bugs, not a background detail: two
"7-day averages" with different semantics (#1909), vitals rendered by the lab
renderer (#1932), three editability contracts (#1933/#1934), clinical knowledge
stranded in one store while the readings it should judge stream into another
(#1996), side-state keyed differently per store (#1931). A surface that names a
TABLE cannot ask a question about a QUANTITY.

## Phase 1 (shipped): one identity-keyed `Reading`

`lib/reading-model.ts` is the pure shape and mapping; `lib/queries/readings.ts`
presents the existing rows in it. **No schema change, no migration, no write
path** — every store keeps its own writers and every store-specific reader keeps
working unchanged.

```ts
interface Reading {
  identity: string; // the #482 canonical family — how knowledge resolves
  value: number;
  unit: string;
  date: string; // profile-local day
  measuredAt: string | null; // the instant, where the row records one:
  // metric_samples.start_time, or the stated occurred_at on body_metrics
  // (#2235) and medical_records (#2154). Null = day-grain, in every store.
  source: "wearable" | "manual" | "import" | "lab";
  store: ReadingStore; // the physical row a surface can still reach
  rowId: number;
  sourceKey: string | null; // the row's raw `source` column
  edited: boolean;
  notes: string | null;
  provenance?: ReadingProvenance; // observation-only, ABSENT on a stream row
}
```

Four rules the shape encodes:

- **Identity, not table.** `readingIdentity()` is `biomarkerFamily()` (#482) —
  the same function the dedup partition, the `is_latest` marker, the star store
  and SQL's `biomarker_family()` already key on. A `medical_records` "Resting
  Heart Rate" and a `body_metrics.resting_hr` row therefore resolve to the SAME
  identity, which is what lets clinical knowledge filed under a canonical NAME
  reach a reading that streams into a different table.
- **`source` is provenance, not membership.** The Health Connect parser writes
  SpO2 into `medical_records` and resting HR into `body_metrics`, so "which
  table" says nothing about where a reading came from. `readingSourceFor()`
  classifies from the row's own links and source stamp: clinical links (document
  / encounter / provider) → `lab`, a `document:<id>` stamp → `import`, an
  integration id → `wearable`, otherwise `manual`.
- **Provenance is ABSENT, not empty, on a stream reading.** A wearable reading
  has no document, no encounter, no reporting lab and no lab-stated range.
  Giving it empty ones is exactly the apparatus #1996 argues a stream must never
  grow.
- **The grain boundary is explicit.** The model covers dated readings **above
  minute grain**. `hr_minutes` is outside it — already excluded from provenance
  for volume reasons, and a per-minute stream is not what a judgement, a period
  average or a readings table is asking about.

### The stream ↔ canonical map — one declaration, two derived halves

`STREAM_READING_SOURCES` is the missing half of the identity map: which stream
store column/metric measures which canonical biomarker name.
`CONTINUOUS_READING_METRIC` (`lib/reading-cadence.ts`) is the other half
(canonical name → metric slug). Same exclusion discipline as the family table:
only a stream key that measures the SAME quantity as a curated canonical entry is
registered. Weight, height, HRV, steps and the rest are absent because the
canonical vocabulary has no entry for them, and an invented mapping would grant a
reading a band nobody curated.

Since **#2086** both halves are **derived** from one declaration,
`READING_IDENTITY_MAP` in `lib/reading-identity-map.ts`: each entry names a
canonical quantity, the metric surface that renders it (or `null` — episodic, so
the reading detail page owns it), and the stream store its rows land in (or
`null` — observations only). They were two literals in two files, consistency-
tested but separately edited, and a half-added entry is a live defect: a name
routed to a metric surface with no stream registered folds no observations in,
and a stream with no surface answer renders its clinical readings on the wrong
page. `lib/__tests__/reading-identity-map.test.ts` pins the fold in both
directions, and that an entry answering neither question cannot exist. The two
constants keep their existing homes as re-exports, so no call site moved.

### Series assembly

`getReadingSeries(profileId, identity)` returns observations and streams
together, oldest first. It does not re-implement the observation read: it
delegates to `getBiomarkerSeries`, which already resolves the family identity and
applies the cross-source de-dup CTE, so a folded series is the one the biomarker
surfaces read rather than a parallel realization of it. The two halves run inside
`readTx` so they describe one snapshot.

`dedupeReadings()` collapses one physical measurement presented twice — the same
reading recorded in two stores, or a re-push beside its own earlier row. Its
group is **(identity, date, normalized `ReadingSource`, value)**, sharpened by
the instant **only where both sides state one** (#2154): two same-value readings
with different stated instants are two real readings (the fever curve's
same-value case), while an instant-less reading claims nothing about when and
still collapses into its group — the #2005 collapse the instant must not undo.

- **The source in the key is the NORMALIZED one** (#2005), never the row's raw
  `source` column. The stores spell one provenance two ways — a hand-entered
  `body_metrics` row carries `source = NULL`, a hand-entered `medical_records` row
  carries the literal `'manual'` — and `readingSourceFor()` already calls those
  the same thing. Keying on the raw column made two readings out of one, a
  double-count that would have shipped with the first phase-2 caller.
- **The value is in the key deliberately.** A same-day fever curve is several
  genuinely different readings from one source on one date (#800/#843), and a
  (date, source) key alone would silently drop all but one.
- **Two devices agreeing on a day therefore collapse**, because both classify as
  `wearable`. That is the right answer for a series — charting one day's 52 bpm
  twice skews every average drawn over it — and "which device said what" is a
  different question with its own reader (`getStreamReadings`, the
  source-comparison surfaces).

The representative is the reading carrying the most — provenance first, then a
stated instant — so a fold never costs a document link, and never costs a stated
time to an untimed twin.

`streamSourcesForIdentity()` **resolves its argument** through `readingIdentity`
rather than comparing it raw, so a canonical name and its identity answer the
same. `biomarkerFamily` is idempotent, so this is free — and the asymmetry it
removes matters: the observation half already normalizes (`getBiomarkerSeries`
families its argument), so the day one of these canonical names joins a #482
family, a caller passing the NAME would have been handed every observation and not
one stream row, with nothing to notice.

## One judgement per identity (#1996) — the model's first consumer

Clinical knowledge (reference range, optimal band, direction, age bands) is filed
in the canonical vocabulary by biomarker NAME. The metric detail surface is keyed
by `BodyMetricSlug`. Nothing mapped one to the other, so a streamed reading was
charted **unjudged** — a toddler's steady 120 bpm resting heart rate measured
against nothing, while the band that says it is normal (1–3 → 80–150) already
existed. That is an identity problem, not a storage one: a merged table would
still be keyed by metric and still need this lookup.

`lib/metric-judgment.ts` answers it:

- `METRIC_KNOWLEDGE` — **every** `BodyMetricSlug` declares which knowledge system
  answers for it: a `canonical` entry, a `growth-percentile` (a percentile-for-age
  is not a band; the growth card owns it), or `none` **with a reason** — where the
  reason is load-bearing, not filler. `waist-circ` (#2322) is the sharpest example:
  real published cut-offs exist, and they are branched by sex **and by population**,
  while the vocabulary has a sex axis and no population axis — so the honest answer
  is `none`, argued, rather than a European band silently applied to everyone. The
  completeness test over that registry is what turns "audit whether another metric
  has this shape" into a build failure — the sweep that would have caught body fat
  before #1996 was written.
- `metricJudgment(identity, subject, entries?)` — the bands for a subject, plus the
  verdict for a reading. It resolves them through the same
  `referenceRange`/`optimalBand`/`rangeBadge` the flag reconcile uses, so a page's
  band can never disagree with the flag stored on a row of the same reading.
- `lib/queries/metric-judgment.ts` — the runtime half: the seeded
  `canonical_biomarkers` row as the vocabulary, and the subject's age **on the
  reading's date** (the #150 precedent), never today's.

### The domain is judged quantities, not one enum (#2086)

`METRIC_KNOWLEDGE`'s totality is the strongest idea in the #1996 fix, and its
weakness was its domain: `Record<BodyMetricSlug, …>` — one enum. A judged
quantity with no metric slug escaped the discipline entirely, and the recorded
escapee proves it: **VO₂ max** has a curated canonical entry _and_ age/sex
fitness norms (#158), with nothing in the build able to notice whether either
reached its readings.

`QUANTITY_KNOWLEDGE` + `quantityKnowledge(identity)` widen the domain to judged
quantities keyed by **#482 identity**, and `MetricKnowledge` gains a
`fitness-norms` source (an age/sex percentile is no more a band than a growth
percentile is). The **membership boundary** is written down beside the
declaration: this is not a second copy of the canonical vocabulary — an ordinary
lab analyte is judged by its own canonical row on the surface that reads that
row, so nothing can go missing. A quantity needs a declaration exactly when its
readings and its knowledge are reached through **different keys**: metric slugs
(readings by slug, knowledge by canonical name — #1996) and the
functional-fitness markers (readings by canonical name, knowledge in a separate
norms dataset — #2086).

**The teeth** (`lib/__tests__/judged-quantities.test.ts`): the domain is derived
from `BODY_METRIC_SLUGS`, `FITNESS_NORM_MARKERS` and `READING_IDENTITY_MAP`, so a
marker added to the norms dataset without a declaration fails the build; a
declaration naming a marker or canonical entry that does not exist fails too, so
widening the **guard** can never widen the **vocabulary**. VO₂ max is the
acceptance case: it declares `fitness-norms`, the surface it names is the one
`readingDetailHref` actually routes its readings to, and the norms resolve to a
real percentile for a real subject.

Its renderer stays the reading detail page, on purpose. The #1932 cadence audit
classifies VO₂ max as **episodic** — an annual-at-best physical test read against
its population curve — so it earns a declaration and reach from the Fitness
check, not a daily-trend surface. What was missing was discoverability: the value
is measured in the Fitness check, and the surface that interprets it was
reachable only by knowing to search the biomarkers list. The check's entry panel
now links a measured clinical test to it through `readingDetailHref`.

Two consequences on `/trends/metric/[kind]`:

- the band renders (`MetricJudgmentCard`), suppressed when the pediatric BP card is
  showing — that IS the judgement for a child's blood pressure, and a second answer
  beside it would be a wrong one — and when there is no reading to judge;
- the series folds in same-identity observations
  (`getMetricObservations` + `foldObservationPoints`), so a clinic-measured reading
  joins the trend it belongs to. Folded readings are **marked** — and, since phase
  2, editable in place — and the fold is empty for a metric whose readings already
  ARE observations, which would otherwise list each one twice.

**The fold decides once (#2029).** `foldObservations` is that decision: the
observation side is collapsed by `dedupeReadings`, then anything the stream's
day/value coverage already answers for is dropped. `foldObservationPoints` is its
chart projection, and `bodyMetricSeriesFold` returns both halves together — the
points to plot and the observations that survived — so `/trends/metric/[kind]`
takes its chart and its readings table from ONE call. It used to read the raw
observations for the table, which meant a clinic value equal to the wearable's
plotted once and listed twice: the same surface contradicting itself one scroll
apart. The coverage test is deliberately source-BLIND, and that is the one place
`dedupeReadings`' key cannot be applied verbatim — a stream series point is a daily
fold of that day's rows, so it has no single provenance to compare.

### The results ROW asks it too (#2315)

The lookup shipped, the metric card rendered it, the biomarker chart drew it — and
the primary results list, the surface most readings are actually read on, never
asked. Its "Reference" cell printed `medical_records.reference_range`, the free-text
string the lab document stated, beside a flag `reconciledFlag` derived from the
**canonical** reference range and then the **canonical** optimal band. The printed
string reaches that function exactly once, as an input to the #761 unit-mislabel
detector: it is provenance, not a threshold. So the row showed the one range that
never judges it and hid both that do — measured at 35 of 333 readings (10.5%) on a
real profile visibly contradicting their own row, including a red "High" on a value
sitting comfortably inside the printed range. The `non-optimal` class contradicts by
construction, since it exists precisely to mark a value inside the reference and
outside the optimal band.

The cell is now a **judgment cell**, and nothing about it is a second derivation:

- `judgeRecords(profileId, rows)` (`lib/queries/metric-judgment.ts`) resolves one
  `MetricJudgment` per row through `flagReconcileProfileContext` — the same
  canonical map, the same alias-aware name resolver and the same subject context
  (sex, birthdate/stored age, reproductive status, cycle log) `reconcileFlags`
  derived the stored flag with. Age is taken **on the collection date** (#150) and
  cycle phase on that date (#718), both per row.
- `referenceCell()` (`lib/reading-reference-cell.ts`) is the pure spelling:
  `ref ≤ 90 · optimal ≤ 60`, both bands when both exist because which one you
  crossed is exactly what the amber/red split means, with the **age band named**
  when one applied (`ref 140–420 · age 1–10`) — the #150 safety half, and the
  reason the cell cannot be a bare number pair.
- No canonical entry → the printed string genuinely IS the deciding range, so it
  shows as before, relabelled **Lab reference**. Either way the lab's own string
  survives: as the cell's hover title, and in full on the reading detail page under
  its own "Lab reference" column.
- `formatBand()` (`lib/band-format.ts`) is the one band formatter, promoted out of
  `MetricJudgmentCard` (#221). It rounds to four decimals rather than two — Urine
  Specific Gravity is curated 1.001–1.035, and two places print "1–1.04".

The stored `flag` column is **unchanged** and no reprocess is triggered: every flag
was already correct. The printed range is **not** reconciled against the canonical
one either — #761's unit-mislabel detector stays the only place the two are
compared, for the one case where the comparison means something.

The severity **word** ships with it, because each half is insufficient alone: a band
with no word leaves the reader inferring which band the amber refers to, and a word
with no band is a judgment with no visible basis. `MedicalValue` gains
`showFlagLabel`, which renders `flagLabel` visibly **instead of** the `sr-only` span
(never both — the severity is announced once), decided by
`medicalValueFlagText`/`medicalValueCaret` in `lib/medical-value.ts`. The biomarkers
table and `/biomarkers/view`'s readings table adopt it, and `RecentLabsWidget`
migrates onto it and drops the parallel label #1220 built beside the component. The
other `MedicalValue` call sites — Timeline, Passport, ExtractedRecords,
BiomarkerScale, the Longevity section, the import preview — keep the `sr-only` label
until each is considered against its own density; without the prop the behavior is
byte-identical.

### And the DETAIL page must be able to point at what it coloured (#2340)

#2315 fixed the list. The detail page (`/biomarkers/view`) had the mirror-image
defect: it coloured its latest value from `latest.flag` while building its range
display — `referenceEntries` / `optimalEntries` — **exclusively from the curated
entry**. When the catalog carries no band those lists are empty and no range renders
at all, while the range the flag came from sits on the row, in
`medical_records.reference_range`, unread by that surface. An alarming value with no
basis for the alarm, and worst precisely where it is most likely: an analyte the
catalog **deliberately** declines to band is exactly when the curated list is
guaranteed empty and the lab's own range is present.

`biomarkerValueBasis()` (`lib/biomarker-value-basis.ts`) is the decision, and it
returns both halves at once — what to render as the basis, and the flag the value is
allowed to carry — so a caller cannot take one without the other:

- **curated** — the app's own band is on screen. Unchanged.
- **reported** — no curated band, but the row carries the source's printed range.
  It renders, **attributed**: `Reference range (as reported)`. The attribution is
  load-bearing. Two readings of one such analyte in a single database can carry
  DIFFERENT source ranges — labs band leptin by sex and body composition — which is
  precisely why the catalog publishes none, and means the source's range is the only
  range that ever applied to that draw.
- **qualitative** — the reading states its own verdict in words ("Detected",
  "Reactive"), and that word IS the value on screen. A positive infection screen is
  flagged `abnormal` by `qualitativeFlagResolution` against the classifier, never
  against a range; its basis is displayable and displayed. The page supplies this
  from the SAME `classifyQualitativeResult` the flag came from.
- **none** — nothing displayable. The value renders **neutral**.

The suppression happens at the **flag**, not at the colour, and that is what makes it
compose with #2315's `showFlagLabel`: handing that mode a basis-less flag would have
replaced an unexplained red with an unexplained red PLUS the word "Low". One decision
covers the colour, the caret and the word. It only suppresses a flag whose
`flagTone` is `bad` or `warn` — `immune` renders its own emerald status and makes no
claim the page must support, so deleting its label would remove an honest one.
Nothing about the stored `flag` column changes; this is what the page CLAIMS.

The same call runs per row of the readings table, whose neighbouring "Lab reference"
column is where a `reported` row's basis is already displayed.

**And the page states each fact once.** The subtitle used to append the curated
`note` beside the reading count while the explainer card fifteen lines below rendered
the curated `description`; for at least one analyte those are near-paraphrases. The
card keeps the description. The note's one distinct clause — _why_ this analyte has
no band — is extracted by `bandNoteClause()` and rendered in the summary card, beside
the value and the absent range, which is where a reader asks the question it answers.
It selects clauses that negate a band/range/cutoff or state a band table in place of
one, deliberately not a bare `/band/`: "Immature (band) neutrophils" is a cell type,
and matching it would re-import the description the change exists to stop
duplicating.

### A care offer on a basis-less reading names its own basis (#2347)

#2340 stopped the page CLAIMING a severity it cannot show. It left two controls on
that page still reading the stored flag: `canTrackFollowUp` (`isOutOfRange(latest.flag)`)
offers a **Recheck** whose whole premise is that the reading is out of range, and the
staleness notice sits beside it. So the same reading rendered neutral _and_ carried an
affordance that exists only because something called it abnormal.

**The owner ruled: keep the control, name its basis** — not gate it on the basis, and
not leave it untouched. The stored flag is real. With no curated band `reconciledFlag`
returns `undefined` (at `valueNum == null || !cb`, and again on a `ref === "unknown"`
range), so it never overwrote what the import stored: the flag on a basis-less reading
is the **source record's own**. The app being unable to _display_ a basis is not the
same as there being none, and gating would make a reading the lab itself flagged
un-recheckable on the strength of a display rule. The contradiction is resolved by
making the control honest — the same direction #2340 took.

`careOfferBasis()` (`lib/biomarker-care-basis.ts`) is that decision, pure, for both
controls at once. It answers where an offer's premise comes from — `displayed`,
`source-flag`, `unflagged`, `reading-age` — and returns the sentence the surface must
render, so no surface composes its own.

- **Recheck.** On a `none` basis with an out-of-range flag, under the heading _"Why a
  recheck is offered."_: _"The record this reading came from flagged it. No range on
  this page judged the value, so it renders neutral — this offer follows the record's
  flag, not a judgment of ours."_ It
  attributes the flag rather than re-speaking it, names no direction, and describes an
  ordinary state rather than a fault. On every other basis the judgment is already on
  screen and the note is silent. It renders only for the OFFER: an existing follow-up
  stands on somebody having tracked one, which is its own premise.
- **Staleness — the same discipline, a different sentence.** `isBiomarkerStale` never
  DERIVES staleness from the flag. The flag reaches it only through `ImmunityResult`,
  where every use is an **exemption** (durable-immunity positive, immutable attribute,
  QC metric) — it can only make a reading _less_ stale. Suppressing it there would
  remove an exemption and nudge someone the app had decided to leave alone, which is
  the contact INCREASE `docs/internals/findings.md`'s contact-consent rule forbids.
  Those exempting signals are unreachable from a basis-less reading anyway: `immune`
  is neutral-toned, so #2340's suppression (colouring flags only) never touches it,
  and an immutable/QC verdict comes from `classifyQualitativeResult`, which _is_ the
  `qualitative` basis. So the notice keeps its claim — it always printed its own
  premise inline (the date, the age, the yearly cadence) — and gains the one thing
  #2340 made newly confusing: on a page that deliberately declines to judge the
  number, an amber banner beside it reads like a verdict on the VALUE. Hence _"This
  notice is about the reading's age — it is not a judgment of the value above."_,
  rendered only where that is the case.

**No reach changed.** Both gates decide exactly what they decided before; nothing here
is read by a notification, a finding builder or an Upcoming generator. Annotating an
offer that already renders is the attention doctrine's "enrich what it was already
saying" case, and a note that appears only where the page has already declined to
judge cannot widen anything.

The **list** surfaces (`BiomarkersTable`, `StarredBiomarkers`) have no counterpart to
this, for a reason worth writing down rather than re-deriving: `TrackLabFollowUpControl`
renders on the detail page ONLY, so no list row carries a recheck offer, and their
`isBiomarkerStale` calls are the retest clock in its ordinary form (the table passes no
immunity context at all; the starred tile passes one, whose flag can only ever exempt).
More to the point, those surfaces do not apply `biomarkerValueBasis` — they still colour
from the stored flag, which is #2340's deliberately detail-page-only scope. There is no
contradiction to annotate there because there is no silence to inherit: a list row that
colours a value and a control premised on that colour agree. If #2340's rule is ever
extended to the list surfaces, this note becomes due at the same time — but widening it
now would annotate a page that is not yet neutral.

### An unqualified glucose has no band to be judged against (#2337)

Both curated glucose entries used to hold a **fasting** band: `Glucose, Fasting` at
70–99 (correct — the ADA normal fasting range, with 100–125 prediabetes and ≥126
diabetes on repeat), and unqualified `Glucose` at 65–99, which is _also_ a fasting
interval — the familiar lab-printed CMP one, and CMP glucose is reported in a
fasting frame. So the catalog had **no band for a glucose whose fasting state is
unknown**, which is exactly what an unqualified reading is, and it judged one anyway.

Re-banding it fails in both directions. Kept fasting, a post-meal 120 is entirely
normal and reads high on a healthy person. Re-banded random (`< 140`), a genuine
fasting 130 is prediabetic and reads normal — the missed finding, which is the worse
error. There is no interval to copy even if we picked: for random glucose the ADA
publishes diagnostic **thresholds** (≥200 with classic symptoms), not a reference
interval, and the widely-quoted 80–140 is a rule of thumb. So the unqualified entry
is **band-less**, with the reason stated in its curated `note` — the second consumer
of the clause `bandNoteClause()` extracts, and written to be read by a person:

> Whether this draw was fasting is not recorded, and the fasting and non-fasting
> bands differ by roughly 40 mg/dL at the top of normal. The value is shown but not
> flagged, because either band would be a guess.

`Glucose, Fasting` keeps 70–99, and 70 — the clinical hypoglycemia threshold, not the
65 lab-interval artifact — is now the only fasting floor the dataset carries.

Two consequences, both deliberate. A reading under `Glucose` **loses its flag**: that
flag asserted a fasting frame the document never claimed. And because
`reconciledFlag` will not clear a stored high/low for an analyte with no reference
bounds — right for the ~90 analytes the catalog has always declined to band, where
such a flag came from the document — migration 176 clears the ones already on disk,
scoped to numeric `Glucose` rows and to the flags `reconcileFlags` itself writes. The
row keeps its value and the source's own printed `reference_range`, which the detail
page still renders **attributed**; what goes is only allos's claim about it.

This is a dataset change, so no `FLAG_LOGIC_VERSION` bump: `canonicalFlagsSignature`
hashes `ref_*`/`optimal_*`, so the boot reconcile re-derives every record on its own
(the version constant exists for a change to the derivation LOGIC while the dataset
holds still).

## Phase 2 (shipped): one write core, one editability contract

`lib/reading-placement.ts` is the pure policy; `lib/reading-writes.ts` executes
it. **Still no schema change** — this is placement over the same three stores,
and `medical_records` remains the clinical record.

### The placement rule

`placeReading({ name, provenance })` — four clauses, in order:

1. **No identity, no placement.** Refused, never defaulted into a table. Sleep
   minutes, steps, HRV and per-minute heart rate all arrive here, and each keeps
   its own writer: inventing a mapping is exactly what the #482 exclusion
   discipline forbids, and the grain boundary holds on the write side too.
2. **Clinical provenance forces the observation store.** A document, an
   encounter, a performing provider, the lab's own stated range or the name a lab
   printed has nowhere to live in a stream store, so routing such a reading there
   would DESTROY the provenance — the one placement error a later correction
   cannot undo. This is the only clause that overrides a registered stream.
3. **Otherwise the identity's registered stream** (`STREAM_READING_SOURCES`):
   resting heart rate → `body_metrics.resting_hr`, body fat →
   `body_metrics.body_fat_pct`. One quantity in one place, whichever surface
   submitted it.
4. **Otherwise `medical_records`** under the identity's canonical name — the
   default: every lab analyte, and the four vitals whose readings already ARE
   observations.

The rule is pinned as a decision table over every registered identity
(`lib/__tests__/reading-placement.test.ts`) and cross-checked in the DB tier
against `METRIC_READING_STORE`, the registry the write path used to resolve a
store from. That cross-check is the "nothing moved" proof: a writer migrated onto
the core writes the row it wrote before.

**A document-linked reading is refused** with `document-import`. Those rows
belong to the import footprint (#453/#422), whose single entry point is
`persistDocumentImport` — clear, reassign and the extracted counts cannot see a
row written past it. The core does not drop the link, it declines the write.

### On the substrate, not beside it

`recordReading` classifies through `classifyUpsert`, `recordReadings` bumps the
split only through `tallyUpsert`, and the #133 lock is read only through
`isEditLocked`. The lock holds out a **source-owned re-push** — a write stamped
with an integration id or a `document:<id>` import stamp — and never the user's
own correction: a person re-entering a value they previously fixed is not a sync,
and refusing there would strand them.

### The editability contract

`ReadingTarget` names a row: `{ store, id }` plus the measure the store needs to
isolate one reading (the `body_metrics` column, the `metric_samples` metric key,
the `medical_records` **identity**). `updateReadingAt` / `deleteReadingAt` route
by it, with typed refusals. Observations are matched through the
`biomarker_family()` SQL function rather than an exact canonical string — the
#1933/#1934 contract generalized from "which table am I" to "which identity am I".

A surface produces a target FROM THE ROW: `readingTarget(reading)` for a
`Reading`, `metricReadingTarget(slug, id)` for the metric registry. The metric
detail page's readings table posts `store:id:measure` alongside its `kind`, and
the two fields answer different questions — `kind` is the PAGE (display unit,
routes to revalidate), `target` is the ROW. They used to be one field, which is
precisely why a folded clinical observation could be charted there but not
corrected.

A MOOD check-in rating is **not** a reading: a 1–5 self-rating has no canonical
identity, no clinical knowledge and therefore no placement. It stays outside
`ReadingTarget`, and `lib/metric-readings.ts` splits it off to the mood store's
own write core, where #992 requires every mutation of that table to live.

### What routed differently

`Resting Heart Rate` joined `CONTINUOUS_READING_METRIC` (part 3 of #1996): its
destination charts the folded observations AND now corrects them, so the two
structural pins generalize from **one store per destination** to **one identity
per destination** — the page's own store must be a store of the same quantity,
which for a streaming reading is its registered stream.

## Phase 3 — deliberately not started

A single tall `readings` table is **deliberately deferred**. Nothing reads or
writes the tables directly any more, so a later collapse is a data move rather
than a rewrite — and `medical_records` is the highest-stakes table in the app
(biomarker families, flags, trajectory, the import footprint, tombstones, undo,
export, the passport, and every FK enumerated in #1808), which is exactly why it
should be migrated last, behind an abstraction, or not at all. It gets its own
issue if the remaining duplication still hurts.
