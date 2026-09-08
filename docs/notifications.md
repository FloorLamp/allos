# Notifications

Allos can deliver reminders through Telegram, browser notifications, Home
Assistant, and email. Open **Settings → Notifications** to choose channels,
message kinds, profiles, and times. No AI configuration is needed for ordinary
reminders, recaps, or milestones.

## Set up a channel

The channel rows show **Not set up**, **Ready**, **Delivering**, or **Erroring**.
Ready means configured without a completed delivery yet; Delivering and Erroring
reflect recorded outcomes. Open a row to configure it or inspect an error.

| Channel        | Belongs to             | Setup                                                                                          |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Telegram       | Your login             | Configure the instance bot under Settings → Server, then enable your chat under Notifications. |
| Web Push       | Your login and browser | Enable notifications in each browser where you want reminders.                                 |
| Email          | Your login             | Configure instance SMTP, then enable email to your account's address.                          |
| Home Assistant | The selected profile   | Enable the webhook and enter its URL under Notifications.                                      |

A reminder can reach several enabled channels. Their content and available actions
may differ, and each channel can allow different message kinds.

### Telegram

An admin sets the bot token and button-tap mode under **Settings → Server**.
Set your chat ID and send a test under **Settings → Notifications**.

Buttons can take or skip doses, acknowledge an escalation, snooze a refill, or
record a preventive-care response. An "I'm on it" acknowledgement does not claim
the dose was taken. Actions needing more information open the corresponding form.

Choose how button taps reach Allos:

- **Polling**, the default, works without a publicly reachable app. Docker's
  notification service runs the poller. Outside Docker, keep
  `npm run notify -- poll` running alongside the scheduler.
- **Webhook** requires an HTTPS public app URL. Set **Settings → Server → Public
  app URL**, then register the webhook there.

### Web Push

Under **Settings → Notifications → Web Push notifications**, enable the browser
and grant notification permission. Repeat on each device. Allos creates its push
keys automatically; you do not need a Telegram account.

Push needs a supported browser, a service worker, and HTTPS or localhost. The app
has no service worker in `next dev`, and a plain HTTP LAN address will not work.
On iPhone or iPad, add Allos to the Home Screen and open it there before enabling
notifications; see [WebKit's Home Screen push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
Notification text can include health details, so consider who can see the device's
notifications. Tapping a notification opens Allos. Button-only prompts, such as
food logging and mood check-in, are not sent over Web Push.

### Email

An admin configures SMTP under **Settings → Server → Outbound email**; see
[SMTP setup](../README.md#outbound-email). Enable your own channel under
**Settings → Notifications → Email**. It uses the same account address as
invitations and password resets.

The default message contains no health details: it asks you to open Allos. Choose
**full content** only if you want reminder details in your inbox. The test message
uses your saved content choice. Email includes ordinary links but cannot carry
one-tap callback buttons; button-only prompts are excluded.

### Home Assistant

Enter the selected profile's HA webhook URL, optionally add a shared secret, and
send a test. HA can use the received reminder for a speaker announcement, lights,
or another household automation. The body can contain medication names and other
health details.

Use the [Home Assistant setup and recipes](home-assistant-notifications.md) for
payloads and configuration. This shipped channel sends from Allos to HA. The
reverse endpoint for logging a dose from HA is still a
[proposal](home-assistant-spec.md); the confirmation part of that recipe will not
work until it is implemented.

## Choose who receives reminders

Telegram, Web Push, and email follow the login receiving them. A profile's
reminders reach its managing logins: explicit profile grants plus the login whose
own profile it is. Channel settings, message-kind choices, and profile mutes still
apply. Home Assistant uses the selected profile's webhook instead.

Admins can view every profile, but that does not subscribe them to every profile's
reminders. Choose notification profiles under **Settings → Notifications → Profiles**,
or manage another login under **Settings → People & access**. Your own profile
is included in that selection; use the notification mute controls when needed.

## Choose messages and times

The **Message kinds** table has one column per channel. Its column checkbox changes
ordinary kinds together; dose reminders, missed-dose escalations, and PRN redose
notices retain individual controls. Review those controls separately.

Schedules use the tracked profile's timezone from **Settings → Health profile**.
New profiles inherit the server's default timezone. Set the intake windows and
other enabled reminders in Notifications. The Morning intake window can follow
typical wake time. The morning digest has separate Static and Dynamic modes:
Static uses your chosen time; Dynamic can wait for sleep data after that time,
within the deadline described in settings.

**Quiet hours** define when non-urgent nudges may arrive. The default waking window
is 08:00 through 21:59; the selected end hour is inclusive. Overnight windows are
supported. Eligible nudges wait until the window opens. Slot-scheduled messages
use their own times, and urgent medication reminders are not held by quiet hours.

**Preventive-care reminders** default on. A screening is announced once when due
for that episode, then can be announced again when a later interval becomes due.
Turning this off also removes preventive-care lines from the digest, while
Upcoming still shows the items.

Snoozing or dismissing a refill, preventive-care item, or training target also
suppresses its associated nudge. A workout nudge can remain while another target
is behind. Snoozes expire; restoring an item removes its suppression. These page
decisions do not silence scheduled dose reminders or missed-dose escalations.

## Recaps and milestones

Recaps are optional. Choose the day, time, and shortest reporting period: weekly,
monthly, or quarterly. When several periods close at the same slot, the longer
recap replaces the shorter one. Choosing a longer cadence reduces messages.
Weekly periods follow the profile's week mode.

Recaps describe training, adherence, food-log coverage, sleep, weight trends, and
goals when enough data is available. They describe logged evidence rather than
assuming missing logs mean missing activity. Goals belong to the period they were
reached; unmet deadlines are reported in their period, and archived goals are omitted.

Milestone alerts default on and can be disabled. Milestones still appear on the
Timeline when alerts are off.

## Run the scheduler

Docker's `allos-notify` service shares the app image and database, runs the
notification tick every five minutes, and keeps the Telegram poller available.
Start it with the rest of the stack using `docker compose up -d`.

Outside Docker, run one scheduler, for example:

```cron
*/5 * * * * cd /app && npm run notify
```

Use your actual checkout path. Run either the Docker tick scheduler or an external
scheduler, so they do not compete. `TICK_SECONDS` in `docker-notify.sh` controls
the Docker interval. Settings reports the observed interval and warns when it
cannot meet a chosen time; hourly scheduling can deliver between-hour reminders
at the following tick.

Scheduled slots allow a second attempt opportunity an hour after the first band.
A partial delivery can produce duplicate notifications if retried. Check channel
errors and scheduler logs when messages do not arrive.

To send a workout reminder manually, use `npm run notify -- workout`, or inside
Docker, `docker compose exec allos-notify node dist/notify.cjs workout`.
Maintainers changing behavior should read the
[notification architecture](internals/notifications.md).
