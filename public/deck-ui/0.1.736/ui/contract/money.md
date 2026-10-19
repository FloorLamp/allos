# Money

`mountMoneyPage(element, host, options)` mounts the shared Deck shell, Money navigation and the selected Money page. It returns the
common page handle: `{bar, page, ready, unmount()}`. The content graph and required styles load on demand; `ready` includes the initial
page read. Unmount removes the page's listeners, drawers and pending rendering.

Options include the normal shell options (`nav`, `brand`, `needsSource`) and:

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
`/accounts/connections` (with `/oauth` for returns), `/accounts/imports` and `/accounts/investments`; Categories is
`/rules/categories` (all relative to the Money base). Tabs scroll horizontally on phones. Old URLs are replaced once
through `onReplace`, retaining query parameters; they render the canonical page, with no legacy page mount.

Transaction drawers use `/transactions?txn=ID` alongside the current list filters. Opening a row adds browser history;
Back closes the drawer and Forward restores it. A direct link reads the transaction even outside the loaded page.
Merchant details open inside that drawer and return to the transaction without replacing the list.
Account rows open `/accounts?detail=ID`, showing imported history, connection state and the ledger-wide import log
(the imports API does not identify accounts), with a link to all transactions for that account.
Overview spending links retain the displayed date range; review and uncategorised tiles open their lists.
Its bank sync banner reads Purser's connection status and links to Connections.

Investment statement linking searches `bridge.find` and confirms the selection with `bridge.doc` before the owner write.
The chooser shows document titles, dates and sources with the destination investment account; changing the query or account
clears the selection. Empty results and failed searches remain in the form for retry. Document IDs are transport values only.

Review combines reasons for each transaction, orders by absolute amount (largest first), and displays 50 cards per page.
It reads Purser’s merchant-ordered API pages before sorting; reason-specific answers remain separate, and selection includes every reason on a card.
