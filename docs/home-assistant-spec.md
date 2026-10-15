# Home Assistant appliance endpoints

Status: unbuilt proposal, tracked in
[#235](https://github.com/FloorLamp/allos/issues/235).

The four HA → Allos endpoints, provider registration, action permission, and
Connect wizard below do not exist yet. The shipped
[Allos → HA notification channel](home-assistant-notifications.md) is separate;
its webhook delivery does not enable inbound dose confirmation.

## Purpose and boundaries

Support three uses: ingest readings from HA-connected devices, trigger food-timed
reminders when a meal happens, and show a household medication board with take/skip
controls. Use narrow endpoints under `/api/integrations/home-assistant/`, backed
by existing domain computations and writes.

The first release excludes MQTT, a HACS integration/card, add-on packaging, and
general access to labs, conditions, documents, or search. Use ordinary HA YAML and
stock dashboard cards. Future read endpoints must format an existing shared model;
this proposal does not authorize another schedule, adherence, or findings engine.

## Authentication and request handling

The proposed capability boundary is one token per profile, with revocation and
an explicit `allow_actions` permission defaulting off; `/dose` requires it. A
household board composes one token per profile.

Request-boundary references: the [Health Connect route](../app/api/integrations/health-connect/ingest/route.ts)
(rate-limit before verification, cap bodies, validate before domain code) and
the [device API](device-api.md) (credential, scope, then allos's grants).
Middleware's cookie-free route registration is not authorization. Reconcile the
capability with the existing credential owners ([API tokens](api-tokens.md),
device links) before adding another table.

Writes may record integration sync outcomes. Board polls must not append
`integration_sync_events`; update a throttled last-seen timestamp instead, roughly
once a minute, for the wizard and provider row.

## Endpoint contracts

### `POST /ingest`

Register a `home-assistant` push integration. Accept a bounded JSON reading with
metric, value, unit, timestamp, and optional device name. Map it through the existing
[integration normalizer](../lib/integrations/normalize.ts) with a distinct
`home-assistant` source. Preserve canonical units, plausibility and timestamp
bounds, natural-key idempotency, and user-edit locks. Record the write's sync
outcome for connected-source review. Supply a scale-reading automation example.

### `POST /event`

The initial payload is `{ "event": "meal" }`. Require a separate per-profile
opt-in, off by default. For that profile, use the shared reminder planner to find
due, unlogged, food-timed doses in the applicable slot and send through normal
notification dispatch. Allos continues to own message content, channels, and
suppression.

The event and clock fallback must share per-day/slot deduplication: repeated events
or an event followed by a clock tick cannot send the same reminder again. Nothing
due returns 200 with `{ "sent": false }`. Household meal automations call once per
opted-in profile token, rather than using a cross-profile token.

### `GET /upcoming`

`?domains=doses` supplies the medication board; `?domains=all` or a comma-separated
selection supplies the broader board. Reuse the
[Upcoming model](../lib/queries/upcoming.ts) for overdue/today/week/later findings,
including the same dismissal and snooze decisions as the app.

The dose board needs resolved entries too, which Upcoming removes. The
[device API](device-api.md) `GET /v1/board` and `POST /v1/board/<doseId>` already
answer that board and its take/skip for a device credential, through the shared
dose-status core with its honest typed outcomes; an HA board reuses that shape.
The board exposes the profile's medication names; explain that and revocation
during setup.

## Connect wizard and HA package

The proposed integration page should:

1. Select profiles and capabilities, with board display on and actions off by
   default. Meal events require their own opt-in. An HA base URL is optional for
   wiring outbound announcements.
2. Issue credentials and generate one `allos.yaml` package plus a separate
   `secrets.yaml` snippet. The shareable package uses `!secret` references; it must
   not contain raw tokens.
3. Include only selected REST sensors, commands, meal-automation stubs, ingest
   examples, and optional outbound-announcement wiring.
4. Show the first authenticated request and last-seen time. Regeneration and token
   rotation must explain which HA configuration needs replacing.

Keep the generator a template over the implemented endpoint contracts. Ship its
examples with the endpoints. Existing calendar feeds can support calendar recipes;
public emergency share links can open directly on a panel, but must not be embedded
in an iframe because share pages prohibit framing.

## Delivery and verification

Implement in three reviewable stages: ingest with provider registration and wizard;
meal events with consent and shared deduplication; then board reads and take/skip
controls with action permissions. Each stage must deliver a usable path and its
matching configuration example.

Use the [change and test policy](change-policy.md). Extend existing adapter,
schedule, serialization, and write coverage where it observes the relevant gap.
Request-level coverage must prove profile isolation, action-permission refusal,
body bounds, ingest idempotency, event/clock deduplication, and honest stale-dose
outcomes. Browser coverage is for token configuration and wizard interactions.
Verify generated YAML against a live HA instance before releasing the endpoints;
this proposal is not evidence that those recipes work today.

Defer HACS, mDNS discovery, summary sensors, broader event vocabulary, environmental
metrics, and per-profile attention sensors until requested. Those need their own
scope and privacy decisions. Add-on packaging is tracked separately in #257;
outbound announcements already use the shipped notification channel.
