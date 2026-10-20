# Things

Find's Things row opens the bundled `things` collection page on web, Mac,
Windows and Android. `mountThings(el, host, {onOpen?})` returns
`{things, refresh(), unmount()}` and uses the shared viewer for receipts.

`bridge.things` reads `GET /v1/things` (`/api/things` on web): product catalog
rows with a `thing` payload. `bridge.thing {id}` reads `GET /v1/thing/<id>`
(`/api/thing/<id>` on web): the product detail. Both require `bridge:find`.
The shell bar shows Things only after a successful list read, including an empty
list; denied or unavailable reads hide it.

The collection contains durable owned items only; Bridge excludes consumables and clothing.
Deck also excludes products whose status is not `owned`. Rows show a short name (the
first clause of a purchase title, bounded to 80 characters), a product icon, and indexed brand, model, variant, owner, store,
purchase date and price. Redundant product/owned labels are omitted; absent purchase details get one neutral placeholder. An absent owner is omitted from both rows and purchase facts; known names are preserved.
For products without `thingId`, the drawer shows cached specs, purchase facts, receipts and the cached
product photo and the full, unchanged name in its heading. Purchase history and
non-owned products remain available through Bridge detail and Find; a purchase is
not proof of ownership. Unknown facts stay unknown.
Cached photos use the allowlisted `/v1/thing-image/<sha256>` resource through the
host; arbitrary remote images are never loaded. Receipts open in the shared viewer.
Web consumers must expose the authenticated `/api/things`, `/api/thing/<id>` and
`/api/thing-image/<sha256>` routes using bridge's existing access policy.

The Purchases button opens categorized purchase history and linked card
charges, including unmatched purchases ([API contract](purchases.md)).

## Physical thing page (FP-1180)

A product or house record with `thingId` opens the shared physical thing page.
`/things#<UUID>` also selects it directly, without a catalog membership requirement.
Legacy view IDs remain document keys; Deck never joins on names, serials or models.
Records without a shared identity retain their existing record view.

The registry operation `bridge.things.detail {query: {id: <UUID>}}` reads
`GET /v1/things/<UUID>` (web twin `/api/things/<UUID>`), requiring `bridge:find`.
This is the consumer contract for the bridge follow-up; bridge main currently
provides identity writes and lookup, but does not yet implement this joined read.
It must return `{thing: {id, name, identifiers, room?, location?, purchase?,
warranty?, manuals, documents, devices, alerts}}`, with the same UUID in `id`:

- `identifiers`: `[{kind, value}]`; `room` and `location`: readable labels.
- `purchase`: `{store?, date?, price?}` or null; `warranty`: `{expires?, terms?}` or null.
- `manuals`, `documents`: ordinary bridge document references `{id, title, date?}`.
  Warranty papers and receipts belong in `documents`; manuals in `manuals`.
- `devices`: `[{id, name?, state?, entities: [{id, state?}]}]` from Habitat's exact
  shared identity references, with no control actions.
- `alerts`: `[{id, title, state?, detail?, since?}]` linked to that identity.

Bridge owns the join and authorization for every returned field and document.
Unknown facts are null and absent lists empty; unavailable upstream data must not
be reported as a successful empty read. A missing thing is 404; forbidden is 403.
Deck shows a retryable error without retaining another thing's data. Empty alerts
say “No indexed alerts”, which does not claim the device is healthy. Lists use
shared search and paging, and documents open in the shared viewer.
