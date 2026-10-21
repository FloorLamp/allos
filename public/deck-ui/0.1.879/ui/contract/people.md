# People

## People

The People collection in `nav.json` opens `/people` using `mountPeople`. The shared palette recognizes `people`, `people <text>` and
`people: <text>` and calls `bridge.people {q, relation}` (web `GET /api/people`, native `GET /v1/people`), with the existing
session or device credential. Search and exact relation filtering run on Bridge, including aliases; rows have no Find result cap.
The relation selector retains relations returned by the API. Rows show relation, organisation, last contact and document count when recorded.
The standalone collection and Find render 40 people per page; search reaches the whole collection through Bridge. Exact person IDs or a shared person-view document establish duplicates; matching names and household contact details do not.
Enter or a tap opens a person profile. Find's Tab still opens its identifiers and document group. Profiles share one renderer between the collection, Find's Details and the person viewer; already-loaded viewer answers need no second read. A collection profile uses one `bridge.pages` read and never hydrates every member document.
Profiles show recorded contacts with copy/call/email actions, the latest six messages and six emails, and 20 other documents per page. Further pages remain available locally; opening a document preserves viewer history and the profile's page/scroll. Recorded links and viewer cluster navigation remain available.
Portraits use only an explicitly recorded canonical authenticated photo resource (bridge's `person.photo`: their latest face) through `host.resource`, wherever a person appears: People rows and profile, Find's person card and rows, Papers' holder headings, Texts' people, an event's attendees. One `Avatar` (`view/avatar.js`) draws them: initials at once, the portrait asked lazily as it nears the view at its drawn size times the density (`?w=`), initials while loading and when missing or failed, the box never moving; never on a shared screen (`SharedScreen`: House's tablet and wall). A recorded Immich destination remains a separate Photos action. No portrait is inferred from a name or document. A person's portrait is their linked face's ([Faces](#faces)); People's **Show** filter's **No photo (n)** shows the people (never an org) without `person.photo` (none linked), counted over the rows bridge answered.

Organizations: bridge names each row's and view's `person.kind` (`person` or `org`, its rules; bridge docs/design.md *Organisations*)
and `person.logo` (true when an org's logo may be asked). The one `Avatar` draws an org as a rounded square: its logo
(`/v1/people/<id>/logo?w=`, the resource list's, asked lazily at the drawn size as a portrait is) whole on a paper plate, its
initials in the square while loading, when bridge has none (`logo: false`: never asked) or on a 404. People's **Show** offers
**People** and **Organizations (n)** while the answer holds an org (filtered on the rows bridge answered). An org's line and view
say **Organization** in place of its relation; it has no face: no Face section, no Link a face, no face picker. The owner's web
session (the same check as Undo merge) has **This is an organization** on a person's profile and **This is a person** on an org's,
a rare correction: in the profile's ⋯ (More) menu at every width, never a button of the profile:
`bridge.personKind {id, kind}` (`PUT /api/people/<id>/kind {kind}`; bridge keeps it over its rules), then the page is read again;
devices and members see neither.
The shared page works at desktop and Android browser widths. Bridge mounts the standalone page through `mountCollectionPage`.

Source nav entries: `contract/nav/<id>.json`, with a unique sparse `order`; `nav.mjs` loads them for the build and source tests. The bundle publishes `ui/contract/nav.json` without `order`.

Find requests words first and feature-detects Bridge’s `two-phase-v1` response, then requests the relative enrichment’s query, limit and full phase through the same host op. Single responses complete immediately. Full results replace the words list; surviving row ids keep their visible order and new rows follow, except the entries the full answer puts ahead of a surviving row (a person, thing, trip, event, the more trips or events, day, topic, area, series or cluster): each goes just before the first surviving row, in the visible order, that the full answer puts after it. Search placeholders appear after 300 ms without first rows; enrichment shows no progress bar.


Find person rows may carry `person.aliases`, an array of recorded names. Every query word must start or nearly start a word
of the canonical name or those aliases for the first matching person to lead as an expanded card. Missing aliases retain
canonical-name matching; unrelated words leave the person as a row. The card keeps the canonical name and person identity.
This additive behavior keeps hostApi 1. After merge, the normal deck-ui publication and Bridge consumer bump ship the shared
model and this contract; Bridge supplies aliases on its Find person rows and pins the published bundle.


People and cluster results in the palette show their record card when selected (palette SPEC.md *Record card*); Open is the
profile above. Cluster rows mounted through `mountRows` open their record card in place (`Details ›`; [collections.md](collections.md)
*Records open in place*). Existing row and viewer navigation remains available.
Cluster details use `bridge.collectionDetails` with `kind=cluster`, `id`, `limit=20` and an optional `cursor`.
Bridge returns newest-first paper metadata, including explicit expiry and renewal fields; More documents loads the next page.
Search and local paging cover loaded metadata without document reads. Missing dates say `Expiry not indexed` and `No indexed
renewals`; failed document reads retain the document and say `Dates unavailable`.
No renewal is inferred from a document's date or the absence of an application.

## Faces

A person's face is an Immich person (a face group); its latest photo is their portrait (`person.photo`). The person view's `face`
is `{id, name, by: rule | owner | kinfolk, rule, label}` or null (`people-faces.js` `faceOf`). Ops (contract/host-contract.json):
`bridge.faces {q?, cursor?}` (`GET /api/people/faces`: 40 a page, named first, then unnamed by photo count; `q` named faces whose
names hold every word; `{faces: [{id, name, photos, thumbnail, immich, person}], next, total}`), `bridge.faceSuggestions {id}`
(`GET /api/people/<id>/faces/suggestions`: at most five `{face, score, rule, why}`, none once linked), and the writes, the site's
only (a member's session that may write: `canLinkFaces`; same-origin Origin; a device's are unsupported): `bridge.faceLink {id,
immich, move?}` (`PUT /api/people/<id>/face`; 409 `{holder}` when it is someone else's), `bridge.faceUnlink {id}` (`DELETE`) and
`bridge.faceNotIt {id, immich}` (`POST …/face/not-it`). The thumbnail is a resource (`/v1/people/faces/<uuid>/thumbnail`).

A profile's **Face** section (`view/person-face.js`): linked, the face's name and how it came (`Linked automatically: <label>`, `Linked
from the family tree`, `Linked by hand`) with **Change face** and **Unlink**; none, **Link a face** and bridge's suggestions
(**Probably this face**: thumbnail, name, why and photos; **Link**, **Not it**, which hides it for good). People's and Find's person
record card has **Link a face** while there is none. Link a face unfolds the picker in place (under the Face section's heading, or in
the card under its actions; Close or Esc folds it, the focus back on the button; no drawer): a search over names, the faces as tiles (thumbnail, name or `Unnamed`, photo count, `Linked to <name>`; **Open in Immich ↗** to name one there), **More** for the next
page; choosing one links it, and one linked to someone else asks **Move it here** first (bridge's 409, then `move: true`). Failures
are the shared failure state (a bridge without faces yet: the picker's failure with Retry, no suggestions). A link or unlink changes
the person on the whole page at once: their `photo` and `face` (`withFace`: rows, profiles, cards, kept answers) and their portrait's
version (`?v=`, every `Avatar` of them redrawn past the browser's cached image). A device shows how a face came, read-only.

## Duplicate review

Bridge merges sure duplicate pairs by rule itself; the owner reviews only the rest. The review is the owner's: the web host's
owner-session check (`env.get`'s `caps.owner`, the same check as `codes` and `tower`; never on a device, the agent member or a member's
page) opens it, and nobody else sees the entry or reads pairs. People's header shows **Possible duplicates (n)**, n the `verdict: ask`
pairs still undecided; a profile and Find's selected person show their own (exact person id: People's `view` or the registry's `a`/`b`,
never a name or contact). All three open the one review (`src/view/people-duplicates.js`), reading `bridge.peopleDuplicates` once per
host snapshot (`GET /api/people/duplicates`).

Each pair: `{a, b, verdict, evidence: {compatibleBirths, identicalDocuments, overlappingIdentifiers: [phone | email | handle],
sources, sharedRelation}, people}`; each person `{id (registry id), view (People's person id), name, relation, sources, birth, photo?
(`/v1/people/<view>/photo` when a portrait is recorded), ids: [{title, value}] (masked by bridge, shown as given), counts: {papers,
texts}, lastActivity}`. The host contract's `result` line for the op keeps its first shape (changing it is a host API break); this is
the shape. One pair at a time, the two people side by side (one over the other when narrow): portrait or initials, name, relation,
sources in words (model.mjs `SOURCES`), birth, papers and texts, last activity, contacts; why bridge asks above them (same phone, same
documents, both family).

**Merge** (M), **Keep separate** (K) and **Skip** (S) move to the next pair; **Undo** (Z) takes back this page's last: a decision
through `bridge.peopleDuplicateUndo {a, b}` (`POST /api/people/duplicates {a, b, choice: undo}`: a merge split back, a Keep separate
forgotten), a skip by going back to it. Keys act while the review is open, not while typing in a field or under another dialog.
Decisions call `bridge.peopleDuplicateDecision {a, b, choice}` (`POST /api/people/duplicates`), Bridge's owner session and same-origin
Origin check required; a merge or its undo reads People again. A 409 discards stale evidence and reads the pairs again; a failed
decision stays to retry. Skipped pairs come back at the end (**Review skipped**).

A profile (`{kind: person, person}`) with `person.merges: [{id, name, by: rule | owner, rule, label, at}]` lists **Merged into this
person**: `Merged automatically: <label>` or `Merged by you`. The owner's web session has **Undo merge**: `bridge.peopleUnmerge {id}`
(`POST /api/people/<id>/unmerge` → `{ok, person, from}`; bridge records Keep separate), then the page is read again as after a merge;
404 says it is no longer a recorded merge, 409 that the person changed. Devices and members see the list read-only.
