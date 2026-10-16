# Device API (`/v1`)

What Deck's devices rely on (spaceport `shared/backend/README.md`). Additive changes only.

## Credential and scope

Every call: `Authorization: Bearer dev_…`, the device's boarding credential,
verified with boarding ([device-credential](../lib/device-credential.ts);
`BOARDING_URL`, default `http://boarding:9816`), then the route's scope:
`allos:read`, `allos:ask`, `allos:log`. Then allos's grants: the owner links the
device to ONE login (`npm run device-links -- link <device> <login>`; on prod
`docker exec allos node dist/device-links.cjs link …`; never by name); that
login's role and grants decide the profiles, as for a session.

Refusals, `{error}`: 401 `token` (none, unknown, revoked, expired); 403 `scope`;
403 `device` (verified, not linked); 403 `profile` (none reachable, or not the one
asked); 403 `access` (a write on a read-only or demo profile); 503 `boarding`
(fail-closed). 400 names the bad field.

`?profile=<id>` picks a reachable profile; default the login's own, else its
first. Every answer carries `profile`. Days are profile-local; `at` an instant.

## Routes

| Route                      | Scope  | Answer                                                                                                                                                                                                                                       |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`             | none   | `{ok, status, reason?, needs}`; 200 while the database answers                                                                                                                                                                               |
| `GET /v1/needs`            | `read` | `{needs: []}`                                                                                                                                                                                                                                |
| `GET /v1/me`               | `read` | `{login: {id, label}, owner, profiles: [{id, label}]}`: the linked login; `owner`: allos's admin role                                                                                                                                        |
| `GET /v1/profiles`         | `read` | `{profile, profiles: [{id, name, access: read\|write}]}`                                                                                                                                                                                     |
| `GET /v1/find?q=&limit=20` | `read` | `{results: [{kind, loggedKind?, key, title, subtitle, date, href}]}`: the palette's search; `href` a site page; `limit` 1–50                                                                                                                 |
| `GET /v1/record?key=`      | `read` | `{kind, key, record: {…}}`: a find row's scalar fields (`condition`, `allergy`, `encounter`, `document`, `protocol`, `activity`, `clinical-result`); other kinds 404 `kind`                                                                  |
| `GET /v1/ask?q=`           | `ask`  | `{answer, offline, citations: [{index, kind, title, subtitle, date, href}]}`: grounded record Q&A; `offline` when no model is configured                                                                                                     |
| `GET /v1/board`            | `read` | `{day, allDone, meds: [{id, name, doses: [{id, timeOfDay, label, status: taken\|skipped\|null, pastDue}]}]}`: today's scheduled doses in the page's order                                                                                    |
| `POST /v1/board/<doseId>`  | `log`  | `{action: take\|skip\|clear, day?, at?: "HH:MM"}` → `{day, dose, outcome}`; `day` today or the two before; bad `at` → 400; `take` with `at` when taken → 409 `already-taken`                                                                 |
| `GET /v1/readings`         | `read` | `{day, readings: [{kind: weight\|body_fat\|resting_hr, value, unit, date} \| {kind: blood_pressure, systolic, diastolic, unit, date, freshness}]}`: the latest of each (kg, %, bpm, mmHg)                                                    |
| `POST /v1/readings`        | `log`  | `{day?, at?, weight?, weightUnit?: kg\|lb, bodyFat?, restingHr?, systolic?, diastolic?, glucose?, glucoseUnit?, spo2?, temperature?, tempUnit?}` → `{day, wrote: [body\|vitals], statedTimeRefused?}`; a day's weigh-in reposted replaces it |
| `GET /v1/labs?limit=10`    | `read` | `{day, labs: [{name, value, unit, flag, date, href, freshness}]}`: latest per marker, notable first; `limit` 1–50                                                                                                                            |

## Web twins and the Health place

Web: each route but `needs` as `/api/<route>`, same handler, the session cookie (none:
401 `token`); grants decide profiles and writes; default profile the session's active
one. Writes are same-origin JSON (else 403 `origin`, 415 `type`); `ask` is `POST
/api/ask` `{q, profile?}` there (GET 405).

`/deck/health`: deck-ui's Health views, vendored by `node scripts/deck-ui.mjs <version>`
into `public/deck-ui/` (pin `lib/deck-ui-pin.json`), under the bundle's CSP. Admin only;
others 404.

Made-up find, `vitamin d`:

```json
{
  "profile": 2,
  "results": [
    {
      "kind": "clinical-result",
      "key": "clinical-result:vitamin d",
      "title": "Vitamin D",
      "subtitle": "41 ng/mL · normal",
      "date": "2026-09-30",
      "href": "/results/vitamin-d"
    }
  ]
}
```
