# Host

## Host object

```js
host = {kind: 'web' | 'shell', hostApi: 1, caps: {recent, transfers, actions, clipboard, files, drag, menus, window, telemetry, picks, browse, usage, corrections, texts, needs, codes, money, tower},
        call(op, args, {signal, onWarming?}) → Promise, resource(path) → URL, on(event, fn) → unsubscribe}
```

- `call` rejects with `{code, status?, message}`; codes `unreachable`, `http` (`status`), `not-set-up` (no bridge token),
  `unsupported` (an op this host lacks, or its cap is off), `refused` (args off the schema, no recent input), `cancelled` (the
  signal). A `call` bridge answers 503 `warming` (its collections just after a start: bridge CONTRACT.md *Errors*) is asked again quietly
  after its `retry-after` (1–30 s, default 5 s) for up to about 10 minutes before it rejects (host.js `untilWarm`, both hosts; a bridge
  restart warms for 6–8). Optional `onWarming` reports each retry, from the first 503, so pages show "Starting up" at once.
  Collections and Find keep successful answers in bounded host-scoped memory and show “Starting, showing your last data” (Find: “…your last
  results”) during warm-up, or “Starting up” with nothing kept yet. Answers are keyed by operation and arguments, never persisted to storage.
- A cap off: the UI hides what needs it and never calls its ops. The site: `actions`, `clipboard`, `picks`, `browse`, `usage`,
  `corrections`, `texts`, `needs`, `money`; also `codes` and `tower` (the owner's AI plans and Fleet on the phone landing, `bridge.tower`)
  for an owner session. `browse` (the site's filtered browse), `usage` (a series' chart), `corrections` (the owner's corrections in
  the Details pane), `texts` (Texts: palette SPEC.md *Texts*) and `needs` (Needs you: palette SPEC.md *Needs you*) are off on a shell
  unless its env.get's `caps` says so: both desktops say `usage`, `corrections` (bridge's `POST /v1/doc/<id>/correct` with the device
  token, past Caddy since 2026-10-14), `texts`, `needs` and `codes` (owner-only one-time codes on every host: palette SPEC.md *Codes*); `browse`
  and `tower` remain off.
- `resource(path)` takes a `/v1/…` path from the [resource allowlist](resources.md) and answers the URL to load; anything else throws `refused`.

Codes are owner only on web, Android, Mac and Windows. Hosts authorize `codes.list` and `codes.copy` and withhold
`codes.changed` from guests and non-owner sessions. Values stay in memory, never persisted or logged; unknown or expired IDs
are `refused`. During `env.get`, web hosts probe same-origin `GET /api/codes` with the site session,
no cache and no redirects; only HTTP 200 with a valid codes list enables `caps.codes`. Denial or error disables it and
clears held values. `codes.list` refreshes authorization and the in-memory list; `codes.copy` accepts only a held ID,
checks its source timestamp (15 minutes) and server expiry, and writes only the code to the browser clipboard.
This is the session twin of bridge’s device-authenticated `GET /v1/codes`; browser requests use cookies and no-store.
ISO `at` and `expires` become epoch milliseconds for expiry checks. Every landing puts Codes first while fresh;
Enter or tap copies only the code and expiry removes the row. After authorization, webHost subscribes to same-origin `/api/events` with the owner session and forwards
SSE `code` events as `beacon.code` with `{id}` only; the host emits `codes.changed` to refresh the list.
EventSource reconnects using the server retry interval; each connection refreshes the list to recover missed events.
Authorization failure, pagehide and `host.dispose()` close the stream; pageshow restores an authorized subscription.
Bundle publication follows the normal deck-ui release; bridge pin adoption is tracked in flightplan item:854.

## Mount loading

`ui/src/mount.js` loads each mount's modules and required styles on demand. All mounts return a handle synchronously,
with `ready` resolving once its modules, styles and mount initialization are ready; page data may still be loading.
Model getters (`controller`, `viewer`, `house`, and the collection name) start null; await `ready` before reading them. Existing handle actions (`open`, `find`, `refresh`, `update`, etc.)
queue during loading. `draw()` before loading is a no-op. `unmount()` cancels queued actions and prevents a pending import from
constructing or painting a page. Import failures reject `ready` and show a reload message. Unsupported House/Accounts return
null models immediately. Collection/Health page wrappers expose `page` synchronously and `ready` for both page and shell.

## Operations

| Op | Args | Result | Web (`host/web.js`) | Shell |
|---|---|---|---|---|
| `env.get` | – | `{platform, mod, theme, highContrast, reduceMotion, bridgeSetUp, version, caps?, restore?}` | the browser | native; `caps` sets the host's; `restore` once ([Deck's own window](shell.md#decks-own-window)) |
| `bridge.find` | `{q, limit?, phase?: "words" | "full"}` | `{results, progressive?, enrichment?, phase?, complete?}` | `GET /api/find` | `GET /v1/find` |
| `bridge.ask` | `{q}` | bridge's answer | `GET /api/ask` | `GET /v1/ask` |
| `bridge.doc` | `{id}` | the document | `GET /api/doc/<id>` | `GET /v1/doc/<id>` |
| `bridge.collectionDetails` | `{kind: person\|cluster\|property, id, cursor?, limit}` | `{entity, papers: [{document, kind?, expiry?, renewal?}], total?, cursor}`; newest first, at most 20 | `GET /api/collection-details` | `GET /v1/collection-details` |
| `bridge.pages` | `{id, message?, attachments?, q?}` | the pages answer; `retryAfter` (s) when bridge sent `Retry-After` (a video being prepared) | `GET /api/doc/<id>[/message/<m>][/attachment/<a>…]/pages` | `/v1/…` |
| `bridge.conversation` | `{id, cursor, dir}` | next messages | `GET /api/doc/<id>/conversation` | `/v1/…` |
| `bridge.texts` | `{cursor?, limit?}` (cap `texts`) | `{conversations, next}` (bridge CONTRACT.md, *Texts, the list*) | `GET /api/texts` (same suffix and query as shell) | `GET /v1/texts` |
| `bridge.textsPages` | `{conv, message?, attachments?}` (cap `texts`) | a conversation at its newest message, or a message's attachment: as `bridge.pages` | `GET /api/texts` (same suffix and query as shell) | `GET /v1/texts/<conv>[/message/<m>][/attachment/<a>…]/pages` |
| `bridge.textsConversation` | `{conv, cursor, dir}` (cap `texts`) | next messages, as `bridge.conversation` | `GET /api/texts` (same suffix and query as shell) | `GET /v1/texts/<conv>/conversation` |
| `bridge.related` | `{id, kinds?, limit?}` | Related | `GET /api/related/<id>` | `/v1/…` |
| `bridge.cluster`, `bridge.day`, `bridge.subject` | `{id}`, `{date}`, `{name}` | the group's documents | `GET /api/cluster/<id>`, `/api/day/<date>`, `/api/subject?name=` | `/v1/…` |
| `bridge.facets` | – | `{sources, types, years: [{v, n}]}` | `GET /api/facets` | unsupported (cap `browse`) |
| `bridge.browse` | `{source?, type?, year?, sort?: newest\|oldest}` | `{results: [{id, title, type, date, period, source, url, mails}]}`, 500 at most | `GET /api/browse` | unsupported (cap `browse`) |
| `bridge.usage` | `{doc}` | `{series: Chart \| null}` (*Chart*): the usage series holding that document | `GET /api/usage?doc=` | `GET /v1/usage?doc=` |
| `habitat.actions` | – | `{actions}` | Habitat entities + states | Habitat entities + states |
| `habitat.run` | `{id}` | `{ok, title, state, shadow}` | Habitat act, then state | Habitat act, then state |
| `bridge.correct` | `{id, action, set?, fields?, fact?, wrong?, value?, subject?, into?, fold?, token?, undo?}` (cap `corrections`, gesture) | `{document, undo?}`, or for `reread` `{document, preview}` | `POST /api/doc/<id>/correct` (bridge checks Origin and the owner) | `POST /v1/doc/<id>/correct`, the args but `id` as the JSON body |
| `bridge.matches` | `{name, q?}` (cap `corrections`) | `{matches: [{name, kind, documents}]}` | `GET /api/subjects/match` | `GET /v1/subjects/match` |
| `bridge.needs` | – (cap `needs`) | `{needs: [Need]}` (spaceport shared/backend/needs.md, *Needs*) | `GET /api/needs` | `GET /v1/needs` |
| `bridge.need` | `{id}` (cap `needs`, gesture) | `{ok, message}`: a need's `op` action, run by bridge | `POST /api/needs/<id>` (bridge checks Origin) | `POST /v1/needs/<id>` |
| `bridge.prefetch` | `{paths}` | – | nothing | warms the speed layer (resource paths only) |
| `document.open` | `{id}` | – | new tab `/api/doc/<id>/file` | download to temp, open (runnable files revealed); 404 → its page |
| `document.page` | `{id, url?}` | – | new tab: `url`, else `/doc/<id>` | OS browser: `url`, else `/v1/doc/<id>`'s, else `<bridge>/doc/<id>` |
| `url.open` | `{url}` (http, https, mailto, tel) | – | new tab | OS browser |
| `map.open` | `{by: day\|cluster\|subject, value}` | – | new tab `/map?<by>=` | OS browser |
| `clipboard.copy` | `{text, sensitive?}` | – | `navigator.clipboard` | native (`sensitive`: kept out of clipboard history) |
| `recent.list/copy/open/reveal/remove/clear` | `{}` / `{id}` | `{items: [{id, at, direction, kind, peers, preview?, link?, name?, size?, type?, path?, thumb?}]}` (`thumb`: `/local/recent/<id>/thumb` serves one) / – | unsupported | `deck` CLI and the OS |
| `codes.list` | – (cap `codes`) | `{codes: [{id, code, from, at}]}`: the one-time codes of the last 15 minutes, newest first, `at` epoch ms (palette SPEC.md *Codes*) | owner session’s in-memory code source | owner device’s memory |
| `codes.copy` | `{id}` (cap `codes`) | –; `refused` once the host no longer holds it | owner session: the code alone onto the browser clipboard | owner device: the code alone onto the native clipboard, out of clipboard history where supported |
| `devices.targets` | – | `{targets: [name], enrolled?: [name]}` (`enrolled`: those that can receive; another is dimmed, refused) | unsupported | `deck devices` |
| `transfer.send` `{to: [name] \| null}`, `.receive`, `.share` | | `{message, item?}` | unsupported | `deck send/receive/share` |
| `drag.start` | `{row, kind: recent\|identifier\|link\|document, recent?, text?, id?, name?}` | – | unsupported (the browser's own drag) | a native drag session: Recent's item (text, image or file), the text, a document's file (downloaded when dropped) |
| `menu.popup` | `{items: [{id, label, key?}], at: {x, y}}` (the page's CSS px; `key` a model key name, `Mod+Enter`, the shell draws as the item's shortcut) | `{id}`: the item chosen, or `{id: null}` | unsupported (the browser's menu) | a native menu |
| `files.pending`, `window.resize {height, width?}`, `window.hide {reason?}` | | – | unsupported | native |
| `window.preview` | `{path: resource path \| null, neighbours?: [path]}` (at most two neighbours) | boolean: shown beside the palette; false requests above-list fallback | unsupported | passive owned image window, top aligned, aspect kept, up to 60% of the work area height; allowlisted resources only; null and palette hide dismiss it |
| `window.drag` | – | –, once the button is let go | unsupported | the OS moves the window with the mouse (*Moving the window*) |
| `window.popOut` | `{state?}` (≤ 1,000,000 chars) | –, once it shows | unsupported (a tab already) | Deck's own window, opened or brought forward, on `state` (*Deck's own window*) |
| `prefs.get {key}` / `prefs.set {key, value}` (the UI's keys: `rail`, `details`, `recentCount`) | | `{value}` / – | localStorage | the prefs file |
| `picks.list` / `picks.add {id}` | | `{picks: {id: ms}}` / – | localStorage (200 latest) | the picks file |
| `telemetry.event` | `{name, ok, ms, detail?}`; names `palette_open`, `find`, `ask`, `find_file`, `view`, `related`, `group`, `transfer`; detail `results:<n>`, `rules:<n>` (a find Deck's rules answered: no bridge or model call) or `status:<code>` | – | nothing | the ndjson queue |

### Shared Texts mount

Both shared mounts are named exports of `ui/src/mount.js` (first published together in 0.1.315).

`mountTexts(element, host, {onOpen?})` exports the read-only Texts page: the conversations and the shared conversation viewer.
From 720 px wide the list and the open conversation sit side by side, each scrolling in its own pane under the page's header; narrower,
the list, and an open conversation over the whole screen with its Back. The page sizes itself; the host gives it the document.
Requires `texts`; uses `bridge.texts`, `bridge.textsPages`, `bridge.textsConversation`, attachment and portrait resources and `url.open`.
`onOpen(document)` overrides the built-in viewer (`document.id` is `texts:<conversation>`).
Rows: the registry's portrait (bridge's `person.photo`) or initials for a person or a group, a glyph for a business; who (a number
that names itself at the head of its text by that name), when, the newest message on one line with links as their site (`urlsText`).
People (bridge's `kind` `person`; without it, any named conversation) first, then Businesses & alerts, their one-time codes folded
into one row; one search over names and newest messages. The returned `{texts, refresh(), unmount()}` reads immediately, adds the
next page under the list with More conversations, and replaces its snapshot on refresh. Unmount aborts pending list reads and resets
the viewer. No polling, mutations or count notifications: bridge exposes no unread state. Enter opens, Mod+Enter (or Mod+click) opens
Google Messages.

### Money reads

All `money.*` operations require `money`. The web host enables it and uses the Deck Money surface at same-origin `/money/api`, including when mounted on another Deck page. Shells default it off until `env.get` explicitly enables it; disabled calls reject `unsupported` without a native message. Enabled shells implement the documented `/money/v1` reads using an enrolled device credential with `purser:read`. Paths are relative to the Deck origin; a backend at its root uses `/v1` instead. Results and query semantics follow [Purser CONTRACT.md](https://github.com/FloorLamp/purser/blob/main/CONTRACT.md). No session, mutation, preview or undo operations are exposed.

Arguments are flat objects; `?` means optional. IDs are positive integers; limit is 1–200 and offset nonnegative. Spending accepts inclusive YYYY-MM-DD dates, category/merchant group and month grain. Transaction filters and sort use Purser’s documented values; category accepts comma-separated IDs.

| Operation | Arguments | Result | Web | Shell (purser:read) |
| --- | --- | --- | --- | --- |
| `money.overview` | `{}` | Overview totals and review counts | `GET /money/api/overview` | `GET /money/v1/overview` |
| `money.spending` | `group?, grain?, from?, to?` | Spending reports by category or merchant and month | `GET /money/api/spending` | `GET /money/v1/spending` |
| `money.merchant` | `id` | Merchant details | `GET /money/api/merchant/<id>` | `GET /money/v1/merchant/<id>` |
| `money.rules` | `{}` | Classification rules, categories and suggestions | `GET /money/api/rules` | `GET /money/v1/rules` |
| `money.categories` | `{}` | Classification rules, categories and suggestions | `GET /money/api/categories` | `GET /money/v1/categories` |
| `money.accountManagement` | `{}` | Ledger account inventory, mapping choices and people | `GET /money/api/account-management` | `GET /money/v1/account-management` |
| `money.views` | `{}` | {views: [{id, name, state}]} | `GET /money/api/views` | `GET /money/v1/views` |
| `money.imports` | `{}` | {imports: [Import]} | `GET /money/api/imports` | `GET /money/v1/imports` |
| `money.link` | `{}` | Connection status and account mapping; configured, env, redirect_uri | `GET /money/api/link` | `GET /money/v1/link` |
| `money.merchants.resolve` | `name` | Exact merchant resolution status and candidates | `GET /money/api/merchants/resolve` | `GET /money/v1/merchants/resolve` |
| `money.txns` | `q?, account?, merchant?, category?, from?, to?, preset?, kind?, min?, max?, sort?, limit?, offset?` | {total, sum_cents, items}; integer cents, outflow negative | `GET /money/api/txns` | `GET /money/v1/txns` |
| `money.txn` | `id` | Transaction detail, account/category, explanation, transfer counterparts, splits, sources, edits, children, merged and active links | `GET /money/api/txn/<id>` | `GET /money/v1/txn/<id>` |
| `money.facets` | `{}` | {accounts, categories} | `GET /money/api/facets` | `GET /money/v1/facets` |
| `money.reviews` | `kind?, limit?, offset?` | Review queue with kinds in tab order | `GET /money/api/reviews` | `GET /money/v1/reviews` |
| `money.needs` | `{}` | {needs: [Need]} | `GET /money/api/needs` | `GET /money/v1/needs` |
| `money.subscriptions` | `{}` | Subscription groups and recurring payments | `GET /money/api/subscriptions` | `GET /money/v1/subscriptions` |
| `money.accounts` | `{}` | {accounts, generated}; shared Accounts contract | `GET /money/api/accounts` | `GET /money/v1/accounts` |
| `money.investments` | `{}` | Investment accounts, holdings and gains | `GET /money/api/investments` | `GET /money/v1/investments` |

### Shared Attention mount

`mountAttention(element, host, {onCount?, onOpen?})` returns `{attention, refresh(), unmount()}`.
It reads `bridge.attention`, `bridge.gaps`, and `bridge.ignored` immediately; no polling.
Sections are locked, unsupported, gaps, coverage and ignored. `onOpen(document)` overrides opening the document page.
The model's `setTab(tab)` selects a section. `mutate(action, ids, password?)` accepts retry, dismiss, gap and restore,
using `bridge.attentionRetry`, `bridge.attentionDismiss`, `bridge.gapDismiss` and `bridge.restore` respectively.
Document mutations take non-empty arrays of positive integer IDs; gap dismiss takes non-empty arrays of string IDs.
Only retry accepts an optional password (at most 1000 characters); mutation results are `{left}` for retry
and `{ok}` for dismiss, gap dismiss and restore. While busy, further mutations are ignored.
Reads return `{items: [{id, kind: locked|unsupported, title, sourceId, problems}]}` for attention,
`{gaps, older, coverage}` for gaps, and `{results: [Document]}` for ignored files.
These map to POST `/api/attention/retry`, `/api/attention/dismiss`, `/api/gaps/dismiss`, `/api/restore`
(cap `browse`, site-only); reads use GET `/api/attention`, `/api/gaps`, `/api/ignored`.
The default opener uses `document.page`.
Passwords are used once, cleared from the form on submit and never retained in model state.
Each refresh replaces the snapshot only after all three reads succeed; a newer refresh cancels the previous read.
Failed reads retain the last successful lists and count. After successful mutations the snapshot is refreshed.
`onCount(number)` fires for the first successful snapshot and
whenever locked documents plus recent gaps changes; unchanged refreshes and failed mutations do not notify.
Unsupported files, older gaps and ignored documents do not contribute. This is a document maintenance count, separate from Needs.
Unmount aborts pending reads and mutations, suppresses late results and calls `onCount(null)` once so the host removes its badge.
Mutation errors remain visible with Retry. The shared rows support desktop and narrow layouts.

The host owns refresh timing for focus and external changes: neither mount subscribes to events or emits
`deck-attention-changed`. Consumers call `refresh()` explicitly and remove their listeners when unmounting.
`onCount` reports snapshots, not every mutation. The error Retry control refreshes the snapshot;
retrying a failed mutation requires invoking that action again. For the first published version with both mounts,
see the [adoption note](../CONSUMERS.md#texts-and-attention-adoption-spaceport-767-bridge-270).
Consumers use the separate [Unified Needs snapshot](../CONSUMERS.md#unified-needs-spaceport-830-bridge-287)
for Needs badges.

## Shared Clusters mount

`mountClusters(element, host, {id?, onOpen?})` exports the document-undertaking page,
labelled **Clusters** to match bundled `nav.json` (`clusters`, `/clusters`).
`mountCollectionPage` also resolves `/clusters`. Returns `{clusters, refresh(), unmount()}`.
`id` opens a cluster after the first list read; `onOpen(document)` overrides the shared
viewer. Back from the viewer retains the collection. Map is the item overlay, not a page.
Activity is excluded. Flightplan's projects are `mountProjects` ([flightplan.md](flightplan.md#projects)).

The `clusters` capability is enabled on the web host only. Bridge requires the owner's
existing authenticated browser session; mutation POSTs require its same-origin Origin.
Native hosts must leave this capability off: Bridge does not expose these writes on `/v1`.
No credentials are passed in mount options. Unsupported operations use the standard host error.

`bridge.clusters {all?: boolean}` reads `GET /api/clusters` (`all=true` adds `?all=1`).
It returns `{clusters}` with stable `p_` ids, name, kind, state, summary, count, from/to
and namedBy. Default excludes set-aside rows; filtering name/kind/summary is local.
`bridge.cluster {id}` reads the canonical cluster, `documents` and `out` (taken-out
documents), with normal document descriptors. A merged id can resolve to a different id.

`bridge.clusterEdit {id, action, ...payload}` posts only payload to
`/api/cluster/<id>/<action>` and returns `{id}` (the canonical destination):

| action | payload | meaning |
| --- | --- | --- |
| rename | `{name}` nonblank | Owner's display name |
| remove / restore | `{}` | Set aside / recognize as a cluster |
| remove-members / add-members | `{ids}` positive document ids, at most 1000 | Take out / put back |
| merge | `{clusters}` source cluster ids | Merge sources into target `id`; explicit Confirm merge button |
| split | `{ids, name}` selected members and nonblank name | New cluster, returned id |

Edits are serialized and controls disabled while pending. Success reloads the list and
destination detail; failure retains the current detail and shows an error. Refresh replaces
snapshots, no polling. Superseded list/detail reads and unmount abort pending requests;
late responses are ignored. Aborting a write cannot undo a server edit: remount/refresh
reads authoritative state. Empty/loading/error states are explicit; Retry repeats the read,
never the write. Documents use the shared viewer's documented operations and resources.

### Collection page URL state

Standalone inline viewers (People, Vehicles, Properties, Insurance, Papers, Taxes, Things,
Texts and Clusters) push `?doc=<positive document id>` (Texts uses `?doc=texts:<conversation id>`) on the current route. Back closes
the viewer; Forward reopens it. Close uses Back for a document opened here; a direct
`?doc=` link closes in place. The mounted list, filters, drawer and list scroll survive.
Invalid document ids are ignored. An explicit `onOpen` retains the host's navigation.

Collection drawers replace the hash with the encoded item id (Taxes uses its year).
Reload restores the drawer; `hashchange` opens or closes it after mount. Embedded
palette collections retain local selection. Unmount removes navigation listeners.

Android Recent rows expose `recent.share` (id, `recentShare` capability; opens the system chooser without sending) through the native share sheet. Android swipe removal uses
`recent.remove`; the host hides the item while offering Undo and commits deletion after the offer or activity closure.

House palette controls use `habitat.actions` and `habitat.run`. The shared host adapter builds the list from
`habitat.entities` and `habitat.states`, using Deck's listed-action mapping. `GET /v1/actions` is Habitat's audit log,
not a control catalog. Run accepts only an id in the last successful list and sends its mapped Action once via
`habitat.act` (POST `/v1/actions`, web `/habitat/api/house/actions`), with the host's gesture gate intact.
HTTP 200 with `ok: false` is a failure. A successful dispatch reads `habitat.state`; a shadow result says
“recorded in shadow”. No automatic retry or HA fallback occurs. Destinations and grants come from the Habitat registry;
entities/states require `habitat:read`, dispatch requires `habitat:api`. Mac serves these ops natively with the same
listed-action mapping, retaining the last list and emitting `actions.changed` after a changed refresh.
