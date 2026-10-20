# Papers

`mountPapers(el, host, {onOpen?, links?})` reads `bridge.papers` (`GET /v1/papers`,
web `GET /api/papers`, device scope `bridge:find`). Returns
`{papers, refresh(), unmount()}`; `links` (`[{label, href}]`, the host's related pages) sit beside
Refresh in the page header, never above it. Find's `papers` row opens the page.

Bridge answer rows carry `{paper, state}`. Paper supplies `{id, person: {id, name},
kind, scope, number, expiry, document, renewal, documents}`; expiry is ISO or null,
state current/expired/unknown, renewal a pending application's document or null.
Rows show holder, kind, expiry and renewal state. RowList, Drawer and StatTiles show
the paper and its source documents, including the renewal application, opened in the
shared viewer. Missing expiry remains unknown; absence of a pending application does
not establish that renewal is unnecessary. No identity numbers appear in list rows.

The shared shell bar only offers Papers after its host successfully reads the route.
An absent host, denied scope or failed read hides it. Publishing/adoption follows
CONSUMERS.md; web and Android's hosted Deck page require bridge to adopt the bundle.
