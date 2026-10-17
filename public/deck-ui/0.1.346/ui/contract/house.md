# House

## House

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
| `habitat.act` (POST) | `body: {action, target: {entity_id: [id]}, data?}` | `{ok, error, shadow}` | `habitat:api` |
| `habitat.need` (POST) | `query: {id}, body: {id, op?, until?}` | `{ok, message}`: repair by default; `op` is `acknowledge`, `resolve` or `snooze` (requires future ISO `until` with timezone) | `habitat:api` |
| `habitat.snapshot` (resource) | `query: {camera, h?}` (camera name without `camera.`) | JPEG | `habitat:api` |
| `habitat.stream` | `query: {patterns}` (entity globs, `*`) | `{}`; then `habitat.state` and `habitat.stream` events | `habitat:read` |

Camera tiles in tablet and phone views call `host.resource('habitat.snapshot', {query: {camera, h: 360}}, {signal})`.
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
  `habitat.stream {live}` and `habitat.state {entity_id, new}`. Writes need the browser's user gesture like any registry POST.
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
- **Rooms**: by `area` (house-model's room id, `primary-bathroom` → `Primary bathroom`, or the page's `rooms` names), no area last as
  `Other`.

The admin Needs view preserves repair, offers Acknowledge, Resolve and Snooze for 1 hour, and refreshes Needs after each write. It displays `acknowledged_at` and `snoozed_until` when present.

The built-in registry (`deck/backends/habitat.json`) includes these routes; hosts supply its ops with their Habitat destination and both `habitat:read` and `habitat:api` scopes. Actual grants remain Boarding’s decision. History uses `/v1/history/{id}` on devices and `/api/house/history?entity_id=` on web; rules and actions use `/api/house/` web twins. HA-mirrored entities retain their ids and controls; Habitat decides whether an action runs or is recorded in shadow. Deck never changes rule modes or disables HA automations.

Admin also reads `habitat.health` (native `/healthz`, web `/api/house/health`),
returning `{ok, degraded, drivers: {name: {ok, ...}}, needs}`, and `habitat.settings`
(native `/v1/settings`, web `/api/house/settings`), returning
`{settings: {name: {type, default, value, unit?, doc?}}}`. Types are `bool`, `int`,
`float` and `str`. Save calls `habitat.setting` with `query: {name}, body: {value}`
(native `/v1/settings/{name}`, web `/api/house/settings/{name}`); it requires a
user gesture and refreshes authoritative settings after success. These ops use
`habitat:api`; Habitat enforces owner/family access and caller audit context.
Driver health is informational. Deck's own settings remain setup and status only.
`houseSelftest(host)` explicitly exercises a disposable fake Habitat, including a
setting write; it must never be invoked against a live house.
