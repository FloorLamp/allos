# Collection search and paging

People, Vehicles, Properties, Insurance, Papers, Taxes, Things and Clusters search
before paging. People searches Bridge's authoritative compact people projection;
other collections search the loaded metadata snapshot. A result beyond the current
page remains findable. Search never reads document bodies or starts detail requests.

Collection lists render 40 rows per page; nested document, checklist, photo,
specification and membership groups render 20. A list has one search (`CollectionSearch`): shown once it runs past
one page or 20 records, or a query is typed; never over its loading, starting, failed or empty state, which the
shared state components say once. Its status is the result count only. A page with its own search (Money) passes
`search: false` to `mountRows`. Selection uses canonical IDs and
survives filtering and paging. Cluster checkboxes retain selections across pages;
merge destinations are searchable and must still be active at confirmation.

Properties show membership first. Only the visible
20-paper page hydrates explicit expiry/renewal fields, with at most four document
reads in flight. Dates cache by document ID; page changes cancel obsolete reads,
refresh clears the cache and Retry reads failed visible dates. Unloaded dates are
labelled as unloaded; missing renewal messages refer to the displayed papers.

Find shows each collection (these, Purchases, Texts, Notes and Sign-ins: nav `collection: true`) as one
Collections row that opens its page; it never draws a collection page inline. A record the words name leads Find, above
the house actions (palette SPEC.md, *Records*): the site opens it on its collection's page with its drawer open
(`/vehicles#<id>`: `mountPalette`'s default), the desktops in the palette's pane. Palette results, collection pages and
generic row Details reuse the same collection detail components. Enter, Space, Right, Tab, click and Details preserve explicit
collection identity through viewer history and pop-outs. Old saved person, product
and cluster groups restore those details. Full loaded membership remains searchable;
only the current page becomes rendered rows or keyboard candidates.

Bridge's separate cursor-based `bridge.collectionDetails` API remains registered for
external consumers; the shared collection details use the authoritative entity projection.

Vehicle photo searches start only for visible expanded cars, cancel when hidden,
and cache until Refresh. Telemetry remains independent of card expansion.
