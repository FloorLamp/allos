# Import and document actions

Use these verbs for document controls. An uploaded document's action home is
its import detail page (`/import/<id>`), reached from **Data → Review**. The
Import tab owns new uploads, paste/CSV jobs, and integration setup.

## Verbs and consent

| Verb                                   | Behavior                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Preview changes**                    | Parses or extracts into memory and compares with persisted records. Does not replace records. Deterministic health records need no AI call; other documents may consume extraction quota. |
| **Save changes**                       | Commits the cached, previewed input without another extraction. Replaces the document's imported rows through shared persistence. Disabled when the preview has no changes.               |
| **Re-extract anyway**                  | Explicitly requests fresh extraction when preview was skipped. Deterministic imports use their parser; AI documents use the configured extractor.                                         |
| **Re-apply saved extraction**          | Replays the extraction saved with the document, without a model call or quota charge.                                                                                                     |
| **Re-run extraction on all documents** | Batch re-extraction, with an AI cost preview. Health-record files re-import deterministically.                                                                                            |
| **Delete document & its records**      | Removes the document and its imported rows. Confirmation names the full scope.                                                                                                            |
| **Discard**                            | Drops an uncommitted paste/CSV extraction job. No imported records exist yet.                                                                                                             |

`ReprocessDiffPanel` owns preview → save. A missing, expired, superseded, or
changed preview requires a new preview; Save never falls back to fresh
extraction. A refused save shows the next step. The separate **Re-extract
anyway** choice sends explicit extraction intent. Token absence alone cannot
request it.

`lib/reprocess-preview-cache.ts` binds single-use input to a profile, document,
and persisted generation. Cache loss requires another preview. An attempt from
a different profile cannot consume the owner's token. `lib/medical-pipeline.ts`
checks the token and claims the document before writing; an active extraction
or failed commit does not dispatch a second extraction.

A no-change preview disables Save through `lib/reprocess-preview-view.ts`.
Persisting reviewed input still applies shared import rules, including existing
source coverage, medication matching, and edit locks; a preview's proposed
additions are not a promise that every candidate becomes a new row.

## Raw data

Raw extraction and sync payload views use `components/RawDataViewer.tsx`.
`lib/raw-data-tree.ts` detects JSON, XML, or plain text; the viewer provides a
shared collapsible tree, full-text copy, and size/depth limits. Authorization
stays with the caller.

## Document footprint and foreign keys

`IMPORT_FOOTPRINT_TABLES` in `lib/import-footprint.ts` owns the rows removed by
document deletion and replacement. Both use `clearImportedDocumentRows`;
`moveImportedDocumentRows` handles reassignment. Preserve their common scope.

For references into this footprint and its cascade closure:

- `CASCADE` and `SET NULL` delegate cleanup to the foreign key.
- `NO ACTION` references must be freed before clearing the footprint. Reassignment
  must also prevent links between profiles; a valid row ID does not prove shared
  profile ownership.

`IMPORT_SIDE_EFFECTS` inventories cleanup outside the footprint loop. For example,
an illness episode's stop record keeps its medication-name snapshot while its
item/course links are cleared: the narrative belongs to the episode.

`lib/__db_tests__/import-footprint-fk-scan.test.ts` inspects the migrated schema,
including cascade closure and document references, to check that cleanup owners
are declared. Keep that coverage aligned with the actual delete and move paths.

## Counts and new domains

`countImportedDocumentRows` counts the persisted footprint. In the same
transaction, `persistDocumentImport` stamps both `extracted_count` and the stored
report's `imported`; `considered` also includes dropped candidates. The toast,
Review feed, Timeline, and import detail coverage use this persisted count.

Parser counts are estimates: persistence can attach a prescription to an existing
medication or defer a metric already covered by another source. Do not maintain
another count formula in a parser or UI.

For a new imported domain, extend `IMPORT_FOOTPRINT_TABLES` for delete, move, and
persisted counts, and `KEPT_ROW_LISTS` in `lib/import-report.ts` when its parser
produces a kept list. Extend the existing every-domain fixture in
`lib/__db_tests__/import-report.test.ts` to cover the new footprint and verify
report/count agreement. Follow the [change and test policy](../change-policy.md).
