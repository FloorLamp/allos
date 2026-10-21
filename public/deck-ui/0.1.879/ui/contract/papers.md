# Papers

`mountPapers(el, host, {onOpen?, links?})` reads `bridge.papers` (`GET /v1/papers`,
web `GET /api/papers`, device scope `bridge:find`). Returns
`{papers, refresh(), unmount()}`; `links` (`[{label, href}]`, the host's related pages) sit beside
Refresh in the page header, never above it. Find's `papers` row opens the page.

Bridge answer rows carry `{paper, state}`. Paper supplies `{id, person: {id, name},
kind, scope, number, expiry, document, renewal, documents, replacedBy?}`; expiry is ISO or null,
state current/expired/unknown, renewal a pending application's document or null, optional
`replacedBy` the id of the newer paper of the same person, kind and scope (null: not replaced;
bridge FP-1692).
Rows show holder, kind, expiry and renewal state. RowList, Drawer and StatTiles show
the paper and its source documents, including the renewal application, opened in the
shared viewer. Missing expiry remains unknown; absence of a pending application does
not establish that renewal is unnecessary. No identity numbers appear in list rows.

## Order

`paper-standing.js`, one rule for Papers and Find's credential answers (bridge's rows carrying
`paper`). Replaced: bridge's `replacedBy` where the paper carries the field; without it (until
FP-1692 ships, then this fallback goes), an expired paper whose holder and kind have a current
paper expiring later, scopes agreeing (an issuer's name must match; a masked or numbered scope
is the paper's own identifier and matches any). Within each holder: needs action first
(expired and not replaced, or current and expiring within 90 days; soonest first; Expired red,
Expiring amber), then current by kind and expiry, then expiry unknown, then the replaced, folded
into one `Replaced (n)` line at the group's end that opens in place (open while searching). A
replaced paper shows a neutral Replaced chip and asks for no renewal. Find keeps bridge's order
but puts what needs action first and the replaced last among its credential rows, a replaced
one's line starting `Replaced`.

The shared shell bar only offers Papers after its host successfully reads the route.
An absent host, denied scope or failed read hides it. Publishing/adoption follows
CONSUMERS.md; web and Android's hosted Deck page require bridge to adopt the bundle.
