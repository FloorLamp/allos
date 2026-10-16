# Device API (`/v1`)

Contract: spaceport `shared/backend/README.md`; Deck's op map: spaceport
`deck/backends/allos.json`.

## Credential and scope

`Authorization: Bearer dev_…` is verified by [device-credential](../lib/device-credential.ts)
using Boarding (`BOARDING_URL`, default `http://boarding:9816`) for
`allos:read`, `allos:ask`, or `allos:log`. Health access requires login linking
(`npm run device-links -- link <device> <login>`; Docker:
`docker exec allos node dist/device-links.cjs link …`); role and grants decide profiles.
`GET /v1/needs` requires `allos:read` only.

Refusals (`{error}`): 401 `token` (missing/invalid credential); 403 `scope`,
`device` (unlinked), `profile` (unreachable), `access` (read-only/demo write);
503 `boarding` (fail-closed). 400 names the bad field.

`?profile=<id>` selects a reachable profile; default: login's own, then first.
`profile` identifies subjects; days are profile-local, `at` an instant.

## Routes

[A test](../lib/__tests__/device-api-routes.test.ts) holds the table to
`app/v1` and `/api` twins (none for `needs`).

| Route                      | Scope  | Answer                                                                                                                                                                                                                                       |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`             | none   | `{ok, status, reason?, needs}`; 200 while the database answers, else 503                                                                                                                                                                     |
| `GET /v1/accounts`         | `read` | `{accounts, generated}`: granted profiles’ portal logins and integrations; ETag/304                                                                                                                                                          |
| `GET /v1/needs`            | `read` | `{needs: []}`                                                                                                                                                                                                                                |
| `GET /v1/me`               | `read` | `{login: {id, label}, owner, profiles: [{id, label}]}`: the linked login; `owner`: allos's admin role                                                                                                                                        |
| `GET /v1/profiles`         | `read` | `{profile, profiles: [{id, name, access: read\|write}]}`                                                                                                                                                                                     |
| `GET /v1/find?q=&limit=20` | `read` | `{results: [{kind, loggedKind?, key, title, subtitle, date, href}]}`: search; `href` a page; `limit` 1–50                                                                                                                                    |
| `GET /v1/record?key=`      | `read` | `{kind, key, record: {…}}`: a find row's scalar fields (`condition`, `allergy`, `encounter`, `document`, `protocol`, `activity`, `clinical-result`); other kinds 404 `kind`                                                                  |
| `GET /v1/ask?q=`           | `ask`  | `{answer, offline, citations: [{index, kind, title, subtitle, date, href}]}`: grounded record Q&A; `offline` when no model is configured                                                                                                     |
| `GET /v1/board`            | `read` | `{day, allDone, meds: [{id, name, doses: [{id, timeOfDay, label, status: taken\|skipped\|null, pastDue}]}]}`: today's scheduled doses in the page's order                                                                                    |
| `POST /v1/board/<doseId>`  | `log`  | `{action: take\|skip\|clear, day?, at?: "HH:MM"}` → `{day, dose, outcome}`; `day` today or the two before; bad `at` → 400; `take` with `at` when taken → 409 `already-taken`                                                                 |
| `GET /v1/readings`         | `read` | `{day, readings: [{kind: weight\|body_fat\|resting_hr, value, unit, date} \| {kind: blood_pressure, systolic, diastolic, unit, date, freshness}]}`: the latest of each (kg, %, bpm, mmHg)                                                    |
| `POST /v1/readings`        | `log`  | `{day?, at?, weight?, weightUnit?: kg\|lb, bodyFat?, restingHr?, systolic?, diastolic?, glucose?, glucoseUnit?, spo2?, temperature?, tempUnit?}` → `{day, wrote: [body\|vitals], statedTimeRefused?}`; a day's weigh-in reposted replaces it |
| `GET /v1/labs?limit=10`    | `read` | `{day, labs: [{name, value, unit, flag, date, href, freshness}]}`: latest per marker, notable first; `limit` 1–50                                                                                                                            |

## Web twins and the Health place

`/api/<route>` twins use Allos/Boarding sessions (401 `token`), grants and profile. Writes: same-origin JSON (403 `origin`, 415 `type`).
`POST /api/ask` `{q, profile?}`; GET: 405. `/api/accounts` CORS: `DECK_ORIGIN` only.
`CAPCOM_URL`: AI setup. `ALLOWED_DEV_ORIGINS`: comma-separated hosts.

`/health`: admin-only deck-ui mount/CSP. `DECK_BASE_PATH`:
Deck page/module/assets/API (empty: `/`). `/deck/health` 301s to
`DECK_ORIGIN` + mount; caregiver/public/device routes stay.
Vendor: `DECK_UI_CHANNEL=… node scripts/deck-ui.mjs <version>`; pin: `lib/deck-ui-pin.json`.

[Boarding](https://github.com/FloorLamp/spaceport/blob/main/shared/backend/boarding-browser-sessions.md)
`/owner` maps the host cookie to the sole admin’s own/first profile;
ambiguity/failure denies. Caregiver sessions win.
`/boarding/client.js` loads; `/boarding/*` proxies to Boarding.

`accounts_rover_origins` maps portal-account IDs to `rover:<login-id>` for Deck dedup;
unmapped stay Allos's. `generated`: latest run/success or epoch.

`GET /metrics`: Prometheus text, operational aggregates only, on port 9830
(compose binds loopback); `deploy/allos.alloy` scrapes it.
