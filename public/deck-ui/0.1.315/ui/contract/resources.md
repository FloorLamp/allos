# Resources

## Resources

GET only; anything else refused. Paths (the UI asks with `/v1/…`):

- `/v1/doc/<id>[/message/<m>][/attachment/<a>[/attachment/<e>]]/(page/<n>|video)`, query `w`, `v` (a find row's `document.thumb`, the focused row's
  preview upgrades it to `page/1?w=2400`, preserving `v`)
- `/v1/doc/<id>/message/<m>/inline/<part>`
- `/v1/doc/<id>/image?u=`
- `/v1/texts/<conv>/message/<m>/attachment/<a>[/attachment/<e>]/(page/<n>|video)`, query `w`, `v` (shell only in practice: the site has no `texts`)
- `/local/recent/<id>[/thumb]` (shell only)

Web: `/api/…` (same path). Windows: `https://deck.example/bridge/v1/…`, Mac `deck-app://app/bridge/v1/…`, served by the shell's
speed layer (disk cache, ETag, keep-alive, Range; video with Range and `Retry-After` passed through).

## Email bodies

The UI shows bridge's sanitised html in `<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc>`
with its own CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'`: no scripts can run in it (never `allow-scripts`);
`allow-same-origin` lets the UI size the frame to its body and hand its links to `url.open`. Every image is a data URL the UI fetched
through `resource()` (`data-inline-src` at once, `data-remote-src` after Load images); a host needs nothing for it beyond those
resources.

## CSP

`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src
'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`: the bundled UI's, and the
site's base policy on pages that mount it. Bridge expands the site's `connect-src` with the configured backend origins, including
`https://flightplan.wang.team` (override: `BRIDGE_FLIGHTPLAN_ORIGIN`), so Flightplan's credentialed cross-origin API calls can run
(spaceport#884, [bridge#294](https://github.com/FloorLamp/bridge/pull/294)). Bridge owns this response header in `src/server.mjs`;
Caddy's Deck route passes it through. Bridge's `test/deck-ui.test.mjs` checks the full CSP on every page, including `/flightplan`.

## Token

The shell reads bridge's token (`~/.config/bridge/client.json`) and adds it only to its own https requests to bridge: never in a
result, event, header or URL the UI sees (contract test). The site has no token: its session is Caddy's (family network) or
boarding's (a member's passkey).

