# Shell Bar

## Shell bar

`mount.js` exports `mountShellBar(el, opts)` → `{update(opts), unmount()}`; `view/shell-bar.js` exports
`ShellBar(opts)` for Preact pages. Styles are loaded once by the mount, under the existing same-origin CSP.

```js
opts = {brand: {label: 'Deck', href: '/', mark?},
  nav, // resolveNav(manifestNav, configuredOrigins); see below
  current: 'search', needs?, verdict?, signIn?}
```

- `ui/contract/nav.json` is the single ordered navigation list. Render every supplied entry immediately,
  including entries with a `backend`, without availability probes or identity checks.
  An unreachable destination displays its own failure page; authorization belongs to that destination.
  Each backend reads it from its pinned bundle at startup and resolves it with deployment configuration; never keep a local navigation list.
  Published entries have a logical `origin` (`deck`, `purser`, `allos`, `habitat`) and a root-relative `href`, including query/hash.
  Import `resolveNav` from `ui/src/nav.js` and call `resolveNav(manifestNav, configuredOrigins)` before mounting.
  `configuredOrigins` maps each logical key to an HTTP(S) origin supplied by the consuming host's environment, never inferred from the current hostname.
  The resolver returns absolute destinations, preserves ids, labels and backend metadata, and throws for missing or invalid origins.
  Configure all four origins for every destination. Fail visibly on configuration errors.
  Existing pins retain their original format; adopt this resolver together with the corrected release.
  Absolute URLs work on either origin. `current` is a list id and marks one with `aria-current="page"`.
- Tower supplies its separate console nav (#301). There are no reload timers.
- `needs` is what waits on the owner: `{count, label, href?}` is an entry's count (a badge, the label read out; 0 draws nothing; on a
  phone the badge alone), or text or a Preact node as it is. `brand.mark`, `verdict` (a status region) and `signIn` (member or
  sign-in controls) accept text or Preact nodes, never HTML strings. Hosts own their data, actions and refreshes; omitted slots disappear. Updates merge options.
- Links and controls retain native keyboard behaviour and focus rings. Below 600 px the brand, Menu disclosure,
  needs badge and sign-in fit in the bar. Menu opens the full scrollable list below the bar; Enter/Space toggle it,
  Tab reaches every link, and Escape closes it and returns focus to Menu. A verdict occupies its own row.
  At wider widths the links scroll sideways in the bar.
