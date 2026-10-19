# Things

The bundled `things` collection opens `?q=things` in the shared palette on web, Mac,
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
The drawer shows cached specs, purchase facts, receipts and the cached
product photo and the full, unchanged name in its heading. Purchase history and
non-owned products remain available through Bridge detail and Find; a purchase is
not proof of ownership. Unknown facts stay unknown.
Cached photos use the allowlisted `/v1/thing-image/<sha256>` resource through the
host; arbitrary remote images are never loaded. Receipts open in the shared viewer.
Web consumers must expose the authenticated `/api/things`, `/api/thing/<id>` and
`/api/thing-image/<sha256>` routes using bridge's existing access policy.
