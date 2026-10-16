# Host

## Host object

```js
host = {kind: 'web' | 'shell', hostApi: 1, caps: {recent, transfers, actions, clipboard, files, drag, menus, window, telemetry, picks, browse, usage, corrections, texts, needs, codes},
        call(op, args, {signal}) → Promise, resource(path) → URL, on(event, fn) → unsubscribe}
```

- `call` rejects with `{code, status?, message}`; codes `unreachable`, `http` (`status`), `not-set-up` (no bridge token),
  `unsupported` (an op this host lacks, or its cap is off), `refused` (args off the schema, no recent input), `cancelled` (the
  signal).
- A cap off: the UI hides what needs it and never calls its ops. The site: `actions`, `clipboard`, `picks`, `browse`, `usage`,
  `corrections`, `needs` only. `browse` (the site's filtered browse), `usage` (a series' chart), `corrections` (the owner's corrections in
  the Details pane), `texts` (Texts: palette SPEC.md *Texts*) and `needs` (Needs you: palette SPEC.md *Needs you*) are off on a shell
  unless its env.get's `caps` says so: both desktops say `usage`, `corrections` (bridge's `POST /v1/doc/<id>/correct` with the device
  token, past Caddy since 2026-10-14), `texts`, `needs` and `codes` (the one-time codes they hold: palette SPEC.md *Codes*); `browse`
  remains off.
- `resource(path)` takes a `/v1/…` path from the [resource allowlist](resources.md) and answers the URL to load; anything else throws `refused`.

## Operations

| Op | Args | Result | Web (`host/web.js`) | Shell |
|---|---|---|---|---|
| `env.get` | – | `{platform, mod, theme, highContrast, reduceMotion, bridgeSetUp, version, caps?, restore?}` | the browser | native; `caps` sets the host's; `restore` once ([Deck's own window](shell.md#decks-own-window)) |
| `bridge.find` | `{q, limit?, phase?: "words" | "full"}` | `{results, progressive?, enrichment?, phase?, complete?}` | `GET /api/find` | `GET /v1/find` |
| `bridge.ask` | `{q}` | bridge's answer | `GET /api/ask` | `GET /v1/ask` |
| `bridge.doc` | `{id}` | the document | `GET /api/doc/<id>` | `GET /v1/doc/<id>` |
| `bridge.pages` | `{id, message?, attachments?, q?}` | the pages answer; `retryAfter` (s) when bridge sent `Retry-After` (a video being prepared) | `GET /api/doc/<id>[/message/<m>][/attachment/<a>…]/pages` | `/v1/…` |
| `bridge.conversation` | `{id, cursor, dir}` | next messages | `GET /api/doc/<id>/conversation` | `/v1/…` |
| `bridge.texts` | `{cursor?, limit?}` (cap `texts`) | `{conversations, next}` (bridge CONTRACT.md, *Texts, the list*) | unsupported | `GET /v1/texts` |
| `bridge.textsPages` | `{conv, message?, attachments?}` (cap `texts`) | a conversation at its newest message, or a message's attachment: as `bridge.pages` | unsupported | `GET /v1/texts/<conv>[/message/<m>][/attachment/<a>…]/pages` |
| `bridge.textsConversation` | `{conv, cursor, dir}` (cap `texts`) | next messages, as `bridge.conversation` | unsupported | `GET /v1/texts/<conv>/conversation` |
| `bridge.related` | `{id, kinds?, limit?}` | Related | `GET /api/related/<id>` | `/v1/…` |
| `bridge.cluster`, `bridge.day`, `bridge.subject` | `{id}`, `{date}`, `{name}` | the group's documents | `GET /api/cluster/<id>`, `/api/day/<date>`, `/api/subject?name=` | `/v1/…` |
| `bridge.facets` | – | `{sources, types, years: [{v, n}]}` | `GET /api/facets` | unsupported (cap `browse`) |
| `bridge.browse` | `{source?, type?, year?, sort?: newest\|oldest}` | `{results: [{id, title, type, date, period, source, url, mails}]}`, 500 at most | `GET /api/browse` | unsupported (cap `browse`) |
| `bridge.usage` | `{doc}` | `{series: Chart \| null}` (*Chart*): the usage series holding that document | `GET /api/usage?doc=` | `GET /v1/usage?doc=` |
| `bridge.actions` | – | `{actions}` | `GET /api/actions` | `GET /v1/actions` |
| `bridge.act` | `{id}` | `{ok, title, state}` | `POST /api/actions/<id>` (bridge checks Origin) | `POST /v1/actions/<id>`, the id one of the last list's |
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
| `codes.list` | – (cap `codes`) | `{codes: [{id, code, from, at}]}`: the one-time codes of the last 15 minutes, newest first, `at` epoch ms (palette SPEC.md *Codes*) | unsupported | the shell's memory |
| `codes.copy` | `{id}` (cap `codes`) | –; `refused` once the shell no longer holds it | unsupported | native: the code alone onto the clipboard, out of clipboard history |
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

