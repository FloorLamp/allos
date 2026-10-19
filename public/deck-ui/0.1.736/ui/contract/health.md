# Health

## Health

Health is Deck's page for allos. Data follows [allos's device API](https://github.com/FloorLamp/allos/blob/main/docs/device-api.md)
(merged in #6084), including `GET /v1/me`: `{login: {id, label}, owner, profiles: [{id, label}]}`.
`GET /v1/profiles` supplies profile names and read/write access.
`allos.me` requires `allos:read`. No UI inference from names, scopes or profile access: only `owner === true` offers Health content;
missing backends, false/missing owner, and identity errors replace that content with the shared failure message. An owner may choose among the returned profiles; read-only
profiles have no write controls. Backend authorization remains authoritative for every request. Never configure the kitchen tablet
with the owner's allos credential.

`mountHealth(el, host, {onRecord?})` mounts today's medication board (Take, Skip, Undo), recent readings and labs, record find/Q&A,
and a reading form. It answers `{health, refresh(), unmount()}` (`health: null` without allos). `refresh()` checks identity again
before fetching personal data; a failed refresh clears Health. The first load shows a skeleton; refresh and profile changes keep the previous snapshot with a busy state and disabled actions until the replacement is ready. There is no polling or health data in localStorage. A record opens
in the shared viewer as the API's scalar fields, rendered as text; `onRecord({key, title, profile})` may override that destination.
The viewer independently checks `allos.me` before `allos.record`, with no bridge pages, Related, corrections or file download.

Configure the registry's allos entry with `origin`, `baseUrl`, granted `scopes`, and `ops` from `ALLOS_OPS` in `src/host/backends.js`:
`accounts`, `me`, `profiles`, `find`, `record`, `board`, `readings`, `labs` use `allos:read`; `ask` uses `allos:ask`; `dose` and `log-reading`
use `allos:log`. `dose` maps POST `/v1/board/{dose}`, filling `query.dose`; other routes match the device doc. Profile selection is
`query.profile`. The Android, Mac and Windows hosts fill the dose path segment from a string `query.dose`, reject missing or unsafe segments,
and leave `query.profile` in the URL query. Dose bodies are `{action: take|skip|clear, day}`; readings use the documented numeric fields, kg, mg/dL and °C in
the form. Every write goes through the existing host gesture gate. Native uses `/v1` and the device credential, web uses the allos
origin's session-authenticated `/api`; no fallback to bridge. Accounts uses GET `/api/accounts` with `credentials: include`,
like purser and rover. For Deck on `https://deck.wang.team`, allos must allow that exact Origin with
`Access-Control-Allow-Origin: https://deck.wang.team`, `Access-Control-Allow-Credentials: true` and `Vary: Origin`,
including error responses, while retaining session authorization. Bridge's Accounts relay excludes sensitive rows;
medical rows reach Deck directly and retain the shared Accounts contract's limited display.
The embedding site's `connect-src` must allow the allos origin and its `backends.allos` entry must
use `ALLOS_OPS` with `allos:read`.

The palette recognizes `health:` before find or ask, strips that prefix, verifies `allos.me` and calls allos directly, including
when bridge is not configured. Search records open in the shared viewer; Q&A includes the API's source labels and offline status.
Health result picks are not saved to the pick history and health records cannot be dragged through bridge.

`mountShellBar` always renders the Health navigation link. Identity checks protect Health's content, not its navigation.
`test/fake-allos.mjs` supplies invented accounts, profiles and records for model and browser tests and Health screenshot scenes only.
Airlock's release job publishes the deck-ui bundle after merge and starts consumer vendoring updates (ui/README.md).

Allos Accounts uses GET `/v1/accounts` (`allos:read`), with the session twin GET `/api/accounts`.
Like purser and rover, the web host calls allos directly with `credentials: include`; there is no Deck relay.
For deck.wang.team, allos must allow `Origin: https://deck.wang.team` on that GET with
`Access-Control-Allow-Origin: https://deck.wang.team`, `Access-Control-Allow-Credentials: true` and `Vary: Origin`,
including error responses, while retaining session authorization. Bridge's embedding connect CSP must allow
`https://allos.wang.team`, and its public backend registry must include `accounts` from `ALLOS_OPS`.
Keep `sensitive: 'medical'` rows in the direct response; Accounts renders only the shared contract's allowed details.


## HTML document mount

`mountHealthPage(element, host, {nav, ...shellOptions})` from `src/mount.js` composes the shared shell
with Health, highlights `health`, and uses document scrolling. It returns `{page, unmount()}`;
`page` is the `mountHealth` handle. Unmount removes both shell and page. Supply resolved nav links;
`mountHealth` alone remains available when the document already owns its shell.

An HTML-string document can use a module script with its vendored bundle URL:

```js
import {mountHealthPage} from '/deck-ui/<version>/ui/src/mount.js';
import {webHost} from '/deck-ui/<version>/ui/src/host/web.js';
import {ALLOS_OPS} from '/deck-ui/<version>/ui/src/host/backends.js';
const host = webHost(window, {backends: {allos: {
  origin: location.origin + '/health', baseUrl: location.origin,
  scopes: ['allos:read', 'allos:ask', 'allos:log'], ops: ALLOS_OPS,
}}});
mountHealthPage(document.getElementById('health'), host, {nav});
```

The consumer owns `/health`, bundle asset URLs and `/health/api/*` session routes, including cookies,
Origin checks and CSP. This mount needs no whole-app basePath or fetch adapter. Other product routes and
device `/v1/*` routes stay product-owned. Root `origin` configuration continues to use `/api/*`.

## Workflow pages (FP-1139)

Health's Today, Import review, Document picker, Medications and Trash buttons are shared by every shell.
The latter four use `allos.health.<kind>` (GET) and `allos.health.<kind>.apply` (POST), where `kind` is
`imports`, `documents`, `medications` or `trash`. Registry sources are `deck/backends/allos/health.*.json`;
`node deck/tool/backends.mjs` generates web, Android, Mac and Windows routes. Reads require `allos:read`;
writes require `allos:log` and a current gesture. Paths: `/v1/health/<kind>`, session twins `/api/health/<kind>`.

These endpoints are an integration contract for allos to implement before retiring its UI. Missing endpoints
show the shared failure state; the allos-origin Health mount stays. The backend owns workflow validation,
profile reachability, current write access, audit, and existing import/intake/trash engines. Deck never calls
Next server actions or duplicates their rules. This JSON contract contains no allos URLs or database columns,
so bridge can implement the same payloads when household health moves (FP-1140).

GET query: `profile` (required selected profile), `q` (search, possibly empty), `cursor` (opaque page token,
possibly empty). Response:

```json
{
  "items": [{
    "id": "intake:example",
    "revision": "opaque-version",
    "title": "Example intake item",
    "summary": "Synthetic example",
    "facts": [{"label": "Schedule", "value": "Morning"}],
    "actions": [{
      "id": "edit",
      "label": "Save item",
      "fields": [{"name": "name", "label": "Name", "type": "text", "required": true, "value": "Example"}]
    }]
  }],
  "next": null
}
```

`items` includes creation forms as well as existing records; creation IDs and revisions are backend-issued.
Every form is one backend transaction. Field types: `text`, `number`, `date`, `time`, `checkbox`, `select`;
select fields have `options: [{value, label}]`. Optional `hint`, `required`, and `value` are presentation data.
Values are strings except numbers (blank becomes null) and booleans. Facts and labels are text, never HTML.
Document items may include `recordKey`, opened through the existing owner-gated Health record viewer.
No scripts, endpoint URLs, file paths, free-form JSON editing or client-side medical rules.
POST body: `{id, revision, action, values: {<field name>: <typed value>}}`; response `{ok: true}`.
Backend rejects unknown actions/fields, invalid values, wrong profile and stale revisions (409); it must
recheck permissions and revision in the mutation transaction. No write retries or persisted drafts.
After success Deck reloads the list. Failure clears the snapshot and offers a fresh read.

Required backend coverage:

- Import review: pending imports, extracted facts and conflicts, review/correct/commit/reject forms using
  the existing review engine; never silently commit or resolve identity ambiguity.
- Document picker: searchable existing documents and their identity/status, explicit selection/reassignment
  forms with authorized profile choices; no arbitrary URL or file-system access.
- Medications: intake item create/edit, lifecycle, ingredients and purposes, plus separate schedule/slot
  and course create/edit forms. Preserve existing cadence, dose amount, units and lifecycle validation;
  each schedule or course can be an item with its own revision and forms.
- Trash: deleted items and explicit restore forms with the existing collision/relationship checks.
  No permanent-delete action is part of this contract.

Read-only profiles receive facts with no mutation forms; Deck also hides all actions. Lists are loaded only
on selection/search/refresh. Profile changes and unmount discard the snapshot and forms; owner denial from
any Health view clears them. No polling, browser storage, health telemetry or bridge fallback.
