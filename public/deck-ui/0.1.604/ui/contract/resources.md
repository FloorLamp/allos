# Resources

## Resources

GET only; anything else refused. Paths (the UI asks with `/v1/…`):

- `/v1/doc/<id>[/message/<m>][/attachment/<a>[/attachment/<e>]]/(page/<n>|video)`, query `w`, `v` (a find row's `document.thumb`, the focused row's
  preview upgrades it to `page/1?w=2400`, preserving `v`)
- `/v1/doc/<id>/message/<m>/inline/<part>`
- `/v1/doc/<id>/image?u=`
- `/v1/texts/<conv>/message/<m>/attachment/<a>[/attachment/<e>]/(page/<n>|video)`, query `w`, `v` (shell only in practice: the site has no `texts`)
- `/v1/people/<person.id>/photo` (recorded profile photo; 404 keeps the initials fallback)
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
site's base policy on pages that mount it. Bridge owns the response header in `src/server.mjs`; Caddy passes it through.
Flightplan uses `/flightplan/api` on the same origin and requires no cross-origin `connect-src` entry. Bridge's
`test/deck-ui.test.mjs` covers its policy, including `/flightplan`.

## Token

The shell reads bridge's token (`~/.config/bridge/client.json`) and adds it only to its own https requests to bridge: never in a
result, event, header or URL the UI sees (contract test). The site has no token: its session is Caddy's (family network) or
boarding's (a member's passkey).

