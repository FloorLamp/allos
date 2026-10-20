# People

## People

The People collection in `nav.json` opens `/people` using `mountPeople`. The shared palette recognizes `people`, `people <text>` and
`people: <text>` and calls `bridge.people {q, relation}` (web `GET /api/people`, native `GET /v1/people`), with the existing
session or device credential. Search and exact relation filtering run on Bridge, including aliases; rows have no Find result cap.
The relation selector retains relations returned by the API. Rows show relation, organisation, last contact and document count when recorded.
The standalone collection and Find render 40 people per page; search reaches the whole collection through Bridge. Exact person IDs or a shared person-view document establish duplicates; matching names and household contact details do not.
Enter or a tap opens a person profile. Find's Tab still opens its identifiers and document group. Profiles share one renderer between the collection, Find's Details and the person viewer; already-loaded viewer answers need no second read. A collection profile uses one `bridge.pages` read and never hydrates every member document.
Profiles show recorded contacts with copy/call/email actions, the latest six messages and six emails, and 20 other documents per page. Further pages remain available locally; opening a document preserves viewer history and the profile's page/scroll. Recorded links and viewer cluster navigation remain available.
Portraits use only an explicitly recorded canonical authenticated photo resource through `host.resource`; missing or failed portraits show initials. A recorded Immich destination remains a separate Photos action. No portrait is inferred from a name or document.
The shared page works at desktop and Android browser widths. Bridge mounts the standalone page through `mountCollectionPage`.

Source nav entries: `contract/nav/<id>.json`, with a unique sparse `order`; `nav.mjs` loads them for the build and source tests. The bundle publishes `ui/contract/nav.json` without `order`.

Find requests words first and feature-detects Bridge’s `two-phase-v1` response, then requests the relative enrichment’s query, limit and full phase through the same host op. Single responses complete immediately. Full results replace the words list; surviving row ids keep their visible order and new rows follow, except the entries the full answer puts ahead of every surviving row (a person, thing, trip, event, day, topic, area, series or cluster), which lead in its order. Search placeholders appear after 300 ms without first rows; enrichment shows no progress bar.


People and cluster results in the palette offer **Details** for the selected row. People use the profile above.
Cluster rows mounted through `mountRows` offer the existing collection drawer. Existing row and
viewer navigation remains available. That Drawer shows cluster facts, indexed documents and recorded renewals with StatTiles and RowList.
Cluster details use `bridge.collectionDetails` with `kind=cluster`, `id`, `limit=20` and an optional `cursor`.
Bridge returns newest-first paper metadata, including explicit expiry and renewal fields; More documents loads the next page.
Search and local paging cover loaded metadata without document reads. Missing dates say `Expiry not indexed` and `No indexed
renewals`; failed document reads retain the document and say `Dates unavailable`.
No renewal is inferred from a document's date or the absence of an application.

Possible duplicate review is shared by People, Find's selected person and every profile. Opening **Review possible duplicates**
loads `bridge.peopleDuplicates` once per host snapshot (`GET /api/people/duplicates` on web, `GET /v1/people/duplicates` on devices).
Only Bridge's `verdict: ask` pairs appear, one candidate row at a time, with recorded sources, identifiers, relation and birth.
Profiles filter by exact person id, never name or contact overlap. No client identity inference or index scan runs.
Retry reads fresh evidence; successful decisions invalidate the snapshot. Web's **Merge** and **Keep separate** call
`bridge.peopleDuplicateDecision {a, b, choice}` (`POST /api/people/duplicates`), requiring Bridge's owner session and same-origin
Origin check. A successful merge reloads the page to discard stale canonical rows and profiles. Devices remain read-only. A 409 discards stale evidence and reloads candidates; a failed decision stays retryable.
Bridge adoption (flightplan #713) must publish the cached device read under its existing grants, pin this bundle and remove its
old wrapper mount and `src/people-duplicates.js` together. Until then devices report unavailable review; they never fall back to guessing.
