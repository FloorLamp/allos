# Persisted vocabulary

Status: shipped (#2740, the durable-name audit following #2479–#2486)

Names persisted in SQLite or a portable payload are product contracts. This audit
covered the final migrated schema, portable export, import jobs and their result JSON,
protocol outcome keys, deleted-row undo envelopes, settings namespaces, and
compatibility triggers. No retired profile terminology or navigation schema contract
remains.

## Renamed contracts

| old contract                             | current contract         | reason                                                                         |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `food_log`                               | `food_daily_totals`      | one aggregate row per food group and day, not an event log                     |
| `protein_log`                            | `protein_daily_totals`   | one aggregate row per day, not an event log                                    |
| `substance_log`                          | `substance_daily_totals` | one aggregate row per substance and day, not an event log                      |
| substance source/default `user`          | `manual`                 | provenance describes how the value was entered, not who owns it                |
| import type and result JSON `biomarkers` | `clinical-results`       | the import accepts the mixed Clinical results model                            |
| protocol outcome `biomarker:<name>`      | `result:<name>`          | protocol outcomes use the same broad series namespace as Trends                |
| undo kind/payload `biomarker-record`     | `clinical-observation`   | the restored row may be any `medical_records` observation                      |
| export dataset `supplements`             | `intake_items`           | the dataset contains supplements and medications and now equals its table name |

Migration `20260814-persisted-vocabulary` preserves row ids, timestamps, notes,
autoincrement position, malformed opaque JSON, and unrelated namespace members. It
deduplicates protocol keys only when an old and current spelling resolve to the same
outcome. The current application neither dual-reads nor dual-writes these contracts.
Portable exports intentionally contain no old-key alias.

## Retained contracts

- `medical_records`, `medical_record_revisions`, and `*_medical_record_id` are the
  record-wide clinical-observation substrate. They carry document, encounter,
  provider, printed-range, and provenance context for quantities and non-quantities;
  `docs/internals/reading-model.md` explicitly defers a physical-store merge.
- `food_log_events` is an event ledger: each serving tap is a distinct row with an
  event instant. Its name is accurate even though its day counter moved.
- Biomarker/analyte contracts remain where their subject is genuinely a biomarker:
  `biomarkerFamily`, biomarker goals and ranges, Coverage's biomarker kind, retest
  dismissal keys (`biomarker:`), and flag acknowledgements (`biomarker-flag:`).

## Temporary read-only compatibility

These names are not application contracts. They exist only so immutable historical
migrations can replay against a current database, and no current writer may populate
them:

- `food_log_events.eaten_at`
- `intake_item_logs.given_at`
- `illness_episodes.started_at` / `ended_at` and
  `illness_episodes_legacy_window_compat`
- `intake_items.priority` / `as_needed` and
  `intake_items_legacy_obligation_compat`
- `savedClinicalResultKindForSchema()` returning the frozen `biomarker` saved-item
  kind while migrations 174, 177, and 178 replay before the saved namespace migration
- `rewriteResultOutcomeKeys()` recognizing the frozen `biomarker:` protocol prefix
  while those same migrations replay against their historical protocol rows

Their removal condition is concrete: the DB integration harness must stop replaying
the complete immutable migration chain unconditionally, or those frozen migrations
must otherwise stop preparing their historical names against the final schema. Until
then the shells stay inert and declared; they are not compatibility promises.

The retired `medical_records.category = 'biomarker'` is a separate residue contract.
No writer can create it, but unclassifiable established rows remain readable and legal
until every residue row has an evidence-backed replacement category. Migration 185
reports rather than guesses that population.
