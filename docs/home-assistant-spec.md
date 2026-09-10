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
an explicit `allow_actions` permission defaulting off. A valid token permits the
proposed ingest, event, and board operations; `/dose` additionally requires action
permission. This separates adherence writes from board access, but does not make
the other capabilities read-only: ingest writes readings and events can send
reminders. A household board composes one token per profile.

Use the existing [Health Connect route](../app/api/integrations/health-connect/ingest/route.ts)
as the request-boundary reference: rate-limit before token verification, resolve
the authorized profile, cap streamed request bodies, and validate input before
calling domain code. The endpoints need no browser session or public app URL;
bearer credentials require an appropriate transport, including TLS when public.
Middleware's cookie-free route registration is not authorization.

The repository also has [login-owned API tokens](api-tokens.md), currently scoped
to document acquisition. They do not grant these proposed HA capabilities. Before
implementation, reconcile the profile/capability requirements with the existing
token owners rather than assuming another credential table is necessary. Preserve
the profile boundary and default-off action permission whichever storage is used.

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

The dose board also needs resolved entries, with dose identity, label, slot,
food timing, and `due | taken | skipped` status. Upcoming deliberately removes
resolved doses, so it alone cannot provide that board. Reuse shared intake
schedule and adherence readers, as digest/dashboard consumers do, and preserve
their local-day semantics; do not infer taken/skipped from an absent finding.

Document an additive JSON response contract and a 30–60-second polling example.
The board intentionally exposes the authorized profile's medication and appointment
names on the display. Explain that visibility and revocation during setup.

### `POST /dose`

Accept `{ doseId, date, action: "taken" | "skipped" }` and require action
permission. Call `markDoseTaken` or `markDoseSkipped` in
[shared dose-status writes](../lib/queries/intake/dose-status.ts), passing the token's
profile and the required write provenance.

Return the shared typed outcome and render it honestly: a stale, inactive, or
already-resolved dose must not be reported as newly logged. Supply changes,
per-dose/day deduplication, and refusal to overwrite a deliberate resolution stay
in the existing core. Both take and skip already exist; no take-only fallback is
needed for that old dependency.

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
