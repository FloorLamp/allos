# Persisted vocabulary

Status: shipped (#2740, the durable-name audit following #2479–#2486)

Names persisted in SQLite or a portable payload are product contracts. This audit
covered the final migrated schema, portable export, import jobs and their result JSON,
protocol outcome keys, deleted-row undo envelopes, settings namespaces, and
compatibility triggers. No retired profile terminology or navigation schema contract
remains.

## Renamed contracts

| old contract                             | current contract                            | reason                                                                                          |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `food_log`                               | `food_daily_totals`                         | one aggregate row per food group and day, not an event log                                      |
| `protein_log`                            | `protein_daily_totals`                      | one aggregate row per day, not an event log                                                     |
| `substance_log`                          | `substance_daily_totals`                    | one aggregate row per substance and day, not an event log                                       |
| substance source/default `user`          | `manual`                                    | provenance describes how the value was entered, not who owns it                                 |
| import type and result JSON `biomarkers` | `clinical-results`                          | the import accepts the mixed Clinical results model                                             |
| protocol outcome `biomarker:<name>`      | `result:<name>`                             | protocol outcomes use the same broad series namespace as Trends                                 |
| undo kind/payload `biomarker-record`     | `clinical-observation`                      | the restored row may be any `medical_records` observation                                       |
| export dataset `supplements`             | `intake_items`                              | the dataset contains supplements and medications and now equals its table name                  |
| dose timestamp `taken_at`                | `recorded_at`                               | immutable capture uses the same name as the food event ledger                                   |
| dose timestamp `recorded_at`             | `occurred_at`                               | the stored administration event is distinct from immutable capture                              |
| activity type `recovery`                 | `mobility`                                  | the activity is a mobility session; recovery remains an equipment kind                          |
| `medical_records.category = 'biomarker'` | supported category or `NULL` pending review | the catchall hid unlike clinical observations and could not be resolved safely without evidence |

Migrations `20260814-persisted-vocabulary` and
`20260814-intake-log-time-vocabulary` preserve row ids, timestamps, notes,
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

Migration `20260814-remove-legacy-schema-shells` removed the temporary read-only
columns and triggers that had existed only for unconditional historical-migration
replay. The test helper now uses the same ledger-gated startup path as production;
fresh installs still execute the complete immutable chain, while repeat startup does
not prepare already-applied historical SQL against the final schema.

Migration `20260814-medical-category-residue` gives the canonical registry one final
evidence-only pass, then converts unresolved rows to the explicit `NULL` review state
while preserving their ids and relationships. The Results surface asks the user to
choose a supported category; neither the schema nor any writer accepts `biomarker` as
a medical-record category.
