# Flightplan

The owner's todos and the fleet's work, from [flightplan](../../../flightplan/CONTRACT.md) through the backend registry
(`deck/backends/flightplan.json`; [Backends](backends.md)). Flightplan in the nav is its own page, `/flightplan`
(`mountCollectionPage`: the page's shell bar, no palette or found rows; the collection routes in [README](../README.md)); the nav's
Needs opens `/flightplan#needs`, which scrolls to Needs you; `#board` opens the Board; `#todos` opens Todos.
`#board/<id>` or `#todos/<id>` restores an item drawer. Tab and drawer changes replace the hash;
reload and `hashchange` restore them. `/flightplan?epic=<id>#board` filters it to that epic.
`?q=flightplan` (also `todos`) still draws it in the palette.
`mountFlightplan(el, host, {brand?, nav?, current?, tab?, clock?})` draws it into any element and returns
`{flightplan, refresh(), unmount()}`; its layout is its own, whatever page or panel mounts it. Fetched on open; web reads revalidate with ETags.

The visible Flightplan page checks `flightplan.changes` every five seconds and on focus or return from a hidden page. A changed
marker refreshes the active view, open item and canonical Needs without clearing search, filters or capture text. Hidden pages
pause; hosts without the marker operation refresh every fifteen seconds. Background failures keep the current work visible with
Retry and back off; HTTP `Retry-After` controls a longer delay. Unmount removes listeners, timers and the pending marker read.

| Op | Route | Scope |
| --- | --- | --- |
| `flightplan.changes`: opaque view-change marker | `GET /v1/changes` | `flightplan:read` |
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

Web calls use `/flightplan/api` on Deck's origin and its member session. Native config keeps `baseUrl: https://flightplan.wang.team`,
the registry ops and `flightplan:read` / `flightplan:write` scopes for device-credential `/v1` requests.

Registry and device provisioning (#889):

- **Site**: Flightplan's web routes always use `/flightplan/api`; the registry supplies the ops and scopes, with no session landing.
- **Desktops**: mothership owns each workstation's `~/.config/deck/client.json` (Windows: the equivalent user config
  directory). The entry above uses this repo's `deck/backends/flightplan.json` ops; workstation registration and verification
  are tracked in [mothership#48](https://github.com/FloorLamp/mothership/issues/48).
- **Devices**: boarding's [0004-pixel-flightplan step](../../../deploy/steps/boarding/0004-pixel-flightplan.sh) preserves
  the Pixel's existing scopes and adds `flightplan:read` and `flightplan:write`. The other owner devices (`win11`, `macmini`,
  `m1x`) use boarding's `all`, which includes both scopes. This changes grants without rotating credentials; a newly enrolled
  device with default scopes still needs both grants explicitly ([Boarding](../../../boarding/README.md#devices)).

## Todos view

Dated Todos and lists are the owner's own: items with no `repo`, read with `repo=none` (flightplan CONTRACT.md *Items*, *Views*).
Needs you is the shared owner-action source, including work; opening a work item selects its Board details.

- **Today and upcoming**: Needs you first, then Overdue, Today, Upcoming by day for 14 days; an item in Needs you shows once.
- **Needs you** uses the same `needsSource` as the shell and Find: configured backend needs plus unfiltered Flightplan Needs you,
  deduplicated by origin. Live backend needs appear even before the poller creates their Flightplan item; those have no drawer or snooze.
  Source failures remain visible and retain successful lists. Each action/status mutation refreshes the source. For actions, a backend need's row has no check and its
  one button, Attention's action: a `url` opens its page, an `op` runs `<backend>.need {id}` (a gesture; the toast says its
  `message`), a `command` shows in the row (mono) and copies; its meta its source (`messages`, `purser`) and detail. The owner's own
  items are todo rows (the check). No Done button on any row.
- **Lists**: the rail (chips below 860 px), each with the owner's open count; the core lists (personal, household, kids, errands,
  house-walk) always, any other (deck, fleet, …) only while it holds the owner's items; one list: its open items by due, undated last.
- **Rows** (every list), about 44 px, no badges: a check (done), the title on one line (ellipsized; a click opens the drawer), and one quiet meta line: the due in
  words (`Today, 4 PM`, `Overdue · Wed Oct 14`), the repeat in words (`every other Tuesday`), the priority, the list; a need's: its
  detail's first line (≤ 140 characters) or its command. `notes` never shows in a row: only in the drawer, in full as Markdown (headings, lists/tasks, tables, quotes, code and links), with line breaks and repository file links. Raw HTML stays text; code stays literal. Links use the host’s HTTP(S), mailto or tel allowlist; images appear as reference links. Snooze (shown on hover or focus; always without a mouse): in 1 hour, tonight (before 8 PM), tomorrow, Monday, next week (9 AM).
  A repeating item's done names its next due. Done today (`status=done`, `updatedSince` New York's midnight) folds below.
- **Quick add**: flightplan's `parse` after a 150 ms pause is the live preview (title, due, repeat, reminder, the list it lands
  on: the open list, else personal). An `ambiguous` reading holds Add and shows its choices; a choice adds with its `due`,
  `repeat`, `remind`. A 422 `ambiguous` (sent before the preview came) asks `parse` for the choices: hosts keep no error body.
- **Undo**: every done, snooze, add and move answers a toast with Undo for 3.5 s: done back to its status (a repeat: its due
  back), a snooze back to the due it had (none: cleared), an add dropped, a move back.
- **Signed out** (web): a refused write reports an error. Sign in through Deck's member gate; no write is stored for another host.

## Board view

Work: items with a `repo` (`repo=any`; an imported issue waiting on the owner in Needs you) and every `kind=epic` item (open and done).
On a desktop the page scrolls past the epics; only the columns fit the remaining viewport, growing to fill it below the shell bar. Each column scrolls inside itself. Columns left to right: Needs you, Stuck, In progress, Ready, Backlog, Done. Every column starts with 20 cards by priority, including Done; scrolling loads the next 20. Search, area, project, priority (including none) and exact label combine before batching. Filter changes reset delivery; automatic refresh preserves delivered batches. Projects use the backend's active project membership by default, with repo, reference and task counts to distinguish them; completed history is explicit and a selected completed project stays available. Unsplit projects remain legitimate. Epics: open ones in at most two rows, with *Show all N epics*. Done epics and epics whose parts are all done are behind one *N done* toggle. Unsplit epics say *Not split yet*. Others show done of total over their tasks (`parent`), a status bar whose
segments filter to the epic and pick that column on a phone, what is stuck, needs you or in progress; a click on its title filters
to it. Area chips. The six columns one at a time below 1100 px or without a mouse (Needs you first); a drag between them on a desktop. Cards: the reference (the issue link, else the `github:` key, else `#id`), the epic's short name while no epic
filters, the title, and at most one chip: why it is stuck (latest timeline detail, else “stuck”; never the issue body), else an open blocker, else its PR. A card opens the drawer: status, priority and list selects, its kind, clickable epic, relative timestamps, all links, Done/Snooze/open/copy actions and its history
(`/v1/items/<id>/events`), fetching the current item alongside history and replacing its board snapshot. Parent, children and blockers resolve by item id even outside the loaded Board; reverse blockers use the loaded snapshot. Related items open in the same drawer, and departed reads cannot replace a newer selection. A move is the owner's (`PATCH {status}`), which flightplan keeps over a rule's.

## Projects

How the projects are going, from `flightplan.projects` alone (flightplan CONTRACT.md *Projects*; no bridge or model call):
flightplan's summary sentence, then one line per project (its `line` as it is), the verdict a dot (waiting on you `warn`, stuck `bad`,
on track `ok`, idle and not split `muted`); a tap or Enter opens its epic on the Board (`/flightplan?epic=<id>#board`).

- `mountProjects(el, host, {onOpen?})` draws it into any element and returns `{projects, refresh(), unmount()}`; fetched on open and on
  `refresh()`, no timer. A tap opens the Board in that page (Mod: a new tab); `onOpen(project, {page})` overrides it.
- **Find's landing** (the empty box, every host with flightplan): the same view above the rows (Recent), but only the first 3 projects,
  then `+N more on the Board` (owner, 2026-10-17: the whole list buried Recent); read each time the box empties; nothing while it
  first loads or when flightplan fails. On a desktop's palette a tap opens the site's Board in the OS browser (`url.open`). The
  desktops' app.html links the stylesheet of every view the palette renders (`test/lint.test.mjs`).
- **The find rule**: `projects`, `project status`, `how are (the) projects going`, `status` (palette SPEC.md, *Flightplan in Find*).

## In the palette's find

Without opening Flightplan (palette SPEC.md, *Flightplan in Find*, *Capture*): the find rules (`what's due`, `today`, `needs you`, a
list's name, `<epic> status`, `projects`) answer from `today`, `upcoming`, `needs-you`, `items` and `projects` alone; a word search adds the owner's open todos
whose title holds the words (`items` `{q, repo: 'none'}`, no epic, never a notes match) to bridge's; found items' Done and Snooze, and `todo <text>`'s parse and add, are this model's (`createFlightplan(host,
{reload})`: a write finds again instead of reading the todos view). `deck find` does the same through the CLI's registry.

## Gaps

- Web from deck.wang.team uses `/flightplan/api` and Deck's member session; no cross-origin request or Flightplan session landing.

Agent questions (`question` on a Needs you item) show the question, one-tap options and a free-text reply in Needs you and the drawer.
Replies use `flightplan.answer` (`POST /v1/items/<id>/answer`, `{option}` or `{text}`, write scope and user gesture required).
Flightplan clears the question, moves the item to Ready and records the answer for coordinator delivery to `agent-task reply`;
Deck updates its saved snapshots and Needs count only after success. A failed send keeps the question available to retry.
