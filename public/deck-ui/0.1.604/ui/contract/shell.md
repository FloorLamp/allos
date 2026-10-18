# Shell

## Gesture gate

`bridge.act`, `bridge.correct`, `bridge.need`, `recent.clear` and `transfer.share` (contract `gesture`) run on a shell only after the person's key or click in the page
within the last 2 s. Every key the person types goes to the page (the box is the page's), so the shell cannot see them all itself
(WebView2 hands the host only its accelerators). The page notes `ui.input {at, kind: key | pointer}` for each trusted `keydown` or
`pointerdown` (capture phase, before any handler runs; never which key), so the note precedes any op that key or click causes. The shell takes a note as a gesture only with its own evidence: when it arrives, the panel is the foreground window (Mac: the
key window) with the web view focused, and the OS's last key or mouse input (Windows `GetLastInputInfo` or stricter, e.g. raw key and button presses only; Mac
`CGEventSource.secondsSinceLastEventType(.combinedSessionState, …)`) is within 2 s. A gated op more than 2 s after the last accepted
note is `refused` (`no recent input`). A page script alone cannot open the gate: without the person's input the OS says otherwise.
(A host-issued nonce per gesture was weighed: the shell can only issue it on the page's word or the same OS evidence, so it adds a
round trip to every Enter and no assurance.)

## Desktop entry

A shell serves its checkout's `deck/` at its app origin's root as the bundle lays it out (`/palette/model.mjs`, `/ui/src/…`,
`/ui/vendor/…`, `/ui/contract/…`), loads `/ui/src/app.html` with the [resource CSP](resources.md#csp), and serves the resources under `/bridge/v1/…` and
`/local/recent/<id>` (the item's bytes with its type). The whole palette is the page (P3): the header (the mark, DECK, close), the
search box (always focused: every key goes to the web view), the rows, the commands bar, the status and hint lines, and the viewer
over them. The shell's window holds the one web view, borderless and transparent outside the panel's rounded corners; the page draws
the panel's backdrop, outline and radius (the shell may add the OS's shadow). The page's header is its drag region (*Moving the
window*).

## Shell messages

- Call: `{v: 1, id, op, args}` → `{v: 1, id, ok: true, result}` or `{v: 1, id, ok: false, error: {code, status?, message}}`. Cancel:
  `{v: 1, cancel: id}` (the host aborts; the UI has already rejected it `cancelled`).
- Event: `{v: 1, event, data}`. Note (UI → host, no reply): `{v: 1, note, data}`.
- Windows: `chrome.webview.postMessage` / `PostWebMessageAsJson`, top-level app origin only. Mac: `webkit.messageHandlers.deck`
  (WKScriptMessageHandlerWithReply: the reply is the promise's value), events through `deckHost.receive(msg)` by
  `callAsyncJavaScript`; main frame and `deck-app://app` only.
- Any message with another `v`, an unknown op, or args off the schema: `unsupported` / `refused`.

## Events (host → UI)

- `show {reason}`: `hotkey`, `tray`, `link`, `menu`; `transfer` (shown for a hotkey's transfer: its `transfer` events follow), `share` (a
  hotkey's share: the page asks its confirmation, as Mod+P), `files` (Send to: `files.pending` follows). The page plays the open
  motion (fade in, rise 8 px over motion.open), focuses its box and notes `ui.painted {what: rows}`.
- `hide`: the panel hid (the page resets: no query, group, answer, viewer; it stays faded out until the next `show`).
- `theme {theme, highContrast, reduceMotion}`.
- `link {find | ask | act | doc | recent}`: act only selects, inside the House group (an action not listed: the status `No house action
  <id>`); doc: the document id opens the shared viewer, without `document.page`; recent: that item selected on the empty query
  (a notification's `deck://recent?id=`). Android emits `doc` for document links. Mac and Windows retain their native
  document-link browser handling; their shared controller also accepts `doc` events. Web hosts need not emit them.
- `transfer {ok, message, item?, op?, to?, busy?, hide?}`: a transfer the shell ran (a hotkey, a push). `busy: true` while it runs (the
  status line with its bar: `Sending to pixel…`); then the outcome on the status line, `op` (`send`, `receive`, `share`) and `to`
  (`[name]`, null for all) flash that commands chip `ok` for motion.flash, `item` selected on an empty query. `hide: true` (the panel
  was shown only for this): after motion.flash the page calls `window.hide {}` when it went through and the person made no key or
  click in it meanwhile; a failure stays to be read.
- `recent.changed`, `actions.changed`, `targets.changed {targets?, enrolled?}` (the commands bar's devices without a restart),
  `codes.changed {codes?}` (a one-time code came or went: the codes.list answer's list; without it the page asks).
- `restore {state}`: Deck's own window's page only, open already when the panel popped out: show `state` (*Deck's own window*).
- `files.pending {count, name?}`: files waiting for a send (Send to → Deck): the status says how to send them (`Send plan.pdf and 1
  more: Ctrl+1–2 to one device, Ctrl+S to all`); the next `transfer.send` the page asks is the shell's to send them with; `count: 0`
  clears it.

## Notes (UI → host)

- `ui.input {at, kind}`: the gesture gate's evidence (above).
- `ui.painted {sinceShowMs, what, frame}`: `rows` after a `show`, `viewer` after one opens, since the `show`, else since the open.
  `frame: true` after the next frame (the real time); a view with no frame within 100 ms (never shown, or its window late on screen)
  notes `frame: false` at 100 ms, then `frame: true` when its frame comes.
- `selftest.done {ok, results}` (below).
- `android.ready {}`: Android's palette lists have loaded; the host can deliver its queued entry intent.
- `android.back {inside}`: Android Back first dismisses a viewer, query, group or confirmation when `inside` is true.
  These additive hostApi 1 notes are sent only on Android; other hosts ignore them.

## Who sizes and hides the panel

- Size: `window.resize {height, width}` in CSS px whenever it changes: the panel's own height (header, box, rows up to
  sizes.visibleRows, commands bar, status, hint) at sizes.width (600); the viewer's frame (width 1040; pages, video and loading the
  screen's height less 72, other kinds what their content needs up to that). The shell keeps the window on screen, top-anchored, and
  clamps the height to what fits.
- Hide: the UI. After `document.open`, `document.page`, `map.open`, `url.open`, `recent.open` or `recent.reveal` succeeds it calls
  `window.hide {reason: "opened"}` (window cap), so what opened shows; after Esc on nothing, the header's close, a copy (its ✓ Copied
  for motion.copied) and a hotkey's transfer (`hide`) `window.hide {}`. Each after its close motion (fade over motion.close; at once
  under reduced motion, the host's `reduceMotion` or the system's). A shell hides on its own only for its own reasons (focus lost,
  the hotkey), then sends `hide`.
- Mouse in the rows: a click selects, a double click is Enter, a right click `menu.popup` (the row's keys; the chosen key runs on that
  row), a drag `drag.start` from the row's `dragstart` (the button still down; the UI cancels the page's own drag; the shell
  answers when its drag session ends, and no click counts until then).

Selftest (both shells: `Deck.exe selftest`, `Deck --selftest`): load `app.html?selftest`; it calls every op of the contract once
(`bridge.facets` and `bridge.browse` expect `unsupported` on a shell without the `browse` cap; reads with their example and expects an answer; anything that changes or opens something with args off its schema, which the host
must refuse untouched; an op whose cap is off `unsupported`), then notes `selftest.done {ok, results: [{op, expect, got, pass}]}`.

Telemetry from the UI on every host with telemetry: `find`, `ask`, `group`, `transfer` (the page's own), `related` (ok, ms,
`results:<n>`, `rules:<n>` for a find Deck's rules answered from flightplan with no bridge or model call, or `status:<code>`) and `view` (one per open, from the Enter or Space that opened it to its first page, so a shell's
prefetch never counts as a view); shells send `palette_open` and their own transfers', no `view`.

## Deck's own window

The hotkey panel's pop out (its header's button beside the close, Mod+Shift+O) calls `window.popOut {state}` (window cap); the shell
opens Deck as a normal window, or brings the open one forward, answers once it shows, and the page then hides the panel (`window.hide
{}` after its close motion; a failure stays on the status line) and resets as on any hide.

- **Its view**: the window opens showing what the panel showed. `state` is the page's JSON (`{v: 1, palette, viewer?}`: the
  controller's snapshot, the query, the selection, a focused chip, an answer, the open groups and scopes and the rows they were drawn
  from; the viewer's history and where it was: page, zoom, scroll, sheet, filter), opaque to the shell, never a secret or token, at
  most 1,000,000 chars (past that the page sends a lean one: the query, the selection, the viewer's target). The shell hands it to the
  window's page unread: the page's first `env.get` answers it as `restore` (a new window: restored before its first paint); a page
  that has asked `env.get` already (the window was open) gets the event `restore {state}` instead, replacing what it showed. bridge's
  answers are not in it: the window asks again (the shell's cache answers).

- **The window**: titled `Deck`, resizable, minimisable, closable; in the taskbar and Alt-Tab (Windows), the Dock and ⌘-Tab (the Mac:
  Deck is a regular app while it is open, an accessory again once it closes); it activates as any window does (the panel stays
  non-activating); losing focus never hides it; its size and place are kept across starts (Windows: the state directory's
  `window.json`; the Mac: its frame's autosave). One at a time.
- **Its page**: the same `app.html` in a second web view on the same environment (Windows: WebView2's; the Mac: the same scheme and
  rules), its own host: env.get's `caps` without `window`, so the page draws no header (the OS's title bar), never sizes or hides it,
  fills it with the rows, and puts the viewer beside them from 1000 px wide (else over them); Esc on nothing does nothing; closing
  the window just closes it. It gets `theme`, `recent.changed`, `codes.changed`, `actions.changed`, `targets.changed` and `restore`; never `show`, `hide`, `link`,
  `transfer` or `files.pending` (the panel's).
- **Its gate**: the gesture gate (above) with its own evidence: a `ui.input` note counts when Deck's window is the foreground (key)
  window with its web view focused and the OS saw a key or click within 2 s; the panel's input never opens the window's gate, nor
  the window's the panel's.
- The hotkey panel keeps working beside it (its hotkey shows the panel; the window stays as it is). Windows: an update waits while
  the window is open.

## Moving the window

Neither web view moves the window for CSS `app-region` (WKWebView never; WebView2's composition control only for a host that
hit-tests its non-client regions), so the page marks its drag regions itself, the same for every shell: `data-window-drag` (the
header: the mark and DECK). A trusted primary-button `pointerdown` in one, not on a control inside it (`button`, `a`, `input`,
`textarea`, `select`: the close), calls `window.drag {}` (window cap); the box, the rows and the commands bar never do. The shell
starts the OS's own window move from that press while the button is still down (Mac `performDrag(with:)` with the web view's
mouse-down; Windows `DragMove`), answers once the button is let go, and refuses (`refused`) when it is already up. The move is no
gesture of its own (the press's `ui.input` is the click's; the release counts for nothing) and never activates the app. The window
keeps the place, top-anchored there, until the shell quits: the next show opens where the person put it (Mac: on that screen;
another screen, its own spot a fifth down); the viewer centres under it.


## Android pages

Android transfers one `WebMessagePort` to the committed main document at `https://deck.wang.team` and exposes
`deckAndroid` to `shell.js`. Navigation revokes that port and its pending replies. Requests outside the bundled manifest,
nav documents and the contract's bridge resource allowlist are denied; the WebView itself has network, file and content
access disabled. Native HTTP attaches the enrolled device credential and refuses redirects. The page never receives it.

The Pages menu reads the bundle's `contract/nav.json`. Collection, Health, House and Flightplan documents mount the same
shared views through `shell-page.js`; unsupported page mounts display an explicit unavailable state. Back walks WebView
history before returning to the bundled `app.html` palette in page layout,
with encrypted local Recent and native Settings, capture, sharing, widgets and push. Repeated launcher and notification entries
reuse the host; Find from a shared page and shared-page Home return to the palette. Back dismisses palette navigation before
exiting from its landing. The system's night mode selects the shared tokens, and Android recreates the activity on appearance
changes. Opening speed is measured after release through Android `palette_open` telemetry ([HANDOFF](../../android/HANDOFF.md#android-home)).
Android registers HTTPS links on `deck.wang.team` with the native entry point, which validates their paths against the bundle.
Full-page controls send trusted input notes before handling writes; Android also requires recent native input in the focused window.

`deck-android-emulator` builds this checkout's debug and instrumentation APKs, runs `selftest` through Chromium's native
port, then captures every nav destination at phone width. Its fresh emulator has no enrollment or live data: screenshots
show the real unconfigured/error states. The artifacts are `deck/android/build/emulator/page-<nav id>.png`.
