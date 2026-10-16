# Accounts

## Accounts

The Sign-ins page (the shell's label; the module and its `accounts` reads keep their name) merges `accounts` reads from every registered backend; a backend without that route contributes none.
`mountAccounts(el, host, opts)` fetches on open and `needs` events or `refresh()`, without a timer. The shared shape is
[Accounts](../../../shared/backend/accounts.md): `{accounts, generated}`, ETag/304 revalidation.
Web reads use each backend's origin and session (`/api`); native reads use its device credential (`/v1`).
Native hosts must revalidate with If-None-Match and retain the list on 304; the three native hosts still need conditional reads
before mounting Sign-ins (their existing Accounts integration gap); account-id path parameters route there as on the web.

- Dedupe by `from.backend`/`from.id`, otherwise responding backend/id; the origin's row wins. Failed refreshes retain each
  backend's last good list, labelled stale with its generated time. Rows name the origin backend; relay actions use the responding backend.
- Groups: Money, Health, Utilities, Websites, API connections, Home and device clouds. Within each: needs-you, failing, paused,
  unknown, ok, then institution or service. Rows show institution/service, person, connection, state and last success, data count
  and range, and the credential location (`credential.ref`, muted; never a value).
- Sensitive financial/medical rows show institution, person, state, last run and coverage only, plus the backend and stale status;
  no connection, credential location or action, including shared screens.
- An action's `op` is a registry suffix with a configured POST `/v1/accounts/{id}/<op>` route, scope `<backend>:act`, and query `{id}`.
  Hosts encode shared account ids as one segment and require a recent gesture. URL actions use `url.open`. Reach `lan` says
  “at home or on VPN”. Accepted ops stay pending until refresh; 503 disables the row's actions until refresh.


On the web, a clicked Rover Sign in or Get missing operation receiving 401 goes at once to Rover's `/session?to=<Deck URL>` landing
(Rover's HTTP contract) through the host's session renewal ([Backends](backends.md), *Session renewal*: `renew('accounts')`), then is
retried once when Accounts starts again (`resume('accounts')`). The original click authorizes only that retry. A second 401 does not
navigate again; a revoked or signed-out member stays on Rover's landing with its explicit Sign in link.

Hosts can import `ROVER_OPS` from `ui/src/host/backends.js` for Rover’s accounts, needs, Get missing and Sign in routes.
Supply the configured Rover origin and `rover:read` / `rover:act` grants; these templates contain no destination or credential.
