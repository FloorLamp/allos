# People

## People

The People collection in `nav.json` opens `/people` using `mountPeople`. The shared palette recognizes `people`, `people <text>` and
`people: <text>` and calls `bridge.people {q, relation}` (web `GET /api/people`, native `GET /v1/people`), with the existing
session or device credential. Search and exact relation filtering run on Bridge, including aliases; rows have no Find result cap.
The relation selector offers the relations returned by the API. Document count, relation, organisation and last contact appear on the second line when present.
Enter or a tap opens the existing person view document; Tab opens the person's identifiers and documents as before.
The shared page works at desktop and Android browser widths. Bridge mounts the standalone page through `mountCollectionPage`.

Source nav entries: `contract/nav/<id>.json`, with a unique sparse `order`; `nav.mjs` loads them for the build and source tests. The bundle publishes `ui/contract/nav.json` without `order`.

Find requests words first and feature-detects Bridge’s `two-phase-v1` response, then requests the relative enrichment’s query, limit and full phase through the same host op. Single responses complete immediately. Full results replace the words list; surviving row ids keep their visible order and new rows follow. Search placeholders appear after 300 ms without first rows; enrichment shows no progress bar.


People and cluster results in the palette offer **Details** for the selected row.
Cluster rows mounted through `mountRows` offer the same drawer. Existing row and
viewer navigation remains available. The shared Drawer shows contact or cluster
facts, indexed documents, and recorded renewals with StatTiles and RowList.
Cluster membership is refreshed through `bridge.cluster`; person membership is
loaded on demand through `bridge.pages` (the authenticated person document pages endpoint). Document expiry and renewal fields use `bridge.doc`, with
owner edits preferred. Missing dates say `Expiry not indexed` and `No indexed
renewals`; failed document reads retain the document and say `Dates unavailable`.
No renewal is inferred from a document's date or the absence of an application.
