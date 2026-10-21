# Collection search and paging

People, Vehicles, Properties, Insurance, Papers, Taxes, Things and Clusters search
before paging. People searches Bridge's authoritative compact people projection;
other collections search the loaded metadata snapshot. A result beyond the current
page remains findable. Search never reads document bodies or starts detail requests.

Collection lists render 40 rows per page; nested document, checklist, photo,
specification and membership groups render 20. A list has one search (`CollectionSearch`): shown once it runs past
one page or 20 records, or a query is typed; never over its loading, starting, failed or empty state, which the
shared state components say once. Its status is the result count only. A page with its own search (Money) passes
`search: false` to `mountRows`. Selection uses canonical IDs and
survives filtering and paging. Cluster checkboxes retain selections across pages;
merge destinations are searchable and must still be active at confirmation.

Properties show membership first. Only the visible
20-paper page hydrates explicit expiry/renewal fields, with at most four document
reads in flight. Dates cache by document ID; page changes cancel obsolete reads,
refresh clears the cache and Retry reads failed visible dates. Unloaded dates are
labelled as unloaded; missing renewal messages refer to the displayed papers.

## Records open in place

A collection page's row opens in place (RowList `expand`, one at a time): its record card under its lines
(`src/view/record-card.js`: copy chips, a two-column fact grid, live state when there is any, up to five items grouped, its
actions, `Open ›`). A click, Enter, Space or → opens a row; on the open row Enter, Space, a click, ← or Esc (from inside its card too)
close it; Ctrl/⌘+Enter opens its full view. The open row is the URL's hash (`/vehicles#<id>`: reload and Back restore it). Its full
view (`Open ›`) is the record's canonical detail in the page's viewer, over the list: `/vehicles?record=<id>#<id>`, Back or
close the list with that row open. People, Vehicles, Properties, Insurance, Papers, Taxes, Things, Clusters and Notes open so (a
note is its own card, read or edited in place). A purchase's row and a sign-in's are their whole record, their actions on the row
(Receipt; Sign in, Get missing): they open nothing. No collection page has a drawer.

A cluster has its own page, its full view: `/clusters?record=<id>#<id>` on the site (`collection-target.js` `recordHref`; every link
to a cluster names it: `entityHref`, `mountRows`, a person's Clusters, Mod+click on the list), the viewer on the desktops and Android
(they have no Clusters list). Bare `/clusters` is the list; `/clusters#<id>` is only the list's own open row. The page shows what it
is, its Things (bridge's `things: {count, results}`: picture or `thing` glyph, name, price, date, store, status not owned; a thing
opens its page, its house record by `thingId`, else its catalog product), the owner's curation, then its Documents. Its card shows
up to four things (`All n ›`) above its newest documents. A record a full view names (a person's cluster, a cluster's thing) opens
the site's page for it, a shell's viewer in place.

Items alike (the same title and date) are one item with their count (`×6`), in the card and the full view's lists: it opens
the newest, its count lists them. A part with nothing in it is left out, never said empty (`No indexed photos`, `Nothing
reported yet`); a full view's photos column shows only with photos.

Find shows each collection (these, Purchases, Texts, Notes and Sign-ins: nav `collection: true`) as one
Collections row that opens its page; it never draws a collection page inline. A record the words name leads Find, above
the house actions (palette SPEC.md, *Records*): selected, it shows the same record card in place (*Record card*); Enter opens it,
the site on its full view (`/vehicles?record=<id>#<id>`: `mountPalette`'s default, `recordPage`), the desktops in the palette's
pane. Palette results, collection pages and generic row Details reuse the same collection detail components. Enter, Space, Right, Tab, click and Details preserve explicit
collection identity through viewer history and pop-outs. Old saved person, product
and cluster groups restore those details. Full loaded membership remains searchable;
only the current page becomes rendered rows or keyboard candidates.

Bridge's separate cursor-based `bridge.collectionDetails` API remains registered for
external consumers; the shared collection details use the authoritative entity projection.

Vehicle photo searches start only for the car opened in place (or its full view), cancel when it closes,
and cache until Refresh. Telemetry remains independent of opening a row.

## Cross-links

Wherever Deck names a record (a person, vehicle, property, thing, policy, paper, tax packet, cluster, note, document or Flightplan
item), the name links to that record's page: `src/view/entity-link.js`, `entityHref({kind, id})` and `EntityLink({kind, id, label,
chip?})`, the only way to build one. A collection record is its row opened in place (`/<collection>#<id>`; `full`: its full view,
`?record=<id>`), a document `/doc/<id>`, an item `/todo/FP-<n>` (the Board's `/flightplan/FP-<n>` for work in a repo). Only kinds whose
page is in the navigation (`contract/nav`, `collection: true`) link, and only with an id bridge gave: a name alone stays text, never a
search. A person links once bridge's people projection holds their id (one `bridge.people` read per host, shared by the page);
otherwise People would say unavailable. The site: plain same-origin hrefs (a middle or modified click opens a new tab; a card's
document item opens in the page's viewer on a plain click). A desktop: `EntityNav` (app.js) opens the record in the palette's pane, a
link from a record there in the viewer's history (Back returns), a note or item on the site through `url.open`; the web view never
navigates. In Find's selected record a link is one of the card's Tab stops.
Linked now: Papers' holder headings and a paper's Holder; a policy's insured and covered vehicles; a car's owner and driver; a
product's owner; a tax checklist line's person; a profile's clusters; every card's document items; a Texts conversation's person;
`FP-<n>` in notes, Flightplan's notes, questions, drawer titles and history; the viewer's People & things chips (the viewer opens them its own way: `onOpen`, on a desktop every click). Fields bridge, Habitat and Purser give only as names:
FP-1730, FP-1731, FP-1732.
