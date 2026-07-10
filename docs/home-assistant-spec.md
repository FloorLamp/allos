# Spec: Home Assistant integration (appliance endpoints)

Status: **draft** · Owner: TBD · Tracking issue: [#235](https://github.com/FloorLamp/allos/issues/235)

## Problem / use cases

Self-hosters running Allos very likely run Home Assistant on the same LAN.
Three concrete use cases, in delivery order:

1. **Device-data ingestion** — HA already aggregates BLE scales, ESPHome
   sensors, and health devices; it should be able to push readings into
   Allos as another integration source.
2. **Event-driven reminders** — an HA automation that knows dinner is
   _actually happening_ (an `is_dinnertime` helper) tells Allos to fire the
   with-food supplement reminders now, instead of guessing at a clock hour.
3. **Kitchen-dashboard medication board** — today's doses per profile
   rendered on an existing HA (Lovelace) dashboard, with **take / skip**
   buttons that actuate Allos.

## Decision: appliance endpoints, not a product API

The mobile-companion spec rejected building a general REST API (permanent
versioning surface, store-app-vs-server skew). That decision stands. What
this integration needs is different in kind: a **handful of narrow,
purpose-built, token-authed endpoints** — the pattern the Health Connect
ingest already established (bearer token, timing-safe match via
`lib/integrations/token-match.ts`, profile-scoped, idempotent, rate-limited
before auth). Small, additive, individually versionable by their payload
shapes; consumed by YAML config on a box the same person administers, so
skew is self-inflicted and shallow. This spec deliberately does NOT create
a general `/api/v1` namespace.

### Non-goals

- **No MQTT** — would add a client dependency and a broker requirement;
  HTTP polling/webhooks cover all three use cases at kitchen-display rates.
- **No HACS custom integration/card in v1** — plain HA YAML (RESTful
  sensor + `rest_command` + a stock entities/markdown card) ships in the
  docs; a polished custom card is a separately-maintained artifact and the
  place scope creep lives. Revisit on demand.
- **No general record access** — schedule + dose actuation + ingest +
  events only. No labs, conditions, documents, or search over these
  endpoints.
- **No HA add-on packaging** (Allos already ships as a container).

## Architecture

New registry entry `home-assistant` (`lib/integrations/registry.ts`),
`kind: "push"`-family with a config page for token issuance. Four
endpoints under `app/api/integrations/home-assistant/`, all sharing the
Health Connect guard stack: rate limit **before** auth
(`lib/rate-limit.ts`), timing-safe per-profile token resolution, streaming
body cap, per-request `integration_sync_events` where applicable.

### Tokens and the actuation scope

HC ingest tokens are **write-data-in only**. Use case 3 introduces a new
capability class: a token that can **actuate** (log/skip a dose). That
distinction is explicit:

- Per-profile tokens, issued/revoked on the integration's config page
  (reusing the HC issuance UI pattern), with a per-token **`allow_actions`
  flag, default OFF**. Ingest/events/board-read work with any valid
  token; the dose endpoint requires `allow_actions`.
- Rationale: a leaked display-only token exposes schedule PHI but cannot
  write adherence history. The kitchen iPad's token is the only one that
  needs actions.
- LAN posture documented: these endpoints work without a public URL
  (unlike SMART); if the instance IS public, tokens ride TLS like every
  other bearer token. No new middleware allowlist entries beyond the
  endpoint routes themselves (token-authed, session-free — the HC
  precedent).

### 1. `POST /ingest` — device data (use case 1)

- Payload: a small documented JSON shape (metric, value, unit, timestamp,
  optional device name) — an **adapter** maps it onto the existing
  `normalize.ts` upserts with `source: "home-assistant"`; the #146
  plausibility bounds and timestamp window apply unchanged.
- Idempotent by the same natural keys as every other source; user-edit
  locks respected; sync events recorded → Review inbox \"Connected
  sources\" row like any provider.
- A distinct source string makes HA a genuinely independent device stream
  (feeds multi-source comparison, #14).
- Ships with an HA **automation blueprint** in the docs (state-change →
  `rest_command` POST).

### 2. `POST /event` — event-driven reminders (use case 2)

- Payload: `{ "event": "meal" }` (v1 vocabulary: `meal` only; the name is
  generic so `wake`/`bedtime` can join later without a new endpoint).
- Behavior: for the token's profile, build and dispatch the dose reminder
  for **due, unlogged, food-timed** doses in the nearest applicable bucket
  — through the existing `dispatch()` fan-out (Telegram/push, with the
  standard take/skip keyboard). The clock-driven slot remains the
  fallback: the same per-day/slot dedup markers make event-then-clock (or
  double events) idempotent — whichever fires first wins, the second is a
  no-op.
- Per-profile **opt-in** (`profile_settings`), off by default; the
  integration page explains the pairing (HA sends the event, Allos still
  owns the message and channels).
- Nothing due → 200 with `{sent: false}`; never an error (automations
  fire unconditionally).

### 3. `GET /upcoming` — the board feed (use case 3, read half)

**Not a bespoke schedule shape.** The Upcoming findings engine
(`collectUpcoming` → the banded model) is already the app's one answer to
"what's next" across nine domains (doses, refill, appointments, care plan,
preventive, immunizations, biomarker retest, goals, training). Serving a
second dose-only computation here would violate the one-question-one-
computation convention; instead this endpoint is a **formatter over the
existing banded model**:

- `GET /upcoming?domains=doses` → the medication board (dose entries carry
  `doseId`, dose label, bucket/slot, food timing, and status
  `due | taken | skipped` so the card can pair each row with `/dose`
  actuation).
- `GET /upcoming?domains=all` (or a comma list) → the family board:
  appointments, care-plan items, preventive due, refill warnings — banded
  overdue/today/week/later exactly as the Upcoming page shows them.
- **Suppression-honoring by construction**: a snooze/dismiss on the
  Upcoming page (or via #227's bus) removes the item from the kitchen
  board too — one suppression store, every surface.
- Shape is a **stable, documented, versioned-by-additive-fields** JSON —
  the one place this spec accepts an API-shaped compatibility promise. The
  promise is cheap precisely because the payload mirrors an internal model
  that the one-computation convention already keeps stable.
- One token = one profile; a multi-profile kitchen board composes N
  RESTful sensors (one per profile token). No cross-profile token.
- PHI note: medication/appointment names on a kitchen display are inherent
  to the use case; the docs say so plainly and recommend display-token
  revocation from the config page if the household changes.

**The scope rule this establishes** (the real defense against endpoint
sprawl): an appliance read endpoint must be a formatter over an existing
shared `lib/` model — the Upcoming bus here; the digest or weekly-recap
models if a stats/summary tile is ever wanted (recent activities, streak,
weekly counts would be `GET /summary` over the digest/recap models — a
later PR, same posture, explicitly NOT a new computation). Anything that
would require a **new** engine or raw record access is out of scope, full
stop.

### 4. `POST /dose` — actuation (use case 3, write half)

- Payload: `{ doseId, date, action: "taken" | "skipped" }` — ids only,
  never names. Requires `allow_actions`.
- Routes through `markDoseTaken` / `markDoseSkipped` (#232) and returns
  the **outcome union** verbatim (`logged | already-logged | stale-dose |
inactive | skipped`), exactly the Telegram-callback contract: a stale
  button can never falsely confirm. The HA card renders the outcome text.
- Supply decrement/restore, per-(dose,date) dedup, and skip semantics all
  come from the shared write cores — nothing HA-specific in the write
  path.

## HA-side deliverables (docs, not code)

A `docs/` (or README section) recipe set, tested against a real HA
instance before release:

1. RESTful sensor YAML for `/upcoming` (medication-board and family-board
   variants; 30–60s scan interval is plenty).
2. `rest_command` YAML for `/dose` + a stock Lovelace card wiring buttons
   to it (entities card with `tap_action` → service call).
3. Automation blueprint for `/ingest` (scale weight example).
4. `is_dinnertime` automation example for `/event`.

## Testing

- **Pure tier:** ingest adapter mapping, event→bucket selection, schedule
  serialization (status derivation), outcome-union → response mapping.
- **Action/DB tier:** each endpoint end-to-end against the in-memory DB —
  token scoping (wrong-profile token 401s), `allow_actions` enforcement,
  ingest idempotency + bounds, event dedup against the slot markers, dose
  outcomes for stale/retired/paused cases.
- **e2e:** the config page (token issuance + `allow_actions` toggle +
  revoke) — the only browser surface.
- **Manual release gate:** the YAML recipes against a live HA instance.

## Rollout

1. **PR 1 — ingest** (`/ingest` + registry entry + config page with
   tokens + Review-inbox wiring + blueprint doc). Smallest, proves the
   token/guard reuse.
2. **PR 2 — events** (`/event` + opt-in setting + dedup tests + recipe).
3. **PR 3 — board** (`/upcoming` + `/dose` + `allow_actions` +
   Lovelace recipes). Depends on #232 for the skip half (ship take-only
   if #232 hasn't landed; the payload already reserves `skipped`).
4. Later, on demand: HACS custom card, more event vocabulary, richer
   sensors (upcoming counts for a household overview tile).

## Open questions

1. **Event vocabulary growth** — `meal` only in v1; do `wake`/`bedtime`
   earn their keep, and do they map to slots or buckets? Decide when a
   real automation asks.
2. **`/summary` (stats tiles)** — recent activities, streak, weekly
   counts as HA sensors. Deferred; when wanted it's a formatter over the
   existing digest/weekly-recap models (per the scope rule above), never a
   new computation.
3. **Per-token rate-limit tuning** — the HC limiter defaults are sized
   for a phone exporter; a 30s-polling display is chattier. Likely fine;
   measure in PR 3.
