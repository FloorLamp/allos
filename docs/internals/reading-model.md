# The reading model

Status: partial (phase 1 shipped — a READ model; write consolidation and any
physical merge are separate, later decisions)

The app stores dated numeric readings in three places, and before #1997 every
consumer knew which one it was reading:

| store             | shape                                              | what it carries                                                                              |
| ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `body_metrics`    | WIDE — one row per day, up to three measures on it | value, day, `source`, the #133 edit lock, shared notes                                       |
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
  measuredAt: string | null; // the instant, where the store records one
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

### The stream ↔ canonical map

`STREAM_READING_SOURCES` is the missing half of the identity map: which stream
store column/metric measures which canonical biomarker name.
`CONTINUOUS_READING_METRIC` (`lib/reading-cadence.ts`) is the other half
(canonical name → metric slug). Same exclusion discipline as the family table:
only a stream key that measures the SAME quantity as a curated canonical entry is
registered. Weight, height, HRV, steps and the rest are absent because the
canonical vocabulary has no entry for them, and an invented mapping would grant a
reading a band nobody curated.

### Series assembly

`getReadingSeries(profileId, identity)` returns observations and streams
together, oldest first. It does not re-implement the observation read: it
delegates to `getBiomarkerSeries`, which already resolves the family identity and
applies the cross-source de-dup CTE, so a folded series is the one the biomarker
surfaces read rather than a parallel realization of it. The two halves run inside
`readTx` so they describe one snapshot.

`dedupeReadings()` collapses one physical measurement presented twice — the same
reading recorded in two stores, or a re-push beside its own earlier row. Its key
is **(date, raw source, value)**. The value is in the key deliberately: a same-day
fever curve is several genuinely different readings from one source on one date
(#800/#843), and a (date, source) key alone would silently drop all but one. The
representative is the reading carrying the most, so a fold never costs a document
link.

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
  is not a band; the growth card owns it), or `none` **with a reason**. The
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

Two consequences on `/trends/metric/[kind]`:

- the band renders (`MetricJudgmentCard`), suppressed when the pediatric BP card is
  showing — that IS the judgement for a child's blood pressure, and a second answer
  beside it would be a wrong one — and when there is no reading to judge;
- the series folds in same-identity observations
  (`getMetricObservations` + `foldObservationPoints`), so a clinic-measured reading
  joins the trend it belongs to. Folded readings are **marked** and **read-only**
  there (see phase 2 below), and the fold is empty for a metric whose readings
  already ARE observations, which would otherwise list each one twice.

`lib/reading-cadence.ts` still keeps Resting Heart Rate off the metric-surface
routing table, but for a **different reason than before**: the destination is no
longer empty, it is not yet editable. See the comment there.

## Phase 2 / phase 3 — deliberately not started

- **Phase 2, write consolidation.** New writes going through one core that
  decides physical placement. Until it lands, a folded observation is READ-ONLY
  on a stream metric's surface: the write path still resolves its store from the
  metric slug, so an observation id posted at it would be refused. That is the
  #1933/#1934 editability contract, and it is a phase-2 job.
- **Phase 3, the physical merge.** A single tall `readings` table is
  **deliberately deferred**. After phase 1 nothing needs to read the tables
  directly, so a later collapse is a data move rather than a rewrite — and
  `medical_records` is the highest-stakes table in the app (biomarker families,
  flags, trajectory, the import footprint, tombstones, undo, export, the passport,
  and every FK enumerated in #1808), which is exactly why it should be migrated
  last, behind an abstraction, or not at all.
