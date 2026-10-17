# Flightplan

The owner's todos and the fleet's work, from [flightplan](../../../flightplan/CONTRACT.md) through the backend registry
(`deck/backends/flightplan.json`; [Backends](backends.md)). Flightplan in the nav is its own page, `/flightplan`
(`mountCollectionPage`: the page's shell bar, no palette or found rows; the collection routes in [README](../README.md)); the nav's
Needs opens `/flightplan#needs`, which scrolls to Needs you; `#board` opens the Board; `/flightplan?epic=<id>#board` filters it to that epic. `?q=flightplan` (also `todos`) still draws it in the palette.
`mountFlightplan(el, host, {brand?, nav?, current?, tab?, clock?})` draws it into any element and returns
`{flightplan, refresh(), unmount()}`; its layout is its own, whatever page or panel mounts it. Fetched on open and on `refresh()`; the loaded board refreshes on visibility and every 60 seconds while visible. Web reads revalidate with ETags.

| Op | Route | Scope |
| --- | --- | --- |
| `flightplan.today`, `.upcoming` (`{query: {days: 14}}`), `.needs-you`, `.lists`; the views `{query: {repo}}` | `GET /v1/today`, `/v1/upcoming`, `/v1/needs-you`, `/v1/lists` | `flightplan:read` |
| `flightplan.projects` (`{query: {repo}}`): each active project's status (flightplan CONTRACT.md *Projects*) | `GET /v1/projects` | `flightplan:read` |
| `flightplan.items` (`{query: {list, status, kind, repo, q, updatedSince, limit, cursor}}`) | `GET /v1/items` | `flightplan:read` |
| `flightplan.item` (`{query: {id}}`) | `GET /v1/items/{id}` | `flightplan:read` |
| `flightplan.timeline` (`{query: {id}}`) | `GET /v1/items/{id}/timeline` | `flightplan:read` |
| `flightplan.events` (`{query: {id}}`) | `GET /v1/items/{id}/events` | `flightplan:read` |
| `flightplan.needs` | `GET /v1/needs` (flightplan's own, in the Needs you row) | `flightplan:read` |
| `flightplan.parse` (`{body: {text}}`) | `POST /v1/parse` (a read; typing is its gesture) | `flightplan:read` |
| `flightplan.add` (`{body: {text, list?, due?, repeat?, remind?}}`) | `POST /v1/items` | `flightplan:write` |
| `flightplan.done`, `.snooze` (`{query: {id}, body?: {until}}`) | `POST /v1/items/{id}/done`, `/snooze` | `flightplan:write` |
| `flightplan.update` (`{query: {id}, body}`) | `PATCH /v1/items/{id}` | `flightplan:write` |

Deck config: `{"backends": {"flightplan": {"origin": "https://flightplan.wang.team", "baseUrl": "https://flightplan.wang.team",
"scopes": ["flightplan:read", "flightplan:write"], "ops": <deck/backends/flightplan.json's>}}}`; the device needs both scopes
(not in a new device's default set). Days and times are New York's, as flightplan's views are.

Registry and device provisioning (#889):

- **Site**: bridge's `backendOrigins` includes `flightplan` (`BRIDGE_FLIGHTPLAN_ORIGIN`, default
  `https://flightplan.wang.team`), supplying the `deck-backends` meta and connect CSP
  ([bridge#294](https://github.com/FloorLamp/bridge/pull/294)). The shared registry supplies the ops above.
- **Desktops**: mothership owns each workstation's `~/.config/deck/client.json` (Windows: the equivalent user config
  directory). The entry above uses this repo's `deck/backends/flightplan.json` ops; workstation registration and verification
  are tracked in [mothership#48](https://github.com/FloorLamp/mothership/issues/48).
- **Devices**: boarding's [0004-pixel-flightplan step](../../../deploy/steps/boarding/0004-pixel-flightplan.sh) preserves
  the Pixel's existing scopes and adds `flightplan:read` and `flightplan:write`. The other owner devices (`win11`, `macmini`,
  `m1x`) use boarding's `all`, which includes both scopes. This changes grants without rotating credentials; a newly enrolled
  device with default scopes still needs both grants explicitly ([Boarding](../../../boarding/README.md#devices)).

## Todos view

The owner's own: items with no `repo`, every read asked with `repo=none` (flightplan CONTRACT.md *Items*, *Views*). Imported issues and
other work (a `repo`) are the Board's.

- **Today and upcoming**: Needs you first, then Overdue, Today, Upcoming by day for 14 days; an item in Needs you shows once.
- **Needs you** (Attention's, folded in: every backend's needs arrive as flightplan items): a backend need's row has no check and its
  one button, Attention's action: a `url` opens its page, an `op` runs `<backend>.need {id}` (a gesture; the toast says its
  `message`), a `command` shows in the row (mono) and copies; its meta its source (`messages`, `purser`) and detail. The owner's own
  items are todo rows (the check). No Done button on any row.
- **Lists**: the rail (chips below 860 px), each with the owner's open count; the core lists (personal, household, kids, errands,
  house-walk) always, any other (deck, fleet, …) only while it holds the owner's items; one list: its open items by due, undated last.
- **Rows** (every list), about 44 px, no badges: a check (done), the title on one line (ellipsized; a click opens the drawer), and one quiet meta line: the due in
  words (`Today, 4 PM`, `Overdue · Wed Oct 14`), the repeat in words (`every other Tuesday`), the priority, the list; a need's: its
  detail's first line (≤ 140 characters) or its command. `notes` never shows in a row: only in the drawer, in full with line breaks and repository file links. Snooze (shown on hover or focus; always without a mouse): in 1 hour, tonight (before 8 PM), tomorrow, Monday, next week (9 AM).
  A repeating item's done names its next due. Done today (`status=done`, `updatedSince` New York's midnight) folds below.
- **Quick add**: flightplan's `parse` after a 150 ms pause is the live preview (title, due, repeat, reminder, the list it lands
  on: the open list, else personal). An `ambiguous` reading holds Add and shows its choices; a choice adds with its `due`,
  `repeat`, `remind`. A 422 `ambiguous` (sent before the preview came) asks `parse` for the choices: hosts keep no error body.
- **Undo**: every done, snooze, add and move answers a toast with Undo for 3.5 s: done back to its status (a repeat: its due
  back), a snooze back to the due it had (none: cleared), an add dropped, a move back.
- **Sign in to save** (web): a write answered 401 without the owner's session on flightplan.wang.team is not an error but one toast
  action, *Sign in to save*, kept until used ([Backends](backends.md), *Session renewal*). It opens flightplan's `/session` landing
  (flightplan CONTRACT.md, *The site*); back on the same page, the first read retries that write once (*Saved*), then reads the views.
  A move goes back to its column meanwhile; a capture keeps its line. A retry refused again is the usual error, with no second trip.
  The palette's find keeps its writes as `find`, the Flightplan view as `flightplan`.

## Board view

Work: items with a `repo` (`repo=any`; an imported issue waiting on the owner in Needs you) and every `kind=epic` item (open and done).
On a desktop the page scrolls past the epics; only the columns fit the remaining viewport, growing to fill it below the shell bar. Each column scrolls inside itself. Columns left to right: Needs you, Stuck, In progress (in full),
Ready and Backlog (their top 5 by priority, then *Show all N*), Done (its count until *Show N done*). Epics: open ones in at most two rows, with *Show all N epics*. Done epics and epics whose parts are all done are behind one *N done* toggle. Unsplit epics say *Not split yet*. Others show done of total over their tasks (`parent`), a status bar whose
segments filter to the epic and pick that column on a phone, what is stuck, needs you or in progress; a click on its title filters
to it. Area chips. The six columns one at a time below 1100 px or without a mouse (Needs you first); a drag between them on a desktop. Cards: the reference (the issue link, else the `github:` key, else `#id`), the epic's short name while no epic
filters, the title, and at most one chip: why it is stuck (latest timeline detail, else “stuck”; never the issue body), else an open blocker, else its PR. A card opens the drawer: status, priority and list selects, its kind, clickable epic, relative timestamps, all links, Done/Snooze/open/copy actions and its history
(`/v1/items/<id>/events`), fetching the current item alongside history and replacing its board snapshot. A move is the owner's (`PATCH {status}`), which flightplan keeps over a rule's.

## In the palette's find

Without opening Flightplan (palette SPEC.md, *Flightplan in Find*, *Capture*): the find rules (`what's due`, `today`, `needs you`, a
list's name, `<epic> status`) answer from `today`, `upcoming`, `needs-you` and `items` alone; a word search adds the owner's open todos
whose title holds the words (`items` `{q, repo: 'none'}`, no epic, never a notes match) to bridge's; found items' Done and Snooze, and `todo <text>`'s parse and add, are this model's (`createFlightplan(host,
{reload})`: a write finds again instead of reading the todos view). `deck find` does the same through the CLI's registry.

## Gaps

- Web from deck.wang.team: flightplan's `/api` answers it credentialed CORS and takes its writes (flightplan CONTRACT.md, *The
  site*); numbered step `flightplan/0012-deck-api-cors` ensures boarding's write refusals carry the same CORS headers.
  This applies on the family network and VPN only (flightplan is family only). The site's registry and connect CSP name
  `https://flightplan.wang.team` (shipped in [bridge#294](https://github.com/FloorLamp/bridge/pull/294); CSP ownership and coverage:
  [resources.md](resources.md#csp)). A write needs the owner's session on flightplan.wang.team itself: *Sign in to
  save* (*Todos view*) renews it.
