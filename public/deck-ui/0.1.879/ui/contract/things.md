# Things

Find's Things row opens the bundled `things` collection page on web, Mac,
Windows and Android. `mountThings(el, host, {onOpen?})` returns
`{things, refresh(), unmount()}` and uses the shared viewer for receipts.

`bridge.things` reads `GET /v1/things` (`/api/things` on web): product catalog
rows with a `thing` payload. `bridge.thing {id}` reads `GET /v1/thing/<id>`
(`/api/thing/<id>` on web): the product detail. Both require `bridge:find`.
The shell bar shows Things only after a successful list read, including an empty
list; denied or unavailable reads hide it.

The collection contains durable owned items only; Bridge excludes consumables and clothing.
Deck also excludes products whose status is not `owned`. Rows show a short name (the
first clause of a purchase title, cut by the row's width), the cached product photo (else a product icon), and indexed brand, model,
variant, owner, store, purchase date and price; an owner or store every listed thing shares is left out of every row. Redundant
product/owned labels are omitted; absent purchase details get one neutral placeholder. An absent owner is omitted from both rows and purchase facts; known names are preserved.
For products without `thingId`, the card and full view show cached specs, purchase facts, receipts and the cached
product photo and the full, unchanged name in its heading. Purchase history and
non-owned products remain available through Bridge detail and Find; a purchase is
not proof of ownership. Unknown facts stay unknown.
Cached photos use the allowlisted `/v1/thing-image/<sha256>` resource through the
host; arbitrary remote images are never loaded. Receipts open in the shared viewer.
Web consumers must expose the authenticated `/api/things`, `/api/thing/<id>` and
`/api/thing-image/<sha256>` routes using bridge's existing access policy.

The Purchases button opens categorized purchase history and linked card
charges, including unmatched purchases ([API contract](purchases.md)).

## Physical thing page (FP-1180)

A product or house record with `thingId` opens the shared physical thing page.
`/things#<UUID>` also selects it directly, without a catalog membership requirement. Find's thing row with a shared
`thingId` (the thing's name or alias) opens it there too: on the site `/things?record=<UUID>#<UUID>`, in a desktop's window in place.
Legacy view IDs remain document keys; Deck never joins on names, serials or models.
Records without a shared identity retain their existing record view.

The registry operation `bridge.things.detail {query: {id: <UUID>}}` reads
`GET /v1/things/<UUID>` (web twin `/api/things/<UUID>`), requiring `bridge:find`.
This is the consumer contract for the bridge follow-up; bridge main currently
provides identity writes and lookup, but does not yet implement this joined read.
It must return `{thing: {id, name, identifiers, room?, location?, purchase?,
warranty?, manuals, documents, devices, alerts}}`, with the same UUID in `id`:

- `identifiers`: `[{kind, value}]`; `room` and `location`: readable labels.
- `purchase`: `{store?, date?, price?}` or null; `warranty`: `{expires?, terms?}` or null.
- `manuals`, `documents`: ordinary bridge document references `{id, title, date?}`.
  Warranty papers and receipts belong in `documents`; manuals in `manuals`.
- `devices`: `[{id, name?, state?, entities: [{id, state?}]}]` from Habitat's exact
  shared identity references (the hub's Live controls them through House: *Hub*).
- `alerts`: `[{id, title, state?, detail?, since?}]` linked to that identity.

Bridge owns the join and authorization for every returned field and document.
Unknown facts are null and absent lists empty; unavailable upstream data must not
be reported as a successful empty read. A missing thing is 404; forbidden is 403.
Deck shows a retryable error without retaining another thing's data. A part with
nothing is left out (*Hub*), never said healthy. Documents open in the shared viewer.

## Hub

A physical thing's page is its hub (`PhysicalThingContent`, view/thing-hub.js; model src/thing-hub.js), each part left out when it has
nothing, in this order: what it is (name, kind and room, aliases, its camera); **Live** (each linked device's entities: a control as
House's own tile and confirmation, `habitat.act` as House sends it; a reading in House's words, `0 W`; its alerts); **Usage** (`Used 18
times in 30 days · last today 7:12 AM, 12 min`, the 12-week strip of use days, the newest five sessions, `All sessions ›` every one
read and `More sessions` bridge's next page; a logged session's `In Health ›` its `practice.url`, a practice Health has not taken `Not in
Health`) and its Health line (`Red light therapy · 18 sessions in 30 days ›`, `health.url`); **Rules** (each to House admin,
`/house/rules#<id>`, House rules with that rule open: house.md *Rules*); **Purchase and warranty** (its facts, its order's document in the viewer,
each charge to Money's `/money/transactions?txn=<id>`); **Papers** (its documents, manuals and the documents linked to it, once each
and none Purchase already shows, in the viewer); **Record** (identifiers, where); **Linked** (*Links*). A thing's card in its list (the record card)
says its usage and Health lines, its devices now and its papers; Open › its page. On Things, a thing no listed row is (`/things#<UUID>`)
opens its page, the whole record. Where the host has House (`habitat` in its backends) Live is House's controls over the entities
bridge names (house.js view `thing`: only theirs watched; a host with no stream reads their states, again after an action); without,
bridge's states as facts. A house record (*House record*) is the same page: its sections in place of the kind and room line and
Record, the hub's parts before its History, Live only when the record names no entities (its Live state shows them), its warranty
the record's.

Bridge's detail (`bridge.things.detail`) adds, for the hub (bridge FloorLamp/bridge#653, Habitat FloorLamp/habitat#546):

- `kind`, `aliases: [text]`.
- `devices[].entities[]`: `{id, name, domain, state, unit}`.
- `purchase`: `{id, store, date, price, orderNumber, document: {id, title} | null, charges: [{id, date, account, amount}]}`
  (`orderNumber` as `/v1/purchases` gives it); `warranty`: `{expires, terms}`.
- `usage`: `{devices, count30d, last: {start, end, minutes} | null, days: [YYYY-MM-DD], sessions: [Session], next}` or null;
  Session `{start, end | null, minutes, entity, source: practice | power | state, practice?: {name, logged, key, url?}}` (`url`
  only when logged); `health`: `{practice, count30d, url}` or null; `rules`: `[{id, title, summary, mode, lastFired, lastOutcome:
  {ok, error, shadow} | null, healthy, entities}]`, `[]` when none match, null when unread.
- `unavailable`: `habitat` (devices and alerts `[]`, usage and rules null: one line, *House unavailable · Retry*, where Live, Usage and
  Rules would be), or `usage` or `rules` alone (that part null: the line in its section); the rest is shown.

| Op | Route | Scope |
|---|---|---|
| `bridge.things.usage {query: {id, cursor}}` | GET `/v1/things/{id}/usage?cursor=` → `{sessions, next}` (400 a bad cursor, 503 Habitat down) | `bridge:find` |

Its web twin is `/api/things/{id}/usage`, the site's own session, as `things.detail`.

## House record (FP-1634)

bridge owns the house's records and Deck edits them directly (owner, 2026-10-20; bridge `docs/plans/house-records.md`, CONTRACT.md
*House records*): no review between an edit and the record. A house record is the thing's full view (the record card's Open ›):
`PhysicalThingContent`, the same in the Things page's viewer, Find's viewer (the desktops' palette pane) and Android's WebView.
`thing.house` (bridge CONTRACT.md *Physical thing detail*) gives, in this order, each section only when it has something:

- the record's facts: kind, make, model, serial, room (`thing.room`, the canonical room name; never the record's room id; not
  edited here), location, installed, manufactured, serves, size, a panel's main breaker;
- **Open items**, one per subject: bridge's `suggestions` (Accept), the questions (`to_confirm`) of the record, its breakers and
  events (Answer), the fields `record.missing` names (Fill in: model, serial, installed, location) and a panel's breakers with no
  `feeds` (Verify). A missing field bridge suggests a value for is that suggestion's item, with "Fill in another";
- **Live state**: Habitat's `habitat.state` of each `record.ha` entity, by its name; hidden where Habitat is not set up. Without
  `ha`, bridge's Habitat devices section;
- **Breakers** (a panel's, in slot order), **Events** (newest first; "+ Event"; with none, only its heading and "+ Event" for a
  writer), **Warranty**, **Installer**, **Notes**, **Photos** (`house.photos`: `[{id: <Immich id>, document: {id, title, date} |
  null}]`, bridge's indexed copies through `/v1/doc/<id>/page/1?w=320`, opened in the viewer; the rest counted), the thing's
  purchase, Manuals, Receipts and documents, devices and alerts, then **History** (who, when, old → new).

Edits, for a member who may write (`memberCan(member, 'write')`: never the agent member; shared screens never mount Things): a
value clicked becomes its field (Enter or Save writes it, Esc leaves it); Accept writes a suggestion; Answer clears a question;
Verify writes a breaker's loads; a breaker's row edits it; "+ Event" adds one; an event's row edits it, Delete asks first. Each
write's answer `{house}` is drawn at once and a toast says Saved; bridge's 400 `{error: "invalid", fields: {path: message}}` shows
beside each field (the web host keeps `fields` on its error); anything else keeps the edit open with the shared failure words.

| Op | Route (web: `/api/…` with the member session) | Scope | Body | Answer |
|---|---|---|---|---|
| `bridge.things.record` | `PATCH /v1/things/<id>/record` | `bridge:act` | `{fields: {<path>: value or null}}` or `{suggestion}` | `{house}` |
| `bridge.things.record.breaker` | `PATCH …/record/breakers/<slot>` | `bridge:act` | `{fields}` | `{house}` |
| `bridge.things.record.event.add` | `POST …/record/events` | `bridge:act` | `{event: {title, date, type, status, notes?, by?}}` | 201 `{event, house}` |
| `bridge.things.record.event` | `PATCH …/record/events/<event>` | `bridge:act` | `{fields}` | `{house}` |
| `bridge.things.record.event.delete` | `DELETE …/record/events/<event>` | `bridge:act` | | `{deleted, house}` |
| `bridge.things.record.answer` | `POST …/record/answers` | `bridge:act` | `{on: record \| breaker:<slot> \| event:<id>, answer}` | `{house}` |
| `bridge.things.record.history` | `GET …/record/history` | `bridge:find` | | `{history: [{id, at, who, subject, field, old, new, note}]}` |

`query` carries `id` (the thing's UUID), `slot` and `event`; writes need a gesture. Dismiss waits for bridge's device route for a
suggestion's dismissal (FP-1682).

## Links

A physical thing's page shows **Linked** (`ThingLinks`, view/thing-links.js; model src/thing-links.js): what bridge joins to it, by
kind (Purchases, House devices, Entities, House records, Documents, Vehicles), each its title (EntityLink where bridge gives `ref`),
who made it (by hand, or found by a rule and its evidence) and Unlink; **Link…**, the shared picker (`LinkPicker`: one kind at a
time, bridge's first results before typing); **Suggested** (why, Link, Not it). A target another thing has (exclusive kinds: all
but documents) moves only after the owner's yes (a result's `thing`, a suggestion's `linkedTo`, or bridge's 409), then posts
`move: true`. Only a member who may write (member.js `memberCan(host.member, 'write')`) sees an action; the agent member reads.
**New thing** (Things' header; a House tile's menu, its device or entity linked at once: `from`) makes one from scratch
(`NewThing`: name, make, model, kind, room, notes, other names) and opens its whole record (`/things?record=<UUID>#<UUID>`).
**Also called** (`Aliases`) lists the thing's other names (the detail's and links' `aliases`, what Find matches), edited in place.
A `/things#<UUID>` no listed row names (an owner-made thing) opens that full view. Find's thing row for a name or alias
(`thing.thingId`) opens the same page through the viewer (`/v1/doc/<id>/pages` kind `thing`). The other sides use the same picker: a purchase's *This is…* and *New thing* ([Purchases](purchases.md)), a House tile's menu
([House](house.md) *Things*).

Registry ops (bridge's thing links API; web twins under `/api`, the site's own session, as `things.detail`):

| Op | Route | Scope |
|---|---|---|
| `bridge.things.links {query: {thing}}` | GET `/v1/things/{thing}/links` → `{links, suggestions, unavailable?}` | `bridge:find` |
| `bridge.things.link {query: {thing}, body: {kind, id, move?}}` | POST `/v1/things/{thing}/links` (409 `{linkedTo}`) | `bridge:act` |
| `bridge.things.unlink {query: {thing, kind, id}}` | DELETE `/v1/things/{thing}/links/{kind}/{id}` (also Not it) | `bridge:act` |
| `bridge.things.search {query: {kind, q?, limit}}` | GET `/v1/things/links/search` (`kind=thing` finds things) | `bridge:find` |
| `bridge.things.create {body: {name, make?, model?, kind?, room?, notes?, aliases?, from?, move?}}` | POST `/v1/things` → 201 `{thing, links, suggestions, aliases}` | `bridge:act` |
| `bridge.things.aliases {query: {thing}, body: {aliases}}` | PUT `/v1/things/{thing}/aliases` → `{aliases}` (≤20, 1–80 characters; bridge trims, dedupes) | `bridge:act` |

A target id is the registry's `{id}` segment (`^[a-z0-9][a-z0-9:._@-]{0,199}$`). `unavailable: ['habitat']` says House devices are
missing, never an empty list. Hosts keep a failed write's body out of the error, so a 409 asks without naming the other thing
unless the picker or a suggestion already did.

## Habitat devices and electricity

When the host configures Habitat, Things also reads `habitat.ha.registry`,
`habitat.ha.states`, `habitat.ha.device {query: {id}}` and `habitat.envoy`.
Web reads use `/habitat/api/ha/{registry,states,devices/<id>}` and
`/habitat/api/envoy`; Deck's proxy forwards them to `/house/api/*` with the
member session. No HA or service token is installed in Deck.

Devices join areas and entity states by registry ids, excluding disabled devices
and disabled or hidden entities. Selecting a device reads its current detail.
Electricity shows monthly grid import and export in kWh from Envoy's `months`
(`period`, `import`, `export`, `days`, `partial?`), flagging partial coverage.
These views load independently of Bridge's product catalog; a failed Habitat read
shows a retryable error. Anonymous reads fail before proxying to Habitat.
Habitat's [response contract](https://github.com/FloorLamp/habitat/blob/main/docs/contract/api.md)
defines Things registry reads and Envoy grid statistics.
