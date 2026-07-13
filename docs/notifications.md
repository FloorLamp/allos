# Notifications — channels, buttons & scheduling

Status: **shipped** · descriptive documentation of current behavior, extracted from the README (#597)

Reminders (supplements due in a window, and a workout nudge when you're behind on a
weekly target) are delivered over three channels — **Telegram**, **Web Push**, and a
**Home Assistant** webhook — that share the same schedule and per-day/slot dedup. Enable
any or all; a profile with several configured gets each reminder on each.

Beyond reminders, two opt-in retention nudges ride the same channels: a **weekly recap**
— a quiet once-a-week summary of your week (workouts + volume, PRs, supplement
adherence, a body-weight trend, and streak status), covering the same "this week" your
routine counters use per your **week mode** (a calendar week or a rolling seven days —
**Settings → Profile**), set the send day/hour under
**Settings → Profile**; and **milestone alerts** — a brief note when you cross a
milestone (your 10th/50th/100th/… workout, a 7/30/100/365-day streak, a completed goal, or
a 7/30-day adherence run). Both are rule-based and work with **no AI configured**.
Milestones are always recorded to your **Timeline** (under the **Milestone** filter)
regardless of the alert toggle. The recap is also available as an off-by-default
**Weekly recap** dashboard card (enable it from the dashboard's **Customize** control).

Newly-due **preventive care** (an age/sex-appropriate checkup or screening) also sends a
single proactive nudge, so a due mammogram/colonoscopy/lipid panel doesn't wait to be
noticed in the "what's due" digest. It's deduped **once per due episode** (not once a
day): the ping fires when an item first becomes due or overdue and stays quiet until the
item is satisfied or ages out, then re-fires when the next interval comes due. The whole
domain is a per-profile toggle — **Settings → Profile → Preventive-care reminders** (on by
default). Turning it off suppresses both the nudge and the preventive lines in the
digest; due items still appear on your **Upcoming** page either way (that's a pull view,
not a push). Informational only — not medical advice.

**Dismiss once, silence everywhere.** Snoozing or dismissing a **refill**,
**preventive-care**, or **training-target** item on the **Upcoming** page (or the
dashboard attention banner) now also silences its **push nudge**, not just the page and
digest lines — the reminder and the nudge share the same identity, so one "I've decided
about this" hides both. For the workout nudge that means dismissing every behind
training target quiets the "today's workout" reminder (a still-behind target keeps it
coming). A snooze
resumes nudging after its date; restoring the item brings the nudge back. Safety-critical
reminders are deliberately **not** silenceable this way — scheduled **dose reminders** and
**missed-dose escalations** keep firing on their own per-day dedup regardless of a page
dismissal.

**Quiet hours.** The non-urgent episode nudges (refill, preventive, milestone) are only
sent during a per-profile **waking window** — set the start/end hours under
**Settings → Profile → Quiet hours** (this profile's timezone; defaults to 08:00–21:00).
An overnight span like 20:00 → 08:00 is supported for a night-shift rhythm. Outside the
window a due nudge simply waits for the next in-window tick (its once-per-episode dedup is
unchanged). Slot-anchored sends (dose reminders, morning digest, workout, weekly recap)
already fire at their own chosen hours and are unaffected; safety-critical **dose
reminders** and **missed-dose escalations** are **never** held by quiet hours — an
escalation at 2am for a missed critical med is the feature working.

### Telegram

Configure the bot token and mode under **Settings → Server** (global, admin-only);
enable notifications, set the chat id, and choose per-slot send times per person under
**Settings → Profile**.

Several nudges carry one-tap action buttons that make the obvious response without
opening the app: a **dose reminder** has ✅ take / ⏭ skip (and ✅ All); a **preventive**
nudge has ✅ Done / 🚫 Not applicable / ⏰ Remind later; a **refill** nudge has 📦 Ordered —
remind me in 3 days (plus a link to the refill form); and a **missed-dose escalation** has
✅ Confirmed taken / 👍 I'm on it (an acknowledgement that stops the re-nudge without
claiming the dose was taken — anyone in the caregiver escalate chat can tap it). A snooze
tapped here is the same fact as a page snooze, so it's silenced everywhere. Buttons whose
answer needs a number (e.g. "mark refilled") deep-link to the form instead.

These button taps reach the app one of two ways (pick under **Button taps**):

- **Polling** (default) — the notify service long-polls Telegram's `getUpdates`, so it
  works without the app being publicly reachable. The Docker `allos-notify` service
  runs the poller automatically; without Docker, keep `npm run notify -- poll` running.
- **Webhook** — Telegram POSTs taps to `<public URL>/api/telegram/webhook`. Set the
  shared **Settings → Server → Public app URL** (also used for Strava OAuth callbacks
  and the Health Connect ingest endpoint), then register the webhook from
  **Settings → Server**. Telegram requires HTTPS.

### Web Push (browser notifications)

No Telegram account needed: subscribe a browser under **Settings → Preferences → Web
Push notifications** and reminders arrive as native OS/browser notifications, opening
the app when tapped. Notes:

- **HTTPS required.** Web Push needs a service worker, which browsers only run over
  HTTPS (or `localhost`). It works on the deployed/installed app, **not** over plain
  `http://` on a LAN IP, and not in local `next dev` (the service worker is disabled
  there).
- **Per browser, per login.** A subscription belongs to the browser you enable it on
  and to your login — enable it on each device you want notified. A subscribed browser
  receives reminders for every profile that login can access.
- **Browser support.** Chrome/Edge/Firefox (desktop + Android) and, on **iOS 16.4+**,
  Safari **only after you install the app to the Home Screen** (Add to Home Screen).
- **Zero setup.** The instance's VAPID keypair is generated automatically the first
  time anyone enables push; the private key stays on the server. Payloads carry only a
  title + short body (the same text Telegram would show) and a link — no record detail.

### Home Assistant (presence/room-aware reminders)

If you run **Home Assistant** on the same LAN, Allos can send each reminder to an HA
**webhook** so HA presents it with what only it knows — _who is home, and which room_:
kitchen-speaker **TTS dose announcements** when the person is actually in the kitchen
(the accessibility win for a household member who'll never install Telegram), **escalation
theatrics** (a critical dose left unconfirmed flashes the lights / announces on the
caregiver's floor), and **presence-aware delivery** (hold an announcement until someone's
home, or suppress the phone push once the wall panel has spoken). Configure it per person
under **Settings → Profile → Notifications (Home Assistant)**: enable it, paste your HA
webhook URL (`http(s)://<host>:8123/api/webhook/<id>` — HA's built-in
[webhook trigger](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger),
no custom component needed), optionally set a shared secret, choose which reminder kinds to
forward (a household may want doses announced but not weekly recaps), and **Send test**.
Allos joins the same channel-aware delivery-health marker, so a wrong URL / unreachable HA
surfaces on **Settings → Server**.

- **Payload.** A JSON POST with `title`, `body`, a machine-readable `kind`
  (`dose`/`escalation`/`refill`/…), the profile display `name`, and — for actionable dose
  reminders — the `doses` (`dose_id` + `date` + `taken`/`skipped`) so an HA automation can
  wire a voice/button confirmation back to the Allos `POST /dose` endpoint. Full shape and
  copy-paste automation recipes (TTS announcement + confirm-to-`/dose`; escalation lights)
  are in [`home-assistant-notifications.md`](home-assistant-notifications.md).
- **PHI posture.** The body contains medication names and usually travels LAN-to-LAN. Use
  an `https` HA URL when the instances aren't co-located, and set a shared secret (sent as
  the `X-Allos-Webhook-Secret` header) so an HA automation can reject calls without it.
- **Delivery only, not a decision surface.** Snooze/dismiss (the "dismiss once, silence
  everywhere" bus) and the safety-tier rules apply _upstream_ of this channel exactly as
  they do for Telegram — a suppressed reminder never reaches HA either.

Sending is driven by a tick that runs **every hour**. Each tick sends whatever is scheduled
for the current hour (supplement windows at their configured hours; the workout reminder on
your inferred training days/time) and not already sent today, deduped per day/slot so a retry
never double-sends. Timing follows the per-profile timezone you pick in **Settings → Profile**
(stored in the DB and shared with the notifier; new profiles inherit the **Settings → Server**
instance default), defaulting to UTC until set.

**Docker (default):** the `allos-notify` service in `docker-compose.yml` runs the tick on the hour
automatically — no host crontab needed — and keeps the Telegram button-tap poller running
alongside it (idle unless polling mode is selected). It shares the app's image and database; bring it up
with the rest of the stack (`docker compose up -d`). Remove that service if you'd rather drive
the tick yourself.

**Without Docker / external scheduler:** add an hourly cron entry instead:

```cron
0 * * * * cd /app && npm run notify
```

Manual sends for testing: `npm run notify -- morning|midday|evening|bedtime|workout` (in the running
container: `docker compose exec allos-notify node dist/notify.cjs workout`).
