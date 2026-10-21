# Money

`mountMoneyPage(element, host, options)` mounts the shared Deck shell, Money navigation and the selected Money page. It returns the
common page handle: `{bar, page, ready, unmount()}`. The content graph and required styles load on demand; `ready` includes the initial
page read. Unmount removes the page's listeners, drawers and pending rendering.

Options include the normal shell options (`nav`, `brand`, `site`; on deck.wang.team `site: true`, [The site](shell-bar.md#the-site)) and:

- `path`: current pathname, including its base; defaults to the element's document pathname.
- `query`: query string; defaults to the element's document search.
- `basePath`: `/money` on Deck, or `''` for a backend served at its root.
- `onNavigate(href)`, `onReplace(href)`: navigate or replace URL state. Money hrefs include `basePath`; export links retain their API
  paths. `href` supplies the full current URL for an OAuth return.
- `onTitle(title)`: update the consumer's document title when a merchant detail names it.
- `owner`: the browser consumer's owner-session adapter described below. Shells never use this adapter.

Pages preserve Purser's transaction filtering, paging, saved views, transaction lineage, correction previews and Undo; overview,
reports, merchants, classification, accounts, review, imports, investments, subscriptions, connections and tax spending share the
same renderer. Amounts remain integer cents and report calculations retain Purser's semantics.

Standard reads use the 18 `money.*` operations in [Host](host.md#money-reads). A host without the `money` capability shows
the unavailable state. Native hosts require an explicitly enabled read capability; the renderer does not acquire credentials or
enroll a device. Owner-only controls offer the web destination when the host cannot perform them.

## Browser owner adapter

Purser supplies its existing session and JSON transports as `owner`:

```
{get(path), post(path, body), session(), signIn(),
 prompt(message, initial?), confirm(message), alert(message), reload(),
 storage: {local, tab}, plaid: {load()}}
```

Paths are backend-relative `/api/...` paths. The consumer rebases them to its own base and preserves owner-session enforcement;
the shared renderer neither stores credentials nor exposes owner writes as device operations. `session()` returns the existing
`{owner, configured}` state. `signIn()` returns the existing return-to URL. `plaid.load()` loads the existing Plaid Link SDK only
on the connections page. Export navigation and OAuth URL replacement use the supplied navigation callbacks.

This adapter preserves browser behavior outside the read-only device contract: owner-session reads, previews, corrections,
review answers, account and classification changes, saved-view writes, imports, Plaid Link and exports. Purser remains the
authority for authorization and validation. No owner adapter is sent to a native shell.

Port source and parity fixtures are retained with the Money renderer until the published path has completed a real browser run.

Money has six primary routes: `/money` (Overview), `/money/transactions`, `/money/review`, `/money/spending`,
`/money/accounts` and `/money/rules`. Transaction filters stay in the query string. Spending sections are
`/spending/merchants`, `/spending/merchant?id=ID`, `/spending/recurring` and `/spending/tax`; Accounts sections are
`/accounts/connections`, `/accounts/imports` and `/accounts/investments`; Categories is `/rules/categories`; `/link/oauth` is
the OAuth return registered with Plaid (all relative to the Money base). The one table is `src/money/routes.js`: Purser
imports it from its vendored bundle and serves the Money shell at exactly those paths; any other path is the shared not-found
state (`PageState` `not found`) with HTTP 404. On the web a Money link changes the page in place and pushes its address (Back
and Forward return; a reload or deep link of any route loads it); Connections alone is a page load, as only its document's
policy allows Plaid Link. Tabs scroll horizontally on phones.

Transaction drawers use `/transactions?txn=ID` alongside the current list filters. Opening a row adds browser history;
Back closes the drawer and Forward restores it. A direct link reads the transaction even outside the loaded page.
Merchant details open inside that drawer and return to the transaction without replacing the list.
Accounts lists each institution's accounts as one list, a bank account not linked to the ledger beside them. A row opens
`/accounts?detail=ID`: balance, history, last activity and bank link, a link to all its transactions, and for the owner its
settings and the link's mapping (never an editor per account on the page). Recurring rows open `?detail=ID`: schedule, price
changes, documents, and for the owner the state as one choice.
The recurring renderer accepts optional fixture fields on a subscription: `next_coffee: {name, roaster?, roast_date?, ship_date?}`
and `shipment: {coffee?: {name, roaster?}, stage, date?, carrier?, tracking?, timeline?: [{stage, date?}]}`.
Dates are ISO dates; timeline entries are supplied in lifecycle order. Stages are `scheduled`, `roasting`, `shipped`,
`delivered`, `skipped` or `swapped`. The row shows the next coffee and the current shipment's reported stage and date;
its drawer shows the coffee, shipment and supplied timeline without inferring missing events. These optional fields are
not yet in Purser's published subscriptions contract; backend delivery remains part of FP-1951.
Overview spending links retain the displayed date range; review and uncategorised tiles open their lists.
Its bank sync banner reads Purser's connection status and links to Connections.

Investment statement linking searches `bridge.find` and confirms the selection with `bridge.doc` before the owner write.
The chooser shows document titles, dates and sources with the destination investment account; changing the query or account
clears the selection. Empty results and failed searches remain in the form for retry. Document IDs are transport values only.

Review combines reasons for each transaction, and a merchant's open category questions (Purser's `group`) into one card answered
together; it orders by absolute amount (largest first) and displays 50 cards per page. It reads Purser’s merchant-ordered API pages
before sorting; reason-specific answers remain separate, and selection includes every review on a card.

Every page shows one state in its body's place while it loads, fails (Retry) or has nothing, under its header and tabs; a signed-out
reader sees one owner notice (Sign in) where the owner could change things (`src/money/labels.js`). Money's words and figures come
from that file too: categories as `Food › Groceries`, codes as words, spending as money out and never negative (more refunded than
spent reads `+$12.00`; a refund month draws no spending bar). Transactions default to this month. For a dated list, the summary shows Spent and Received over the same filters
using the ledger's spending and income kinds, excluding transfers, card payments, investments and internal moves.
An all-dates list or a response without classified aggregates shows its count without monetary totals.
Totals never use an all-kind `sum_cents` or add up just the loaded rows.

Transaction detail resolves Purser’s explicit `purchase: {id}` through `bridge.purchases` by exact stable ID, following its cursors.
It links the purchase and its optional thing through the shared entity link. Null references make no Bridge read;
unavailable purchases and read failures stay in the drawer, with Retry for failures. Amounts and names never match records.
