# Purchases

Library links to `/purchases`, mounted by `mountCollectionPage` or `mountPurchases`.
Things also includes a Purchases button on every shared UI host. It opens
purchase history independently of the owned-product catalog, as a section above
the owned things. One name, Purchases, for the nav entry, the page and that section. Category filtering
and paging read `bridge.purchases` through the backend registry; receipts open
in the existing document viewer. Read errors offer Retry and clear stale rows.

## Bridge integration contract (FP-1246)

This endpoint is required backend work, not yet present on bridge main.
`GET /v1/purchases` (`/api/purchases` on web), scope `bridge:find`, accepts
`limit` (40), optional opaque `cursor`, and optional category id `category`.
A response is `{results, categories, nextCursor}`. `categories` is the full
unified taxonomy as `[{id, path}]`; `nextCursor` is a string or null. Filtering
includes descendants and happens before paging. Results are newest first.

Each result is one categorized purchase item, not an owned thing:
`{id, name, category: {id, path} | null, merchant, date, orderNumber?,
total: {amount, currency}, document?: {id, title}, charges: [{id, date,
account?, amount, currency}]}`. Dates are ISO dates. Amounts are numbers in
major currency units, never cents. `total` is the item's purchase amount;
missing amounts are null, never zero. IDs are stable strings; document ids
follow bridge's existing document contract.

Bridge joins only confirmed typed order-to-charge links. An unmatched item has
`charges: []` and remains visible. Split charges remain separate. A charge can
appear on several items; Deck never adds it to the purchase amount or sums it
across items. Null category displays Uncategorized. Returned and cancelled
history is not treated as ownership. No client-side categorizer or matching.
