<!-- docs-size-override: pending FP-1782 rewrite -->

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
the ticker), `wall` (the Pixel tablet's camera wall, *Camera wall*), `phone` (the shell bar, a Cameras row, the ~20 controls people use most with a search over every control, the status; *Most used*, *Cameras*), `cameras` (the Cameras place, *Cameras*) and `admin` (the shell bar, needs, the rules' counts with the way to *Rules*, every
entity, filtered by name and domain). The phone and admin views' header links to *Rules* (`Rules ›`) where the host passes `rulesHref`. Built from `ShellBar`, `RowList` and `Chart`; the viewer is for bridge's documents.

It reads and acts through the *Backend registry* (no cap, no host code of its own); the registry's `habitat` entry maps these ops
(routes are the registry's, Habitat's own paths; a list answer may be bare or wrapped as `{entities}`, `{states}`, `{rules}`, `{needs}`):

| Op | Args | Answer | Scope |
|---|---|---|---|
| `habitat.entities` | – | `[Entity]` | `habitat:read` |
| `habitat.states` | – | `[State]` | `habitat:read` |
| `habitat.history` | `query: {id: entity_id, since}` | `[State]`, oldest first | `habitat:api` |
| `habitat.rules` | – | `[Rule]` | `habitat:api` |
| `habitat.runs` | `query: {id: rule name, limit}` | `{rule, runs: [{time, action, entities, ok, error, shadow}]}`, newest first | `habitat:read` |
| `habitat.needs` | – | `[Need]` (spaceport shared/backend/needs.md) | `habitat:api` |
| `habitat.tablet-readiness` (POST) | `body: {rendered: true, stream_reconnected: true, at: ISO timestamp with timezone}` | 202 `{accepted: 1}` | `habitat:api` |
| `habitat.act` (POST) | `body: {action, target: {entity_id: [id]}, data?}` | `{ok, error, shadow}` | `habitat:api` |
| `habitat.need` (POST) | `query: {id}, body: {id, op?, until?}` | `{ok, message}`: repair by default; `op` is `acknowledge`, `resolve` or `snooze` (requires future ISO `until` with timezone) | `habitat:api` |
| `habitat.snapshot` (resource) | `query: {camera, w?}` (camera name without `camera.`; `w` the tile's drawn width × DPR) | JPEG | `habitat:api` |
| `habitat.stream` | `query: {patterns}` (comma-separated entity IDs or globs) | `{}`; then `habitat.state` and `habitat.stream` events | `habitat:read` |
| `habitat.live` (resource) | `query: {camera}` (any House camera; Habitat streams its wall cameras today, the rest from FP-1714) | web: `{url}`, the `wss:` URL of go2rtc's MSE socket on Deck's origin; a shell: `{open}`, its relay (*Live camera*) | `habitat:api` |

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
503 removes the last image and shows **Camera unreachable**; resuming immediately fetches again. A frame that takes past 15 s is
a failure too (never *Loading camera…* forever); on the House page and the Cameras place a failed tile says **Camera unreachable**
(the reason in its tooltip) with **Retry**, which asks at once whatever the backoff says, and a 404's says **Camera not found**
with no Live to press. A tile not yet on screen asks nothing and says nothing.

```js
Entity = {id: 'light.kitchen_pendants', domain, name, area: 'kitchen' | null, driver, attributes: {device_class?, unit_of_measurement?, ticker?}}
State = {entity_id, state: 'on' | '58.6' | 'unavailable' | …, attributes: {brightness?, current_temperature?, temperature?, …}, last_changed}
Rule = {name, mode: 'live' | 'shadow', enabled, last_run: iso | null, shadow_count, shadow_diff_count: number | null, title, summary, area,
  automation: entity_id | null, shadow_only, inputs: [entity_id], outputs: [entity_id], last_fired: iso | null,
  last_outcome: {ok, error, shadow} | null, healthy, shadow: {agree, disagree, since, until} | null}   // habitat docs/contract/rules.md *Every rule*
stream message: {type: 'state_changed', entity_id, new: State | null}   // current states first, then each change
```

- **Web**: each op is Habitat's session-authenticated `/api` on its registry `origin` (*Backend registry*). `habitat.stream` is a
  WebSocket to the same `/api` route (`wss:` on https) with the session's cookies; the host reconnects (1 s doubling to 30 s) and emits
  `habitat.stream {live}` and `habitat.state {entity_id, new}`. Writes need the browser's user gesture except the fixed `habitat.tablet-readiness` telemetry op.
House subscribes with one glob per domain needed by the view's quick controls, every control (phone: its search toggles at once), chart, status, ticker and cameras;
admin includes every listed entity. Replayed states are filtered locally to the view's exact input IDs. The upgrade URL stays short
for large registries. Quick controls page by as many compact rows of three (72 px) as the tablet's column holds (a pager under them past that) and cameras by 9 on the tablet (the grid of up to four columns that holds the largest frames above the chart, each frame its image's own shape from its cell's top left, never stretched or cropped; a house whose quick controls fit in five rows spreads the chart along the board's bottom instead); the phone and the Cameras place have no camera pager (*Cameras*). Quick/view updates replace the subscription. Stream snapshots supply initial states,
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

Rule operations (Habitat docs/contract/rules.md and per-rule-shadow-reports.md; *Rules* and the shadow reports page use them):
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

### Rules

`/house/rules` (`mountHouseRules(el, host, {member})`, Library's *House rules*; every member reads it): every Habitat rule
(`habitat.rules`) in its own words, the page's header its counts (`142 rules · 118 live · 20 shadow · 4 unhealthy`; off and unhealthy
only when some are). Grouped by Habitat's `area` (sticky headings with their counts, in the order of `house-rules.js` `AREAS`).

- **Search** (the collection search, always shown) over the title, the id, the words, the area and every entity it reads or acts on
  (ids and the House's names); **filters**: Area (a select), the chips Live, Shadow, Off (disabled), Unhealthy, Fired today (24 h),
  each with its count; a chip again clears it.
- **Row**: the title, when it fired and how (`Fired 2 hours ago · Recorded in shadow`, `Failed: <error>`), *Unhealthy*, its words,
  the mode's chip.
- **Open in place** (the record card; the URL's hash, `/house/rules#<name>`, which a thing page's Rules section links to): its mode,
  health, last fired, the HA automation it replaces, the shadow agreement (shadow only); *Reads* and *Acts on* as entity chips (a
  thing's page, `EntityLink`, where Habitat names the entity's `thing`; else the rules that use it); its ten newest runs
  (`habitat.runs`).
- **The owner's switch** (the owner signed in, never the read-only agent member): *Go live…* (a shadow rule whose seven-day
  `habitat.shadowreport` is ready; never `shadow_only`) or *Back to shadow…*, asked in the card first; Cancel changes nothing.
  `habitat.rule` with the click as its gesture, then the rules read again; Habitat's refusal is said in the card, the mode as
  Habitat has it. The fake-only selftest exercises both.

### Admin pages

`/house/admin`, `/house/admin/shadow` and `/house/zigbee` (house-paths.js): each under the site's bar like every House page (nothing
added to the bar), the shared `PageHeader` linking the other two, `PageState` for loading, failure and empty, `RowList` rows; dates
through format.js; unknowns left out, never `unknown`.

- **Admin** (the House view `admin`): *Service health*, one row per `habitat.health` driver, unhealthy first: its name (`ha` Home
  Assistant, `ha_<x>` Home Assistant <x>), its `detail` in words (Habitat's `key=value; …` read out: `connected=True` Connected, a time
  `Last stats 1 min ago`), since when it is stale, each failing check as a note; *Placement needs*: the health's `areas` needs; every
  entity 50 a page.
- **Shadow reports** (`mountHouseShadow(el, host, {query, canSwitch, links})`, src/house-shadow.js): `habitat.shadowreport` for the
  address's `rule` and `days` (default 7). Habitat's 503 with `Retry-After` (building the report) is the loading state, asked again
  each `Retry-After` for 60 s, then a timeout with Retry. Each rule under its heading: its mode, days clean, open diffs, window and
  *Ready* / *Not ready*; its blockers; its unexplained runs (kind, when, Habitat's actions and what Home Assistant showed, in words) and
  its daily counts, each folded. The owner (never the read-only agent member): *Cut over…* (a ready shadow rule) or *Roll back…* (a
  live one), asked under the row first, then `habitat.rule` and the reports read again; a refusal is said there.
- **Zigbee reconnect** (`mountHouseZigbee(el, host, {transport, owner, links})`, src/house-zigbee.js; the web host's transport,
  web/house-zigbee.js: Habitat's `/api/zigbee`, `sensor.zigbee_reconnect` on its stream, POST `/api/zigbee/permit`): the header's
  offline count and join state; the owner's *Join through* router, *Allow joining (60 s)* and *Stop*; every device by area, offline
  first: its name (a slug in words), model, power (a battery's level and type when Zigbee2MQTT reports them), offline since or last
  seen, *Offline* / *Online*, and for an offline one what to do; the activity feed with ages. The stream reconnects after 3 s.
### Cameras

The cameras a member opens (`view/house.js` `CameraRow`, `CamerasPlace`; tiles and players as *Live camera*):

- **The House page's row**: under its header, above Most used: *Cameras* with `All 9 cameras ›` (the Cameras place: `opts.camerasHref`,
  default `/house/cameras`) on the right, then the first four cameras (Habitat's order by name), four across from 600 px, two by two
  below. A press opens one live in the row's place, as on the Cameras place.
- **The Cameras place** (`view: 'cameras'`; Deck's web host serves it at `/house/cameras`, web/house-paths.js; the nav's Library entry *Cameras*, Find's
  `cameras`): its header, then every camera at once, no pager: three columns from 1024 px, two from 600 px, one below. A press plays
  one live in its place, the grid's whole width, with its sound (one camera heard at a time), *Pop out* and close. It subscribes to
  `camera.*` alone, reads no usage and charts nothing. Members only: with `opts.member` null (a shared screen nobody signed in to,
  as the kitchen's tablet) it shows the signed-out state and asks no camera; the wall keeps its own view.

### Things

The admin's Rules show one rule selected and scrolled to when the page's hash names it (`#rule:<name>`: a thing's page links its rules
there). A thing's page uses the House's tiles and confirmation for its devices ([Things](things.md) *Hub*).

Off the kiosks (phone, desktop), a tile whose entity carries Habitat's `thing: {id, name}` shows *Linked: <name>*
(`/things#<UUID>`); for a member who may write (the page's and Habitat's: never the agent member) its corner menu has *Link to a
thing*: the shared thing picker, then `bridge.things.link` with kind `device` and the entity's `device` (`ha:<id>`), or kind
`entity` and its id without one; a device another thing has moves only after a yes. *New thing* there makes one from scratch
with that device (or entity) linked at once, then opens it ([Things](things.md) *Links*). Habitat shows a device link within a minute;
the tile shows it at once. [Things](things.md) *Links* has the ops.

## Camera wall

`wall` (Habitat's `/wall`; the Pixel tablet's HA dashboard frames it, so its Companion app keeps announcements and screenshots):
a kiosk at 1280×800 (the tablet's 2560×1600 at DPR 2), no shell bar, page header or scrolling.
Habitat decides what it holds (habitat `docs/contract/wall.md`): the entity with `attributes.wall: 'band'` carries `weather`,
`chips`, `ticker` and `delivery` (*Delivery map*) (items `{id?, entity_id, icon: 'mdi:…', color, primary, secondary?}`, HA's mdi names and mushroom colours,
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
  every 5 s as on the tablet) stands in; while it plays, no stills are fetched. A host without `habitat.live` (Android, a shell
  without the `live` cap) shows stills. The bundle CSP's `media-src 'self' blob:` admits the MediaSource; sockets stay on Deck's
  origin (`'self'`), and a shell's page opens none (*Live camera*).
- The featured tile takes the page's one sound (*Live camera*).
- **Delivery map** (`view/delivery-map.js`): while the band's `delivery` is set (`{service, stage: 'confirmed' | 'on_way' |
  'almost', eta: ISO | null, distance_m, dasher: {lat, lon, at}, home: {lat, lon}}`; Habitat sends it only while a DoorDash order is
  on its way with a dasher position under 2 min old; one without two valid points is none), its map takes the featured place and
  the featured camera leads the five small tiles, still heard, its taps as before; when it ends, the camera is featured again.
  OpenStreetMap under a header `DoorDash · Picked up · ETA 6:42 PM · 1.2 km` (`deliveryLine`: stage *Confirmed*, *Picked up*,
  *Nearby*; the ETA in the house's time; metres under 1 km), the house and the dasher as pins with a line between, both kept in view
  with padding (refitted on each report), the dasher gliding to each new position over the time since the last (0.3–5 s; at once
  under reduced motion), OpenStreetMap's credit; no controls or gestures (a kiosk). Leaflet 1.9.4 from cdnjs with its sha384
  (`view/leaflet.js` `LEAFLET`, `loadLeaflet`); the wall's page policy (`mapPolicy`: the web host's `/house/wall`, from the build's `backendPages` `policies.wall`; Habitat's
  `/wall` the same) adds
  `https://cdnjs.cloudflare.com` to `script-src` and `style-src` and `https://tile.openstreetmap.org` to `img-src`, nothing else.
  A map that cannot load says *Map unavailable* under the header.

### Live camera

One camera live with its sound, opened by a person (`view/camera.js` `LiveCamera`, `camera.css`; the wall's tiles use its hooks):

- **Where**: the House page (`phone`, the site's House at every width, desktop to phone: its Cameras row) and the Cameras place: a
  press on a camera's still (its *Live* cue) opens it live in its place, the grid's whole width; a camera thing in the palette's viewer (palette SPEC.md *Kinds*,
  `thing`: a Home Assistant `camera.<name>` among its entities, exact ids, never names) plays live at its view's top, on the site
  and the desktops. The tablet and the wall keep their own; the admin view lists cameras as entities only.
- **Player**: the frame whole (`contain`) on the media's dark surface, the still until the video plays; under it the name, the
  stream's state (*Live*, *Connecting…*, *Reconnecting…*, *Live unavailable*), a sound button when its stream carries sound (its
  glyph the state, its words the press: *Mute*, *Unmute*; *Tap for sound* when the browser wants a gesture first) and, on the
  House, a close button (focused on open); *Pop out* (below). Live as *Camera wall* *Live* (MSE, reconnects, the still standing in).
- **Sound**: opening plays its sound (the press is the gesture, as a tap on the wall's tile). One camera is heard on a page: a
  player that takes the sound (opened, or Unmute) mutes whichever had it (`sound`).
- **Closing**: Esc, Back (opening adds a history entry; a reload keeps it open) or the close button on the House; the viewer's
  own close or another view in the palette. Closed, its socket and frames go and the focus returns to the camera's still.
- **Live unavailable**: Habitat refuses a camera it does not stream (its socket closed before it opened: the 404 for a camera off
  the wall until FP-1714), or the host has no live video: the still stays, refreshed every 5 s, with *Live unavailable*; it
  retries at the reconnect's pace. A camera Habitat has no still of (its snapshot 404s: Frigate does not list it) says *Camera not
  found* and stops asking for live.
- **Hosts**: the web opens `habitat.live`'s `wss:` URL itself (Deck's origin, the session; Caddy passes `/habitat/api/*` to
  Habitat). A shell (Deck.exe, Deck.app; cap `live`) relays it: `camera.open {id, camera}` opens the registry's `habitat.live`
  route as a WebSocket with the device credential (never the page's), at most 2 at once; `camera.send`, `camera.close`; events
  `camera.message {id, text | data (base64)}`, `camera.closed {id}` (host-contract.json). The page opens no socket, so the CSP
  stays `connect-src 'self'`. Android shows the thing's page (no viewer kind): no live.

#### Pop out

A playing camera's bar has a *Pop out* button (`popout` glyph, `Pop out <name>`) where the host has a way out (`popOutKind`); none
where it has not, and none in a camera window.

- **Desktops** (Deck.exe, Deck.app; cap `live`): `camera.popOut {camera, title}` opens the camera in its own small window, or brings
  its open one forward. Frameless, the page's thin strip on top (the name, the stream's state, Mute, close; the strip is the
  window's drag region, `window.drag`), always on top (Windows: a tool window, out of the taskbar and Alt-Tab; the Mac: a floating
  panel on every Space), shown without taking the focus. Resizable at the stream's shape: once the frame is known the page asks
  `window.resize {width, height, ratio, strip}` (`ratio` the video's width over its height, else the still's; `strip` the CSS px
  above the frame) and the shell keeps the frame below the strip at that ratio as the person resizes it. A move that ends within
  48 px of an edge of the screen's work area docks the window in that screen's nearest corner, 16 px in from both edges; a resize
  to the stream's shape keeps a docked window in its corner. Each camera's last place and size are kept per display (Windows:
  `camera-windows.json` in the state directory; the Mac: defaults `DeckCameraWindows`); a new one opens on the display with the
  pointer, 480 px wide in its bottom right corner. At most 4 at once (past that `refused`, said in the bar); one each camera.
  The page: `camera.html` (`camera-page.js`), the same `LiveCamera`, `windowed` (`data-surface="camera"`): env.get's `camera
  {name, title}`, caps `window` (window.drag, window.resize, window.hide: closes it; nothing else) and `live`; Esc or its close
  closes it. Closing it stops its stream (its relay retired). They close with the app and are never reopened; an update waits
  while one is open. From the palette's panel the panel then hides; Deck's own window keeps the camera's still with *In its own
  window* and a *Play here* button (its stream stops meanwhile). Android: no pop out (no live).
- **Relay**: at most 2 sockets a page and 4 across the app's windows; past 4 the oldest socket not a camera window's closes
  (`camera.closed` to its page, which shows its still and retries), and while all 4 are camera windows' a new one is refused
  (*Live unavailable* until one closes). Four are safe: go2rtc restreams each camera's one RTSP connection to every viewer, and
  Habitat takes 32 live sockets (`LIVE_MAX`: two wall tablets' tiles and members'), so a desktop's four cost only the LAN's
  bandwidth (about 4 × a main stream's bitrate).
- **One sound across windows**: a player taking the sound on a shell says `camera.sound {}`; the shell sends `camera.muted` to every
  other page with the `live` cap (the panel's, Deck's own window's, the camera windows'), whose players go quiet (`sound.elsewhere`).
  A new camera window takes the sound as it opens. Windows' web view may hold sound back until a click in that window (*Tap for
  sound*); the Mac's plays it at once.
- **The web** (deck.wang.team, Habitat's House and the site's viewer): Document Picture-in-Picture where the browser has it
  (Chromium): the player's box itself moves into a picture-in-picture window the frame's size, the page's style sheets and look
  with it (`data-surface="camera"`: the strip on top), so Mute and the one-sound rule go with it; the page keeps *<name> is
  playing in a picture-in-picture window*; closing that window puts the player back. Else the video's own Picture-in-Picture
  (`requestPictureInPicture`, Safari and Chromium; `disablePictureInPicture` lifted for it): the browser's own window, its own
  controls. Either way the press brings it back (*Back to the page*), and the stream keeps playing while the page is scrolled away
  or hidden. Firefox (neither): no button.

### Zones

`/house/zones` (house-paths.js; `mountZones(el, host, {canWrite})`, mount.js): Habitat's zones (habitat `docs/contract/zones.md`,
FP-1724) on a map beside their list (above it under 900 px). Every member reads them, never a kiosk; linked from House's bar as
Zones and House's More (nav `house.json` page `zones`; Find's *zones*). Writes are the owner's (Habitat answers 403 to any other member's and the agent member's): for anyone else
`canWrite: false`, no Add, search, fields, handles, Retry or drift actions.

| Op | Args | Answer | Route | Scope |
| --- | --- | --- | --- | --- |
| `habitat.zones` | `{}` | `{zones: [Zone], drift: [Drift]}`, Home first, then by name | `GET /v1/zones` | `habitat:read` |
| `habitat.zones.create` | `{body: {name, latitude, longitude, radius_m, icon?, passive?}}` | 201 `{zone}` | `POST /v1/zones` | `habitat:api` |
| `habitat.zones.update` | `{query: {id}, body: {…changed fields}}` | `{zone}` | `PATCH /v1/zones/{id}` | `habitat:api` |
| `habitat.zones.delete` | `{query: {id}}` | none (204) | `DELETE /v1/zones/{id}` | `habitat:api` |
| `habitat.zones.geocode` | `{query: {q}}` (1–200 characters) | `{results: [{name, latitude, longitude}]}`, at most 5 | `GET /v1/zones/geocode` | `habitat:api` |

The site's twins are `/habitat/api/zones…`. Zone: `{id, name, latitude, longitude, radius_m (1–50000), icon, passive, source:
'habitat' | 'ha-core', unnamed, ha: {entity_id (null until HA created it), state: 'synced' | 'pending' | 'failed', error?}}`; `id`
is the name's slug at creation, kept across renames; Home Assistant's own Home is `id: 'home'`, `source: 'ha-core'`, read only
(409 to a write). Drift: HA's values `{entity_id, name, latitude, longitude, radius_m, differs}`, `differs` the fields (`name`,
`latitude`, `longitude`, `radius_m`, `passive`, `icon`), `'missing-here'` (only in HA) or `'missing-in-ha'` (a synced Habitat zone
HA deleted). A refused write is 400 `{error, fields: {<field>: <what it must be>}}` (the web host passes `fields` on the error; each
shows beside its field; a name another zone has is one), 404 an unknown id (the list is read again), 502 a search Nominatim failed.

- **Writes wait for Home Assistant**: Habitat answers once HA has (or after 15 s), so the answer's `ha.state` is final. Meanwhile
  the zone's row and form say *Saving…* or *Deleting…*; nothing shows Synced before Habitat says so. *Synced*: HA has it;
  *Pending*: HA unreachable or no token (`error` says which; Habitat retries every five minutes, no re-reads here); *Failed*: HA
  refused, its reason and Retry (the zone written again). A delete answers once HA has deleted its copy.
- **Map** (`view/zone-map.js`): Leaflet from `view/leaflet.js` (`LEAFLET`, `loadLeaflet`, as the delivery map); the page's policy
  (`mapPolicy`, built into the bundle's manifest) adds `https://cdnjs.cloudflare.com` to `script-src` and `style-src` and
  `https://tile.openstreetmap.org` to `img-src`, nothing else; `connect-src` stays `'self'`: the browser never asks Nominatim.
  OpenStreetMap's attribution always shows. Leaflet's zoom and attribution controls set markup from strings, so the page draws its
  own; labels and handles are elements. Each zone a circle with its name under it; Home dashed and muted, a failed push in the bad
  tone.
- **Select**: a row (click, Enter or Space) or a circle; each highlights the other. The selected zone's form: name, radius (m),
  latitude, longitude, its sync, Save, Cancel or Close, Delete. Unsaved changes keep the selection until saved or cancelled.
- **Change**: drag the circle or its centre handle to move it, its edge handle to resize it, or type. A drag changes the draft,
  never Habitat; Save writes once (`update` with only the changed fields; a new zone `create`), after checking a name and the
  numbers. Delete asks first (*Delete X? Home Assistant loses it too.*).
- **Add**: Add zone, then a click on the map; or a click on empty ground with nothing selected; or a search (Habitat geocodes;
  the page asks once per query) whose result centres the map there and drafts a zone named after its first part, radius 100 m.
  A 502 says *Search unavailable*; the map still places zones.
- **Unnamed** zones (`unnamed` or no name) say *Needs a name*. **Drift** (*Different in Home Assistant*), nothing changed until one
  is chosen: a zone that differs, *Take HA's* (update with HA's differing fields) or *Keep Habitat's* (update with ours, pushed
  again); only in HA, *Add it here* (create); gone from HA, *Push to HA* (update with ours, which recreates it there) or *Delete
  here* (the zone selected with Delete's confirmation).

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
