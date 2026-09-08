# Home Assistant notifications

Status: shipped, Allos → Home Assistant.

Allos sends reminders to a profile's Home Assistant webhook. HA can announce
messages or control lights using its own automations. Scheduling, recipient
selection, and message-kind controls are covered in [Notifications](notifications.md).
HA → Allos dose confirmation remains an [unbuilt proposal](home-assistant-spec.md).

## Setup

For the selected profile, open **Settings → Notifications → Home Assistant**:

1. Create an HA webhook automation with an unpredictable, private webhook ID.
   Allow POST requests and keep `local_only: true` for a local Allos instance.
2. Enable the Allos channel and enter the webhook URL:
   `http(s)://<host>:8123/api/webhook/<webhook_id>`.
3. Select reminder kinds in the **HA** column of **Message kinds**, then use
   **Send test** and inspect the HA automation trace.

The payload can contain medication names and other health details. Use HTTPS
when sending between networks, and choose speakers/displays with that visibility
in mind. HA authenticates its built-in webhook by the private webhook ID; follow
[HA's webhook guidance](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger)
for network access and credential handling.

Allos optionally sends `X-Allos-Webhook-Secret`. HA's built-in trigger does not
expose request headers to templates, so `trigger.headers` cannot validate it.
Use that extra secret only with a receiver or proxy that checks the header before
forwarding. See [available webhook variables](https://www.home-assistant.io/docs/automation/templating/#webhook).

## Payload

Allos POSTs JSON with these fields:

```json
{
  "title": "💊 Morning supplements",
  "body": "Vitamin D 2000 IU\nMagnesium 200 mg",
  "kind": "dose",
  "profile": "Example Person",
  "profile_id": 2,
  "doses": [{ "dose_id": 41, "date": "2026-07-11", "action": "taken" }],
  "dose_ids": [41],
  "links": [],
  "sent_at": "2026-07-11T13:00:00.000Z"
}
```

- `title` and `body` are display text; `profile` names the tracked person.
- `kind` selects the reminder category, such as `dose`, `escalation`, `refill`,
  `digest`, or `test`. The [notification vocabulary](../lib/notifications/types.ts)
  owns the complete set.
- `doses` describes available take/skip actions, deduplicated by dose and action;
  it does not mean those actions happened. `dose_ids` contains unique dose IDs.
  These fields do not enable an inbound confirmation endpoint.
- `links` contains the reminder's navigation URLs. `sent_at` is the send instant.

The [payload builder](../lib/notifications/home-assistant-core.ts) owns this
additive response shape. HA templates read its body through `trigger.json`.

## Example: announce reminders

Add this automation to `configuration.yaml` or a package. Put your private webhook
ID under `allos_webhook_id` in HA's `secrets.yaml`; replace the TTS and speaker
entities with your own. The example accepts dose reminders and Allos's test message.
It uses HA's [TTS speak action](https://www.home-assistant.io/integrations/tts/).

```yaml
automation:
  - alias: "Allos: announce dose reminders"
    triggers:
      - trigger: webhook
        webhook_id: !secret allos_webhook_id
        allowed_methods: [POST]
        local_only: true
    conditions:
      - condition: template
        value_template: "{{ trigger.json.kind in ['dose', 'test'] }}"
    actions:
      - action: tts.speak
        target:
          entity_id: tts.home_assistant_cloud
        data:
          media_player_entity_id: media_player.kitchen_speaker
          message: >
            {{ trigger.json.profile }}. {{ trigger.json.title }}.
            {{ trigger.json.body }}
```

Adapt the receiving automation to route `kind == 'escalation'` to the appropriate
speaker or light action. A presence condition can restrict where HA announces a
message; it does not change delivery through Allos's other channels.

## Other household surfaces

- The calendar feed under **Data → Import → Calendar feed** can supply appointments
  to HA's calendar integration.
- Open an emergency share link in a browser tab or panel navigation action.
  Share pages prohibit framing, so an iframe card cannot embed them. Anyone with
  access to the public link can read its contents.
