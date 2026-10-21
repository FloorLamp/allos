# Shell Bar

## Shell bar

`mount.js` exports `mountShellBar(el, opts)` → `{update(opts), unmount()}`; `view/shell-bar.js` exports
`ShellBar(opts)` for Preact pages. Styles are loaded once by the mount, under the existing same-origin CSP.

```js
opts = {brand: {label: 'Deck', href: '/', mark?},
  nav, // read ui/contract/nav.json from the pinned bundle
  current: 'search', site?, host?, needsSource?, needs?, verdict?, signIn?,
  actions?} // [{id, label, glyph?, run}]: the host's own commands (Android: Send file, Settings), a row of buttons first in the phone's Menu, after the destinations wide
```

- `ui/contract/nav/<id>.json` (published as `ui/contract/nav.json`) is the single ordered navigation list. Render every supplied entry immediately,
  including entries with a `backend`, without availability probes or identity checks.
  An unreachable destination displays its own failure page; authorization belongs to that destination.
  Read the list from the pinned bundle and pass it directly to the mount; never keep a local navigation list.
  An entry with `native: false` is a page only a browser session serves; native hosts stage their bundle without it (`build({native: true})`).
  Library collections (bridge's, Texts, Notes, Sign-ins) carry `collection: true`; named pages such as Money, Health and House are separate.
  Find matches a collection's label and every entry's and page's `find.words` ([Navigation](README.md#navigation)) with the palette’s
  word/prefix/typo rules and opens their destinations; `pages` are an entry's own pages, linked from its page, not the bar.
  Entries have root-relative `href` paths, including query/hash, with no `origin` metadata or origins configuration.
  Money, House and Health use `/money`, `/house` and `/health` on the embedding site's origin.
  `resolveNav` is removed, with no alias. Adopt this contract and the consumer change together;
  older pins retain their original format. `current` is a list id and marks one with `aria-current="page"`.
- Tower supplies its separate console nav (#301). There are no reload timers.
- `site: true`: the bar of every page on deck.wang.team, whichever host serves it (Deck's own pages, Purser's Money, Habitat's House);
  see *The site*. Its Needs and member slots are the site's: a host's `needsSource`, `needs` and `signIn` never replace them.
- With `host` or `needsSource`, the bar uses the shared `needsFor(host)` snapshot and cached fetch, including across page remounts.
  It labels the total Needs and links to Todo (the nav's `todo` entry, `/todo`), where Needs you leads; page-local `needs` counts cannot
  override it. While it loads, or when any source failed, the slot draws nothing (never a partial or stale total); Todo shows that state.
- `needs` is what waits on the owner: `{count, label, href?}` is an entry's count (a badge, the label read out; 0 draws nothing; on a
  phone the badge alone), or text or a Preact node as it is. `brand.mark`, `verdict` (a status region) and `signIn` (member or
  sign-in controls) accept text or Preact nodes, never HTML strings. Hosts own their data, actions and refreshes; omitted slots disappear. Updates merge options.
- Entries carry `group: top | library` and `glyph` (a name in `src/glyphs.js`); a Library entry also `section` (its heading; one
  section's entries sit together in `order`) and `hint` (one line under its name). `nav.mjs` rejects an entry without them.
  Desktop shows the top entries and Library, a disclosure at the links' type with a chevron, current on any of its pages. It opens
  on click (no hover) as a card under the button, left-aligned, right-aligned to it when that would pass the viewport's gutter: the
  sections under `dk-label` headings, two columns from 760 px, each row the glyph's tile, the name and the hint; only the current
  page's row is highlighted. Keys: Enter/Space toggles it; ArrowDown/Up open it and move (wrapping), Home/End, ArrowLeft/Right across
  the columns, a letter to the next entry starting with it (letters typed together: the entry starting with them); Escape closes it
  and returns focus to the button.
  Below 600 px a Menu button opens navigation as a sheet: a rounded card under the bar, every destination a row (`--row`, its glyph's
  tile, the current one highlighted), then Library's sections as on the desktop (no Library button: nothing to disclose), sized to its
  content up to the screen below the bar and scrolling inside past that. Escape closes the sheet and returns focus; outside clicks or
  focus leaving the header dismiss it. The header stays sticky, with phone navigation targets at least 44 px.
- `mountPalette(el, host, {nav, …})` draws phone tiles immediately below Find’s box on an idle page
  (no query, scope, answer or pending ask). Pass the same resolved `nav` array used by `mountShellBar`;
  no per-site table or separate tile mount is needed. Tiles remain hidden on desktop and in panel layouts.
- `mountNavTiles(el, {nav, current})` → `{update(opts), unmount()}` draws the same list as a phone tile grid
  (hidden on desktop). Hosts place it immediately below the Find box, before other home content.
  It uses the supplied same-origin destinations, with no per-site lists or availability probes.

## The site

`ui/src/host/site.js` is the site's one context, the same on every host's page; `mount.js` exports `siteNeeds(window)` and `siteHost(window)`.

- **Needs**: Flightplan's Needs you (Flightplan's pollers carry every backend's needs; Bridge's are not read on the site). The origins
  come from the page's `<meta name="deck-backends">`, else Deck's `GET /api/deck-backends`; a failed read is an unknown count, read
  again on the next refresh. A page passes `siteNeeds(window)` to the content that counts Needs (Find, Todo, House's strip),
  so they and the bar show one number. Focus and `deck-attention-changed` refresh it.
- **Member**: boarding's `GET /boarding/session` (the session Caddy and Deck send upstream as `X-Member`): the member's name and
  Sign out (`POST /boarding/sign-out`, then `/boarding/`; `deck-sign-out` fires first), Sign in (`/boarding/sign-in?to=<this page>`)
  when boarding answers signed out, nothing when nothing answers. A host's own owner check (Money's) gates its owner controls, never the bar.
- Hosts mount it as `mountShellBar(el, {nav, current, site: true})` or a page mount's options (`mountMoneyPage(el, host, {…, site: true})`);
  the brand defaults to Deck at nav's `search`. Kiosks (House's tablet, the wall) mount no bar.
