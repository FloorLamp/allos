# House

## House

Admin includes Location history: step a house-local day back or forward (never past today), read `habitat.positions`
(`GET /v1/presence`, `habitat:presence`) in pages of 100 using the last `at` as `after`.
Explicit `since`/`until` bounds reach imported history. Samples show time, geofence state,
coordinates and accuracy beside a north-up trail; no external map service receives positions.

The House page: Habitat's pages (habitat `docs/design.md`, *Dashboards*), served from the deck-ui bundle on Habitat's origin
(`mountHouse(el, webHost(window, {backends}), {view, …})`, mount.js). It is offered only where the host's registry has a `habitat`
backend (`host.backends`; a shell gets the names from `env.get`'s `backends`): else `mountHouse` draws nothing. Habitat ships no UI.
`view`: `tablet` (the kitchen's Fully Kiosk, 1280×800, no scrolling: status strip, quick controls, the outdoor temperature's last 24 h,
the ticker), `wall` (the Pixel tablet's camera wall, *Camera wall*), `phone` (the shell bar, the ~20 controls people use most with a search over every control, the cameras, the status; *Most used*) and `admin` (the shell bar, needs, rules, every
entity, filtered by name and domain). Built from `ShellBar`, `RowList` and `Chart`; the viewer is for bridge's documents.

It reads and acts through the *Backend registry* (no cap, no host code of its own); the registry's `habitat` entry maps these ops
(routes are the registry's, Habitat's own paths; a list answer may be bare or wrapped as `{entities}`, `{states}`, `{rules}`, `{needs}`):

| Op | Args | Answer | Scope |
|---|---|---|---|
| `habitat.entities` | – | `[Entity]` | `habitat:read` |
| `habitat.states` | – | `[State]` | `habitat:read` |
| `habitat.history` | `query: {id: entity_id, since}` | `[State]`, oldest first | `habitat:api` |
| `habitat.rules` | – | `[Rule]` | `habitat:api` |
| `habitat.needs` | – | `[Need]` (spaceport shared/backend/needs.md) | `habitat:api` |
| `habitat.tablet-readiness` (POST) | `body: {rendered: true, stream_reconnected: true, at: ISO timestamp with timezone}` | 202 `{accepted: 1}` | `habitat:api` |
| `habitat.act` (POST) | `body: {action, target: {entity_id: [id]}, data?}` | `{ok, error, shadow}` | `habitat:api` |
| `habitat.need` (POST) | `query: {id}, body: {id, op?, until?}` | `{ok, message}`: repair by default; `op` is `acknowledge`, `resolve` or `snooze` (requires future ISO `until` with timezone) | `habitat:api` |
| `habitat.snapshot` (resource) | `query: {camera, w?}` (camera name without `camera.`; `w` the tile's drawn width × DPR) | JPEG | `habitat:api` |
| `habitat.stream` | `query: {patterns}` (comma-separated entity IDs or globs) | `{}`; then `habitat.state` and `habitat.stream` events | `habitat:read` |
| `habitat.live` (resource) | `query: {camera}` (a wall camera) | `{url}`: the `wss:` URL of go2rtc's MSE socket on Deck's origin (*Camera wall*) | `habitat:api` |

Camera tiles in tablet, phone and wall views call `host.resource('habitat.snapshot', {query: {camera, w: Math.ceil(tile.getBoundingClientRect().width * devicePixelRatio)}}, {signal})`:
Habitat sends a frame that size (habitat `docs/contract/cameras.md`), never the camera's full frame.
Configure the GET route as `/v1/cameras/{camera}/snapshot`. Web uses the session-gated `/api` twin on Habitat's own
origin; another origin is refused so the image CSP stays unchanged. Native uses the registry destination and device credential,
returning an in-memory JPEG data URL through its envelope; web returns an object URL. The resource resolves to `{url}`;
the tile revokes object URLs on replacement, pause and unmount. No images are saved or logged; access is family only.
Habitat clamps `w` to 120–1920, shares a frame per camera and size for one refresh, returns `Cache-Control: private, max-age=5`, 404 for unknown cameras,
and 503 `{error:"frigate-unreachable"}` when Frigate cannot supply its latest frame.

The tablet focuses a Frigate camera on a changed `habitat.state` event after its initial snapshot,
showing it alone in the camera area for ten minutes. New activity replaces the focus and restarts
the hold; expiry restores the camera grid. Snapshot reads and identical replays do not extend it.
Habitat's `cameras_tablets.py` activity mappings also select doorbell (porch person), garage
(garage person or recently opened garage door), front yard (mailbox), and backyard (backyard
person or either patio door), on transitions to `on`.
`input_boolean.lawnwork_mode: on` takes priority and keeps `camera.front_yard` focused without
an expiry, including when first loaded through the stream or the fallback state snapshot. Other activity cannot replace it. Leaving `on` restores
the grid; the next activity starts a fresh hold. Phone, admin and camera-wall views are unchanged.

Each visible camera refreshes every 5 s and when its Frigate-driven state changes on the stream (`habitat.state`); the stream's
replay of the state it already had, on every connect, loads nothing, so each camera loads once. Intersection, document visibility
and network state gate refreshes; hiding, going offline or unmounting aborts requests and drops the frame.
503 removes the last image and shows **Camera unreachable**; resuming immediately fetches again.

```js
Entity = {id: 'light.kitchen_pendants', domain, name, area: 'kitchen' | null, driver, attributes: {device_class?, unit_of_measurement?, ticker?}}
State = {entity_id, state: 'on' | '58.6' | 'unavailable' | …, attributes: {brightness?, current_temperature?, temperature?, …}, last_changed}
Rule = {name, mode: 'live' | 'shadow', last_run: iso | null, shadow_count, shadow_diff_count: number | null}
stream message: {type: 'state_changed', entity_id, new: State | null}   // current states first, then each change
```

- **Web**: each op is Habitat's session-authenticated `/api` on its registry `origin` (*Backend registry*). `habitat.stream` is a
  WebSocket to the same `/api` route (`wss:` on https) with the session's cookies; the host reconnects (1 s doubling to 30 s) and emits
  `habitat.stream {live}` and `habitat.state {entity_id, new}`. Writes need the browser's user gesture except the fixed `habitat.tablet-readiness` telemetry op.
House subscribes with one glob per domain needed by the view's quick controls, every control (phone: its search toggles at once), chart, status, ticker and cameras;
admin includes every listed entity. Replayed states are filtered locally to the view's exact input IDs. The upgrade URL stays short
for large registries. Quick controls page by as many compact rows of three (72 px) as the tablet's column holds (a pager under them past that) and cameras by 9 on the tablet (the grid of up to four columns that holds the largest frames above the chart, each frame its image's own shape from its cell's top left, never stretched or cropped; a house whose quick controls fit in five rows spreads the chart along the board's bottom instead) or 4 on the phone. Quick/view updates replace the subscription. Stream snapshots supply initial states,
with `habitat.states` also read on reconnect and when the document becomes visible (and as a fallback when streaming is unsupported).
While disconnected, tiles dim, entity controls are disabled, and the last received states are labelled “as of HH:MM”.
State changes apply immediately; subscriber redraws coalesce
into one animation frame, cancelled on unmount.

The tablet reports readiness after a DOM commit with at least one received state, a live stream and no loading/error.
It reports once on the first rendered state and once after each stream connection returns, using the current timestamp;
connection or state receipt alone never reports. Phone/admin views do not report. The fixed POST `/v1/tablet/readiness`
(web `/api/tablet/readiness`, session authenticated) is allowed without a gesture only for the two true flags and timestamp.
Reports are best effort; a failed report is retried on the next connection. No report invokes a control or tablet refresh.
`opts.member`, Habitat's `/api/member` answer, says who the page serves: `null` (a display nobody signed in to) reads no
`habitat.needs` and reports no readiness, `read_only` (the agent member) reports none; omitted, Habitat's answers decide.

- **Native**: the device credential with `habitat:api` (the `habitat:events` scope is the phone's `POST /v1/events` only), the same
  ops. A native host without the stream answers `habitat.stream` `unsupported`: the House then shows what the read ops brought.
- **Controls**: a tap on a `light` or `scene` runs at once (`light.turn_on`/`turn_off`, `scene.turn_on`); a `switch`, `fan`,
  `cover` (`open_cover`/`close_cover`) or `lock` (`lock`/`unlock`) asks first: a confirmation bar (`Open Garage door?`, the verb
  focused; Esc or Cancel drops it, it lapses after 8 s). An unavailable entity has no control. The tile stays busy until the stream
  brings its change (10 s at most); the outcome (Habitat's `error`, `recorded in shadow`) on the status line.
- **Status strip**: the weather (else the outdoor temperature: a `temperature` sensor in `outside` or no area), people home
  (`person.*`), the garage (`cover` with `device_class: garage`), locks, open doors (`binary_sensor` door, garage_door, opening,
  window), climate, lights on, the needs count; warnings in the warn colour. Several garages, unlocked locks or open doors are one
  figure each, named when one needs a look and counted when more do (`2 open`, `4 unlocked`), so the tablet shows every figure whole.
  The tablet is the board alone, edge to edge: no shell bar (unless reporting an error), page header or page column; a confirmation
  sits by the tile it asks about, which is highlighted. Temperatures carry the unit Home Assistant reports (a weather's
  `temperature_unit`, an entity's `unit_of_measurement`; a thermostat with neither takes its house's weather's), never converted;
  `°` alone when none is known. The chart's unit is its readings' (the latest state's, else the entity's).
- **Ticker**: an entity whose static `attributes.ticker` is true says `name: state` while it has a state (not `off`, `idle`,
  `unknown`, `unavailable`); then the stream's latest changes of doors, covers, locks and people, newest first.
- **Most used**: the quick controls (tablet, phone) and Find's House tiles run in Habitat's ranking of the controls people use most
  (`habitat.usage`, `GET /v1/house/usage`, web `/api/house/usage`; habitat docs/contract/house-usage.md: person-initiated uses over
  30 days, ties by the latest), read at start and each hour; the rest (or all, with too little history) in the quick-control order:
  scenes, covers, locks, then lights by room. Configured `quick` ids win. The phone shows the first 20 as one grid of tiles and
  nothing room by room: Find's House group reaches any device, admin lists every entity.
- **Search** (phone, never the tablet or the wall: nobody types there): the shared collection search over every control
  (light, switch, fan, scene, cover, lock) by name, room (authoritative `ha_area`'s name when present, else house-model's `area`,
  see below) and HA's `attributes.aliases`; its matches as the same tiles in the twenty's place, 20 a page; `/` focuses it, Esc or
  clearing returns to the most used. The index is built once per entity list; a keystroke filters and draws in under 50 ms over
  ~1,000 controls.

The admin Needs view preserves repair, offers Acknowledge, Resolve and Snooze for 1 hour, and refreshes Needs after each write. It displays `acknowledged_at` and `snoozed_until` when present.

The built-in registry (`deck/backends/habitat/`) includes these routes; hosts supply its ops with their Habitat destination and both `habitat:read` and `habitat:api` scopes. Actual grants remain Boarding’s decision. History uses `/v1/history/{id}` on devices and `/api/house/history?entity_id=` on web; rules and actions use `/api/house/` web twins. HA-mirrored entities retain their ids and controls; Habitat decides whether an action runs or is recorded in shadow. Deck changes rule modes only through the documented Habitat switch after explicit confirmation. Habitat owns HA replacement handoff; Deck never directly disables HA automations.

Admin also reads `habitat.health` (native `/healthz`, web `/api/house/health`),
returning `{ok, degraded, drivers: {name: {ok, ...}}, needs}`, and `habitat.settings`
(native `/v1/settings`, web `/api/house/settings`), returning
`{settings: {name: {type, default, value, unit?, doc?}}}`. Types are `bool`, `int`,
`float` and `str`. One Save calls `habitat.setting` for each changed setting with `query: {name}, body: {value}`
(native `/v1/settings/{name}`, web `/api/house/settings/{name}`); it requires a
user gesture and refreshes authoritative settings after success. These ops use
`habitat:api`; Habitat enforces owner/family access, same-origin writes and preserves caller audit context.
`habitatClient(host)` exposes `health(options)`, `settings(options)` and
`setting(name, value, options)`; options pass through to the host, including cancellation.
Driver health is informational. Deck's own settings remain setup and status only.
`houseSelftest(host)` explicitly exercises a disposable fake Habitat, including a
setting write; it must never be invoked against a live house.

Admin rule operations (Habitat docs/contract/rules.md and per-rule-shadow-reports.md):
- `habitat.shadowreport`: GET native `/v1/shadow/report`, web `/api/house/shadow/report`;
  `query: {rule?, days: 7}` returns `{reports: [{rule, ready, ...}]}`.
- `habitat.rule`: POST native `/v1/rules/{id}`, web `/api/house/rules/{id}`;
  `query: {id: name}, body: {mode: 'live' | 'shadow'}` returns the rule row.
Both use `habitat:api`. Cut over requires a ready seven-day shadow report;
rollback is available for live rules. Both ask for confirmation, require a write
gesture, retain Habitat's Origin/owner/family and caller-audit checks, and refresh
rules and reports after success. Refusals remain visible without optimistic mode
changes. Reports never automatically switch rules. Compare and group cutover have
no documented web twins and are not offered. Fake-only selftest exercises both switches.

Accepted controls say “Sent”, then show the observed state when it changes. After ten seconds without a state change, they say
“<name> did not respond”. Shadow requests say “recorded in shadow” and do not wait for a device response.

Quick controls show each entity ID once, retaining the first configured ID and the first entity record.
Default scenes retain registry order; distinct IDs with identical names remain separate controls.
This uses the existing hostApi 1 entity/state contract; no additional host operation is required.
After merge, the normal immutable deck-ui publication and Habitat consumer bump carry this change.

### Camera wall

`wall` (Habitat's `/wall`; the Pixel tablet's HA dashboard frames it, so its Companion app keeps announcements and screenshots):
a kiosk at 1280×800 (the tablet's 2560×1600 at DPR 2), no shell bar, page header or scrolling.
Habitat decides what it holds (habitat `docs/contract/wall.md`): the entity with `attributes.wall: 'band'` carries `weather`,
`chips` and `ticker` (items `{id?, entity_id, icon: 'mdi:…', color, primary, secondary?}`, HA's mdi names and mushroom colours,
which the view maps to its glyphs and theme tones), the one with `wall: 'cameras'` its `cameras`
(`[{id, title, stream, fit: 'cover' | 'contain', camera, osd, audio, featured?}]`, featured first; `osd`: the camera draws its own
name into its picture where the tile shows it (bottom right), so the tile adds none, else the name in the shared caption in the same
place, its bottom-right corner; `audio`: its stream
carries sound). The view subscribes to those entities alone and charts nothing; they are no room's.

- **Band**: the clock (`clockText`, `06:33`), the weather card over the date (`shortDayText`, `Tue 10/20`), each chip while
  Habitat publishes it, in its order (the HA strip's priority), as many as fit whole, then a `+N` chip that opens the rest in a
  sheet (`fitChips`; never one cut or silently dropped), then the ticker in what is left (hidden under 180 px). At least 64 px;
  the grid takes the rest.
- **Grid**: three columns, rows 16:9 of a column (`wallGrid`: the band keeps its floor when the height limits, the grid then
  centred), the featured camera two columns by two rows, five more tiles; tiles past the first screen are not drawn and open no
  stream. A tile's frame fits per `fit` (the garage's square composite `contain`: whole, centred on the tile's dark surface).
- **Sound**: the featured tile plays its camera's sound; every other tile is muted, so two streams never sound at once. A tap on a
  small tile features it, with its sound (`arrange`: the rest keep Habitat's order; Habitat's featured camera again after ten
  quiet minutes); a tap on the featured tile mutes or unmutes it. A speaker chip on the featured tile says which, only when its
  camera has `audio` and its stream carries sound. A browser that refuses sound without a gesture (`play()` rejected
  `NotAllowedError`) keeps it muted, the chip says *Tap for sound*, and the first tap anywhere turns it on. The Pixel tablet's
  Companion WebView plays sound without one (probed 2026-10-20; the dashboard's iframe card has `allow="autoplay"`).
- **Live** (`view/camera.js`): each tile on screen while the page is visible and online opens `habitat.live` and plays go2rtc's
  protocol: after `sourceopen` it sends `{type: 'mse', value}` with the codecs the browser plays (video, and AAC, Opus or FLAC
  sound), adds a SourceBuffer for go2rtc's `{type: 'mse', value: mime}` and appends its binary fMP4 segments in order, keeping
  within 3 s of the newest frame and the buffer under 10 s. It is live once the video plays. A close, go2rtc's `{type: 'error'}`,
  a codec the browser cannot play, an append or decode error, or 10 s without data (15 s for the first) release everything and
  reconnect after 1 s, doubling to 30 s. Until it plays and whenever it fails, the tile's still (`habitat.snapshot`, refreshed
  every 5 s as on the tablet) stands in; while it plays, no stills are fetched. A host without `habitat.live` (the desktops,
  Android) shows stills. The bundle CSP's `media-src 'self' blob:` admits the MediaSource; sockets stay on Deck's origin (`'self'`).

### Authoritative HA room assignment

An HA-backed Entity may additionally carry `ha_area: {id, name} | null`.
The host resolves the HA entity registry's area first, then its device registry's
area; `id` is the HA area ID and `name` its area-registry display name. Device
groups are never areas. Presence of `ha_area` is authoritative, including null
(unassigned); Deck must not fall back to the projected `area` in that case.
Legacy hosts without this field retain their existing `area` grouping.
The pinned house-model projection remains available in `area` for rules and
diagnostics, but must not override `ha_area` in a control's room (the search).

Habitat's current `src/habitat/rooms.py` gives explicit pinned entity mappings
precedence over HA area aliases. Thus a guest-bedroom light projected into Anya
cannot be corrected by display names or UI inference. Habitat must expose the
field above on both native and web entity routes before authoritative placement
is available. The synthetic `2026-10-17-areas.json` fixture records this distinction;
it is not a live registry capture. Items 491 and 543 are already merged and their
thermostat filtering and Quick deduplication remain in effect.
The normal post-merge release publishes the content-addressed bundle and hashed
manifest; the registered Habitat consumer adopts it through `tool/deck-ui.mjs`,
which verifies the channel and manifest hashes. No vendor edits are needed.
