# Device API (`/v1`)

Contract: spaceport `shared/backend/README.md`, `deck/backends/allos.json`.

## Credential and scope

`Authorization: Bearer dev_…`: [device-credential](../lib/device-credential.ts) via Boarding
(`BOARDING_URL`, default `http://boarding:9816`). Scopes: `allos:read`, `allos:ask`, `allos:log`.
Health: `npm run device-links -- link <device> <login>`; grants apply.
Needs: `allos:read` only.

`{error}` refusals: 401 `token`; 403 `scope`, `device`, `profile`, `access`;
503 `boarding`; 400 invalid input; 409 stale form.

`?profile=<id>`: subject, default own, else first reachable.
Workflows require selection. Days: profile-local; `at`: instant.

## Routes

[Coverage](../lib/__tests__/device-api-routes.test.ts): `/api` twins except `needs`, `practices`.

| Route                         | Scope  | Answer                                                                                                                                                                                                                                       |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                | none   | `{ok, status, reason?, needs}`; database reachable: 200; unreachable: 503                                                                                                                                                                    |
| `GET /v1/accounts`            | `read` | `{accounts, generated}`; ETag/304                                                                                                                                                                                                            |
| `GET /v1/needs`               | `read` | `{needs: []}`                                                                                                                                                                                                                                |
| `GET /v1/me`                  | `read` | `{login: {id, label}, owner, readOnly, profiles: [{id, label}]}`; `owner`: admin                                                                                                                                                             |
| `GET /v1/profiles`            | `read` | `{profile, profiles: [{id, name, access: read\|write}]}`                                                                                                                                                                                     |
| `GET /v1/find?q=&limit=20`    | `read` | `{results: [{kind, loggedKind?, key, title, subtitle, date, href}]}`; `limit` 1–50                                                                                                                                                           |
| `GET /v1/record?key=`         | `read` | `{kind, key, record: {…}}`; unsupported kind: 404                                                                                                                                                                                            |
| `GET /v1/ask?q=`              | `ask`  | `{answer, offline, citations: [{index, kind, title, subtitle, date, href}]}`                                                                                                                                                                 |
| `GET /v1/board`               | `read` | `{day, allDone, meds: [{id, name, doses: [{id, timeOfDay, label, status: taken\|skipped\|null, pastDue}]}]}`                                                                                                                                 |
| `POST /v1/board/<doseId>`     | `log`  | `{action: take\|skip\|clear, day?, at?: "HH:MM"}` → `{day, dose, outcome}`; `day` today or the two before; bad `at` → 400; `take` with `at` when taken → 409 `already-taken`                                                                 |
| `GET /v1/readings`            | `read` | `{day, readings: [{kind: weight\|body_fat\|resting_hr, value, unit, date} \| {kind: blood_pressure, systolic, diastolic, unit, date, freshness}]}`; kg, %, bpm, mmHg                                                                         |
| `POST /v1/readings`           | `log`  | `{day?, at?, weight?, weightUnit?: kg\|lb, bodyFat?, restingHr?, systolic?, diastolic?, glucose?, glucoseUnit?, spo2?, temperature?, tempUnit?}` → `{day, wrote: [body\|vitals], statedTimeRefused?}`; a day's weigh-in reposted replaces it |
| `POST /v1/practices`          | `log`  | `{practice, end, durationMin, key}` → `{profile, day, outcome}`; zoned ISO `end`, positive minutes; profile-local start = end − duration; inserted/unchanged/updated/edited/suppressed; edits/deletions win                                  |
| `GET /v1/labs?limit=10`       | `read` | `{day, labs: [{name, value, unit, flag, date, href, freshness}]}`; `limit` 1–50                                                                                                                                                              |
| `GET /v1/health/imports`      | `read` | `{items, next}`                                                                                                                                                                                                                              |
| `POST /v1/health/imports`     | `log`  | `{id, revision, action, values}` → `{ok: true}`                                                                                                                                                                                              |
| `GET /v1/health/documents`    | `read` | `{items, next}`                                                                                                                                                                                                                              |
| `POST /v1/health/documents`   | `log`  | `{id, revision, action, values}` → `{ok: true}`                                                                                                                                                                                              |
| `GET /v1/health/medications`  | `read` | `{items, next}`                                                                                                                                                                                                                              |
| `POST /v1/health/medications` | `log`  | `{id, revision, action, values}` → `{ok: true}`                                                                                                                                                                                              |
| `GET /v1/health/trash`        | `read` | `{items, next}`                                                                                                                                                                                                                              |
| `POST /v1/health/trash`       | `log`  | `{id, revision, action, values}` → `{ok: true}`                                                                                                                                                                                              |

## Web twins and the Health page

`/api` twins: Allos/Boarding sessions, grants; same-origin JSON writes.
`POST /api/ask` `{q, profile?}`; GET: 405. `/api/accounts`: `DECK_ORIGIN` CORS, even 401.
`CAPCOM_URL`: AI setup. `ALLOWED_DEV_ORIGINS`: comma-separated hosts.

`/health`: admin-only deck-ui mount/CSP. `DECK_BASE_PATH`:
page/module/assets/API (empty: `/`). `/deck/health` → `DECK_ORIGIN` + mount.
Vendor: `DECK_UI_CHANNEL=… node scripts/deck-ui.mjs <version>`; pin: `lib/deck-ui-pin.json`.

[Boarding](https://github.com/FloorLamp/spaceport/blob/main/shared/backend/boarding-browser-sessions.md)
`/owner`: HTTPS `DECK_ORIGIN`; verdict/failure TTL: 10s. Sole admin:
write, own/first; `ownerRead` (_agent member_): read-only, audit `who`.
Zero/multiple: deny+warn/minute. Uncached permissions.
`/boarding/client.js` loads; `/boarding/*` → Boarding.

`accounts_rover_origins`: portal-account ID → `rover:<login-id>` dedup. `generated`: latest run/success or epoch.

`GET /metrics`: Prometheus aggregates, loopback 9830; `deploy/allos.alloy`.
