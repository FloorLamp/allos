# Things

The bundled `things` collection opens `?q=things` in the shared palette on web, Mac,
Windows and Android. `mountThings(el, host, {onOpen?})` returns
`{things, refresh(), unmount()}` and uses the shared viewer for receipts.

`bridge.things` reads `GET /v1/things` (`/api/things` on web): product catalog
rows with a `thing` payload. `bridge.thing {id}` reads `GET /v1/thing/<id>`
(`/api/thing/<id>` on web): the product detail. Both require `bridge:find`.
The shell bar shows Things only after a successful list read, including an empty
list; denied or unavailable reads hide it.

Rows show name, kind (`type: product`), owner, store, purchase date and ownership
status. An absent owner is omitted from both rows and purchase facts; known names are preserved.
The drawer shows cached specs, purchase facts, receipts and the cached
product photo. Ordered, returned, sold and gifted products retain their explicit
status; a purchase is not proof of ownership. Unknown facts stay unknown.
Cached photos use the allowlisted `/v1/thing-image/<sha256>` resource through the
host; arbitrary remote images are never loaded. Receipts open in the shared viewer.
Web consumers must expose the authenticated `/api/things`, `/api/thing/<id>` and
`/api/thing-image/<sha256>` routes using bridge's existing access policy.
