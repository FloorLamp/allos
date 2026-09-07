# Integration sync contract

For setup, use [Integrations](../integrations.md). This guide owns ingestion,
provenance, sync accounting, and source health. Start at `lib/integrations/registry.ts`
and the source's existing normalizer/runner.

## Source vocabulary and lifecycle

A connected integration is `sourceId` in TypeScript and `source_id` in SQL.
`Provider` belongs to healthcare clinicians and organizations. Do not add aliases
or dual writes between these concepts.

The registry declares source capabilities, delivery families, and poll cadence.
Use these declarations for source pages and the Imports feed. Push sources accept
incoming data; pull sources use the shared runner. A reminder tick and a provider
poll are separate schedules. Preserve polling phase, truncation/error reporting,
and the existing retry policy rather than adding caller-local retries.

A re-queued backfill resumes its progress and accounts for work already completed.
Do not restart completed windows or retry candidates the source cannot answer.

## Writes and provenance

- Resolve profile authorization at the request boundary; every owned read/write
  remains scoped to that profile. One normalization call has one profile/source.
- Reuse the observation/reading substrate and normalizers. Deduplicate on the
  source's actual natural identity; adapters must normalize the source's spelling
  of its identifier field before generic ingestion reads it.
- Preserve edit locks on manually corrected imported data. An edit-locked row is
  unchanged, not silently overwritten on the next rolling-window sync.
- Record inserted, updated, and unchanged results separately. An SQL affected-row
  count alone does not distinguish a value change from a no-op update.
- Keep raw provenance and source context with the row/run where supported. A raw
  payload drill-in is available only when the underlying payload exists; its
  displayed count must describe what the drill-in can actually show.
- Preserve deletion/re-import tombstones. A deleted document stays deleted, and
  health-record entry IDs can identify duplicates even when bytes differ.
  Remember refused duplicate identities so acquisition does not keep resending.
- Reissued clinical results retain correction history rather than silently
  replacing the previous interpretation. Use the clinical result terminology
  and shared import actions for preview, apply, and replay.

## Time and cross-source duplicates

Use `lib/source-time.ts`, source timezone reconciliation, and declared row-instant
readers. Stored sleep sessions are absolute instants. A re-sent metric row keeps
its attributed day; a day bucket's date follows its own anchor rather than the
profile's current zone.

Same-source and cross-source duplicate questions differ. Cross-source activity
review can consider an offset-shaped clock discrepancy together with duration and
distance agreement, but that is review evidence, not permission to auto-merge.
An inferred activity type must not block matching. The user chooses which clock
survives when evidence is ambiguous. A merge must also reconcile any session-level
notification identity instead of allowing another completion send.

## Health Connect day-bucket supersession

`lib/metric-window-overlap.ts` and the normalizer own this operation. Preserve
these invariants when changing chunking, deduplication, or time handling:

1. Upserts decide their own vetoes through `metricSampleVeto`: misrouting,
   tombstones, edit locks, and stale retries. Accounting is typed through
   `VETO_TALLY`. Supersession must not reimplement those decisions.
2. Derive victims from the stored rows under the final chunk's `IMMEDIATE`
   transaction, after its upserts. Only a row actually carrying this push's stamp
   can justify a delete. Payload membership alone cannot justify one.
3. Match profile, metric, source, origin, day-bucket granularity, and overlapping
   instants. Preserve edited rows and rows written by this same push.
4. Freshness comes from the payload's push timestamp, not arrival order or a
   sample/window timestamp. NULL is unknown; existing era rules determine when
   a NULL-stamped row may be superseded.
5. Delete only when the existing day-coverage rule permits it. Do not leave a
   previously represented date without a reading. Keep rows whose attribution
   does not satisfy the rule.
6. Intermediate commits may hold old rows or old plus new rows; they must never
   hold neither. Earlier chunks commit upserts only. Derivation and deletes
   occur with the final chunk, so interruption can leave visible overlap, not
   a data hole.

The accepted limits include same-push overlapping anchorings and the switch day's
leading sliver. Report unresolved overlap from the same stored-state question;
do not add a historical repair or suppress otherwise valid incoming writes.
`hc-overlap-push-property.test.ts` and `hc-overlap-supersede-refutations.test.ts`
in `lib/__db_tests__/` exercise ordering, chunking, and interrupted-commit behavior.

## Review and source health

Sync history uses the shared view model and groups runs by day. The status card
answers current health without duplicating the history. Raw technical detail stays
in its drill-in; user-facing errors say what failed and what the person can do.
Preserve path/status details for diagnosis without exposing them as the headline.

A partial/truncated run cannot report clean completion. Weather has independent
current/daily data and a shared location cache; a failure in one required half must
not disappear into the other's success.

Transport silence, stale streams, and a disconnected/abandoned device are distinct
questions. Health gates use the same source/stream scope as their evidence. Stream
frontiers follow canonical instants and declared cadence; do not infer a clinical
absence from a quiet feed. On/offboarding suggestions use the existing suppression
keys, and only an explicit acceptance enables contact.

Document acquisition distinguishes an actual acquisition run from delivery-only
reporting. Keep standing per-identity decline state distinct from individual run
fields. A portal sync request uses the existing cadence/consent contract and one
request endpoint; it must not become a second notification schedule.

For related contracts, read [time](time-model.md), [reading placement](reading-model.md),
[import actions](import-actions.md), and [notification consent](findings.md) only
when the change reaches those boundaries.
