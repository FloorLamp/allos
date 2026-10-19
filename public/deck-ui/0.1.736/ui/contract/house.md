# House

## House

Phone and admin include Location history: choose a UTC date, read `habitat.positions`
(`GET /v1/presence`, `habitat:presence`) in pages of 100 using the last `at` as `after`.
Explicit `since`/`until` bounds reach imported history. Samples show time, geofence state,
coordinates and accuracy beside a north-up trail; no external map service receives positions.

The House page: Habitat's pages (habitat `docs/design.md`, *Dashboards*), served from the deck-ui bundle on Habitat's origin
(`mountHouse(el, webHost(window, {backends}), {view, …})`, mount.js). It is offered only where the host's registry has a `habitat`
backend (`host.backends`; a shell gets the names from `env.get`'s `backends`): else `mountHouse` draws nothing. Habitat ships no UI.
`view`: `tablet` (the kitchen's Fully Kiosk, 1280×800, no scrolling: status strip, quick controls, the outdoor temperature's last 24 h,
the ticker), `phone` (the shell bar, status chips, quick controls, rooms as rows) and `admin` (the shell bar, needs, rules, every
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
| `habitat.snapshot` (resource) | `query: {camera, h?}` (camera name without `camera.`) | JPEG | `habitat:api` |
| `habitat.stream` | `query: {patterns}` (comma-separated entity IDs or globs) | `{}`; then `habitat.state` and `habitat.stream` events | `habitat:read` |

Camera tiles in tablet and phone views call `host.resource('habitat.snapshot', {query: {camera, h: Math.max(1, Math.ceil(tile.getBoundingClientRect().height))}}, {signal})`.
Configure the GET route as `/v1/cameras/{camera}/snapshot`. Web uses the session-gated `/api` twin on Habitat's own
origin; another origin is refused so the image CSP stays unchanged. Native uses the registry destination and device credential,
returning an in-memory JPEG data URL through its envelope; web returns an object URL. The resource resolves to `{url}`;
the tile revokes object URLs on replacement, pause and unmount. No images are saved or logged; access is family only.
Habitat clamps `h` to 120–1080 (default 360), returns `Cache-Control: private, max-age=2`, 404 for unknown cameras,
and 503 `{error:"frigate-unreachable"}` when Frigate cannot supply its latest frame.

Each visible camera refreshes every 5 s and on its Frigate-driven `habitat.state` event. Intersection, document visibility
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
House subscribes with one glob per domain needed by the view's quick controls, rooms (phone), chart, status, ticker and cameras;
admin includes every listed entity. Replayed states are filtered locally to the view's exact input IDs. The upgrade URL stays short
for large registries. Quick controls page by 12 (tablet) or 8 (phone), room sections by 50 (entities separately by 50 within a room) and cameras by 4. Quick/view updates replace the subscription. Stream snapshots supply initial states,
with `habitat.states` also read on reconnect and when the document becomes visible (and as a fallback when streaming is unsupported).
While disconnected, tiles dim, entity controls are disabled, and the last received states are labelled “as of HH:MM”.
State changes apply immediately; subscriber redraws coalesce
into one animation frame, cancelled on unmount.

The tablet reports readiness after a DOM commit with at least one received state, a live stream and no loading/error.
It reports once on the first rendered state and once after each stream connection returns, using the current timestamp;
connection or state receipt alone never reports. Phone/admin views do not report. The fixed POST `/v1/tablet/readiness`
(web `/api/tablet/readiness`, session authenticated) is allowed without a gesture only for the two true flags and timestamp.
Reports are best effort; a failed report is retried on the next connection. No report invokes a control or tablet refresh.

- **Native**: the device credential with `habitat:api` (the `habitat:events` scope is the phone's `POST /v1/events` only), the same
  ops. A native host without the stream answers `habitat.stream` `unsupported`: the House then shows what the read ops brought.
- **Controls**: a tap on a `light` or `scene` runs at once (`light.turn_on`/`turn_off`, `scene.turn_on`); a `switch`, `fan`,
  `cover` (`open_cover`/`close_cover`) or `lock` (`lock`/`unlock`) asks first: a confirmation bar (`Open Garage door?`, the verb
  focused; Esc or Cancel drops it, it lapses after 8 s). An unavailable entity has no control. The tile stays busy until the stream
  brings its change (10 s at most); the outcome (Habitat's `error`, `recorded in shadow`) on the status line.
- **Status strip**: the weather (else the outdoor temperature: a `temperature` sensor in `outside` or no area), people home
  (`person.*`), each garage (`cover` with `device_class: garage`), locks, open doors (`binary_sensor` door, garage_door, opening,
  window), climate, lights on, the needs count; warnings in the warn colour.
- **Ticker**: an entity whose static `attributes.ticker` is true says `name: state` while it has a state (not `off`, `idle`,
  `unknown`, `unavailable`); then the stream's latest changes of doors, covers, locks and people, newest first.
- **Rooms**: by authoritative `ha_area` when present (see below), otherwise legacy `area`
  (house-model's room id or the page's `rooms` names); no area last as `Other`.

The admin Needs view preserves repair, offers Acknowledge, Resolve and Snooze for 1 hour, and refreshes Needs after each write. It displays `acknowledged_at` and `snoozed_until` when present.

The built-in registry (`deck/backends/habitat/`) includes these routes; hosts supply its ops with their Habitat destination and both `habitat:read` and `habitat:api` scopes. Actual grants remain Boarding’s decision. History uses `/v1/history/{id}` on devices and `/api/house/history?entity_id=` on web; rules and actions use `/api/house/` web twins. HA-mirrored entities retain their ids and controls; Habitat decides whether an action runs or is recorded in shadow. Deck changes rule modes only through the documented Habitat switch after explicit confirmation. Habitat owns HA replacement handoff; Deck never directly disables HA automations.

Admin also reads `habitat.health` (native `/healthz`, web `/api/house/health`),
returning `{ok, degraded, drivers: {name: {ok, ...}}, needs}`, and `habitat.settings`
(native `/v1/settings`, web `/api/house/settings`), returning
`{settings: {name: {type, default, value, unit?, doc?}}}`. Types are `bool`, `int`,
`float` and `str`. Save calls `habitat.setting` with `query: {name}, body: {value}`
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
The phone view includes a Battery and temperature table from sensor `attributes.device_class`
(`battery` or `temperature`). Rows group by optional entity `device` (label `device_name`, else the
first populated sensor name); sensors without a device have their own row. Only finite numeric
states count as readings, including zero. Empty rows and columns are omitted; an entirely empty
table is hidden. Units use state attributes, then entity attributes (battery defaults to `%`).
This uses the existing hostApi 1 entity/state contract; no additional host operation is required.
After merge, the normal immutable deck-ui publication and Habitat consumer bump carry this change.

### Authoritative HA room assignment

An HA-backed Entity may additionally carry `ha_area: {id, name} | null`.
The host resolves the HA entity registry's area first, then its device registry's
area; `id` is the HA area ID and `name` its area-registry display name. Device
groups are never areas. Presence of `ha_area` is authoritative, including null
(unassigned); Deck must not fall back to the projected `area` in that case.
Legacy hosts without this field retain their existing `area` grouping.
The pinned house-model projection remains available in `area` for rules and
diagnostics, but must not override `ha_area` in Deck's rooms.
Room pagination counts whole area sections (50 per page), with a separate
50-entity pager inside each room. Unassigned entities appear in a final Other
bucket; that bucket is included in pagination totals and is not an HA area.

Habitat's current `src/habitat/rooms.py` gives explicit pinned entity mappings
precedence over HA area aliases. Thus a guest-bedroom light projected into Anya
cannot be corrected by display names or UI inference. Habitat must expose the
field above on both native and web entity routes before authoritative placement
is available. The synthetic `2026-10-17-areas.json` fixture records this distinction;
it is not a live registry capture. Items 491 and 543 are already merged and their
thermostat filtering, Quick deduplication and sparse readings remain in effect.
The normal post-merge release publishes the content-addressed bundle and hashed
manifest; the registered Habitat consumer adopts it through `tool/deck-ui.mjs`,
which verifies the channel and manifest hashes. No vendor edits are needed.
