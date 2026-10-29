# Device API (`/v1`)

Spaceport: `shared/backend/README.md`, `deck/backends/allos.json`.

## Credentials

Bearer `dev_…`: [verification](../lib/device-credential.ts), `BOARDING_URL` (default `http://boarding:9816`).
Scopes: `allos:read`, `allos:ask`, `allos:log`.
Health: `npm run device-links -- link <device> <login>`; grants.
Needs: `allos:read`.

`{error}`: 401 `token`; 403 `scope`, `device`, `profile`, `access`;
503 `boarding`; 400 input; 409 stale.

`?profile=<id>`: subject (default own/first reachable); workflow selection required.
Days: profile-local; `at`: instant.

## Routes

[Coverage](../lib/__tests__/device-api-routes.test.ts); `/api` twins except `needs`/POST `practices`. `/v1/health/*?id=`: one item.

| Route                                 | Scope  | Answer                                                                                                                                                                                                                          |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                        | none   | `{ok, status, reason?, needs}`; database: reachable 200/unreachable 503                                                                                                                                                         |
| `GET /v1/accounts`                    | `read` | `{accounts, generated}`; ETag/304                                                                                                                                                                                               |
| `GET /v1/needs`                       | `read` | `{needs: []}`                                                                                                                                                                                                                   |
| `GET /v1/me`                          | `read` | `{login: {id, label}, owner, readOnly, profiles: [{id, label}]}`; admin `owner`                                                                                                                                                 |
| `GET /v1/profiles`                    | `read` | `{profile, profiles: [{id, name, access: read\|write}]}`                                                                                                                                                                        |
| `GET /v1/find?q=&limit=20`            | `read` | `{results: [{kind,loggedKind?,key,title,subtitle,date,href}]}`; 1–50                                                                                                                                                            |
| `GET /v1/record?key=`                 | `read` | `{kind, key, record: {…}}`; unsupported: 404                                                                                                                                                                                    |
| `GET /v1/ask?q=`                      | `ask`  | `{answer,offline,citations: [{index,kind,title,subtitle,date,href}]}`                                                                                                                                                           |
| `GET /v1/board`                       | `read` | `{day, allDone, meds: [{id, name, doses: [{id, timeOfDay, label, status: taken\|skipped\|null, pastDue}]}]}`                                                                                                                    |
| `POST /v1/board/<doseId>`             | `log`  | `{action: take\|skip\|clear, day?, at?: "HH:MM"}` → `{day, dose, outcome}`; `day` today or the two before; bad `at` → 400; `take` with `at` → 409 `already-taken` if taken                                                      |
| `GET /v1/readings`                    | `read` | `{day, readings: [{kind: weight\|body_fat\|resting_hr, value, unit, date} \| {kind: blood_pressure, systolic, diastolic, unit, date, freshness}]}`; kg, %, bpm, mmHg; `trend`: series tail                                      |
| `POST /v1/readings`                   | `log`  | `{day?, at?, weight?, weightUnit?: kg\|lb, bodyFat?, restingHr?, systolic?, diastolic?, glucose?, glucoseUnit?, spo2?, temperature?, tempUnit?}` → `{day, wrote: [body\|vitals], statedTimeRefused?}`; repost replaces weigh-in |
| `GET /v1/readings/series?kind=&days=` | `read` | `{kind,unit,points}`; oldest-first                                                                                                                                                                                              |
| `GET /v1/practices`                   | `read` | `{profile, practices: [{key, name, logged, thing?: {id, url}}]}`; profile-local ISO `logged`; newest-first                                                                                                                      |
| `POST /v1/practices`                  | `log`  | `{practice,end,durationMin,key}` → `{profile,day,outcome}`; zoned ISO `end`, minutes >0; profile-local start=end−duration; inserted/unchanged/updated/edited/suppressed; edits/deletions win                                    |
| `GET /v1/labs?limit=10`               | `read` | `{day, labs: [{name, value, unit, flag, date, href, freshness,trend}]}`; 1–50                                                                                                                                                   |
| `GET /v1/marker?name=`                | `read` | `{name,latest,range,points,documents,related}`; 404                                                                                                                                                                             |
| `GET /v1/health/imports`              | `read` | `{items,next}`                                                                                                                                                                                                                  |
| `POST /v1/health/imports`             | `log`  | `{id,revision,action,values}` → `{ok: true}`                                                                                                                                                                                    |
| `GET /v1/health/documents`            | `read` | `{items,next}`                                                                                                                                                                                                                  |
| `POST /v1/health/documents`           | `log`  | `{id,revision,action,values}` → `{ok: true}`                                                                                                                                                                                    |
| `GET /v1/health/medications`          | `read` | `{items,next}`                                                                                                                                                                                                                  |
| `POST /v1/health/medications`         | `log`  | `{id,revision,action,values}` → `{ok: true}`                                                                                                                                                                                    |
| `GET /v1/health/trash`                | `read` | `{items,next}`                                                                                                                                                                                                                  |
| `POST /v1/health/trash`               | `log`  | `{id,revision,action,values}` → `{ok: true}`                                                                                                                                                                                    |

## Web

`/api`: Allos/Boarding sessions, grants; same-origin JSON writes.
`/api/ask`: POST `{q, profile?}`, GET 405. `/api/accounts`: `DECK_ORIGIN` CORS (including 401).
`CAPCOM_URL`: AI setup.

Practices: `habitat:<entity>:<start>` → entity `attributes.thing_id` UUID
→ `{id,url:"/things#<UUID>"}`; unlinked: omit `thing`.
Liftoff `habitat-url`/`habitat-token`: `HABITAT_URL` (mounted)/`HABITAT_TOKEN`
(`habitat:read`), uncached
`/v1/entities`; unconfigured/unavailable: no links. Local: `practice:<id>`.

`ALLOWED_DEV_ORIGINS`: CSV hosts.

`/health`: admin-only deck-ui mount/CSP. `DECK_BASE_PATH`:
page/module/assets/API (empty `/`). `/deck/health` → `DECK_ORIGIN` + mount.
Vendor: `DECK_UI_CHANNEL=… node scripts/deck-ui.mjs <version>`; `lib/deck-ui-pin.json`.

[Boarding](https://github.com/FloorLamp/spaceport/blob/main/shared/backend/boarding-browser-sessions.md)
`/owner`: HTTPS `DECK_ORIGIN`; TTL 10s. Sole admin:
write, own/first; `ownerRead` (agent): read-only, audit `who`.
Zero/multiple: deny+warn/minute; uncached permissions.
`/boarding/client.js`; `/boarding/*` → Boarding.

`accounts_rover_origins`: portal-account → `rover:<login-id>` dedup; `generated`: latest run/success or epoch.

`/metrics`: Prometheus, loopback 9830; `deploy/allos.alloy`.
