# Home Assistant as a notification channel

Status: **shipped** · Issue: [#248](https://github.com/FloorLamp/allos/issues/248) ·
Related: [#235](https://github.com/FloorLamp/allos/issues/235) (the HA→Allos
appliance endpoints this complements; its
[spec](home-assistant-spec.md) open question 6 pointed here)

This is the **Allos → Home Assistant** direction: a third dispatch channel beside
Telegram and Web Push that POSTs each reminder to a Home Assistant **webhook**, so an
HA automation can present it with what only HA knows — _who is home, and which room_.
The household wins this unlocks:

- **Kitchen-speaker TTS dose announcements** when the person is actually in the
  kitchen — the accessibility path for a household member who will never install
  Telegram (the grandparent case).
- **Escalation theatrics** — a critical dose left unconfirmed flashes lights or
  announces on the caregiver's floor. Allos's escalation engine already decides
  _when_; HA becomes its loudest _how_.
- **Presence-aware delivery** — hold an announcement until someone is home, or
  suppress the phone push once the wall panel has already spoken.

## Setup

Per person, under **Settings → Profile → Notifications (Home Assistant)**:

1. **Enable** the channel.
2. Paste the **webhook URL**. In HA, an automation with a **Webhook** trigger gets a
   URL of the form `http(s)://<host>:8123/api/webhook/<webhook_id>` — no custom
   component or HACS install needed.
3. Optionally set a **shared secret**. Allos sends it as the `X-Allos-Webhook-Secret`
   header; your HA automation can reject any call that doesn't carry it (HA webhook
   ids are already capability URLs, so this is belt-and-suspenders).
4. Choose **which reminder kinds** to forward (doses, escalation, refill, preventive,
   workout, digest, upcoming, weekly-recap, milestones). A household may want doses
   announced but not weekly recaps.
5. **Send test** to verify the wiring.

> **PHI posture.** The webhook body contains medication names (in `title`/`body`) and
> typically travels LAN-to-LAN. Use an **`https`** HA URL when the two instances are
> not co-located, and set a shared secret. This is a _delivery_ channel only —
> snooze/dismiss (the "dismiss once, silence everywhere" bus) and the safety-tier
> rules apply _upstream_, so a suppressed reminder never reaches HA either.

## Payload

Allos `POST`s this JSON (a stable, additive-only shape):

```json
{
  "title": "💊 Morning supplements",
  "body": "Vitamin D 2000 IU\nMagnesium 200 mg",
  "kind": "dose",
  "profile": "Grandpa",
  "profile_id": 2,
  "doses": [{ "dose_id": 41, "date": "2026-07-11", "action": "taken" }],
  "dose_ids": [41],
  "links": [],
  "sent_at": "2026-07-11T13:00:00.000Z"
}
```

- `kind` is a machine-readable classification: `dose`, `escalation`, `refill`,
  `preventive`, `workout`, `digest`, `upcoming`, `weekly-recap`, `milestone`, `test`,
  or `other`. Route/announce by it.
- `doses` lists the **actionable** doses (ids only, never names) so an automation can
  wire a voice/button confirmation back to Allos's `POST /dose` endpoint (issue #235,
  PR 3): `{ doseId, date, action: "taken" | "skipped" }`. `dose_ids` is the deduped
  id list for convenience.
- `links` holds any PHI-free deep-link URL the reminder offers (e.g. the refill form).

In an HA webhook automation the body is available as `{{ trigger.json }}` and the
headers as `{{ trigger.headers }}`.

## Recipe 1 — kitchen TTS dose announcement + confirm back to `/dose`

> **Requires unshipped PR 3.** The confirm-back half of this recipe POSTs to
> `POST /api/integrations/home-assistant/dose`, an actuation endpoint that **does
> not exist yet** — it's part of the HA→Allos appliance work tracked in
> [#235](https://github.com/FloorLamp/allos/issues/235) (its "PR 3"), specced in
> [`home-assistant-spec.md`](home-assistant-spec.md) but **not built**. Building
> this automation today, the `allos_log_dose` rest_command will 404. The
> **announce** half (the outbound webhook that speaks the reminder) works now with
> the shipped notification channel; only the log-back-to-`/dose` call is blocked
> until PR 3 lands.

Announce dose reminders on a speaker **only when someone is in the kitchen**, and
expose a physical/voice confirmation that logs the dose back in Allos. Uses HA
`!secret` references so no token lands in a shared config.

`configuration.yaml` (or a `packages/` file):

```yaml
rest_command:
  allos_log_dose:
    # Allos's actuation endpoint (issue #235). Requires a token with allow_actions.
    url: "https://allos.example.lan/api/integrations/home-assistant/dose"
    method: POST
    headers:
      authorization: !secret allos_token_grandpa
      content-type: "application/json"
    payload: '{"doseId": {{ dose_id }}, "date": "{{ date }}", "action": "taken"}'

automation:
  - alias: "Allos: announce doses in the kitchen"
    trigger:
      - platform: webhook
        webhook_id: !secret allos_webhook_id
        allowed_methods: [POST]
        local_only: true
    # Only announce dose reminders, and only if the shared secret matches.
    condition:
      - condition: template
        value_template: >
          {{ trigger.json.kind == 'dose'
             and trigger.headers['x-allos-webhook-secret'] == states('input_text.allos_secret') }}
      - condition: state
        entity_id: binary_sensor.kitchen_occupancy
        state: "on"
    action:
      - service: tts.speak
        target:
          entity_id: tts.home_assistant_cloud
        data:
          media_player_entity_id: media_player.kitchen_speaker
          message: >
            {{ trigger.json.profile }}, it's time for your {{ trigger.json.title }}.
            {{ trigger.json.body }}
      # Stash the first actionable dose so a follow-up confirmation can log it.
      - service: input_number.set_value
        target:
          entity_id: input_number.allos_pending_dose
        data:
          value: "{{ trigger.json.doses[0].dose_id if trigger.json.doses else 0 }}"
      - service: input_text.set_value
        target:
          entity_id: input_text.allos_pending_date
        data:
          value: "{{ trigger.json.doses[0].date if trigger.json.doses else '' }}"

  # A confirmation source: an NFC tag on the pill organizer, a nightstand Zigbee
  # button, or a voice assistant intent. Tapping it logs the pending dose as taken.
  - alias: "Allos: confirm pending dose taken"
    trigger:
      - platform: tag
        tag_id: pill-organizer-grandpa
    condition:
      - condition: numeric_state
        entity_id: input_number.allos_pending_dose
        above: 0
    action:
      - service: rest_command.allos_log_dose
        data:
          dose_id: "{{ states('input_number.allos_pending_dose') | int }}"
          date: "{{ states('input_text.allos_pending_date') }}"
      - service: input_number.set_value
        target:
          entity_id: input_number.allos_pending_dose
        data:
          value: 0
```

> Allos's `/dose` returns the same **outcome union** the Telegram buttons use
> (`logged | skipped | already-taken | already-skipped | stale-dose | inactive`), so
> a stale/duplicate tap can never falsely confirm a dose — surface `resp.status` in
> the automation if you want spoken feedback.

## Recipe 2 — escalation lights / floor announcement

A **missed-dose escalation** (`kind == "escalation"`) is the loud one: flash the
caregiver-floor lights and announce it everywhere, regardless of presence.

```yaml
automation:
  - alias: "Allos: escalate a missed dose"
    trigger:
      - platform: webhook
        webhook_id: !secret allos_webhook_id
        allowed_methods: [POST]
        local_only: true
    condition:
      - condition: template
        value_template: "{{ trigger.json.kind == 'escalation' }}"
    action:
      - service: notify.all_speakers
        data:
          message: >
            Attention: {{ trigger.json.profile }} — {{ trigger.json.body }}
      - service: light.turn_on
        target:
          entity_id: light.upstairs_hall
        data:
          flash: long
          color_name: red
```

## Free wins that need no new automation

- **Appointments in HA natively** — HA's calendar integration consumes Allos's
  token-authed `.ics` feed directly (**Settings → Profile → Calendar feed**), giving
  appointment cards and native "time to leave" automations.
- **Emergency card on a wall panel** — an HA webpage/iframe card pointing at Allos's
  public share link (`/share/*`). Anyone at the panel can read it — that's the point
  of an emergency card.
