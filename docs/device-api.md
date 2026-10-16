# Device API (`/v1`)

Contract: spaceport `shared/backend/README.md`; Deck's op map: spaceport
`deck/backends/allos.json`.

## Credential and scope

`Authorization: Bearer dev_…` is verified by [device-credential](../lib/device-credential.ts)
with Boarding (`BOARDING_URL`, default `http://boarding:9816`), then checked for
`allos:read`, `allos:ask`, or `allos:log`. Each device links to one login
(`npm run device-links -- link <device> <login>`; Docker:
`docker exec allos node dist/device-links.cjs link …`); its role and grants decide profiles.

Refusals (`{error}`): 401 `token` (missing/invalid credential); 403 `scope`,
`device` (unlinked), `profile` (unreachable), `access` (read-only/demo write);
503 `boarding` (fail-closed). 400 names the bad field.

`?profile=<id>` selects a reachable profile; default: login's own, then first.
`profile` identifies the subject; days are profile-local, `at` an instant.

## Routes

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

Except `needs`, `/api/<route>` twins use Allos's session cookie (missing: 401 `token`),
login grants and active profile. Writes require same-origin JSON (403 `origin`,
415 `type`). Ask uses `POST /api/ask` `{q, profile?}` (GET: 405).
`/api/accounts` allows credentialed CORS for exactly `ALLOS_DECK_ORIGIN`.

`/deck/health` is admin-only (otherwise 404), with bundle CSP.
Vendor: `node scripts/deck-ui.mjs <version>`; pin: `lib/deck-ui-pin.json`.

Boarding's [browser sessions](https://github.com/FloorLamp/spaceport/blob/main/shared/backend/boarding-browser-sessions.md)
do not apply: Allos signs in its own sessions; Boarding only verifies devices.
Health mounts `mountHealth`, not `mountShellBar` (which loads
`/boarding/client.js`); no Allos page renews Boarding sessions.

`accounts_rover_origins` maps portal-account IDs to `rover:<login-id>` for Deck dedup;
unmapped stay Allos's. `generated`: latest run/success, else epoch.

`GET /metrics`: Prometheus text, operational aggregates only, on port 9830
(compose binds loopback); `deploy/allos.alloy` scrapes it.
