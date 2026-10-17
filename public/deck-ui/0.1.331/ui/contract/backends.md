# Backends

## Backend registry

Deck config (`DECK_CONFIG`, else `~/.config/deck/client.json`) supplies `backends` and a top-level `tokenFile` (relative to
that config, default `credential`). Native hosts and `deck backend <backend.op> [JSON args] [--confirm]` use the device credential
for `/v1`; never a backend's legacy token. `deck credential` keeps this file. Android keeps the same public `backends` object in
Settings and the credential in SecretStore (`Settings.backendHost()`).

```json
{"tokenFile":"credential","backends":{"purser":{
  "origin":"https://purser.wang.team","baseUrl":"https://purser.wang.team",
  "scopes":["purser:read"],
  "ops":{"needs":{"method":"GET","path":"/v1/needs","scope":"purser:read"}}
}}}
```

Each registry key is the backend's name; each `ops` key is a suffix: `purser.needs` above. Names use lowercase ASCII letters,
then letters, digits or hyphens; operation suffixes may contain dot-separated names. The same registry accommodates bridge, purser, rover, allos and habitat without adding host code.
Routes are trusted config, fixed `/v1/` paths with letter/digit/underscore/hyphen segments, GET, POST or PATCH (an item changed
where it is: flightplan's). A `{name}` segment is a path parameter, filled from `query.<name>` on every host: `{id}` takes a shared
id (`^[a-z0-9][a-z0-9:._@-]{0,199}$`), any other name letters, digits, `_` and `-`; encoded as one segment (`encodeURIComponent`),
and refused when missing or invalid (`<op>: <name> is not a path segment`). The grammar is `deck/tool/backends.mjs`'s `routeGrammar`,
generated into each host's registry. A route's scope must
be in `scopes`, and every scope must start with that backend's name and `:`. These are configured device grants; the backend still
verifies the credential and its actual grants with boarding on every request. A config cannot grant a device additional access.
`host-contract.json`'s `backendOp` defines these calls' args: optional `query` (scalar values, encoded by the host), optional JSON
object `body` (POST or PATCH), no other fields. Every POST or PATCH needs the host's recent input gate (web: active browser user gesture;
CLI: explicit `--confirm`). Unknown ops are unsupported; missing or invalid config, scope or credential is not-set-up; bad args
or missing input is refused. HTTP failures retain their status, network failures are unreachable, cancellation is cancelled.
No fallback to bridge, another backend or another credential. Requests refuse redirects. Native `baseUrl` destinations are HTTPS origins (HTTP
only for loopback tests), with no user info, path, query or fragment. Credentials never cross the native host boundary.

**Web decision (owner, 2026-10-15): keep sessions.** Pass the public registry as `webHost(window, {backends})`. Each backend op
uses that backend's `origin`, replaces `/v1/` with `/api/`, and sends that origin's session cookies (`credentials: include`).
For registry operations, `origin` may include a trusted web prefix: `https://allos.example/health` (or `/health/`)
produces `/health/api/*`; a root origin still produces `/api/*`. Prefix segments contain ASCII letters, digits, `_` or `-` only.
Empty segments, dot segments, escapes, user info, query and fragment are refused. Call args cannot supply a destination or prefix.
`baseUrl` remains root-only and device requests remain `/v1/*`. `webPost` reads (Allos ask) use the same prefix,
with query values in a JSON POST body and no write gesture; mutations still require input.
Boarding's member gate and the backend's owner session authorize it; cross-origin sites must explicitly allow credentialed CORS
from the calling site (and writes its Origin). Browsers never receive a device credential. An auth, CORS or network failure
stays a failure. Backend origins must also be allowed by the embedding site's connect CSP; the native bundle's CSP stays self only.

Bridge's existing ops, argument shapes, resources, caps and action-list checks stay as documented in [Host](host.md) and [Resources](resources.md). Existing bridge config
continues to work; a registry `bridge` entry supplies its native destination and device credential, and its web origin supplies
the existing `/api` routes. The Needs you row reads `needs` on every configured backend and bridge, deduplicating by `from.backend`/`from.id`
(or the responding backend and id). A direct item wins over a relay; each item always names its origin backend, even when only
one backend has needs. A failed refresh keeps that backend's last list. A backend without a configured needs route contributes none. Bridge may still relay non-backends
such as house-agent. On every host, `<backend>.need {id}` posts to the configured needs route plus the encoded id, with the same
credential or session and gesture gate; bridge keeps its existing op. Registry calls with `{body}` and other operations use their configured
routes.

## Session renewal

A backend whose definition names a `session` landing (`deck/backends/<id>.json`: rover's and flightplan's `/session`, rover
CONTRACT.md *Browser session renewal*) has its writes renewed on the web: on `https://deck.wang.team`, a POST or PATCH op (scope not
`:read`) answered 401 rejects with `renew(page)` on the error. The view calls it (Accounts at once; Flightplan from its *Sign in to
save*): the host keeps `{page, href, op, args}` in sessionStorage for at most five minutes and navigates to `<backend origin>/session?to=<this
page's URL>`. Boarding signs the owner in on the backend's host and the landing returns. `resume(page)`, when that view starts again on
the same URL, removes the kept write and retries it once (the original click its gesture); another page's stays, a different URL, a
stale or a read one is dropped. A retry's 401 carries no `renew`: no second trip. Native hosts have neither.

On wang.team HTTPS pages, `mountShellBar` loads the same-origin `/boarding/client.js` HTTP client once per document. The host
routes `/boarding/*` to boarding outside its gate, including on the family network. Boarding owns the non-secret prior-sign-in
marker and bounded silent ticket renewal; the shell never stores an authentication token. Keep the usual sign-in link for a failed
renewal. Other origins and native hosts do not load the client. See spaceport boarding README's silent renewal HTTP contract.


Structured palette lookups use bridge's `find` answer rows for expiry/renewal, balances,
vehicle facts and people's contact or birth details. Ask on a recognized lookup renders
stored rows with document citations; no matching fact is stated explicitly and never sent
to the model. Number/VIN/plate lookups also accept copyable identifier rows.

`spent at <text> in YYYY-MM` (also `spending on` and `how much did I spend at`)
uses the configured `purser.txns` GET `/v1/txns` (`purser:read`; web `/api/txns`).
It first calls `purser.merchants.resolve` GET `/v1/merchants/resolve?name=<text>`
(`purser:read`; web `/api/merchants/resolve`). Only `resolved` with one merchant ID
uses `merchant=<id>` for an exact merchant total. Ambiguous or missing matches (or an
older host without the resolver) retain the matching-transactions label and request `q=<text>`, inclusive month bounds, `kind=spending`, `limit=1` and uses
`sum_cents` and `total` across every match, rather than summing the returned page.
The displayed USD outflow is the negated integer-cent ledger sum. The label states
that text matches descriptions, notes, categories, accounts or merchants; for the text fallback. The embedding site must allow the configured Purser origin
in its `connect-src` CSP; web requests use the Purser session with credentials included. Backend configuration, session/CORS and device grants follow
the registry rules above. A missing route, signed-out session or failed backend stays
an error with retry, with no model fallback.
