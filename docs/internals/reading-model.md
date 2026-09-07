# The reading model

Use the shared reading APIs for dated numeric quantities that have a canonical
identity. Shared APIs span three stores. Physical consolidation remains deferred;
store-specific readers and writers still exist.

| Store             | Shape and purpose                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `body_metrics`    | One day/source row with weight, body fat, and resting HR; shared notes and edit lock.             |
| `metric_samples`  | Metric/value samples with start/end instants, source, and edit lock.                              |
| `medical_records` | Observations with canonical names, reported ranges, flags, and document/encounter/provider links. |

Only registered quantities participate in the reading model. A store containing a
quantity does not itself grant that quantity a canonical identity. Minute-scale
traces, mood ratings, and unmapped measures keep their own models.

## Identity and provenance

[reading-model.ts](../../lib/reading-model.ts) owns `Reading` and row conversion.
A reading carries its identity, value/unit, profile-local day, optional measured
instant, normalized source, physical store/row ID, raw source key, edit lock, and
notes. `measuredAt: null` means day grain; never substitute the capture time.
Observation provenance is optional and absent on stream readings.

`readingIdentity()` delegates to `biomarkerFamily()`, matching the identity used
by deduplication, stars, latest markers, and SQL's `biomarker_family()`. Resolve
canonical names through this function instead of maintaining another name map.

`readingSourceFor()` classifies provenance independently of storage:

1. Document, encounter, or provider links: `clinical`.
2. A `document:<id>` source stamp: `import`.
3. Another integration source: `wearable`.
4. Missing source or `manual`: `manual`.

[reading-identity-map.ts](../../lib/reading-identity-map.ts) declares each mapped
canonical quantity, its metric surface (or `null`), and its stream location (or
`null`). `STREAM_READING_SOURCES` and `CONTINUOUS_READING_METRIC` derive from that
one declaration. Register only the same quantity as the curated canonical entry;
an approximate match can give a reading the wrong interpretation. Stream
placement and continuous presentation are separate decisions: a stream entry may
still use the clinical detail page.

## Reading and folding series

[queries/readings.ts](../../lib/queries/readings.ts) owns the database reads:

- `getReadingSeries(profileId, identity)` combines observations and registered
  streams, oldest first. Its observation side uses `getBiomarkerSeries` and its
  existing deduplication. Combined reads run in one `readTx` snapshot.
- `getStreamReadings` retains the individual stream rows for source comparison.
- `getMetricObservations` supplies same-identity observations to a metric whose
  base series is a stream. Metrics already backed by observations return no fold.

`dedupeReadings()` groups by identity, day, normalized source, and value.
Different values survive. Equal values with distinct stated instants also
survive; an untimed member can collapse into a timed group. Within a duplicate
slot, provenance wins first, then a stated instant, then caller order. Two devices
can collapse because both normalize to `wearable`; use the stream reader when
device identity matters.

`foldObservations()` first deduplicates observations, then removes those already
covered by the stream's day/value points. That coverage comparison ignores source
and instant because a daily point no longer carries either.
`trendMetricSeriesFold()` in
[trend-metric-series.ts](../../lib/trend-metric-series.ts) returns both chart points
and surviving observation rows. Use both results so the chart and its table agree.

## Choosing and displaying a judgment

[metric-judgment.ts](../../lib/metric-judgment.ts) declares the knowledge source for
every `TrendMetricSlug`: canonical bands, growth percentiles, fitness norms,
personal best, or `none` with a reason. `QUANTITY_KNOWLEDGE` covers additional
quantities whose readings and knowledge use different keys; it does not duplicate
the ordinary lab catalog. `quantityKnowledge()` resolves the combined identity
lookup. An absent declaration is not evidence that an ordinary lab analyte lacks
its own canonical judgment.

[queries/metric-judgment.ts](../../lib/queries/metric-judgment.ts) supplies runtime
canonical definitions and subject context. Use age and cycle phase on the
collection date. Reuse the reference/optimal-band functions used by flag
reconciliation. Growth, fitness norms, and pediatric BP have their own percentile
renderers. Peak-flow zones use `peakFlowZone()` at read time against the person's
current best; no personal best means no zone. Do not store that changing judgment
as a fixed flag.

For results tables, `judgeObservations()` and
[referenceCell()](../../lib/reading-reference-cell.ts) produce the applicable
reference and optimal bands, age label, and differing canonical unit when needed.
[formatBand()](../../lib/band-format.ts) owns numeric formatting. Retain the source's
printed range as attributed provenance. `MedicalValue` can show the severity word
with `showFlagLabel`; it must be announced once.

On the clinical reading detail page,
[biomarkerValueBasis()](../../lib/biomarker-value-basis.ts) returns both the visible
basis and the permitted display flag:

| Basis       | Display                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| Curated     | The app's band.                                                           |
| Reported    | The row's range, attributed as reported.                                  |
| Qualitative | The result's own classified verdict.                                      |
| None        | Suppress warning/error flags together with their caret and severity word. |

This is a display decision, not a stored-flag rewrite. Neutral status labels such
as immunity remain. `bandNoteClause()` supplies the explanation for an absent
band without repeating the analyte description.

[careOfferBasis()](../../lib/biomarker-care-basis.ts) explains existing recheck and
retest offers; it does not decide their reach. A recheck on a neutral,
source-flagged reading names the source's flag. A retest notice names reading age.
Keep flag-based exemptions in the retest clock. List surfaces that still display
stored flags do not automatically inherit the detail page's suppression rule.

## Flag ownership and missing context

[reference-range/flags.ts](../../lib/reference-range/flags.ts) owns reconciliation,
flag tiers, and `flagInSql`. Reuse its membership lists in SQL and TypeScript.
`reconciledFlag()` returns `undefined` to preserve a flag and `null` to clear it;
those outcomes are different.

- Conversion failure or a probable unit mislabel declines numeric judgment and
  preserves the source flag. Do not move clearing rules above these checks.
- After those checks, pediatric BP declines adult-band judgment and retires the
  adult numeric flags it owns. Qualitative flags survive. Unknown age keeps the
  adult regime; collection-date age prevents later birthdays changing the regime
  of an old reading.
- Canonical reference and optimal judgments precede the reported-range fallback.
  Without reference bounds, an existing source `high` or `low` is preserved.
- The fallback compares the printed value and range, respecting the analyte's
  direction. It writes `reported-high`/`reported-low`, an attributed amber tier
  distinct from `isOutOfRange` and non-optimal flags. These derived flags can clear
  when the value or range changes.
- `frameUnstatedNames()` derives bare entries with patient-state-qualified siblings,
  such as unqualified versus fasting glucose. An unstated frame must not acquire
  a judgment from a printed range or a registered continuous stream. Do not infer
  the missing patient state.

[canonical-flags-version.ts](../../lib/canonical-flags-version.ts) fingerprints
flag-relevant dataset fields for boot reconciliation. Change `FLAG_LOGIC_VERSION`
when derivation logic changes with the dataset held still.

## Placement, corrections, and deletion

[reading-placement.ts](../../lib/reading-placement.ts) owns placement and targets;
[reading-writes.ts](../../lib/reading-writes.ts) executes writes. Resolve the active
profile and authorization at the request boundary, and scope reads and writes by
`profile_id`. Parsing a target does not authorize it.

`placeReading()` applies these rules in order:

1. Refuse an empty identity.
2. Clinical provenance requires `medical_records`, preserving links, reported
   names, and ranges that stream stores cannot carry.
3. Otherwise use the identity's registered stream.
4. Otherwise use `medical_records` under the supplied canonical name.

Callers supply a valid canonical quantity; placement does not turn an arbitrary
metric key into one. Mood ratings and unmapped measures use their existing writers.

`recordReading()` refuses document-linked writes with `document-import`. Use
`persistDocumentImport` so clear, reassign, and counts see the whole footprint.
Reuse `classifyUpsert`, caller-side `tallyUpsert`, and `isEditLocked`. A source-owned
re-push must respect the edit lock; the person's own correction remains possible.

For corrections and deletes, derive a `ReadingTarget` from the actual row with
`readingTarget()` or the appropriate metric target helper. It names store, ID,
and measure (body column, sample metric, or observation identity).
`updateReadingAt()` and `deleteReadingAt()` route by that target. The posted
`store:id:measure` identifies the row; the page's `kind` identifies display and
revalidation context. A folded observation stays editable in its physical store.

Observation corrections set `edited` regardless of `external_id`.
[import-corrections.ts](../../lib/import-corrections.ts) captures corrected values
before reprocess clears the document footprint and reapplies them after insertion,
in the same transaction. Match by family identity, day, and normalized unit;
pair same-day duplicates in order, never by old row ID. Preserve the lock and let
import followups reconcile the corrected values. Report unmatched corrections as
`correction_orphaned` drops without resurrecting rows or inflating `considered`.

## Where continuous glucose belongs

Raw CGM points live in `glucose_trace`, outside `Reading`, like `hr_minutes`.
[glucose-trace-db.ts](../../lib/glucose-trace-db.ts) writes canonical UTC instants
and source-qualified points, then recomputes each touched profile-local day from
the stored trace. It writes `glucose_mean_mgdl`, `glucose_time_in_range_pct`, and
`glucose_trace_points` through `upsertMetricSamples`, preserving that core's
edit-lock, tombstone, and accounting rules. Trace storage uses mg/dL.

Health Connect routes glucose by the person's per-connection continuous-sensor
setting, off by default. Declared connections write trace points; undeclared ones
write discrete `Glucose` observations. Current routing does not inspect specimen
metadata. Sources are `health-connect:<data_origin>`, falling back to
`health-connect`. A push with exactly one qualified source can absorb the bare
backlog and recompute its days. Mixed or multiple origins cannot identify that
backlog and must not guess.

The trace and its summaries have no `READING_IDENTITY_MAP` entry. Adding clinical
identity requires an explicit curation decision; adding trace/AGP/time-in-range
surfaces requires a metric and document-reach decision. The `diabetic-cgm` seed
persona supplies both raw trace points and discrete observations for development.

## Verification and related contracts

Use existing reading-model/placement tests for pure decisions and reading-series,
reading-writes, metric-fold-agreement, import-correction, and glucose-trace DB
coverage for persistence changes. Judgment, reported-range, and pediatric-BP tests
cover their distinct rules. Follow the shared [test policy](../change-policy.md).

See [time](time-model.md), [temporal columns](time-columns.md),
[charts](charts.md), [integration sync](integrations-sync.md), and
[findings](findings.md) for their separate contracts.
