# Taxes

Find's Taxes row opens the bundled `taxes` collection page on every host.
`mountTaxes(element, host, {onOpen?})` mounts it independently; documents use the existing viewer.

`bridge.taxes` reads bridge `GET /v1/taxes` (web: `/api/taxes`) and returns
`{results: [{year, subtitle, done, total, missing: [{id, person, kind, scope}]}]}`.
Only returned years are listed, using bridge's subtitle for found/expected counts and top missing
forms, prior-year forms first. Older responses without a subtitle retain the checklist summary.
The shell bar shows Taxes only after this read succeeds, including an empty collection.
A missing device `bridge:find` scope hides the collection; denied reads clear stale data.

`bridge.taxPacket {year}` reads `GET /v1/taxes/<year>` (web: `/api/taxes/<year>`),
with integer year 2000–2099. The drawer shows `items` (person, kind, scope, state,
documents), `present`/`missing` counts, documents deduplicated by id, and bridge's
planning deadline and caveat. Missing items are expectations, never proof a form must be issued.
Reads are cancelled on refresh, close and disposal; late replies cannot replace the selected year.

Download ZIP opens the response's authenticated `export` URL through `url.open`.
It uses the browser's Deck session, including from native hosts; sign in if asked.
No public share, saved export or credential in the URL. Bridge owns the ZIP limits and errors.

Packets and ZIP manifests optionally include
`spending: {label: "Spending for tax review (Purser)", url: "https://deck.wang.team/money/spending/tax?year=YYYY"}`;
Find rows expose the same object as `tax.spending`. The packet drawer renders the supplied label
and opens the supplied URL through `url.open`; older packets without it omit the action.
Purser requires owner sign-in and category selection on the family network/VPN.
Bridge must not fetch, proxy, cache or copy CSVs or supply credentials.
This is household-wide spending for review even in person-filtered packets, never
established deductions or holder allocation. See [Purser's contract](https://github.com/FloorLamp/purser/blob/main/CONTRACT.md#yearly-spending-for-tax-review).

Web consumers must provide `/api/taxes` with the same owner/family-network access
as their existing per-year routes, then adopt the published bundle. Native hosts use
the device routes with `bridge:find`. Publication and consumer adoption follow README.md.

The missing web collection route and published-bundle adoption are tracked in
[bridge#244](https://github.com/FloorLamp/bridge/issues/244).
