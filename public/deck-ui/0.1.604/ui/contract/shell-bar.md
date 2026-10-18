# Shell Bar

## Shell bar

`mount.js` exports `mountShellBar(el, opts)` → `{update(opts), unmount()}`; `view/shell-bar.js` exports
`ShellBar(opts)` for Preact pages. Styles are loaded once by the mount, under the existing same-origin CSP.

```js
opts = {brand: {label: 'Deck', href: '/', mark?},
  nav, // read ui/contract/nav.json from the pinned bundle
  current: 'search', needs?, verdict?, signIn?}
```

- `ui/contract/nav/<id>.json` (published as `ui/contract/nav.json`) is the single ordered navigation list. Render every supplied entry immediately,
  including entries with a `backend`, without availability probes or identity checks.
  An unreachable destination displays its own failure page; authorization belongs to that destination.
  Read the list from the pinned bundle and pass it directly to the mount; never keep a local navigation list.
  Bridge collections carry `collection: true` and optional `aliases` for Find; named pages such as Money, Health and House are separate.
  Find matches collection names and aliases with the palette’s word/prefix/typo rules and opens their existing destinations.
  Entries have root-relative `href` paths, including query/hash, with no `origin` metadata or origins configuration.
  Money, House and Health use `/money`, `/house` and `/health` on the embedding site's origin.
  `resolveNav` is removed, with no alias. Adopt this contract and the consumer change together;
  older pins retain their original format. `current` is a list id and marks one with `aria-current="page"`.
- Tower supplies its separate console nav (#301). There are no reload timers.
- `needs` is what waits on the owner: `{count, label, href?}` is an entry's count (a badge, the label read out; 0 draws nothing; on a
  phone the badge alone), or text or a Preact node as it is. `brand.mark`, `verdict` (a status region) and `signIn` (member or
  sign-in controls) accept text or Preact nodes, never HTML strings. Hosts own their data, actions and refreshes; omitted slots disappear. Updates merge options.
- Entries carry `group: top | library`. Desktop shows the top entries and a Library disclosure.
  Enter/Space toggles Library; Escape closes it and returns focus to the button.
  Below 600 px a Menu button opens navigation as a sheet, including Library. Escape closes the sheet and returns focus; outside clicks or focus leaving the header dismiss it. The header stays sticky, with phone navigation targets at least 44 px.
- `mountPalette(el, host, {nav, …})` draws phone tiles immediately below Find’s box on an idle page
  (no query, scope, answer or pending ask). Pass the same resolved `nav` array used by `mountShellBar`;
  no per-site table or separate tile mount is needed. Tiles remain hidden on desktop and in panel layouts.
- `mountNavTiles(el, {nav, current})` → `{update(opts), unmount()}` draws the same list as a phone tile grid
  (hidden on desktop). Hosts place it immediately below the Find box, before other home content.
  It uses the supplied same-origin destinations, with no per-site lists or availability probes.
