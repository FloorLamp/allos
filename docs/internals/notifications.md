# Notifications — architecture deep-dive

> **Who may be contacted, and about what, is decided by the intake `obligation`
> model and the attention doctrine, not per-channel.** `must` reminds and
> escalates; `should` reminds; `may` is never pushed and reaches the user only
> through surfaces they open themselves — including the daily digest's
> guaranteed "Log other (3 for midday)" tail, whose slot-boundary refresh is a
> keyboard EDIT and therefore not a send. See
> [the attention doctrine](findings.md#the-attention-doctrine) and
> [supplements](supplements.md).

Status: **shipped** · extracted verbatim from AGENTS.md (#597)

Maintainer documentation for `lib/notifications/`: delivery channels and the
notify tick, the delivery-health marker, the two suppression contracts, the
two-way Telegram button principle, and the channel chokepoint — with the full
design history and issue trail. The load-bearing invariants are summarized in
AGENTS.md; the user-facing setup guide is
[`notifications.md`](notifications.md).

---

**Channels belong to LOGINS, not profiles (#1072).** A notification **channel**
is scoped to the **login** (a person with a phone), while an **event** is scoped
to the **profile** (the data subject it's about). A toddler has no phone; their
caregiver does — so a per-profile event **fans out** to the logins that
**manage** that profile. This replaced (not layered over) the old per-profile
`profile_settings.telegram_chat_id`: the chat now lives in `login_settings`
(`telegram_chat_id` / `telegram_enabled` / `telegram_notify_disabled_kinds`, via
`getLoginTelegram`/`setLoginTelegram`), and Web Push subscriptions were already
login-keyed (`push_subscriptions.login_id`).

- **Fan-out scope = EXPLICIT grants (`login_profiles`) + the login's own profile
  (#1013, null until it lands) — NEVER admin-bypass-all.** This is the ONE place
  the "admins reach every profile" rule is deliberately not inherited: a
  notification is a push into someone's pocket, so an admin who can act as every
  profile must OPT specific profiles into their notification scope by granting
  themselves. The resolution lives in `lib/notifications/fan-out.ts` —
  `managingLoginIdsForProfile(profileId)` (grants only, id-ordered), the pure
  `dedupeRecipientsByChat` (first login wins per distinct chat, empties
  dropped), and `resolveTelegramRecipients(profileId)` (managing logins that
  have Telegram enabled + a chat + haven't muted the profile, deduped by chat).
  The push audience (`getPushSubscriptionsForProfile`) is the same
  grants-minus-mute set with the old `role='admin'` bypass removed.
- **What stayed profile-keyed vs moved login-keyed.** The **fire decision**
  stays event-keyed **profile+slot+day** — one evaluation, unchanged: every
  `notify_last_*` marker, the per-profile **schedule** (digest hour, recap day,
  waking window, supplement hours, preventive/milestone toggles), and the
  per-subject content opt-ins (food/mood/sleep) stay in `profile_settings`. What
  moved to the **login** is the **channel** (chat id + enable + Telegram/push
  disabled-kinds), the **per-(login,profile) mute** (`isProfileMutedForLogin`, a
  `notify_mute_profile_<id>` login_settings key — "don't notify me about
  Grandpa", affects only that login's fan-out; safety-tier mute is allowed but
  off by default), and the post-migration **review flag**
  (`notify_review_needed`). The **delivery-health marker stays GLOBAL** (one
  shared bot — a broken token/chat is an instance-level signal on Settings →
  Server); its channel-aware clear (#192) is unchanged.
- **Delivery dedup by resolved chat id.** A single dispatch fans Telegram out
  over `resolveTelegramRecipients` and sends once per DISTINCT chat, so a family
  group two logins both point at gets ONE message (the profile-name-in-title
  #380 is now universal). Escalation (`runEscalations`) fans out the same way
  but its `escalate_chat_id` supplement override, when set, supersedes the
  fan-out (per-item caregiver routing). Since #1716 that override rides the
  dispatch call as a `DispatchOptions.telegramChatIds` routing hint rather than
  a direct Telegram send, so the safety tier keeps per-item routing AND gains
  delivery accounting — see the escalation paragraph below. Callback taps resolve **chat → login →
  in-scope profiles** (`getProfilesByTelegramChatId` rewritten over
  `login_settings`+`login_profiles`); the button token still names the acting
  profile, so the tap logic is unchanged.
- **Migration (105-login-notification-channels).** Best-effort, non-data-lossy
  (a wrong channel is a recoverable missed notification, never lost health
  data): for each login, the most-common enabled chat among its accessible
  profiles wins (ties → lowest profile id); an explicit `login_profiles` grant
  is materialized for every profile that contributed the winning chat
  (preserving delivery without admin bypass — the single-admin bootstrap keeps
  working); MORE than one distinct enabled chat raises `notify_review_needed`;
  the old `profile_settings` telegram keys are read once then deleted; a
  one-shot reconciliation summary lands in the `notify_channel_migration_report`
  global setting.
- **Settings surfaces.** The Telegram channel + its matrix column + the "send
  test" moved to the **login** tier (`app/(app)/settings/actions.ts` —
  `saveLoginTelegram`/`saveLoginTelegramNotifyKinds`/`sendTestNotification`,
  `requireSession()` gate, allowed for read-only members since the chat is
  theirs); the schedule + food/mood/sleep stay on the **profile** tier
  (`saveNotificationPrefs`, `requireWriteAccess`); the per-profile mute is a
  login-tier action (`saveProfileNotifyMute`, validated against
  `canAccessProfile`). Since #1462 §6 the page is three sections — Channels,
  Schedule & message kinds, and the two per-login reductions (digest tune, mute)
  — and since #1868 it is registered `tier: "mixed"` so its header states the
  mixed scope instead of claiming one tier; the per-section scope strings remain
  the fine-grained layer. The instance-wide Telegram BOT card lives on
  Settings → Server.

**The Settings page is ONE editor per setting (#1868).** Settings → Notifications
was the densest page in the app, and about a third of its controls were
duplicates of controls already on it:

- **The Home Assistant card no longer routes kinds.** Its "announce which
  reminders" grid wrote the SAME `ha_notify_disabled_kinds` key as the matrix's
  HA column — 26 checkboxes for 13 booleans — while the page's own header comment
  claimed the matrix had already replaced per-kind duplication (true for Telegram
  and Push, never done for HA). The card now configures the CHANNEL only (enable,
  webhook URL, shared secret, send-test) and points at the column.
  `saveHomeAssistantPrefs` therefore **preserves** the stored disabled set rather
  than deriving it from `ha_kind_*` fields — load-bearing, since a form without
  those fields would otherwise read as "every kind unchecked" and silence the
  whole channel on a URL edit. The `TOGGLEABLE_HA_KINDS` alias is gone with it.
- **Column select-all on the matrix** (`lib/notifications/matrix-bulk.ts`, pure):
  a tri-state control in each column header — `sweepableKinds` /
  `columnBulkState` / `nextColumnBulkTarget` / `applyColumnBulk` — writing the
  full disabled set through the SAME tier-correct action a single cell uses. No
  new setting, no new storage, no delivery-semantics change. **Safety kinds are
  never swept** (#928): `dose`, `escalation` and `redose` keep their individual
  checkboxes and the existing warn-never-block all-off notice, so a safety signal
  can never be silenced by one undifferentiated tap — and `columnBulkLabel` says
  so in the control's own accessible name ("turn off everything except safety
  reminders"). A NON_CONFIGURABLE kind (`followup`, #1873) has no registry row, so
  it is invisible to the matrix and unreachable by a sweep. Row-level select-all
  is deliberately absent: a row spans three cells and overlaps the per-kind
  enable.
- **The digest mirror is collapsed.** Its ten checkboxes were an acknowledged
  mirror of the message's ⚙️ Tune control, so they now sit behind a disclosure
  over `digestTuneSummary` — one line naming exactly what is turned down. The card
  survives rather than being deleted because it is the only way to reverse a
  demotion off-Telegram, which is the whole point of the #1714 mirror.

**Two cadences, not one (#2121 step 1).** The tick does two unrelated things, and
they are now bounded by different constraints. _Evaluating what is due to send_ is
bounded only by the tick process's ~0.5 s boot, so it may run as often as the
scheduler fires. _Polling external providers_ is bounded by those providers' API
quotas, and is held to a per-provider cadence declared in the integrations registry
(`pull.cadenceMinutes`, hourly for all four today) and enforced in
`lib/integrations/pull-tick.ts` — see
[`integrations-sync.md`](./integrations-sync.md). The consequence for this document:
**a finer tick multiplies due evaluations and not provider API calls**, which is
what made taking the tick below the hour a scheduler-shape change rather than a
quota decision. `docker-notify.sh` now fires every 15 minutes; a host crontab may
run any steady rhythm from 1-minute to hourly, because the tick OBSERVES its own
cadence (the `notify_tick_last_run_at` watermark → `observedTickMinutes`) and
sizes its slot windows from what the scheduler actually does, not from a config
claim.

**The retry budget is DECIDED (#2121 item 3): two attempts, an hour apart, at
every tick rate.** A send marker is written only on `delivered`, so a slot whose
sends FAIL retries on every tick on which it reads "due" — under a naive
minute-grain membership window that count would have been the window divided by
the tick rate (8 at 15-minute ticks, 120 at 1-minute), silently. Instead
`slotDue` is two discrete ATTEMPT BANDS, each one observed-tick wide: the first
tick at/after the slot minute, and the first tick an hour later
(`slotAttempt`, `lib/notifications/schedule.ts`). A slot is due ONLY on a tick
landing in a band, so a failing send is attempted exactly twice a day, one hour
apart — the budget the hourly tick always had, now invariant under the tick
rate, with no attempt counter and therefore nothing new in
`SEND_MARKER_REGISTRY`. This is the stateless "back off" resolution of the
email-vs-push tension the old note recorded: #1855's email channel keeps a
retry that outlives an SMTP greylist (an hour does), and a push service
returning 429 is never hammered (twice a day is not hammering). A channel that
ever needs a different budget changes `SLOT_RETRY_DELAY_MIN` or the band count
in that ONE place. What the bands preserve from the old `[slotHour, slotHour+1]`
hour-equality window — bit-identical hourly behavior, DST spring-forward
recovery on the retry band, the no-midnight-wrap rule and its cost — is spelled
at `slotAttempt` itself. The tick learns its own cadence by observation
(`notify_tick_last_run_at` → `observedTickMinutes`, clamped to [1, 60] so an
outage can never widen the window), and Settings → Notifications warns when the
observed cadence cannot honour a configured sub-hourly time
(`subHourlySlotsAtRisk`): a sub-hourly slot under an hourly crontab fires up to
~an hour late, and a slot after the day's last tick (e.g. 23:50 under hourly
ticks) never fires at all, because slots never wrap into the next day.

**The email channel (#1855).** Email is the fourth channel: login-scoped like
Telegram/push (the address is `logins.email` — the auth address; the enable,
content mode, and matrix column are `login_settings` keys), fanned out over the
SAME managing-login set minus the per-(login, profile) mute, deduped by address,
and sent through the ONE `lib/email.ts` chokepoint. What a mail may CARRY is a
per-login choice defaulting to **content-free** ("something needs your attention
— open Allos", structurally message-blind), with **full content** — plainBody
parity plus deep links, callback tokens always dropped — only ever widened by
the login's own tap on the Settings control; a shared inbox collapses to the
more restrictive mode. Button-only kinds are a no-op under the same predicate
Web Push uses; failures fold into the delivery-health marker and retry on the
shared attempt band (an hour outlives an SMTP greylist — no email-specific
retry state). The full design record is `docs/internals/email.md` § "The
notification channel".

**Notifications** (`lib/notifications/`) are delivered over four channels —
Telegram, Web Push, an outbound Home Assistant webhook, and email — driven by a tick
(`npm run notify` / the `notify` Docker service, every 15 minutes; slot times are
minute-precise since #2121, stored as "HH:MM" by migration 158). Sends are deduped per
day/slot; timing follows the DB-stored timezone
(Settings → Health profile → Timezone). Inbound
button taps arrive either via the webhook route (`app/api/telegram/webhook`) or,
when the app has no public URL, a `getUpdates` long-poll loop
(`npm run notify -- poll`, run by the Docker sidecar); both delegate to
`lib/notifications/telegram-callbacks.ts`. The mode is a setting
(`telegram_mode`), and the shared public URL lives in `getPublicUrl()`
(`lib/settings.ts`). **Delivery-health marker (#131 → lifecycle state #942):**
`dispatch()` (`lib/notifications/index.ts`) folds every send fan-out into a
global delivery-health marker — set on any failed channel, cleared on the next
all-OK send — so a revoked bot token / wrong chat id surfaces on **Settings →
Notifications** (the admin Server section) instead of only as the tick's exit
code; the login-scoped **Send test** button (#1072) is the remediation path (a
successful test clears it). As of #942 the marker is a first-class **lifecycle
row** (`notify_lifecycle`, migration 061, keyed `'delivery-health'`) rather than
three ad-hoc `notify_last_error*` settings keys: presence of a `state='failing'`
row = a live failure, a healthy dispatch DELETEs it, and `getNotifyError()`
returns the identical shape it always did (the row I/O is
`lib/notifications/delivery-marker.ts`; migration 061 copies any live legacy
marker into the row on upgrade and retires the old keys). The pure decision half
is `lib/notifications/delivery-status.ts`
(`pickDispatchError`/`isDeliveryHealthy`/`decideMarker`, unit-tested), whose
`decideMarker` now speaks the shared **set/clear/freeze**
`MarkerLifecycleAction` vocabulary (`lib/lifecycle.ts`) — "freeze" (formerly
"keep") is the third state, the marker left exactly as it stood. **Clearing is
channel-aware (#192):** the marker records _which_ channel failed, and a healthy
dispatch only clears it when it actually attempted that channel (`decideMarker`)
— so in a tick's per-profile fan-out, a Telegram-only profile can't clear a
still-broken push recorded by a both-channels profile earlier in the same tick.
**Two suppression contracts (#227):** tick nudges split into **bus-gated
nudges** and **safety reminders**. A _bus-gated_ nudge (the **refill**,
**preventive**, **workout**, and **illness-care** pushes, plus the retest lines
inside the morning digest's **Today** section (#1108)) consults the SHARED
findings-suppression bus (`getFindingSuppressions(profileId)` over
`upcoming_dismissals`) before sending, keyed by the **identical `dedupeKey` its
Upcoming twin carries** — `refill:<id>` via `refillSignalKey`
(`lib/refill-nudge.ts`), `<kind>:<ruleKey>` via `preventiveSignalKey`
(`lib/preventive-upcoming.ts`), `training:<id>` via `trainingSignalKey`
(`lib/workout-nudge.ts`), `illness-care:<variant>:<situation>:<start>:<symptom>`
via `illnessCareDedupeKey` (`lib/illness-care.ts`, #805) — so a page
dismiss/snooze silences the push too ("dismiss once, silence everywhere"). **The
illness-care nudge (`runIllnessCare`, #805)** is care-tier, not safety-tier — a
logged symptom crossing a CITED duration/trajectory line is a reminder-class
care finding, not a dose-safety signal, so it is deliberately bus-gated (a
parent already at the doctor can dismiss it once and silence every surface,
`planIllnessCareNudges`), and — like refill/preventive — held to the waking
window and assessed once per profile-local day. **The temperature red-flag nudge
(`runTempRedFlag`, #859) is its bus-gated sibling but is NOT day-gated
(#1025):** its input is the open episode's LATEST reading, which changes
intra-day exactly during the fever days that matter, so the tick assesses it
EVERY waking tick (dedup is owned by the per-finding
`notify_last_tempredflag_<dedupeKey>` marker — the key embeds the reading's
date + rule — plus the bus), and the temperature WRITE paths (the log action,
the Telegram temp reply, the Health Connect vitals ingest) dispatch it
immediately via `dispatchTempRedFlagForReading`/`queueTempRedFlagDispatch`
(fire-and-forget; a cheap dataset pre-check keeps ordinary readings free of
notification work). The write-path dispatch follows the REDOSE quiet-hours
precedent, not the episode-nudge one: a 2 AM 106 °F reading is the
overnight-emergency case and only exists because a caregiver is awake logging
it; the tick path keeps its waking window and is the fallback for readings that
arrive without an event (a backfilled import row never fires — the
open-episode + latest-reading framing bounds it). Suppression is a **third
"frozen" source** alongside the preventive covered-visit case (#183): a
suppressed item is held out of BOTH the send set and the marker-clear set, so
its once-per-episode `notify_last_*` marker is frozen exactly as it stood —
un-dismissing (or a snooze expiring) resumes the normal lifecycle without
re-nudging a same-episode item (the pure decisions are
`planRefillNudges`/`planPreventiveNudges`, unit-tested). **The workout nudge
(#245)** joined the bus after #227 deferred it — the #221 unified core
(`lib/workout-recommendation.ts`) synthesizes ONE "train today" suggestion, so
it carries its originating behind-target ids and, when **every** matching
`training:<id>` finding is dismissed, `recommendWorkout` returns null (the pure
gate is `isWorkoutNudgeSuppressed`); returning null holds it out of the send AND
freezes its daily `notify_last_workout` slot marker (the tick only marks a slot
on a delivered message), while a habit/rest/on-track nudge with no behind target
— or partial suppression with a still-live target — still fires. Safety-tier
generators stay ungated. **Situation-aware quiet (#837):** `recommendWorkout`
ALSO returns null (slot quiet) during an open flagged-illness episode and
through the post-close ease-back ramp — a fever week needs no "time to train"
ping. The pure gate is `illnessCoachingMode(input.illness, today)` off the SAME
shared `gatherCoachingInput` the dashboard coaching card reads, so the two can't
drift (#221); the coaching engine holds the gap/pace nags in lockstep. On
episode close the tick sends **one** ease-back re-entry note (`runEaseBack`,
`lib/notifications/ease-back.ts`) — a per-episode one-shot keyed by
`notify_ease_back_<episodeId>` (an id-keyed marker, #203-safe) and waking-gated
— then goes quiet again; it's a one-time transition courtesy (like the
weekly-recap/milestone one-shots), NOT the recurring coaching stream #449 keeps
off notifications. A _safety_ reminder — scheduled **dose reminders**,
**missed-dose escalation**, and the **PRN redose notice** (#798) — is
DELIBERATELY **not** bus-gated (same non-hideable-safety reasoning as #171's
attention strip): a page dismissal must never silence a possibly-critical
medication signal, so their per-day/slot (or per-administration) markers stay
the only dedup. **Missed-dose escalation dispatches like every other builder
(#1716):** it used to call `sendTelegramMessage` directly, which made the
loudest safety-tier message the only one that reached Telegram ONLY — while the
kind registry offers `escalation` per-channel routing and the Home Assistant
channel advertises escalation light-flashes, neither of which could structurally
happen — and it bypassed `dispatch()`'s `recordDeliveryOutcome`, so a broken
safety channel never set the delivery-health marker and stayed invisible in
Settings. It now goes through `dispatch()`; the message states the elapsed time
that made it fire ("morning slot, unconfirmed for 2h 40m") and carries a deep
link. The fan-out's warn-never-block posture on a muted safety kind is
unchanged. As of #942, missed-dose escalation is the **first lifecycle
tenant**: it declares `ESCALATION_SUPPRESSION_POLICY = "safety-ungated"`
(`lib/notifications/escalation.ts`), the #449 carve-out expressed as DATA in the
shared `LifecycleSuppressionPolicy` vocabulary (`lib/lifecycle.ts`,
`isHiddenUnderPolicy` — `normal` / `snooze-only` / `safety-ungated`, the ONE
decision the bus-gated nudges, the overdue-follow-up persistence contract #700,
and the safety carve-out all route through). The send path still never reads the
bus (structural non-consultation is the stronger guarantee); the declared policy
is the machine-checked assertion of that —
`isHiddenUnderPolicy("safety-ungated", <any dismiss/snooze>, today)` is always
false, pinned in `lib/__tests__/lifecycle.test.ts` and end-to-end in the #673
notify-orchestrators harness. **The PRN redose notice
(`lib/notifications/redose.ts`, `runRedoseNotices`)** is a per-item, opt-in,
**administration-armed one-shot**: for each opted-in PRN med with CONFIRMED
`min_interval_hours`/`max_daily_count` (an unconfirmed/empty field ⇒ no notice,
ever — the liability line), the pure `redoseNoticeDecision`
(`lib/prn-redose.ts`) fires ONCE when the minimum interval elapses since the
latest logged administration, keyed by that administration's id in the
`notify_last_redose_<itemId>` marker (the `notify_last_*` discipline). It
**re-arms only on the next administration** (a newer id ≠ the marker) and is
**suppressed at the confirmed daily max**. It carries a "Log dose" button that
reuses the `/dose` `prn:` callback → `logAdministration` through the ONE
chokepoint (NOT idempotent — a dedup nonce + `logAdministration`'s short-window
guard), and sends via `dispatch()` so push mirrors the content-safe body (#692)
and the delivery marker folds like any other send. **QUIET-HOURS EXCEPTION
(deliberate):** unlike the episode nudges (refill/preventive/milestone), the
tick calls `runRedoseNotices` UNCONDITIONALLY — it is NOT gated by
`inWakingWindow`, and `redoseNoticeDecision` has no waking/hour input at all
(pinned by `lib/__tests__/prn-redose.test.ts`). A redose due at 3am is exactly
the overnight fever case, and it can only fire from a dose the user actually
logged, so nighttime delivery is the feature working, not spam. The DELIVERED
half of over-max — an administration count EXCEEDING the confirmed max — is a
separate **care-tier** finding (the `prn-max:<itemId>` Upcoming generator, the
\#148 UL-warning shape per-day), which IS bus-suppressible; only the redose
reminder itself is the ungated safety signal. Request-time engines (coaching, AI
insight) are out of this contract. **Two-way button principle (#233):** a nudge
earns an inline action button only when the expected response is ONE idempotent,
low-risk state change with an EXISTING server function (else deep-link) — the
time-correction chips are the one deliberate exception (#2206: a repeat tap
COMPOSES, and the row re-renders with the value each step stored, so "again"
means "further" rather than "undefined") —
preventive ✅ Done/🚫 Not applicable/⏰ Remind later route onto
`recordPreventiveDone`/`setPreventiveOverride`/bus-snooze — plus (#1083) a
**deep-link "go do it" button** carrying the concrete next action per class (the
SAME per-class link + CTA the Upcoming row shows, from `preventiveNudgeAction`
in `lib/preventive-upcoming.ts` — `<page>?screen=<INSTRUMENT>` for an
instrument, the prefilled biomarker/procedure add form for a lab/procedure, the
vitals quick-add for a vital, the Book path for a visit); the absolute URL is
built from `getPublicUrl()` and the button is omitted when no public URL is
configured (a relative URL can't be a Telegram button), while Web Push carries
the same link as its notification click-through
(`buildPushPayload`/`pushClickThroughUrl` in `push-core.ts`) and Home Assistant
forwards it in the payload's `links[]`, refill 📦 Ordered onto a
`refillSignalKey` bus-snooze (+ deep link; no amount-bearing "mark refilled"),
escalation ✅ Confirmed taken/⏭ Skip/👍 I'm on it onto `markDoseTaken`/
`markDoseSkipped`/an ack that sets the episode marker without logging the dose.
The ⏭ Skip (#1716) is the dose reminder's own precedent applied to the
escalation: a skip is a RECORDED DELIBERATE DECISION — distinct from silence —
written through the same `markDoseSkipped` core, so the ledger cannot tell an
escalation skip from a reminder skip, and the existing `skippedDoseIds` gate
ends the escalation loop with no marker of its own. Without it, "we decided not
to give it" forced a false confirm, an indefinite ack, or an app visit.
**A history correction never re-arms an escalation (#1933):** deleting a taken
dose log, or amending one onto a different date, leaves that day unconfirmed —
so the write core stamps the dose's per-day escalation marker for the day it
vacated, exactly as a real escalation or an ack would. The system may reduce
contact unilaterally and may never increase it off its own reading of state, and
a bookkeeping correction is not a request to be chased. The suppression is
per-DATE, so a correction to an older day cannot silence a genuine miss today. Payloads carry **ids only** (never
names — 64-byte limit, AUTOINCREMENT ids never recycle), every handler answers
from a **typed outcome union** (the `DoseTakenOutcome` pattern — never
unconditionally confirm; a stale/foreign tap gets the outdated-message
replacement), buttons are removed/replaced on consumption, and escalation taps
authorize by **chat id** (any chat the escalation fanned out to for that profile
— the managing logins' chats — OR the supplement's `escalate_chat_id`; anyone in
the caregiver chat may confirm, by design, #1072). **A refusal is never
SILENT (#1716):** an unresolvable/unauthorized profile used to `answerCallbackQuery`
with no text — the spinner stops and the tap LOOKS successful, which on the
safety tier means a caregiver believing a critical dose is confirmed when
nothing was written. Every refusal path now answers `OUTDATED_MESSAGE_TEXT`, the
callback-silence variant of the never-confirm-unconditionally rule (#232). Pure
parse/decide lives in `lib/notifications/callback-data.ts` (unit-tested); the
handler flows in `telegram-callbacks.ts`. **Channel chokepoint (#454):** every outbound Telegram
write — the tick's channel send, escalation's explicit-chat send, and the
callback edit/rebuild paths — routes through the ONE chokepoint module
`lib/notifications/telegram.ts` (`telegramChannel` / `sendTelegramMessage` /
`rebuildMessage` / `closeMessage` / `updateMessageKeyboard`), the sole importer
of the guarded raw primitives in `telegram-api.ts`
(`sendMessageRaw`/`editMessageTextRaw`/`editMessageReplyMarkupRaw`). The
chokepoint owns the four cross-cutting obligations so they can't diverge or be
forgotten per call site: **limits** (4096-char split + 100-button cap,
`telegram-limits.ts`, #379), **attribution** (the `[Name]` prefix via
`prefixForProfile` in `attribution.ts`, re-applied on a rebuild so it can't drop
the send-time label, #377/#429), **escaping** (`renderMessageHtml` in the pure
`telegram-render.ts`), and **delivery accounting** (a throw feeds `dispatch()`'s
marker fold). A source-scan test (`lib/__tests__/telegram-chokepoint.test.ts`)
fails CI if any other module imports those guarded primitives — a new sender
must go through the chokepoint. Messages that self-attribute in their body
(refill/preventive/digest/escalation) don't take the title prefix; only
dose/workout reminders (and their rebuilds) do.

**Telegram household dose round (#1459).** The cross-profile twin of the
scheduled dose reminder, for the caregiver standing at the breakfast table: at
the RECEIVING profile's own schedule slots, ONE message listing the
due-unconfirmed doses of the household members that profile explicitly
subscribed to, each with an inline confirm. Before it, household dose
confirmation existed only as a DESTINATION (the Household page's per-member
confirm buttons) while the Telegram reminder that actually reaches a caregiver
carries exactly ONE profile — so confirming the morning round meant navigating
to `/household` after all. **Subscription (§1).** Two `profile_settings` keys on
the RECEIVING profile (`household_round_enabled`, `household_round_members`) —
no schema change; `getProfileHouseholdRound`/`setProfileHouseholdRound`. The
bridge between per-profile Telegram targets and per-login grants is stated ONCE,
in `lib/notifications/household-round-access.ts`: **a member M is covered by R's
round iff at least one login whose OWN profile is R (`logins.own_profile_id`,
\#1013) currently holds WRITE access to M**, and M ≠ R. "Own profile" rather
than "any login granted R" is deliberate — the round is a push into the
RECEIVER's pocket, so it must be their account, else a co-parent with a read
grant on R could conjure a round about someone else's children. Access is read
through lib/auth's `accessForProfile`/`accessibleProfilesForLogin`, the SAME
functions the in-app cross-profile confirm gates on, so the Telegram round and
the Household page can never disagree about who may log for whom. The stored
member list is **data, not an auth check** (the ProfileScope stance): it is
re-validated against live grants at send time, again at button-tap time, AND
narrowed on write in the action (the form is client-side, so a posted read-only
or ungranted id is dropped three times over). A revoked member drops out
silently; a profile that is no login's own profile has no offerable members and
the settings card says so. **Composition (§2).** Rides the existing notify tick
and the receiver's slots with its OWN per-day markers
(`notify_last_household_<slot>`, on the receiver — the round is the receiver's
notification), so a receiver whose personal reminder already fired this slot
still gets the round. Each member's due set is computed in THAT member's own
context — `today(memberId)`, their timezone, situations, workout-conditioned
dueness, PRN exclusion — via the SAME `collectWindowDoses` + #1156 priority
floor the member's own reminder uses (#221: this module adds no dueness logic of
its own). This is the #1095 loop-composed case, NOT a `profile_id IN` reader.
Names are disambiguated (#534) before formatting; **an empty round sends
nothing**, and members with nothing due are omitted. Members' own reminders and
escalation are completely untouched — the round is additive. The PreWorkout
pseudo-slot is excluded (it is workout-relative to the RECEIVER, which says
nothing about another member's doses). **Buttons (§3).** Per-dose
`✓ <Member> · <Item>` actions grouped one row per member, tokens carrying **ids
only** under a new `hh:<receiver>:<member>:<dose>:<item>:<date>` kind — note the
date is the MEMBER's own profile-local day, so a round spanning two timezones
logs each dose against the right date. Past `HOUSEHOLD_ROUND_MAX_BUTTONS` (12)
the keyboard degrades to a single "Open Household →" deep link (a wall of taps
is a page, not a message); UNDER the cap that link now rides ALONGSIDE the
confirm buttons (#1718), because Web Push and Home Assistant strip the buttons
and their copies used to arrive naming members and items with no way to act. **STALENESS (#1719).** Each round sends a fresh message and every previous
round's keyboard stayed live forever, so a next-morning tap on yesterday's
surviving round logged a dose confirmation **to yesterday** — for someone else's
medication, in the surface built for caregivers. The food nudge has guarded
exactly this since #947; the round had neither half. Both halves now apply:
send-time **pointer rotation + strip** (`household_round_last_message`, the
chokepoint's own job since only it holds the sent message id and the guarded
edit primitive) so at most one live round keyboard exists per chat, and a
tap-time **date guard** (`tapDateGuard`, the ONE decision the food nudge also
reads) comparing the token's date against the MEMBER's today — a mismatch writes
nothing and answers honestly. A round is identified by its `hh:` tokens, never
by kind, since it shares `kind: "dose"` with the ordinary slot reminder. When a
round's members genuinely disagree about what day it is, each section header
carries its own date ("Ada — Tue 28"), so a caregiver can tell which "today" a
section means. The handler re-resolves access (chat owns the receiver → still
subscribed → grant still holds), applies the date guard, then calls the existing
idempotent `markDoseTaken(memberProfileId, …)` and answers from its typed
`DoseTakenOutcome`; each of the three refusals gets its own honest toast and
writes nothing — never an unconditional ✓. Only the tapped button is consumed (a
row is a MEMBER, so dropping the row would take their other doses with it).
**Safety (§4).** The message carries `kind: "dose"` deliberately (the #924
precedent) so it inherits the dose kind's safety-tier routing and per-login
toggle instead of minting a parallel kind: it is never bus-gated and never
quiet-hours-gated. **Missed-dose escalation is NOT aggregated into the round** —
folding a critical signal into a convenience digest could soften it — and the
`safety-ungated` carve-out stands untouched. A failed send folds into the
delivery-health marker like any other dispatch. Everything ships through the ONE
chokepoint. Split for testability: pure formatter + token
(`household-round-format.ts`, `callback-data.ts`), DB-touching builder
(`household-round.ts`) with a #448 two-timezone fixture test, access rule
(`household-round-access.ts`). Settings → Notifications carries the toggle, the
access-filtered member checklist and a send-test.

**The food nudge's keyboard (#682/#1016/#1073/#1075/#1807).** The nudge rides the
morning/midday/evening supplement slots and is opt-in per profile. Its keyboard is
the whole surface: `FOOD_NUDGE_BUTTON_COUNT` (6) top-ranked quick-log buttons two
per row — the SAME `rankFoodGroups` the `/nutrition` log bar calls (#221/#1980 —
one function, not two that claim to agree) — each carrying a day-total "(n)" suffix,
plus the reserved `__protein__`
pseudo-group's "💪 ＋Xg protein" button at its ranked position, over a day-total
"✓ Today:" tally line and the protein status line. Buttons are **not consumed**: a
tap logs one serving and the message re-renders from `buildFoodNudge`, the one
builder every send, tap-rebuild and reconcile goes through.

That "(n)" was slot-scoped until #2019, and stopped being so with the read-time
window derivation it depended on. The protein button's count is the one that cannot
come from the `food_log` day counter — the reserved key never lands there — so it is
counted off `food_log_events` (`getProteinTapsOnDate`) and merged into the same map,
which keeps ONE suffix rule for every button on the keyboard.

### The declared food timing becomes a live check (#2022)

Every dose declares a `food_timing`, and the reminder used to render it as a STATIC
LABEL: an 08:00 `with_food` reminder said "with food" into a morning where nothing had
been logged, even though the app holds both the declaration and the food ledger. It now
compares them, and adds ONE optional informational clause to the dose line's tail,
immediately after the label it remarks on:

| declared timing                 | ledger check (trailing window) | clause                              |
| ------------------------------- | ------------------------------ | ----------------------------------- |
| `with_food` / `with_fat`        | no serving within ~90 min      | `no food logged in the last 90 min` |
| `empty_stomach` / `before_meal` | a serving within ~60 min       | `food logged ~20 min ago`           |
| `any`                           | —                              | never                               |

**It rides the send; it is never the send.** No new message, no gate, no delay, no
escalation, no suppression — a dose reminder is a safety signal, so the ledger may
inform its text and nothing else. The dose stays due either way and `markDoseTaken` is
untouched: the same informational posture as the weather-med notes (#1727) and the
food–drug note beside it.

**It is phrased about the LOG, never the person.** Absence of a food log is weak
evidence — somebody may have eaten and logged none of it — so "no food logged" is what
the app knows and "you haven't eaten" is a claim it cannot support. The first clause
also names its own horizon, because "nothing logged" without one reads as a statement
about the whole day.

`lib/food-timing-check.ts` is the whole model (pure: the two windows, the truth table,
the wording), `getMinutesSinceLastFoodLog` is the single bounded ledger read, and
`gatherWindowDoses` joins them once per gather onto each `WindowDose`. Because the check
rides the GATHER rather than a renderer parameter, every surface built from those entries
— the dedicated window reminder, a merged multi-slot send, every tap rebuild — words the
same fact identically (#221). A gather for a PAST date carries no check at all: "in the
last 90 min" is a statement about right now, and pinning it to a day that has ended would
be a confident falsehood. `COALESCE(eaten_at, logged_at)` is where #2019 slots in
transparently — a stated eating instant beats a tap stamp, with no branch and no second
read.

### Time correction: `foodtime` / `dosetime` (#2019, #2020)

A one-tap button in a chat carries a contract — "I'm eating NOW", "I'm taking this
NOW" — so **the tap instant IS a measurement** of when the thing happened, with a
known error. Two things were missing: recording it, and a correction path for when
the contract is false because the tap was late.

**The capture.** A Telegram food tap writes `food_log_events.eaten_at` with
`time_source = 'tap'` (migration 154). `logged_at` is untouched and stays the audit
stamp migration 056 froze, and stays the ranking input. A write with nothing to
state — a web backfill — leaves `eaten_at` NULL, because defaulting to now would
reintroduce the guess under a more authoritative name. The web bar's own **Now /
Earlier…** chips (#2053, `lib/food-eating-time.ts`) are how that silence is broken
deliberately: they write `'stated'` for either shape, because the web "+" declares no
contract of its own, so the source of the instant is the person who said so. Online the
form carries the CHOICE and the server resolves it — a tab open for an hour cannot stamp
a stale "now"; offline the capture carries a resolved instant and the replay validates it
through the same `acceptEatenAt` gate, which is `resolveQueuedTakenAt`'s untrusted-client-
clock posture applied to eating time. On the dose side there is no
schema at all: `intake_item_logs.given_at` has carried the administration instant
since migration 041, and the PRN redose window already arms off it.

**The offer is a QUERY over ledger state**, never a memory of what some earlier
message rendered — which is why the rows survive a rebuild, a pointer rotation and a
restart, and simply appear on whichever keyboard is live. `lib/correction-time.ts`
holds the whole model, domain-blind, and `lib/notifications/correction-rows.ts`
renders it for both:

- taps within ~15 min collapse into a **burst**, because burst-mates share one error
  — dinner logged two hours late is off by two hours for all four servings;
- the row is `🕐 <name> <HH:MM> · <HH:MM · −30m> · <HH:MM · −1h>`, where the NAME
  button is the picker (a fourth button would shrink the row below legibility);
- 🕐 drills down to **absolute hours** — the past twelve, starting one hour past the
  last chip, three per row, plus `↩︎ Back` — the `symp:`→`symsev:` shape, except the
  quick-log buttons stay on screen so `↩︎ Back` can rebuild from the live keyboard.

**One vocabulary: every offer is an absolute local time (#2206).** A chip states the
instant it will store, with its offset as context — `19:11 · −1h`, not `−1h`. The
absolute value is the answer, `chipInstant` computes it once for both the label and
the write, and it is DST-correct by construction, which is exactly the case a relative
label gets silently wrong across a fall-back hour. Two chips rather than three, because
repeat taps reach the middle of the range and the absolute labels need the width.

**A chip counts back from the STORED instant, not the tap (#2206).** Repeat taps
COMPOSE: two `−1h` taps mean two hours back. That costs no new state — `eaten_at` /
`given_at` IS the ledger the row set is already a query over — so the chips still
survive a rebuild, a pointer rotation and a restart. It replaces the older idempotence,
which turned into the wrong answer once the row started showing its result: "tap again
to go further" is the only reading a visibly-moving value supports, and a silent no-op
would be the worst possible reply to it. Composition is race-safe without versioning
because each write resolves its base inside its own `IMMEDIATE` transaction, so a second
callback reads what the first committed. What bounds it instead is the **floor**: a chip
is only offered while its result stays inside the picker's own twelve-hour reach, and a
tap arriving off a stale keyboard past that point is REFUSED in words, never clamped.
Freshness stays keyed on the TAP — a correction is not a tap and must not renew its own
window — and nothing is stranded when the window closes, because every tap is a complete
committed write.

**The row states what the ledger holds (#2206).** The header used to name the burst by
its TAP time, which is precisely the value a correction replaces, so a corrected row went
on asserting the wrong time forever. It now reads `🕐 Salmon 19:11 (corrected)` — the
#1779 "a chat must not claim what is no longer true" rule applied to a displayed value
rather than to a button. No new machinery: the row set is a query, so every rebuild
re-reads it. The re-render only ever REDUCES what the message claims; it adds no button
and no new token.

The picker stays absolute-and-anchored-on-now so the stamp does not drift with the
seconds between rendering the keyboard and choosing an answer. An offered hour LATER
than the current hour resolves to **yesterday** — which is how the cross-midnight
re-date falls out of the same computation.

**The two domains differ in exactly one place.** A serving's day is a fact about the
serving, so a food correction crossing midnight moves the event's `date` AND the
`food_log` counter row with it, in one `writeTx`. A dose's day is **schedule-owned**
(#614), so `dosetime` moves `given_at` and nothing else, and the toast says so. The
dose correction also never re-runs the phantom-dose proximity guard (it runs at
INSERT time and a correction may legitimately move two administrations together) and
never re-arms an escalation (#1933) — it is a correction of history. It can only
move an instant EARLIER, so the redose window only ever becomes more conservative.

`foodtime`/`foodtimeat` join the `food` family and `dosetime`/`dosetimeat` the
`intake-dose` family in `RECONCILE_PREFIXES`. They are **not inert**: a chip claims
"these entries are still correctable here", which stops being true an hour after the
burst. The sweep strips them in one trailing edit per logging burst and then
reconciles to zero calls — and the same rule closes an **abandoned open picker**,
since a lapsed anchor drops out of the offer set and the plain nudge comes back. A
picker whose burst is still fresh SURVIVES the sweep's rebuild (`openPickerAnchor`
reads it back off the live keyboard, the way `countVisibleFoodButtons` reads back the
expansion), because reconciliation may reduce what a chat claims but must not change
what the user asked to see.

**Ranking does not editorialize (#1980, reversing #1822 item 5).** #1822 item 5
pushed CAPPED groups (the catalog's `limit` tier) below every floor group on this
keyboard, so "🍷 Alcohol" could not take an above-the-fold button. That shipped on
the Telegram path only and was **reversed by owner ruling**: a group you log often
is a group you need to log FAST, and demoting it made the app slower at capturing
exactly the intake a cap exists to measure. Position is a speed affordance, not a
verdict (#992/#716). `rankFoodGroups` — the ONE ranking function, which since #1980
serves the web bar and this keyboard from the same call and carries the #2019
proximity weighting for both — composes ONE stable partition over the blend,
`demoteExcludedGroups` (#975), the user's own choice. `demoteCappedGroups` is
deleted, comment and all, so the argument for it cannot invite a re-add. The `limit`
tier keeps its meaning everywhere else (targets, the inverted-cap reads, the web
bar's tier headings); it just never moves a button. The web bar ranks the protein
pseudo-entry too, from the same call.

**One label grammar, one protein line.** Every quick-log button leads with a glyph
(#1710); `PROTEIN_NUDGE_EMOJI` gave the protein button the one it was missing
(#1822 item 6), deliberately not a catalog group's glyph since it is the shake
path, not a serving. The status line reads
"🍗 Protein: 36 g+ so far · goal 80–105 g" (#1822 item 4): the same facts the
pre-#1822 "Protein · at least 36 g of ~80–105 g" carried — the #767 floor marker,
the band, the neutral #1710/#992 below-band tone — with the hedges unstacked so it
parses in one pass. `ProteinNudgeLineParts` still separates amount/band/status, so
the plain and emphasized renderings can differ only in emphasis.

That 6 is also the **page size** in both directions. "➕ Show more" (#1075) reveals
the next page and drops once every ranked key is out; "➖ Show less" (#1807) steps
one page back, clamped at the compact default so a stray tap bottoms out where a
fresh send starts rather than at an empty keyboard. They share one row — mid
expansion reads "➕ Show more · ➖ Show less", full expansion carries "➖ Show less"
alone — and "Show less" is rendered against the buttons ACTUALLY shown, so a short
ranked list can never produce a collapse button whose tap changes nothing.

Both directions are **stateless**: the tokens (`foodmore:`/`foodless:`, one parser
with a direction, the ⚙️ Tune shape) carry no count, because the expansion state
IS the rendered keyboard — `countVisibleFoodButtons` reads it back off the tapped
message. Both are declared **inert** in the reconcile registry: a view control
makes no state claim. That same derivation is what the #1779 sweep's food rebuild
uses (off the pointer's stored post-cap keyboard), so **expansion is the user's** —
a tick can neither collapse a keyboard someone expanded nor re-expand one they
collapsed.

There is **no deep link** on this nudge. The "＋ More…" url button to `/nutrition`
and its `deepLinkBase` plumbing were retired in #1807: the nudge's job is one-tap
logging in place, the ranked buttons plus "Show more" cover the real vocabulary,
and the long tail was not worth a keyboard row on every send. Other messages' deep
links (refill's "Open form", the household round's "Open Household →") are
untouched — this is a food-nudge ruling, not a policy against deep links.

**Strip and record are ONE decision (#1945).** A pointer rotation performs two
writes that must agree about the world: close the keyboard of the message the
pointer names, and record the just-sent message in its place. The food rotation
performed them under DIFFERENT conditions — strip whenever a previous pointer
existed, record only when the new message yielded a pointer — so a nudge whose
keyboard carried no `food:` quick-log token (the #1807 "Show less"-only shape, a
protein-button-only keyboard) stripped its predecessor and then failed to name
itself. The pointer went on naming the message just stripped, the next nudge
re-stripped that dead id (a swallowed "message is not modified"), and the
in-between message kept a live keyboard **nothing would ever close** — whose
tokens carry its send-time date, which is the whole reason #947 strips at all.
The reported shape was one slot stripped with its neighbours still live.

The ordering is now one pure decision, `planPointerRotation`
(`lib/notifications/pointer-rotation.ts`), shared by the food nudge (#947) and
the household round (#1719) so the two copies of the mechanism cannot drift
again. Its `skip` arm carries **no strip target at all** — "strip, record
nothing" is not a representable plan — and a send that yields no pointer leaves
the previous keyboard alone, which is correct: nothing superseded it. A network
edit and a settings write cannot share a transaction, so the execution order
carries the rest: the plan captures the strip target before anything is written,
then the chokepoint **records first and strips second**, so a settings-write
throw takes the strip down with it and a failed strip lands on a pointer that is
already right. Residual, unchanged: a rotation is still best-effort against
Telegram, so a strip that fails leaves one extra live keyboard until the #1779
sweep's date close reaches it (for the food nudge, the day boundary — #2018).

**Pointers read the DELIVERED keyboard.** Both extractors
(`foodNudgePointerFromMessage`, `isHouseholdRoundMessage`) scanned the uncapped
`msg.actions` while #1779's `recordPointer` re-derived the post-cap
`capTelegramKeyboard(messageKeyboard(msg))` that actually rides the wire, so a
nudge whose quick-log rows were dropped by the 100-button cap could record a
pointer describing buttons the chat never received. All three now read one named
derivation, `deliveredKeyboard` / `deliveredCallbackTokens`
(`lib/notifications/delivered-keyboard.ts`) — the same "re-derive, don't guess"
rule, in one place.

**The workout nudge's copy rules (#1672/#1673/#1709, amended by #1822).** Three
rules govern the message that fires on a day someone already trained:

- **One pace fact, one phrase.** `daysLeftPhrase` (`lib/effort-class.ts`) is the
  single days-left formatter, called by BOTH `workoutAcknowledgmentLine` and
  `recoveryOverrideLine`. `daysLeftInWindow` counts on-days AFTER today, so 0 is
  "only today left", never "with 0 days left" — which read as a closed door on the
  one day the nudge exists to save. Sharing the phrase is what stops the two
  formatters answering the same edge differently again (#221).
- **Lead with what they did, without praising a placeholder.** A named session
  keeps its praise ("Nice chest workout today"); a generic title
  (`isGenericSessionTitle` — "Workout", "Gym", "Training session") degrades to
  "Trained today". Either opening still leads with the session and never with the
  shortfall, which was #1672's whole point.
- **State the driver once.** The `← today` marker on the behind list is the #1709
  owner ruling, and #1822 amends it narrowly: when the acknowledgment headline has
  already named a target and its pace, `behindThisWeekLine` drops that target from
  the list (the whole line falls away if nothing else is behind). Every message
  whose headline does not name the driver renders exactly as before, suffix
  included.

**What the workout message may carry, and what marks it (#2015/#2016/#2017/#2002).**
Four rules, all enforced in the pure core so no formatter can re-derive them:

- **The core names its own drivers.** `NextWorkout.driverIds` lists the behind
  targets whose sessions the message actually names, derived from the rendered
  routine-gap items. `recommend.ts` passes it straight to `orderBehindTargets`,
  which now accepts a number or an array. It used to read the driver off
  `items[0]` — a FIXED order (cardio, then strength) while the title, focus and
  exercises all come from the strength half — so any day behind on both suggested a
  back workout and put `← today` on Cardio (#2015).
- **Both owed sessions are named.** When a cardio target and a strength target are
  both behind, the core returns two recommendations and the message reports both:
  strength leads (it carries the exercise list and the how-to deep link), the
  cardio half is one line (`cardioSessionLine`, from `WorkoutRecommendation.cardio`),
  and BOTH targets carry the marker. `digestWorkoutLine` appends a compact
  `+ cardio` for the same recommendation, so the 7am preview and the actionable
  prompt cannot disagree about how many sessions are owed (#2016).
- **Only targets this message can help you close.** `WORKOUT_TARGET_SCOPES`
  (`lib/workout-recommendation.ts`) is an explicit, reasoned allowlist of frequency
  scope kinds — `region`, `group`, `type` in; `practice`, `mobility_region`,
  `substance`, `food_group` out, each with its reason — applied at the source, to
  the `behind` set that feeds BOTH the scope pick and the rendered list. A wellness
  practice is out because it already has its own pace-aware `practice` nudge, and a
  second contact for one fact is what the attention doctrine forbids; it was also
  eligible to SCOPE a strength workout, since a practice names no region and so
  passed the recovery gate unconditionally (#2017). An unregistered scope kind is
  out by default, and the enum-parity test pins the registry against the
  `frequency_targets.scope_kind` CHECK so a new kind cannot join by omission.
  A kind may also narrow to specific VALUES: `type` admits only `strength` and
  `cardio`, because the third member of that vocabulary — `type:sport`, which the
  Training page offers today — resolves to neither picker, so it was listed as a
  deficit AND eligible to scope a strength workout that closes nothing (#2067).
  `isWorkoutTargetScope` takes both halves of the scope, and the completeness test
  now reads values as well as kinds.
- **Weather parking is disclosed here too.** `recommendWorkout` carries
  `parkedNotes` from the shared `parkedDisclosureLines` (`lib/weather-training.ts`),
  the same formatter `contextNotes` renders for the dashboard card and the Training
  overview. The nudge previously rendered none of it, silently swapping the indoor
  stand-in in for a parked ride (#2002). The rest reframe keeps both the cardio line
  and the disclosure out on purpose — a rest day pushes nothing.

**Display units in notification copy (#1019).** Notifications render
measurements in **canonical units (kg / km / °F)** — unit prefs are
per-**login**, notifications per-**profile**, so there is no pref to consult
(the weekly-recap comment made this stance per-file; it's policy now). The ONE
exception: **safety-critical temperature renders dual-unit** (`fmtTempDual`,
"38.5 °C / 101.3 °F") — the temperature red-flag nudge passes `"dual"` into
`tempRedFlagFindingFor` so a mixed-preference household reads a fever number
correctly either way. Web surfaces always follow the viewer's login pref
instead. Full policy (including the identity/cited-text rules):
`docs/internals/findings.md` § "Display units on finding surfaces".

**Finish-triggered post-workout nudge + stale-session suggest (#921).** Two
nudges ride derived **workout presence** (`workoutPresence` /
`getWorkoutPresence`, `lib/workout-presence.ts` + `lib/queries/presence.ts`) —
the ONE computation that reads a session as `active` / `finished` / `idle` off
existing `activities` rows (no new tables), shared with the app-wide workout
dock, the household presence chip, and the rest-coaching tense.
**`runPostWorkoutFinish` (`lib/notifications/workout-presence.ts`)** is the
flagship: the moment a session transitions to `finished` (its end instant inside
the 60-min trailing window; imports also freshness-capped on first-seen so a
delayed bulk sync about this morning's run can't fire evening nudges), it
delivers the due, unresolved `post_workout` supplement doses IMMEDIATELY instead
of waiting for the next scheduled `supp_<W>` slot. It is a **dose reminder =
SAFETY tier**: NOT bus-gated and NOT waking-gated (it's timed to a real event,
exactly as the scheduled slot is timed to a real hour), a **one-shot per
activity id** (`notify_last_post_workout_<activityId>`, an id-keyed marker,
\#203-safe, stamped only on delivery), and **only-when-pending** (a finish with
every post_workout dose already logged sends nothing and does NOT burn the
one-shot). `isPostWorkoutReady` stays the dueness truth — this changes DELIVERY
timing only, and the scheduled slot remains the fallback when a finish was never
observed. The 60-min finished window guarantees even an hourly tick observes every
finish exactly once. **`runStaleWorkoutSuggest`** sends ONE gentle "Still
working out? Finish or discard" note when an `active` session's draft has gone
quiet past `STALE_MIN` (45 min) — suggest-only (#560), never auto-ends, one-shot
per activity id (`notify_stale_workout_<activityId>`), waking-gated (a soft
coaching suggest, not a safety signal). **Actionable finish (#1205):** the nudge
now carries a **🏁 Finish workout** and **🗑 Discard** inline button alongside
the "Open workout" deep-link (the two-way principle — ids only:
`wofinish:<profileId>:<activityId>` / `wodiscard:<profileId>:<activityId>`; the
callback resolves activity→profile against the chat like every other family-chat
button). Finish stamps `end_time = now` through the SHARED, auth-blind
`finishWorkoutSession` core (`lib/workout-finish.ts`, the same core the
request-path `finishWorkout` action uses) and **transforms this message in
place** into the #924 post-workout-dose summary — the SAME
`renderPostWorkoutFinishMessage` the tick sends (#221), with its take/skip dose
buttons, or a plain "Workout finished ✅" when nothing is pending — while
setting the `notify_last_post_workout_<activityId>` finish marker as delivered
so the tick sends NO second notification. The handler answers from a
typed outcome union (`finished` / `already-finished` / `empty-draft` /
`not-found`) — a re-tap on an already-finished session says so (no false
confirm, no re-edit surprise), an empty draft keeps its buttons so the user can
Discard, and Web Push / Home Assistant (no stateful callback) fall back to the
"Open workout" deep-link + the normal separate #924 dispatch. All edits ride the
`telegram.ts` chokepoint (re-applying the shared-chat `[Name]` prefix).
**Reminder-collision presence gates — revisited and shipped (#981):**
presence-as-a-send-gate was DECLINED in #921 ("revisit if it annoys in
practice"), and it did — the slot fired MID-workout and, once #921's
presence-aware tense fix shipped, its rest line even read "you're training now".
The revisit trigger hit, so `recommendWorkout` now consults the ONE derived
`workoutPresence` (never a second derivation, #221) through the pure
`workoutPresenceGate` (`lib/workout-presence-gate.ts`) over the SAME tracked
target scopes the nudge already reads: (1) **`active` ⇒ HOLD** — a live session
is running (the #837 illness-hold shape: null holds the slot out of the send AND
the daily `notify_last_workout` marker, so a discarded false start doesn't
consume the day); (2) **a credit-bearing finish inside the finished window ⇒
SKIP this attempt** — the finish/recap message (#924) owns that moment, but
STRICTLY window-scoped and marker-neutral, so a dog walk crediting a "walk
5×/week" habit quiets only this one attempt, never the day's lift reminder, and
the next scheduled attempt evaluates fresh. "Credits a tracked scope" reuses
`getFrequencyTargetProgress`'s scope rules (`getFinishedActivityCredit`,
`lib/queries/presence.ts`), so a finish crediting NOTHING tracked (a synced walk
with no walking target) still fires — type-awareness comes from target SCOPING,
not from "did anything finish", and a generic finish never holds. Both gates are
marker-neutral by construction (the tick marks the slot only on a delivered
message); the pure gate matrix + finished-window boundary is pinned in
`lib/__tests__/workout-presence-gate.test.ts`, the marker-neutrality end-to-end
in `lib/__db_tests__/workout-presence-gate.test.ts`.

**Pace-aware wellness-practice nudge (#1259).** A wellness-practice frequency
target (scope_kind `practice` — red light, sauna, meditation, …) with a min–max
weekly RANGE gets a coaching-tier, BUS-GATED reminder built by
`buildPracticeReminder` (`lib/notifications/practices.ts`): it fires ONLY when
the target is behind its FLOOR late in the week (the workout-nudge pace pattern
— `shouldNudgePractice`/`behindPractices` over `getFrequencyTargetProgress`, one
computation with the Upcoming `practiceItems` twin), is QUIET on-pace, and is
SILENT at/above the CEILING (a dose-limited practice is never pushed toward
more). It is DELIBERATELY never safety-tier (a missed red-light session is not a
missed medication) and rides the shared suppression bus keyed by the SAME
`practice:<targetId>` `dedupeKey` its Upcoming twin carries
(`practiceSignalKey`, `lib/practice.ts`) — dismiss the Upcoming item once and
the push goes quiet too, with the daily `notify_last_practice` marker frozen
(set only on a delivered message, the #227 discipline). It is waking-window +
once-per-day gated and only sends where Telegram is deliverable (the defining
feature is the button; a practice target exists only after the user creates one
on Wellness or through a protocol — that IS the opt-in, and Stop tracking removes
the target without erasing its session ledger). A target owned only by ended
protocols is historical and therefore excluded from this active progress/nudge
gather.

**Rhythm retiming (#2188).** A behind practice with an inferred weekly rhythm —
`inferPracticeSchedule` (`lib/queries/wellness.ts`), the `inferWorkoutSchedule`
shape over `practice_logs` via the shared core in `lib/weekly-rhythm.ts` — is
HELD inside `behindPractices` for its next predicted day and released at its
typical hour, waking-window clamped (`practiceNudgeReleased`,
`lib/practice.ts`). The refinement only ever moves the send LATER within the
week and never adds one: a hold day is a day the daily-while-behind rule would
also have fired on, and once the week's last predicted day passes while still
behind, the flip-day rule is back so the week's nudge is never silently lost
(rolling week mode treats every day as the last). No pattern → released
unconditionally, byte-for-byte today's behavior (#558: unknown is never "every
day"). Predicted ≠ due (#1505): `frequencyPace` remains the only dueness
authority, and the bus gate, per-day marker, and ceiling silence are untouched.
The same inference feeds the calm "usually a session day" note on the
protocol/practice cards (rendered surfaces, quiet without a pattern), and the
nudge line may name the rhythm ("usually Mon/Wed/Fri") — data, not advice.
**Every one-tap practice log now records what it shows (#2204, owner ruling).** The
inline duration stepper is on all four practice affordances — the quick-log
sheet, the Wellness card, the protocol detail card, and the dashboard's
Active-protocols widget — each rendering `practiceDurationPrefill` over the
practice's last LOGGED session. `LogPracticeButton` routes the stepper's render
and the tap's write through ONE `stepperShown` expression, so no surface can
post a duration that is not on screen. The expanded modal survives where it
already was (`showDetails`): it owns the past date, the corrected time and the
notes, and the objection it answered was always about stacking a modal over a
one-tap surface, never about the field.

**The one-tap paths feed that inference now (#2204).** `logPracticeSession`
treats an OMITTED `time` as "the caller is a tap, stamp the profile-local
instant" — distinct from an explicit `null`, which stays the expanded form's
"this session has no instant". Until #2202 nothing read `practice_logs.time`, so
the quick sheet and this Done ✓ button both wrote null; once `modalHour` became
its reader that inverted into a defect where the fastest logging paths starved
the inference that reschedules their own nudge. The stamp is bounded to the
profile's today, so a backdated correction never acquires a fabricated instant. Each behind practice carries an inline
**"Done ✓"** button (`pdone:<profileId>:<targetId>:<token>`, ids only) that logs
one session for TODAY through the shared write core (`logPracticeByTargetId` →
`logPracticeSession`); the handler answers from the typed `PracticeLogOutcome`
(never an unconditional confirm — a session log is NOT idempotent, multi-session
days are supported) and CONSUMES the tapped button (siblings survive) so a stale
message can’t double-log.

**The right-sizing ride-along (#1670).** When a practice's shortfall has been
CHRONIC — every one of the last four completed weeks under its floor — this same
message carries one extra **"⤓ <name> → N×/wk"** button
(`rslower:<profileId>:<targetId>`, ids only) offering to lower the weekly floor to
the cadence actually kept. It is the entire push presence of the frequency-target
right-sizing engine: **no message is ever sent because of a suggestion**, and a
target that has stopped generating this nudge simply has no delivery path, which
is correct rather than a gap (the ride-the-nag rule,
`docs/internals/findings.md` § the attention doctrine).

Three properties: the token deliberately does NOT carry the new floor — the
handler (`handleRightSizeLowerTap`) re-derives the live candidate and writes
through the same `lowerFrequencyTargetFloor` core the in-app card uses, so a stale
button on a practice whose cadence recovered refuses with a typed outcome instead
of shrinking a commitment nobody is suggesting shrinking; the write is DOWNWARD
and user-initiated, the two properties that make it (like the ⤓ May tap) safe for
the notification layer to perform at all; and the button is governed by DETECTION
STATE ALONE rather than the suppression bus — an in-app dismiss means "keep asking
me about this practice", a statement about the card, not about whether a message
already being sent may offer relief.

**Recap-led finish nudge (#924).** `runPostWorkoutFinish` now OPENS with a
one-line **session recap** ("Push day done · 47 min · 14 sets · Bench press PR ·
all targets hit"), then the due post-workout supplement section. The composition
(`composeFinishNudge` / `recapNudgeLine`,
`lib/notifications/workout-recap-format.ts`, both pure) is: **recap line** —
gated by the new `workout-recap` NotificationKind, which is ONE row of the #928
kind×channel matrix (`TOGGLEABLE_NOTIFICATION_KINDS`, on by default; zero new
settings surface). `runPostWorkoutFinish` includes the line unless workout-recap
is turned OFF on EVERY profile-scoped channel (Telegram + Home Assistant, via
`isKindEnabled` over each channel's disabled-kinds); the login-scoped push
channel gates its own copy at dispatch. The line is ALSO gated by there being
real strength working sets (a pure-cardio/freshly-synced-import finish yields no
recap line, so #921's dose-only behavior is unchanged and a "run done" note
can't spam); **supplement section** — the existing dose reminder, gated by
dueness. **Either alone still sends; both absent ⇒ no send** (and the one-shot
marker is not burned). A combined message keeps the dose message's
`kind: "dose"` so its SAFETY-tier routing/actions are preserved; a
**recap-only** message is classified `kind: "workout-recap"`. The recap line
comes from the ONE server-side `getSessionRecap` gather
(`lib/queries/session-recap.ts`) over the pure `sessionRecap`
(`lib/session-recap.ts`) — the SAME computation the finished-window dashboard
card and the live "Session complete" step render, so the three surfaces can't
drift (#221). Everything still routes through the Telegram chokepoint with the
usual delivery accounting. **Weekly-remaining line (#981 §3, corrected by
\#1122):** the recap line gains a forward-looking, pace-framed status leading
with the target the session just advanced ("Legs — 1 of 2 this week, one more to
go"; calm all-met line when every workout target is met; omitted otherwise),
computed by `weeklyRemainingLine` as a **workout-scoped FORMATTER** over the
SAME `getFrequencyTargetProgress` rollup (#221). Two #1122 fixes over the
original "N of M met" tally: it (1) SCOPES to workout-affectable targets
(`region`/`group`/`type` only — `food_group`/`mobility_region` dropped, since a
barbell session can't move veg-servings or mobility days, which is how it read
"0 of 4"), and (2) reports PACE via each target's `count`, not the
all-or-nothing `met`, so a session that rarely _completes_ a 2–4×/week goal
still reads as progress. It rides WITH the recap line inside the congratulatory
message where its tone is natural — which is what makes #981's silent
reminder-skip (rather than a softened second ping) correct: one moment, one
message.

## Bedtime wear reminder (#2161)

**The one consented send in the quiet-stream family.** A watch left on the
charger as bedtime approaches costs a whole night of sleep data that no later
sync recovers — on the measured 56-day profile it happened once in eight weeks
and was that profile's only missing night. #2146 detects and RENDERS that state
and is deliberately never-a-send; its constraint 4 reserves contact for "a
separate consented feature", and this is it.

**Why it may be a class-1 send at all.** Sleep and HR are observation domains
(`docs/internals/findings.md` §3), so no obligation exists to hang a send on.
The contact-consent rule permits a contact INCREASE only behind a user-owned
declaration, so the declaration IS the feature: `wear_reminder_enabled`
(`profile_settings`, off by default), rendered as one row of the Settings →
Notifications kinds matrix. Two properties are enforced, not merely intended:

- **Off is byte-for-byte today's behaviour.** `bedtimeWearVerdict`
  (`lib/wear-reminder.ts`) checks consent FIRST and returns before any other
  signal is read; `bedtimeWearReminderState` pays one settings read and stops.
- **Nothing enables it but a user action.** `saveNotificationPrefs` is the only
  writer. A detected lost night may SUGGEST turning it on — the right-sizing
  family's shape, detection suggests and the tap writes — but no detector, tick,
  or gather may perform the write.

**The predicate** is #2146's quiet-stream shape at a bedtime-sized tolerance:
the declared continuous stream has been silent for ≥ `WEAR_QUIET_TOLERANCE_MIN`
(40 min, declared — never learned from a wear pattern) **while the provider kept
syncing ok in that window**. The second clause is load-bearing: continuing ok
syncs with nothing on the stream is the off-wrist signature, whereas a window
with no ok syncs is a CONNECTION outage that #1685 already owns and names — two
rows for one fault is exactly what the one-row rule forbids. The declared stream
is Health Connect's `hr_minutes`, the only continuous wear stream the app
ingests (the Fitbit Takeout archive import has no live cadence to be silent
against and is exempt by construction). #2146 moves that declaration into the
provider registry beside `staleAfterDays` once a second provider needs one.

Two gates sit in front of the predicate. The **expected-active** gate is the
SHARED #2097 vocabulary — `isSleepTracking` over `getSyncedSleepWakeDays` — so a
profile that does not wear a device to sleep is never reminded even when the
setting is on, and a manual-only sleep logger never hears from it at all. The
**deference** gate yields to a failing or `needs-reauth` provider through the
same `getIntegrationAttention` model every other surface reads: a reconnect item
already owns that contact, and "still on the charger?" would be false advice
while the pipeline is down.

**Send hygiene.** It rides the profile's existing **Bedtime** supplement slot
minute (no schedule of its own), through the tick's ordinary `dueSlots` loop, on
one declared per-day marker `notify_last_wear_reminder` (`profile-fixed`,
`profile_settings`, swept by the standard date rollover). One send per night, no
escalation, no repeat; ignoring it does nothing further and the morning surface
is #2146's calm row. The cadence is the tick's per-day marker discipline rather
than `planNudgeCadence`: there is one profile-fixed key with no subject to
strand, so there is no candidate set to freeze and no self-healing sweep to run.
A skipped night leaves the marker UNSET, so it never spends the night's send.

**Timestamps.** The gather joins two of the three coexisting conventions
(#94/#1333/#2146 constraint 6): `hr_minutes.ts` is profile-local bare,
`integration_sync_events.at` is UTC bare. The stream's wall time is converted
once through `zonedWallIsoToUtc` and everything is compared in UTC from there —
reading `hr_minutes.ts` as UTC is the #2096 failure class, and subtracting two
bare local strings would report wall-clock difference rather than elapsed time
on a DST night.

**The precondition is named, never guessed.** The reminder's entire schedule is
the Bedtime slot minute, and that slot is independently switchable — someone who
takes nothing at bedtime turns it off — so consent plus a disabled slot is a
reachable state in which the checkbox reads ON and nothing can ever send. A
checkbox that says on and does nothing is the worst failure a settings page has,
and worse still for a consent. The fix is at the SURFACE: `ridesSlots` on the
kind registry entry declares which slot(s) a scheduleless kind fires at,
`unmetSlotRequirement` is the pure predicate, and the row renders a note naming
the missing slot and pointing at the Schedule card above it. The checkbox stays
editable (a consent must always be withdrawable, and turning one on before
setting a time is a legitimate order to work in). Deliberately NOT a fallback
hour in the tick: guessing a bedtime for a send the user consented to at _their_
bedtime is a worse answer than saying what is missing. The mood check-in
(Evening) and the food nudge (Morning/Midday/Evening) declare the same field and
get the same note — the defect was never unique to this kind.

**Known grain limit, accepted.** The check runs at the slot minute, so a charger
placement a few minutes before a late bedtime is missed. #2121's finer ticks and
a `typicalBedTime` anchor tighten it later; neither is a dependency.

## Send markers and nudge cadence (#2036)

**The `notify_last_*` discipline is a registry now, not a convention.**
`lib/notifications/send-markers.ts` holds `SEND_MARKER_REGISTRY`: one entry per
`notify_*` settings key the app writes to remember that something was already
sent. Each entry declares its tail **shape**, its **class** (`id-keyed`,
`catalog-keyed`, `anchored`, `slot-keyed`, `profile-fixed`,
`name-keyed-swept`, `legacy`), its **cadence** (`per-day`, `per-episode`,
`one-shot`, `repeat-n`, `watermark`, `retired`), the settings **tier** it lives
in, which module **writes** it, and its **retention** — the sweep that clears
it, or, in writing, why none is needed. Companion `NON_MARKER_NOTIFY_KEYS`
records the `notify_`-prefixed strings that are schedules, preferences, login
flags or table names instead.

Why the registry exists: a marker keyed on something recyclable, or never swept
after its subject is deleted, is a silent wrong-cadence bug — either a nudge
that never fires again or one that fires for a subject nobody asked about. That
is the class `DISMISSAL_KEY_REGISTRY` (#1931) made unshippable for suppression
keys; this is the same shape for the send side.

**The teeth** (`lib/__tests__/send-markers.test.ts`): a source scan over `lib/`
and `scripts/` collects every `notify_…` string literal and template-literal
prefix, ignoring comments, and requires each to resolve to a declaration. It
also asserts agreement with `lib/dismissal-classes.ts` — every `notify_` prefix
that registry excused as "not a dismissal" must be a real send marker here, and
no key may be both.

A key whose tail is interpolated from a free-form variable is invisible to any
scan, which is how four namespaces stayed unregistered. Those now mint through
declared builders in the same module — `foodNudgeMarkerKey`,
`intakeSlotMarkerKey`, `TICK_SLOT_MARKER_KEYS`, `DIGEST_MARKER_KEY`,
`WEEKLY_RECAP_MARKER_KEY` — over closed, typed slot vocabularies.

**One cadence decision, four planners.** `planNudgeCadence`
(`lib/nudge-cadence.ts`) is the pure "given what has already been sent, what is
live, and what the user silenced, which nudges go out and which stale markers
get swept" answer. Its three rules are: **send** a live, unspent, unfrozen
candidate; **freeze** — neither send nor clear — a candidate the user dismissed
or a booked visit covers, so un-dismissing resumes the lifecycle rather than
restarting it (#227/#183); **sweep** a marker whose subject is no longer live,
self-healing because the caller passes the FULL live-marker set rather than the
candidates' keys (#325). `planRefillNudges`, `planPreventiveNudges`,
`planIllnessCareNudges` (which the temp-red-flag nudge shares outright) and
`planFollowUpNudges` are thin adapters over it; each keeps its own vocabulary,
outcome shape and ordering. The one axis they differ on is declared per call
site: `frozenBlocksClear`, true only for the preventive/illness-care family,
because dropping a covered rule's marker would let a later un-cover re-nudge the
SAME episode.

None of this moves policy. Dose reminders and missed-dose escalations do not
route through the cadence planner and never did — they are safety signals an
Upcoming dismissal may never silence, and registering their bookkeeping changes
only the census.

### The cadence boundary is declared (#2089)

The extraction above says what the shared engine decides. It did not say where
its jurisdiction **ends**, so every family outside it carried private cadence
code with no way to tell "this was decided" from "nobody looked" — the state
#2033 billed us for, when the workout nudge decided its driver privately and got
it wrong.

`lib/notifications/cadence-registry.ts` closes that: `KIND_CADENCE` declares,
for **every** `NotificationKind`, what owns its cadence — either
`nudge-cadence` (naming the adapter module) or one of the exemption owners, each
with a written reason:

| Owner               | What decides the send                                                                    | Families                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `nudge-cadence`     | `planNudgeCadence` — episode opens, one (or N spaced) sends, marker swept when it closes | refill, preventive, illness-care, followup                |
| `user-schedule`     | a schedule the user configured; a per-day marker only stops a double send within the day | dose, digest, weekly-recap, workout, food, mood, practice |
| `item-clock`        | a per-subject clock: the PRN redose interval, the missed-dose escalation ladder          | escalation, redose                                        |
| `per-subject-event` | one send per subject, id-keyed; the subject cannot happen twice                          | workout-recap, workout-stale, ease-back, milestone        |
| `on-demand`         | the user's own request, one second earlier                                               | prn-list, symptom, temp, test                             |
| `not-dispatched`    | nothing mints the kind                                                                   | upcoming, other                                           |

The exemptions are the point, not an admission. `planNudgeCadence` answers one
question — when does an **episode** nudge repeat, and when is its marker stale?
Most families have no episode: a digest is a scheduled composition, a dose
reminder is a slot the user wrote, a milestone is an announcement of something
that happened once. The two the #2089 survey flagged as candidates —
**mood check-ins** and **practice nudges** — are declared `user-schedule` for
that reason: their cadence is one profile-local day, their marker re-arms at
midnight whatever the subject does, and nothing is ever spaced off a first send
or swept. Mood's auto-pause is a contact-consent mechanism (#992/#1668), not an
episode lifecycle.

**The teeth** (`lib/__tests__/cadence-registry.test.ts`): membership is total
over `ALL_NOTIFICATION_KINDS` and no entry is stale; every reason is real in
both directions; a member's declared `planner` must be a module that genuinely
calls `planNudgeCadence`, and the set of such modules must be **exactly** the
declared set — so a fifth domain adopting the engine cannot ship without joining
the declaration, and a declaration cannot claim an adapter that does not exist.
A safety kind may never be declared a member: the planner's freeze rule is a
suppression-bus lookup, and putting that between a person and their medication
is the one policy that must not move.

## The tick has a memo of its own (#2118, #2111)

**A tick is not a request, so `cache()` does nothing in it.**
`lib/request-cache.ts` degrades React's `cache()` to identity outside a Next
server request — deliberately: the plain `react` package a tsx entrypoint
resolves has no `cache` export, and a memo with no request to bound it has no
honest lifetime. The consequence is that the hourly tick had **no** memoization
anywhere, and the same profile's heaviest reads ran several times per tick.

Two were measured. `assessProfilePreventive` — which merges manual and inferred
satisfactions, overrides, smoking history and the whole `getRiskFactors` gather
— ran from the nudge planner, from the digest's `collectUpcoming`, and again
inside the reconcile sweep **once per live preventive-carrying pointer**.
`getMedicationFamilyStates` — the #1027 cross-item PRN safety state — ran from
the redose notice, the digest's over-max finding and the quick-log gather.

**`lib/tick-cache.ts` supplies the missing lifetime.** `runInTickScope` opens a
scope, `tickCached(name, keyOf, fn)` memoizes inside it, and outside a scope the
wrapper is a plain passthrough — so a DB test, a `manual` send and the `poll`
loop all compute every call, exactly as before. `scripts/notify.ts` opens one
scope per profile, around `tickProfile`. Both gathers are wrapped in `cache()`
**and** `tickCached`, so a render and a tick each get the memo whose lifetime it
can justify.

**Why not a TTL memo**, the `tzMemo` / schedule-history (#2066) shape. That
shape is right for a value whose miss "degrades to the documented fallback,
never a wrong answer". A medication-family state is not such a value: stale, it
reads LOW, and a low count is the "you may redose" false GO the family gather
exists to prevent. So the lifetime here is not a duration but a **scope**, held
by the one caller that can promise nothing inside it writes what it reads —
`tick()` sends messages and writes `notify_*` markers, while dose confirms,
preventive satisfactions and overrides arrive through Server Actions and
Telegram taps, i.e. the webhook route or the sidecar's separate `poll` mode.
A scope closes with its profile, throw included, and the next one re-reads.

**The teeth** (`lib/__db_tests__/tick-scoped-gathers.test.ts`): a realistic
profile tick is driven with the statement counts of each gather's own signature
recorded — 5 preventive assessments and 3 family gathers unscoped, exactly 1
each scoped, with the verdicts asserted equal either way. The lifetime is pinned
in the same file: a sibling scope re-reads, a throwing tick still closes its
scope, and the within-scope snapshot is asserted outright, so a future tick step
that DOES write one of these inputs fails there rather than silently reading its
own stale answer.

Migration 156 belongs to the same fix: the family's arming-administration read
carries no date bound (the interval clock is armed whenever the last dose was),
and on the baseline indexes it scanned the whole append-only dose ledger and
sorted the survivors. `intake_item_logs(item_id, given_at)` turns that into a
seek. The `(item_id, date)` alternative was measured and deliberately not
shipped: the date-shaped reads all pin one day, so `idx_intake_log_date` already
bounds them to a set that stays flat as history grows.

## Overdue safety-follow-up escalation (#1866)

**The overdue finding follow-up (#700) pushes — with zero settings and a
per-item off-switch (owner ruling 2026-08-01).** `runFollowUpNudges`
(`lib/notifications/followup.ts`) rides the notify tick (waking-window, assessed
once per profile-local day — overdue-ness is day-granular, and an escalation
about something already months late earns no 3am delivery) over the SAME
`followUpItems` computation the Upcoming page and Needs-attention hero render.
The consent question is answered by structure, not by a toggle: the user (or
their accepted extraction) recorded the follow-up as a tracked care item **with
a due date**, which is the same declaration shape that lets a `must` medication
remind without a "remind me about medications" setting. Accordingly the
`followup` kind is **NON_CONFIGURABLE** (no registry row, no matrix
row — the reason is data in `NON_CONFIGURABLE_KINDS`), and delivery is governed
entirely by the channels the user already enabled: no channels, nothing new
happens.

- **Conservative cadence, owned by a pure planner**
  (`planFollowUpNudges`, `lib/followup-nudge.ts`): ONE send when the follow-up
  crosses overdue, ONE repeat `FOLLOWUP_REPEAT_DAYS` (21 days) later that says
  out loud it is the final message, then nothing further, ever — the finding
  keeps holding Upcoming and the hero, which never age out. The
  `notify_last_followup_<carePlanItemId>` marker stores the send DATES
  (comma-joined), so the whole cadence state is one value, stamped only on a
  delivered send (#227 discipline) and swept when the follow-up leaves the
  overdue set (#325 self-heal). Ids are AUTOINCREMENT and never recycle (#203).
- **A third suppression shape: policy-gated, not bus-gated and not ungated.**
  The send gate is `isHiddenUnderPolicy` under the item's OWN declared policy
  (`itemSuppressionPolicy` → `snooze-only` for an overdue follow-up, #700 ask
  5 / #942), keyed by the IDENTICAL `followup:<id>` dedupeKey the visible
  finding carries. So the push behaves exactly as the page does: an Upcoming
  **dismiss is RESISTED** — it can never silence this send (the safety posture
  the issue requires) — while a deliberate time-boxed **snooze defers** it with
  the cadence marker frozen, resuming where it stood when the snooze expires.
- **The per-item TERMINATOR is the only permanent off-switch** (the real
  control, per the ruling): `settleFollowUpCore` records "done on \<date\>" or
  "discussed, not doing it" (optional reason) onto the chain node (migration
  141), which removes it from the builder's output entirely — the escalation
  ends because the question is answered. A declined follow-up never sends
  again, including across marker sweeps and re-ticks; deliberately re-tracking
  the same source creates a NEW chain node (a new tracked due date = a new
  consent) with its own fresh cadence.
- **Channel honesty (#1718):** the copy names no button any channel strips —
  the message states the fact ("Was due 2026-03-15", the source-finding detail)
  and carries a single "Open Upcoming" url action (the push click-through),
  because the terminator needs a date/reason and therefore belongs on the
  surface, not in a callback keyboard (the two-way button principle: no ONE
  idempotent state change to offer). Sends go through `dispatch()` like every
  builder — delivery-health marker fold included — and any Telegram write rides
  the one chokepoint.

**Morning digest (one merged message, #1108).** The tick sends ONE summary per
profile per day at `digest_hour`, hard-deduped by the single
`notify_last_digest` marker. Sections in order: **Illness** (open-episode
headline) → **Today** → **Yesterday** (activities/adherence/weight) → **Sleep**
(#1117; ON by default when the digest is enabled as of #1378 — an opt-OUT
toggle, `getProfileSleepDigest` reads absent-means-on, a stored `"0"` still off,
and the freshness + no-data gates in `gatherDigestSleep` are unchanged so a
profile with no fresh sleep still sees no section) → **New** (newly-flagged
biomarkers + documents). The **Today** section is a formatter over
`collectUpcoming` (the SAME banded aggregation the Upcoming page/hero read): a
dose-count glance headline plus the `groupUpcoming` band summaries +
high-priority "why" highlights (#656), with the `dose` domain excluded from the
band counts (the headline summarizes them). Because it reads `collectUpcoming`,
the morning message inherits the findings-suppression bus (a page dismiss/snooze
silences the digest too — the #221 one-computation guarantee) and the #558
predicted-training-day dose dueness. **Derived-situation acknowledgment
(#1292/#1298):** the Today section also carries the SAME basis-aware state lines
the Supplements bar + check-in disclosure show ("Rough night (…) — N
sleep-support items active today (auto)"; "Period logged — N items active"), via
the ONE shared `getDerivedSituationLines` formatter, so a Telegram-first user
isn't surprised by the extra due items a derived Poor sleep / Period context put
on the list (the digest's dose dueness reads `getEffectiveActiveSituations`,
declared ∪ derived). The separate "what's due" upcoming digest and its
`notify_last_upcoming` marker are **retired** (migration 093 sweeps the dead
key); the `upcoming` NotificationKind is retained in the type union /
`parseDisabledKinds` for back-compat but is no longer a toggleable matrix row —
the single `digest` kind governs the merged message.

**When the digest sends, and the one hour it will wait (#2102).** Two separate
decisions, both pure in `lib/notifications/digest-schedule.ts`:

- **`auto` resolves past the ARRIVAL, not the wake.** An `auto` digest time used
  to resolve to the hour the person WAKES — while the sleep row lands a measured
  ~70 minutes behind waking (real Health Connect profile, 11 nights, wake 05:40,
  arrivals 06:02–07:49). The old whole-hour rounding compounded it: `round(340/60)`
  is 6, so the digest fired at 06:00, before all eleven arrivals and an hour worse
  than the manual 07:00 it was meant to improve on. `digestAutoMinute` now
  resolves to the first MINUTE strictly after the measured arrival p90 (#2121
  deleted the round-up-to-the-next-hour along with the rounding defect). Below the
  sample gate it returns null and the caller falls back to the wake minute, where
  the deferral below is the safety net. The **`auto` Morning intake time
  deliberately stays on the raw wake minute**: it needs you awake, not your
  tracker synced, so do not fold the arrival into the Morning resolution.

**The arrival statistic (#2214).** "When does last night's sleep normally land, in
clock time?" is ONE computation — `arrivalStatistics`
(`lib/notifications/digest-schedule.ts`) over rows gathered by `getSleepArrivals`
(`lib/queries/metrics.ts`, joining `integration_sync_rows` → `metric_samples`).

- **The percentile is taken over arrival CLOCK TIMES**, never composed. It used to
  be `median wake + p90 lag`: a central value of one varying quantity plus a tail
  value of another, biased low whenever wake and lag are not anti-correlated. On
  the measured 13-night sample the true p90 is 07:39.6 and the composition
  returned 07:10 — half an hour early, turning 12 complete digests out of 13 into 8. Since `arrival = wake + lag` per night and both instants are on the row,
  nothing needs composing, and `typicalWakeTime` is not read by the digest at all.
- **The lag survives as the ADMISSION test.** `[0, MAX_ARRIVAL_LAG_MIN]` is the
  right filter for "is this a morning arrival at all" — a negative lag is a
  backfill, a multi-hour one a Takeout-style bulk import. Admit on lag, measure on
  clock time.
- **Two statistics, one pass.** `p90Minute` is what a send time or deadline must
  clear (`ARRIVAL_PERCENTILE`); `medianMinute` is what "the configured time loses
  more often than not" means. Both come out of the same admitted sample so two
  consumers cannot describe two different distributions.
- **No answer is a first-class state.** The result is a discriminated union, not a
  nullable minute: neither number exists unless `available` is true, and the
  reason is stated (`no-source`, `no-arrivals`, `thin-sample`, `dispersed`).
  Never extrapolate below `MIN_ARRIVAL_SAMPLE`.
- **Midnight wrap is decided, not assumed.** Arrivals are ordered and interpolated
  as plain minutes of day on `[0, 1440)` with no rotation and no circular mean, and
  a sample spanning more than `MAX_ARRIVAL_SPREAD_MIN` (half the clock) is REFUSED
  as `dispersed` rather than described. The lag filter already removes the shapes
  that would put a 23:xx beside an 00:xx.
- **A DST transition day is dropped.** Such a day mixes two UTC offsets into one
  clock-time sample; with ~13 nights of `integration_sync_rows` retention a single
  hour-shifted arrival moves the p90 materially, and it carries no information
  about the sync pipeline. `isDstTransitionDay` (`lib/date.ts`) marks it at gather
  time and the exclusion is visible in the `nights` count that gates the sample.
- **It is not live.** The sample is thin by construction and jumpy
  (leave-one-night-out moves the p90 up to 11 minutes), so it may be proposed or
  used as a bound, never silently BE a user's send time.
- **One deferral, into the retry attempt that already exists.** `slotDue` is two
  attempt bands paired with the hard per-day marker, so the FIRST attempt is free
  to decline: `deferDigestForSleep` skips the send when last night's sleep is
  pending but expected, and the retry attempt — an hour later, at every tick
  rate — sends it. It is bounded by construction — the decision requires this
  tick to be the slot's "first" band (`slotAttempt`), so the retry attempt never
  defers and the digest goes out an hour later whether or not the night landed.
  **Auto only**: a manually set time is user-owned timing, and silently sliding
  someone's 07:00 would make their own setting untrue. A slot past 22:59 never
  defers, because `slotAttempt` does not wrap past midnight and there would be no
  attempt to defer into (`LAST_DEFERRABLE_MINUTE`).

**No new stored state, and no new send marker.** "Have I already deferred today?"
is answered by the clock, not a flag, which is why nothing here appears in
`SEND_MARKER_REGISTRY`. A decline writes nothing at all, so a deferred-then-sent
digest records its `notify_last_digest` marker, its `notify_digest_last_at`
watermark, its tail pointer and its #2081 dependency stamp exactly as an on-time
one does.

**When to send vs what to print stay separate.** This decides only WHEN. #2099
decides what: a night that is not last night is omitted rather than printed as
last night's, so a digest that reaches the end of its window with nothing in hand
simply has no Sleep section. `digestSleepPending` asks the freshness question with
the SAME rule the section prints by (`isLastNight` over `mainSleepNights`), so
"wait for it" and "print it" can never disagree about which night that is — and it
is gated on `isSleepTracking` (`lib/sleep-summary.ts`: at least 2 of the 3 nights
before last night recorded). Without that gate an abandoned tracker would defer the
digest every morning forever: the connection-side staleness signal is structurally
unable to see a device that stopped recording sleep while the phone kept syncing
steps (`lib/integrations/staleness.ts` tracks the CONNECTION's liveness by design).

**What CHANGED, not just what is due (#1713).** The **New** section is no longer
just "flagged biomarkers + documents". It also renders the lines the shared
**recent-changes collector** produces at a **24-hour** window:
`collectRecentChanges(profileId, { sinceDays: 1 })`
(`lib/queries/recent-changes.ts` over the pure `lib/recent-changes.ts`). That is
the SAME collector the Household member card reads at 7 days (#1463) — one
definition of "what changed", two windows, so the card and the message can never
drift. The collector composes existing per-profile readers only (no new
cross-profile SQL), ranks through `lib/rank-core.ts` under a **floor** that a
flagged lab and an out-of-range vital both hold, caps the lines and says
`+N more` rather than spilling. The digest passes `exclude: ["labs"]` because
the two fields above already report newly-flagged **lab** results from the
digest's own send cursor — the same `getCurrentFlaggedBiomarkers` computation at
a different window.

This is what finally lets four things reach the message: **out-of-range vitals**
(a BP spike, a low SpO₂ — invisible before because the flagged read is
`category = 'lab'` by #1076's deliberate decision; `getCurrentFlaggedVitals` is
its vitals twin, read only by the collector, with `'instrument'` still excluded
so a PHQ-9 can never leak), the **daily check-in** (value plus a shift against
the subject's own recent average — never a judgment, never a streak, per the
#992/#716 contract), **symptoms**, and **overnight data arrival**. Sync
STALENESS is deliberately NOT re-derived in the collector: #1685 already owns it
end to end and already renders it in this same message's Today section.

**Arrival lines FOLD into the content lines they describe (#1913 item 1).** An
arrival's only value is **provenance**, and the lines it described were already in
the same message. So a routine overnight sync is no longer narrated at all:

- **Yesterday's activity lines carry the source** — `🏋️ Morning Ride — 18.85 km ·
Strava` — through the same `activityProvenanceLabel` the Journal and the timeline
  render. A **manual** row carries no clause: "Manual" beside a session you logged
  yourself is not provenance.
- **The Sleep section IS the Health Connect arrival.** It needs no `📥` restatement
  beside it.
- **The New section keeps only the arrivals with no content line to ride:** a
  provider's **first sync** (`📥 First data from Withings: sleep` — a new source
  starting to flow is news about the setup) and a **kind this profile has never
  received before** (`📥 New from Oura Ring: blood oxygen`). Both are once-ever by
  construction, so neither can become the permanent line the attention doctrine
  forbids. `arrivalChanges` reads its whole arrival history in one pass split at the
  window edge, so "has this ever arrived before?" is one question with one answer.

The two rules below still hold and still shape what those surviving lines say.

**Arrival lines report NEWS, not substrate (#1819 items 1–2).** The data category
had drifted into reporting the storage layer at the reader.

- **Cache-kind providers are excluded outright.** Weather & UV's
  `📥 Weather & UV (Open-Meteo): 406 new records` counted cells of the GLOBAL
  location-keyed forecast cache, not records about the profile (the #1772
  vocabulary disease, pushed to a phone) — and because the sliding fetch window
  inserts new forecast hours every day, the old `HAVING SUM(inserted) > 0` passed
  **every morning forever**. A permanent line carries no information (the
  attention doctrine's own logic). The exclusion derives from the provider KIND
  through the one shared `syncVocabularyForKind`, so a future cache-kind provider
  is covered with no list to maintain. Cache-kind sync accounting lives in
  **Data → Review**.
- **The line names KINDS, not a summed count.**
  `📥 Google Health Connect: 2271 new records` added minute-grain heart-rate rows
  to a single body-weight reading, which is technically true and humanly
  meaningless. `arrivalChanges` now reads the **per-row provenance the syncs
  already persist** (`integration_sync_rows`, #1333 — the target table each written
  row landed in, plus the metric for a `metric_samples` row) and renders
  `📥 Google Health Connect: steps, sleep, workouts`. No second accounting is
  minted; counts stay in Data → Review. The kind vocabulary and the capped phrase
  are pure (`arrivalKind` / `arrivalKindsPhrase` in `lib/recent-changes.ts`).
  A window whose writes name nothing — a legacy pre-#1333 event, a provider that
  records no provenance — therefore produces **no line**, which is the honest
  answer rather than a count standing in for news.

**The Today section's band grammar (#1819 items 3–5).**

- A band of **at most three items NAMES them** instead of counting them:
  `🗓️ Overdue: Colonoscopy · CBC, Lipid panel`. Below that size a count withholds
  the only thing the reader needs; above it, naming stops fitting on a line and the
  count is genuinely the right shape (`summarizeBand`'s `nameAtMost`).
- The **band summaries carry the section's bullet emoji** (`🗓️`) — they were the
  only lines in the whole message without one.
- A band whose `training` items are all **weekly targets** states weekly PROGRESS
  instead of counting unmet ones — "This week: 2 of 4 training targets on pace —
  behind on Back, Chest" — formatted by the shared `weeklyTargetPaceLine` over the
  SAME paced set (`getFrequencyTargetProgress`) the Training chips render. The
  guard is the `training:` key namespace, not the domain — an endurance event and
  an outdoor plan also live in `training`, and the phrase is not about them.
- The **workout preview** renders `digestWorkoutLine`'s bare variant, because the
  formatter's standalone `Today:` prefix restated the section heading it sits under.
  Same computation, section-aware framing. Its head is named from
  `suggestTitle(rec.exercises)` — the SAME argument the dedicated nudge passes
  (#2012). It used to pass `rec.focus`, a `MuscleRegion[]`, into a function that
  takes exercise names and ends in a loose substring match, so "Back" resolved
  through "back squat" and a pull day was titled **"Legs workout"**.

**A data-plumbing ask gets ONE entry (#1913 items 2, 5–8).** `integration` and
`portal-sync` are the two **named-line domains**: their whole point is that they
happen without you opening the app, so a count alone would send the reader back to
the surface the signal exists to save them from.

- They are **excluded from the band count**, because the named line IS the band
  item. Before this a single 503 arrived twice in one message. The merge keys on
  `NAMED_LINE_DOMAINS`, not on the weather standing — both members were counted and
  named, so a weather-shaped fix would have left the portal double-mentioning.
- The sync lines consume the **#1880 flap-aware standing**, and always did:
  `getImportIssues` gates on `standingEscalates`, so an `intermittent` provider (a
  failure with a recent success beside it) never reaches a push channel.
- The grammar is `glyph title — because · dueText`, each part declared rather than
  inferred. **`because`** is a short cause fragment each producer writes for this
  surface — the `${title} — ${detail}` join silently assumed `detail` was one, which
  held for the integration producer and made the portal line say its imperative
  twice. `syncRequestCopy` stays the one formatter and gained the fragment beside
  its card sentence. **`dueText`** carries the expiry, and only for a domain that
  declares it has a deadline: a broken integration does not expire, and its
  `dueText` is a CTA label. **The glyph says WHO ACTS** — `🔌` keeps "a connection
  broke and allos will keep retrying"; `🙋` marks a line only a person can close,
  away from the device they are reading on. It is declared beside the domain, so a
  new named-line domain must choose one rather than defaulting into `🔌` silently.

```
• 🙋 Run the portal tool for tbh — never checked · expires in 6 days
```

**New documents say WHICH and WHAT (#1913 item 3).** `📄 1 new document: ccda` was
the raw `doc_type`: it named no document, reported nothing that came out of it, and
linked nowhere. Every fact the honest line needs already sat on the row or in
accounting the import had already done — so it renders the title/type, the
`document_date`, the acquired-by portal (#1748), and the per-domain split of the
SAME footprint tally that stamps `extracted_count` (#1827). The reader's word for
each footprint table is declared **on `IMPORT_FOOTPRINT_TABLES` itself**, so a
domain added to the registry lands in this line for free. A multi-document morning
names up to three and then counts the rest.

```
• 📄 New: Ochsner visit summary (Jul 28, via Ochsner MyChart) — 12 labs, 2 meds
```

**Yesterday: the delta and the fraction merge when redundant (#1819 item 6).**
`🔁 Missed: Glycine (1 day)` above `💊 Supplements: 8/9 taken` stated one fact
twice — the 1 missing IS the Glycine. When the delta **fully explains the gap**
(exactly one item changed state, it went missed, and the gap is exactly one dose)
the two collapse to `💊 Supplements: 8/9 taken — missed Glycine (1 day)`. Every
divergent case — a skip, several misses, a resume, a mixed window — keeps both
lines, because there #1505 part 3's "delta leads, fraction supports" is still
answering two questions. The test is the pure `intakeGapExplainedBy`.

**Sleep copy (#1819 item 7).** The verdict is a clause about the figure, so it
takes the em-dash separator (`😴 Last night: 6h 38m — about typical`) rather than a
bare space that read as one run-on quantity. `sriPresentation` gained a **banded
qualifier** on its existing thresholds, so the line says what the index means:
`📈 Sleep regularity 94 — very consistent`. #992's non-judgmental contract holds by
construction — the qualifier describes the SCHEDULE's consistency, never the
sleeper.

**Separator grammar.** One rule across the digest: `:` introduces a label's
content, `—` attaches a clause that qualifies the statement before it, and `·`
joins peers on one line (`,` joins peers within one group). Applied wherever the
above lines touch; a line that predates the rule and was not otherwise edited
still follows it or is a candidate for the next pass.

## The Telegram command vocabulary (#1895)

**The defect was silence.** The bot understood `/dose`, `/symptom` and `/temp`, and
every handler no-opped on non-matching text with nothing answering afterwards. So
`/start` — the first thing Telegram shows a new user, before they have typed a word
— vanished. `/help` vanished. A typo'd `/doze` vanished. From the chat's side the
bot was indistinguishable from broken, and the only way to learn a verb was to be
told one out of band.

**The rule.** A slash command in a chat the bot is in gets an answer. Always —
either the command's own reply or a short pointer at `/help`. Ordinary text is the
only thing that may go unanswered, because chat in a group the bot sits in is not
addressed to it (the free-text symptom intake, #877, claims it or nothing does).

**One registry, one gate** (`lib/notifications/telegram-commands.ts`, pure). It
holds the verbs, their aliases (`/symptoms`, `/temperature`), their one-line
descriptions, and their per-chat relevance predicate. `commandsForChat` is read by
BOTH `/help` and the dispatcher's gate, so the help text can never advertise a verb
that then refuses — the failure mode that makes a help text worse than none.
`lib/notifications/telegram-help.ts` resolves the chat's facts and sends the meta
replies; `handleIncomingMessage` is still the single router, now a switch over the
parsed verb, and a DB-tier completeness pin fails the build if a verb in the
registry has no route.

**Which domains get a verb is a census, not a vibe** (#2130). The registry also
declares `TELEGRAM_DOMAIN_CENSUS`, type-checked over the shared
`LoggableDomain` axis (`lib/loggable-domains.ts`): every loggable domain maps to
a shipped verb, a `plannedVerb(...)`, or an `arguedExclusion(...)` with its
reason (vitals, activity, period, substance, document). A new domain fails
`tsc` there until someone decides. #2130 decided food, practice and weight IN and
#1895 built them, so those three rows now name their shipped verbs — the flip
happened in the same change that routed the handlers, which a runtime pin forces
(a planned verb may never shadow a shipped one) and nothing is left planned.

**One authority for "which text triggers this handler" (#2004).** The dispatcher
resolved the verb through `parseCommand`/the alias table, and then each logging
handler re-validated the raw text against a hand-written regex of its own
(`/^\/dose(@\w+)?(\s|$)/i` and friends) — two independent answers, kept in step by
hand. An alias added to the registry without the matching regex edit reproduces the
silence this feature exists to remove: the dispatcher routes, the gate says the verb
exists, the handler's private regex declines, and the user gets nothing. The guard is
now DERIVED — `isCommandText(name, text)` asks the same parser the dispatcher asks —
so aliases, `@botname` addressing, case and trailing args have one definition. A pure
test pins agreement across the whole command table and scans `lib/notifications` for
any reintroduced slash-command regex literal, so a second authority cannot be written
rather than merely being wrong once it is.

**Three different answers, deliberately.** An unknown verb echoes what was typed
(so a typo reads as a typo) and points at `/help`. A REAL verb gated off for this
chat says so instead — "not set up here" and "not a thing" send you looking in two
different places. An UNLINKED chat is told that nothing is wired up yet, which is
what is actually wrong.

**Registration is instance-level, relevance is per-chat.** `setMyCommands`
populates Telegram's own `/` autocomplete menu, and Telegram scopes it per bot —
there is no per-chat variant a self-hosted instance can keep current for every chat
it joins. So the registered list stays GENERIC (every verb the build ships) and the
handlers keep owning per-chat gating; `/help` is the per-chat-honest answer. It is
registered by the same Settings → Server action that registers the webhook, since
that is the one moment the operator is provably holding a working token — and
deliberately NOT fatal: a failed menu registration must not report a working
webhook as broken, so it degrades to a named caveat in the action's message.

**`/mood` on demand.** The scheduled check-in rides the evening slot; if it
scrolled away or the day got away from someone there was no path back to it. The
command is a RE-RENDER of `buildMoodCheckin` — the same builder the tick calls, so
the faces, the token shape and the auto-pause affordance are whatever the send
renderer says they are (#221, no second engine). ONE message with per-profile
prefixed buttons in a shared chat (the `/dose` precedent — never a guess about
whose day is being logged, and one message rather than N keeps the (chat, kind)
supersede invariant from closing a sibling the same command just sent). A build
that yields nothing is answered honestly — "already checked in today" — never with
an empty keyboard, because a command that silently produced nothing is the defect
this feature exists to remove.

**`/food`, `/practice` and `/weight`** — the three verbs #2130 decided in.

- **`/food`** re-renders `buildFoodNudge` for the profile's CURRENT slot
  (`currentFoodSlot`, the derivation the Food tab's chip reads) — the same builder
  the tick sends, the reconcile rebuilds and every tap re-renders through. ONE
  MESSAGE PER PROFILE rather than one merged keyboard, because the food family's
  reconciler rebuilds a nudge from its first `food:` token and two profiles' buttons
  in one message would make every rebuild render one over the other. Each message
  declares its own subject (#1995) and rotates its own #947 pointer, so the single
  live food keyboard invariant holds across both senders — which is why that
  rotation now lives in `trackDelivered` beside the other bookkeeping rather than in
  the fan-out branch alone. Gated on food-logging RELEVANCE (the life-stage rule the
  dashboard uses), deliberately not on the `food_telegram_enabled` opt-in: that flag
  decides whether the tick may CONTACT someone, and a typed verb is access.
- **`/practice`** lists the tracked practices as one-tap buttons — the door the
  domain never had, since #1259 only offers logging when the pace nudge happens to
  arrive. It is not the nudge with its filters removed: the nudge exists because the
  SYSTEM found a target behind (bus-gated, ceiling-silent, rhythm-retimed), and this
  exists because the user asked, so it carries every tracked practice including the
  met ones and none of the nudge's ride-alongs. Its buttons take their own `plog:`
  prefix, declared INERT (the `prn:` shape one domain over): logging a session is
  additive and always valid, so the list claims nothing that could go stale — while
  `pdone:` keeps its state-claim family, because the nudge asserts "this is behind".
  Same handler, same write core, typed outcome.
- **`/weight`** is the `/temp` prompt-reply shape one quantity over: a prompt
  carrying a `(#weight:<profileId>)` marker, a reply parsed by the palette's own
  `parseWeightEntry` (one grammar and one range guard for `weight 82.5` and a chat
  reply alike), and a write through `insertBodyMetric` — canonical kg converted at
  the boundary, kg assumed when the reply names no unit, since a chat carries no
  login unit preference. A refusal is stated; nothing is confirmed unconditionally.

`practice-list` and `weight` are their own notification kinds, non-configurable for
the reason every on-demand reply is: the request IS the consent. `practice-list`
re-issues (a second `/practice` supersedes the first); the `weight` prompt carries no
keyboard, so it records no pointer and supersedes nothing.

## Live-message reconciliation (#1779)

**The defect.** Every inline keyboard the app sent was a frozen snapshot that
in-app writes never corrected. Take a dose, mark it in the app, come back to
Telegram six hours later: the reminder still sat in the chat with live
"✅ Taken" buttons, presenting the dose as outstanding. At that distance the
chat artifact is trusted more than memory, so the message actively invited a
re-take — the safety tier lying in the OUTBOUND direction (the #1716 family, one
channel over). Sent-message edits had exactly three callers (the callback
handlers, the quick-log flow, the send path's strip-previous guard), no Server
Action touched them, and the only stored pointers were the one-per-profile food
nudge (#947) and household round (#1719), kept to close the PREVIOUS message on
the NEXT send rather than to sync state.

**The honesty rule, which needs no second state model.** _A button whose tap
would now be refused or answered "already done" by its own typed outcome must not
remain rendered as actionable._ The typed-outcome layer already knows that answer
for every family; reconciliation renders it PROACTIVELY. So a reconciler is one
read-only predicate over the SAME computation that composed the send
(`collectWindowDoses` for a dose session, `getWorkoutPresence` for a live draft,
`buildFoodNudge` for the food counts) — never a second dueness model or a second
renderer (#221).

**The substrate.** Migration 135's `notify_messages` records one pointer per
DELIVERED keyboard-bearing message — `(profile_id, chat_id, message_id, kind,
date, keyboard, title, sent_at)` — written in the Telegram chokepoint, the only
place holding both the sent message id and the message it was rendered from. It is per
DELIVERY, not per send: one send fans out to N deduped chats (#1072), so a dose
confirmed from a family group's copy corrects the copies in every other
subscriber's chat. The delivered (post-cap) keyboard is stored because Telegram
has no "read my message" API — that blob is the only record of what a chat is
showing. Retention is a named cleanup class (#203): pointers past Telegram's
~48h edit horizon are pruned on every sweep. Two indexes serve it: 135's
`(profile_id, sent_at)` for the sweep and the pruner, and 152's
`(profile_id, chat_id, kind, sent_at)` for the supersede lookup (#2003), which runs
on the DELIVERY PATH of every `/dose`, `/symptom` and `/mood` and until then matched
only the profile prefix and filtered the rest in memory — the full read its own
comment claimed it avoided.

**The sweep** (`reconcileProfileMessages`, one pass per profile per tick) applies
one pure decision (`lib/notifications/reconcile-core.ts`):

- nothing resolved → **no edit at all** (pinned by an edit-call count in the DB
  tier — a reconcile that edits every tick is a rate-limit incident);
- partially resolved → strip exactly the dead buttons, or re-render through the
  family's own rebuilder (the dose family reuses the identical
  `slotSessionForKeyboard` → `renderMergedIntakeMessage` path the TAP rebuild
  runs);
- fully resolved → `closeMessage` with an honest closing line that **names its
  subject**;
- **past what its family's own tap guard honors** → strip or close regardless of
  state, since every button on it would now be refused (see the date-guard
  declaration below);
- a dead pointer (message deleted, chat gone, past the edit horizon) → the
  best-effort edit fails, the pointer is dropped, nothing is retried forever.

**How late a keyboard may still be tapped is the FAMILY's answer (#2018).** That
fourth arm shipped as one global comparison — `pointer.date < today` ⇒ close — which
is `tapDateGuard`'s equality rule lifted out of the food handler and applied to every
family. It is right for one family and wrong for another, because the two mean
different things by a token's date. A **food** token's date is the system's GUESS at
a user-owned fact (a tap says "I'm eating now", and the button carries nothing that
settles which day that was), so `handleFoodTap` writes only where its two candidate
answers agree and refuses where they diverge — the guess expires at midnight, and
rollover-close is correct. A **dose** token's date is a fact the system itself
established: the schedule's day, assigned before the message was sent. The tap
confirms that a scheduled thing happened rather than reporting when, so there is no
second candidate answer to reconcile, and `markDoseTaken` honors it for
`DOSE_LOG_DATE_WINDOW_DAYS` (#614) — including the after-midnight tap its own comment
names. The sweep was deleting the button on the grounds that the handler would refuse
the tap, and the handler had been built to accept it: last night's bedtime supplements
could not be confirmed from the chat in the morning, and an overnight missed-dose
escalation lost its buttons while the dose was still unconfirmed.

So the sweep closes a button **exactly when the handler would refuse it, by asking
the same guard the handler asks**. `RECONCILE_DATE_GUARD` (in
`reconcile-registry.ts`) declares per family WHICH existing guard that is —
`exact-day` → `tapDateGuard`, `dose-window` → `isDoseDateAccepted`, or `none` for a
family with no date axis at all — with a written reason in every direction, and
`messageExpiry` resolves it. There is deliberately **no per-family rollover-policy
constant**: any button-specific number would be a second answer to "how late may this
be logged", which is the drift being fixed. If ±2 days is too generous,
`DOSE_LOG_DATE_WINDOW_DAYS` moves the button, the Telegram tap, the web path and the
offline replay together. The resulting lifetimes:

| family                                                                       | button lives                                            | bounded by                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `intake-dose`, `escalation`                                                  | through the end of D+2                                  | `isDoseDateAccepted`                         |
| `food`, `household-round`, `mood`                                            | until the next nudge, or local midnight                 | the #947/#1945 rotation, then `tapDateGuard` |
| `workout-draft`, `preventive`, `refill`, `symptom`, `practice`, `food-optin` | while the family's own `dead` predicate says it is live | that predicate alone                         |

Two couplings this creates. `DOSE_LOG_DATE_WINDOW_DAYS` (2) must stay strictly below
`MESSAGE_POINTER_RETENTION_DAYS` (3): past retention the pointer is pruned and the
sweep can no longer close the message, so the keyboard would become immortal — both
constants carry a comment naming the other. And the two date closes are separate
words, because "This is yesterday's message." is a lie for a dose whose window has
run out; `RECONCILE_CLOSING.expired` names the consequence instead ("Too late to
confirm here — log it in the app."), pointing at the historical-dose backfill (#1950)
where a later correction belongs. The `mood` family is the one declaration STRICTER
than its handler: `handleMoodTap` writes the token's date without consulting a guard,
and since reconciliation may only ever REDUCE what a chat claims, closing at the
boundary is the safe direction — should that handler ever gain a date check it must be
`tapDateGuard`, not a third rule.

Rollover also closed the residual #947 gap — the last food nudge of an evening used
to keep a live keyboard until the next send, which may never come — and it still
does, because food is an `exact-day` family.

**A failed edit is CLASSIFIED, never assumed dead (#1885).** The transport used to
throw a bare `Error` for every Bot API failure alike, so the sweep's catch dropped
the pointer on a 429, a 5xx, a DNS blip, an `AbortSignal` timeout or a missing bot
token exactly as it did on "message to edit not found" — and because the claim
mutates or deletes the row _before_ the network call, a wrongly-dropped pointer has
no retry path left at all: a live chat keeps a stale keyboard no later tick can fix.
`lib/notifications/telegram-api.ts` now throws a typed `TelegramApiError` carrying
the HTTP status and Telegram's own `description` (network failures included, with a
null status), and one pure decision —
`classifyTelegramFailure` in `lib/notifications/telegram-error.ts` — splits them:

- **permanent** (`message to edit not found`, `message can't be edited`,
  `chat not found`, `bot was kicked` / `bot was blocked`, `CHAT_WRITE_FORBIDDEN`,
  any 403, …) → drop the pointer, exactly as before;
- **transient** (429, 5xx, network reach failure, timeout, unconfigured token, and
  anything unrecognised) → **release the claim** and leave the pointer as the sweep
  found it, so the next tick recomputes the same plan and retries. A keyboard claim
  is swapped back under the same compare-and-swap
  (`releaseMessagePointerKeyboard`); a close claim, which deleted the row, is
  re-inserted verbatim — original id and `sent_at` included
  (`restoreMessagePointer`). The result carries these as `deferred`.

**One pointer's failure is one pointer's failure (#2070).** The classification above is
about the TRANSPORT. A pointer's own reconciliation can also throw before any network
call — a malformed row surfaced by a rebuild, a bad settings edge case — and the sweep
used to walk every pointer in one unguarded loop, so that exception propagated out of
`reconcileProfileMessages` entirely. Because the digest is normally the earliest-`sent_at`
pointer of the day, a digest that could not be rebuilt meant **no other pointer for that
profile was examined that tick**, including a same-day dose or escalation keyboard the
ledger had already resolved — a live "✅ Taken" on a dose already taken, for as long as
the build kept failing. Each pointer now runs inside its own `try`/`catch`. A COMPUTE
failure is classified the same way #1885 classifies a transport one, and it says nothing
about whether the message is still reachable: the pointer is left exactly as found (never
dropped, never edited on a guess), the result carries it as `failed`, the tick logs it, and
the sweep carries on to every remaining pointer.

The **unknown default is transient** on purpose, because the two mistakes are not
symmetric: a wrong "permanent" is unrecoverable, while a wrong "transient" costs at
most one fast-failing call per tick until the pointer ages out. Keeping the original
`sent_at` on a restore is what bounds it — retention (`MESSAGE_POINTER_RETENTION_DAYS`)
still prunes the row, so "retry" can never become "retry forever" and no attempt
counter is needed. Delivery HEALTH is untouched by any of this: reconcile never
dispatches, so the set/clear/freeze decision in `delivery-status.ts` stays the only
thing that moves the `notify_last_error` marker.

**Overlapping ticks (#1788).** The sweep does not assume an operator runs exactly
one scheduler — a compose poll sidecar plus a host crontab, two replicas on one
volume, or a manual `notify` run during the hourly one all put two passes on one
profile at once, and both would read the same pre-edit keyboard and issue the same
Bot API call. The end state converges (the edits are identical), so nothing is
corrupted; what is spent twice is the rate-limit budget the zero-call steady state
exists to protect. The pointer's keyboard is therefore treated as a lifecycle field
with an atomic transition (AGENTS.md, the `demoteIntakeObligation` shape): each pass
**claims** the transition — old blob → new blob, or a `DELETE` under the same witness
for a close — _before_ it touches the network, and only the winner calls Telegram
(`claimMessagePointerKeyboard` / `claimMessagePointerClose`). Claiming afterwards
would leave both passes calling the API, which is the whole cost being avoided. The
witness is the stored blob **verbatim**, never a re-serialization: a round-trip that
reordered a key would yield a witness that never matches and a sweep that silently
stopped editing anything.

**The closing line names what it closed (#1822 item 7).** A close replaces the
ENTIRE message text, so `RECONCILE_CLOSING` alone arrived as an orphan bubble:
"Handled in the app — nothing left here." at 08:00, with no indication of WHAT was
handled and — in a shared family chat — the "[Name] " attribution gone with the
rest of the text, leaving two members' identical reminders indistinguishable once
resolved. The tap path solved this for #377 with `replacementWithTitle`; the sweep
now follows the same convention through `reconcileClosingText`, which composes
"[Norton] 🍽️ Morning food log — handled in the app." (and, for a rollover,
"… — this was yesterday's message."; for a dose past its log window,
"… — too late to confirm here, log it in the app."). The subject comes from the pointer's stored
`title`, recorded AS DELIVERED in the same chokepoint write as the keyboard —
migration 139 — because the tick edits by pointer and never holds the text it is
replacing; re-deriving it would run a whole builder and would produce TODAY's
title for YESTERDAY's message on a rollover close. A pointer without one (written
before 139) degrades to the bare line: a close never invents a subject.

**Edits, never sends.** Everything routes through the chokepoint's
`closeMessage` / `updateMessageKeyboard` / `rebuildMessage`. Telegram does not
notify on an edit, so no interruption is spent; reconciliation only ever REDUCES
what a chat claims, which is the direction the contact-consent rule allows
unilaterally (docs/internals/findings.md §2).

**The safety-rule check.** Closing a reminder because the dose was actually
logged is state-driven, not dismissal-driven — the dueness is genuinely gone from
the ledger, so "dose reminders are never silenced by suppression" survives
intact. A reconciler may only read real ledger state and **never** the
findings-suppression bus; the practice family reads raw frequency progress rather
than `behindPractices` for exactly this reason, because the latter applies the
bus. An Upcoming dismissal still never touches a safety message.

**The completeness guard** (`lib/__tests__/reconcile-registry.test.ts`). A source
scan harvests every callback-token prefix the notification modules can mint and
fails the build unless each one is either owned by a family in
`RECONCILE_PREFIXES` or declared **inert** with a written reason (a view control
— "▲ Collapse", "⚙️ Tune", "➕ Show more"/"➖ Show less", the `/dose` access list — makes no
state claim, so it cannot lie and must not keep a resolved message alive). It
also fails on a stale entry. An UNKNOWN prefix is deliberately not treated as
inert: an unreasoned button leaves its message untouched rather than being closed
on a guess.

**One live keyboard per (chat, kind) — the re-issue invariant (#1898).** The sweep
made stale keyboards HONEST; nothing made them SINGULAR. Repeated `/dose` or
`/symptom` calls accumulated live keyboards in a chat: each safe to tap (typed
outcomes) and each kept fresh by the sweep — which is the cost, an hourly Telegram
edit per stale duplicate, forever, to keep clutter honest. **A send of a
re-issuable kind re-issues THE keyboard; it never adds another.** On sending kind K
to chat C, the chokepoint closes this profile's other live K-pointers in C with the
attributed supersede line ("[Norton] 💊 Log a PRN dose — superseded, use the message
below."), through the same `reconcileClosingText` vocabulary the sweep uses.

Two properties carry it. The strip targets come from the **pointer table**, never
from the outgoing message, so a target is always a delivery that was actually
recorded — #1945's stranding class is unrepresentable here rather than guarded
against. And the trigger is symmetrical: a send that recorded no pointer of its own
(no delivered keyboard) has superseded nothing and closes nothing. Ordering is
#1945's — **record first, close second** — so a failure anywhere leaves the chat
with MORE live keyboards than the invariant wants, never zero. The close is
claimed with the same #1788 compare-and-swap the sweep uses (a supersede racing a
reconcile does not double-edit) and released on a transient failure (#1885), which
is what makes it self-healing: a close that fails is retried by the next send of
that kind AND by the next sweep, instead of leaving one extra live keyboard until
day-rollover the way #947's bespoke strip did.

**A chat-addressed send names its own SUBJECT (#1995).** `sendTelegramMessage`
addresses a CHAT; a pointer is owned by a PROFILE, so every explicit-chat send has to
answer "whose message is this?". It used to answer by guessing — the lowest profile
the chat could act as, whatever the message said. Harmless while every such send
covered the whole chat (`/dose` and `/symptom` render ONE keyboard with per-profile
prefixed buttons), and wrong the moment a command sends one message PER profile: all N
pointers land on the same borrowed owner, so in a family chat Basil's send rotates
Ada's pointer, her live keyboard is stripped because HE logged something, and the two
trade one (chat, kind) slot back and forth forever. Nothing lands on the wrong person
— callback tokens carry their own profile id and `resolveTapProfile` re-checks it on
tap (#797) — the damage is to the AFFORDANCE, and it is exactly the invariant #1898
had just bought.

The subject is now **declared, never inferred**: a required third argument whose two
values are the two honest answers — a **profile id** ("this message is about that
person") or **`CHAT_WIDE`** ("this covers the chat, or has no data subject at all,
like `/help`"), which resolves to the chat's stable representative so a re-issuable
chat-wide verb keeps landing on one slot. An unmapped chat resolves to nothing and
records NO pointer rather than inventing an owner. All three delivery paths — a
fan-out copy, an explicit-chat override, a chat-addressed send — now share one
`trackDelivered` tail and differ in nothing but the subject they were handed.

The supersede key stays **per profile** rather than widening to (chat, kind) across
profiles: with trustworthy subjects that is the correct key, because a per-profile
message must close its own predecessor and never a housemate's.

**Re-issuability is DECLARED, per kind** (`KIND_REISSUE` in
`lib/notifications/reconcile-registry.ts`), and the completeness guard fails the
build for a kind that never answered. "No" is the right answer for every
state-claim kind and is not a gap: a morning dose reminder and an evening one are
two outstanding claims, both true at once, so closing either would remove a safety
prompt nobody answered. The `false` entries therefore carry reasons too, so
"decided against" stays distinguishable from "nobody looked". Two entries are worth
naming:

- **`temp` is not re-issuable.** The sibling-closing hazard that first justified
  the entry is gone since #1995 (a `/temp` call's per-profile prompts now declare
  their own subjects, so the supersede lookup is per profile and cannot reach a
  sibling's copy), but the entry stands on its own footing: a prompt asks for a typed
  REPLY and carries no keyboard, so it records no pointer and supersedes nothing
  either way.
- **`food` is not re-issuable** because the nudge already holds the invariant
  through its own #947/#1945 rotation, whose strip is conditioned on the NEW message
  carrying a `food:` quick-log token. The generic rule cannot express that
  condition, and without it a view-control-only nudge (#1807's "➖ Show less" shape)
  would close the only keyboard in the chat that can still log a serving.

The on-demand command replies carry real kinds (`prn-list`, `symptom`, `temp`) for
exactly this reason: an un-kinded send collapses into the `other` catch-all, which
is the one bucket where superseding must never apply, since any two unrelated
messages would then close each other.

### Prose claims reconcile too (#1913 item 4)

The two declarations above are **keyboard-shaped**: "what happens when this BUTTON is
still in the chat tomorrow?" and "does sending this again replace the last one?". The
morning digest slipped between them. Its every token is (correctly) declared inert — an
offer tail and a ⚙️ Tune control claim nothing — so `owningFamily` returned null and the
sweep concluded a collapsed digest had nothing to reconcile. Its **claims are its
sentences**: "Supplements: 8/9 taken — missed Glycine (2 days)" stood until the next
morning after the user had already logged it. That is #1779's harm pattern in the app's
most-read message. The owner's question that exposed it: _"if I mark yesterday's Glycine
now, will this message fix itself?"_

A **prose-claim class**, declared by message KIND in `KIND_PROSE`
(`lib/notifications/reconcile-registry.ts`):

- **The send registers its pointer by KIND**, not by keyboard token. `recordPointer` no
  longer requires a delivered keyboard when the kind declares a prose reconciler, which
  is what lets a button-less digest be tracked at all.
- **No second renderer.** The reconciler re-runs the SAME
  `gatherDigestInput → buildDigest → renderDigestMessage` pipeline `runDigest` ran, for
  the pointer's own date — so a reconciled digest is exactly the message that would have
  been sent had it been composed now.
- **Unchanged ⇒ no edit**, pinned by an edit-call count, exactly like the additive food
  class. Migration 153 adds the `body_hash` witness that makes the comparison possible
  without the pointer table holding a second copy of a message full of health facts, and
  it doubles as the #1788 compare-and-swap for a prose edit — a digest's keyboard blob is
  unchanged (often empty) across one, so it cannot tell two overlapping ticks apart.
- **Day rollover DROPS the pointer; it does not close the message.** A dated report is
  honest AS HISTORY; only the LIVE day's claims must track the ledger. Replacing
  yesterday's digest text would destroy a report the reader may legitimately scroll back
  to, so the prose branch simply stops tracking it — untracked, no edit, no closing line.
  It never reaches `decideReconcile`'s keyboard-expiry arm, which could not have closed a
  digest anyway (every token is inert, so that arm sees no claim). The registry's `digest`
  entry says exactly this since #2071; it previously described a rollover close that does
  not happen, and this registry is read as ground truth for what has been decided versus
  what nobody has looked at.
- **The rebuild is pre-checked before it is paid for (#2069).** A sent digest's pointer
  stays live until rollover, so the sweep was running the full `gatherDigestInput` — a
  coaching scan, a ~20-domain `collectUpcoming` and a per-document footprint loop — on
  every remaining tick of the day, ~15 times out of 16 only to hash the result and find it
  identical. Two cheap questions now come first: a pointer with no recorded `body_hash`
  can never be edited (so a rebuild for it is pure waste), and a **dependency stamp**
  (`lib/notifications/digest-deps.ts`) of narrow indexed aggregates over the ledgers the
  digest's claims derive from says whether anything moved. A resolution the user makes —
  the dose logged, the workout recorded, the item dismissed — still reaches the chat on
  the very next tick. The stamp is an **accelerator, not an oracle**: `decideProseGather`
  (pure, in `reconcile-core.ts`) forces the rebuild anyway once the recorded gather is
  older than the kind's floor, so a dependency nobody declared costs latency, never a
  claim left standing for the rest of the day. The record lives in one `profile_settings`
  key, `notify_digest_recon`, declared as a non-marker in the send-marker registry: it
  gates a silent EDIT and can never suppress a send.
- **The completeness scan covers this class**, so the next report-shaped message has to
  answer "do your sentences reconcile?" rather than inherit silence. The weekly recap
  answers **no**, and says why: it describes seven days that are already over, so its
  claims are history the moment they are made.

**Deliberately out of scope.** No write-path coupling: the Server Action layer
stays free of Telegram calls. A fire-and-forget edit from the action layer could
be added on top later, but it cannot replace this (no retry, a second concurrent
writer of message state, a call site to remember at every write, and a burst
against rate limits when items are logged one by one). Web Push is transient and
has no retroactive-edit story.

**A quiet 24h produces no section at all** — the digest does not manufacture news.

**Per-category demotion — the ⚙️ Tune control (#1714).** As the digest's coverage
grew, the recourse for an unwanted category was nothing or a settings checkbox
farm. The escape hatch instead rides the surface that annoys you (the
Take/Skip/Demote precedent, #1505): the message carries a collapsed **⚙️ Tune**
button that expands **in place** — a keyboard edit, never a send — into one toggle
per category, then **▲ Done**.

- **Demote ≠ hide.** A demoted category stops appearing ROUTINELY and still
  surfaces when it crosses its own notable threshold — and that predicate is
  always the classification the line ALREADY computes (#221), never a second
  threshold: `sleepVerdict` for sleep (#1712), the mood shift against the
  subject's own recent average, a severe symptom-day, a growth band crossing, a
  personal record for a training day (`recentPRs` / `recentCardioPRs`, the same
  pair the weekly recap reads).
- **Every category is tunable** (owner ruling 2026-08-01, #1797). #1774 shipped a
  deliberately conservative launch set — the collector's categories minus `labs`,
  with `activities` deferred — and that intersection is retired. The set is
  DERIVED per side, so there is no hand-maintained list to drift: the collector
  owns its half through `RECENT_CHANGE_CATEGORIES` (a category added to the
  collector is tunable the day it exists), and `digest-tune.ts` owns the digest's
  own sections through `DIGEST_OWN_CATEGORIES` (`sleep`, `activities`) — the two
  the collector never produces. Ten categories today, so the largest possible Tune
  keyboard is 5 rows + ▲ Done = 11 buttons, well inside the 100-button cap
  `capTelegramKeyboard` already enforces.
- **Preference filtering can never reach a safety floor.** `flagged` implies
  notable inside `applyRecentChangeDemotion`, so a flagged lab or an out-of-range
  vital survives every preference, structurally. `labs` back in the set
  demonstrates that rather than weakening it: every lab line the digest carries is
  flagged, so a reader who tunes labs down still receives every flagged result, and
  the row's copy says so ("A flagged result always appears — turning this down
  never hides one"). The offer tail, the Today obligations and the minimal-digest
  guarantee are not tunable at all — those are the MESSAGE's job, not a category.
  Demoting everything makes the digest short, never silent.
- **Vocabulary and predicates:** `lib/notifications/digest-tune.ts` (pure) —
  `DIGEST_TUNABLE_CATEGORIES`, `DIGEST_OWN_CATEGORIES`, the labels, the stored
  form, the toggle, the keyboard builders, `sleepSurvivesDemotion` and
  `activitiesSurviveDemotion`. The collector half applies through
  `collectRecentChanges({ demoted })`; the Sleep section applies through
  `gatherDigestSleep(profileId, demoted)`; the Yesterday activity list applies in
  `gatherDigestInput`, which resolves the PR count only when the category is
  actually demoted (`personalRecordsOn`).
- **Storage is per LOGIN** (`login_settings.digest_demoted_categories`), beside
  the login's Telegram channel config: which lines a digest routinely carries is a
  display preference of the person reading it, not a fact about the data subject.
  `toggleLoginDigestDemotion` does its read-modify-write inside one immediate
  transaction and returns the state it stored, so both surfaces answer from the
  typed outcome rather than confirming unconditionally.
- **One message, N readers.** The digest is built once per profile and fans out to
  every managing login, so `digestDemotionsForProfile` collapses the per-login
  preferences CONSERVATIVELY (`intersectDigestDemotions`): a category is demoted
  only when EVERY managing login declared it, and a profile with no managing login
  demotes nothing. Nobody is shown less than they asked for, and no login's tap can
  thin another login's digest. A per-recipient message body would be the only way
  to honour two disagreeing readers exactly, and that is a delivery-core change
  (`dispatch` renders one message per profile) — a separate decision, not a
  side effect of this control.
- **Which login a tap belongs to:** the login whose Telegram channel IS the chat,
  lowest id first when a family chat has several — the same "first login owns the
  chat" rule `dedupeRecipientsByChat` uses outbound, so the two directions cannot
  disagree. A tap on YESTERDAY's digest is refused rather than retuned from stale
  context.
- **Mirrored in Settings → Notifications** ("Morning digest") as the same toggles,
  read-write, so preferences are discoverable, reversible off-Telegram, and visible
  to someone auditing why their digest looks thin. One storage, two surfaces — a
  mirror of an existing message control, not a settings-only feature. Since #1868
  the mirror renders COLLAPSED: an honest one-line state (`digestTuneSummary`,
  pure) plus a disclosure holding the full list. Being a mirror is the reason —
  the canonical control rides the message, and this surface exists for discovery
  and reversal, not for ten always-rendered checkboxes on the app's densest page.

**Light and movement lines (#1723).** Two more Today/Yesterday lines, both
riding this message — **no send is created by either**:

- a **weather-aware light-exposure line** rendered from the already-synced
  weather/UV cache, gated by the named predicate `favorableLightConditions`
  (`lib/light-exposure.ts`: clear/partly-clear, effectively dry, a real daylight
  window, and UV inside a usable band — a scorching day belongs to the #1172
  overexposure engine, not to encouragement) plus a **relevance** gate
  (`lightExposureRelevant`: the profile tracks a light/outdoor practice, or its
  sun surface is live). It STATES A WINDOW ("UV moderate until 4pm — good window
  for light exposure") and never issues an instruction with a deadline. It
  composes the tracked practice's pace from the shared `frequencyPace` result
  when that practice is behind.
- the **daily step target** (`lib/steps-target.ts`), a value the user declares in
  Settings → Training and which is stored in `profile_settings`
  (`steps_daily_target`) — `frequency_targets` are weekly-SESSION shaped and
  cannot carry a daily sum, so no schema was added. The digest states yesterday's
  verdict against it (#1712's pattern) and restates the target this morning only
  when the trailing 7-day average sits below it. Later in the day, when the count
  is well behind by `STEPS_AFTERNOON_HOUR` in the profile's timezone,
  `stepsPaceItems` adds ONE calm Upcoming row (`steps-pace:<date>`) — which is
  how it reaches the surfaces that already fire, without a dedicated step nudge.
  Stale step data goes **silent** rather than guessing: a late Health Connect
  batch must never manufacture a "behind".

**Delayed completion dispatch + no-finish fallback (#1154 §B).**
`runPostWorkoutFinish` delegates to the shared per-activity core
`runPostWorkoutForActivity`; the live Finish / retroactive save (`saveActivity`)
and the integration syncs arm a ~60s re-armable timer
(`lib/notifications/post-workout-queue.ts`, fire-time completed-today
verification) that runs the SAME core, so the post-workout dose reminder lands
moments after completion instead of on the next tick. Both paths share the
stamp-on-delivery one-shot marker (`notify_last_post_workout_<activityId>`); the
notify tick remains the mandatory backstop (and flushes tick-armed timers before
exiting). Deliberately not quiet-hours-gated — a post-completion send answers an
action the user just took.

**One supplement reminder per tick (#1154).** Every slot due on a tick —
the four windows plus the PreWorkout pseudo-slot (an `anytime` pre_workout dose
timed one hour before the inferred training hour) — coalesces into ONE message
(`buildIntakeReminderForSlots`/`renderMergedIntakeMessage`); each contributing
slot's `notify_last_supp_<slot>` marker is stamped on delivery. Telegram
rebuilds re-render the whole merged keyboard footprint.

**Priority floor (#1156).** `doseReminderNotifies`
(`lib/supplement-schedule.ts`): low-priority SUPPLEMENTS are excluded from every
dose-reminder send (window/merged/post-workout/digest count/buttons) at the
send-assembly layer (`notifiableWindowDoses`); medications are never gated, and
the escalation gather deliberately reads the unfiltered `collectWindowDoses` —
the safety tier is structurally never priority-gated. An all-low send is silent
BY DESIGN.

## The tick's decision record (#2209)

Only `error` used to be durable. Everything the tick said below it — `nothing
due`, `already sent today`, `no channels configured for profile`, every
`… nudge skipped: no channel`, every reconcile outcome — went to stdout only,
and the deploy timer recreates the `allos-notify` sidecar tens of times a day,
so its working retention is under an hour, permanently.

The asymmetry is one class: the **decline**. A send writes a row
(`notify_messages` plus a `notify_last_*` marker); a decision _not_ to send
writes nothing, anywhere. Recoverable without logs: sends, sync outcomes with
counts, delivery health, errors, AI events. Not recoverable, and all of it below
`error`: every decline above.

`data/logs/notify.jsonl` (`lib/notify-log.ts`) is the third sink behind the
shared JSONL substrate (`lib/jsonl-log-file.ts`, #1883), filtered by **scope**
(`lib/notify-log-format.ts` declares which) rather than by level. The viewer is
**Settings → Logs & audit → Notify tick**, admin-only.

Rules this record lives under:

- **The tick must not get slower.** The sink is synchronous by design, as the
  error sink already is, and best-effort throughout — a logging failure never
  throws into the tick, and a dead disk costs neither an outcome nor a marker.
- **Scope, not level.** Persisting every `info` from the web app is a different
  and much larger decision. `debug` is never persisted.
- **No new chatter.** The tick is already quiet when nothing is due, and the
  point is to keep what it says rather than to make it say more. Exactly two
  lines were added, both to make a quiet run visible: `tick started` (once per
  run) and `profile evaluated` (once per profile per run).
- **The unit is a RUN.** `beginNotifyRun()` stamps a run id; the profile half
  rides the `lib/tick-cache.ts` scope the tick already opens per profile,
  falling back to the `profile` field the call sites already pass. Grouping is
  keyed on that id, never on a timestamp bucket — a fan-out over several
  profiles routinely straddles a minute.
- **A quiet run renders as a ROW, not as absence.** Otherwise "silence because
  nothing was due" reads identically to "silence because the sidecar is wedged",
  which is the whole ambiguity the record removes.
- **Same PHI posture as `errors.jsonl`**: profile names, item names and finding
  text can appear, so the message and the field bag both go through the shared
  `redactSecrets`/`buildDetail` chokepoint, and the viewer is admin-only.

`deferDigestForSleep` (#2102) carries an explicit trace. Its **write** policy is
unchanged — the marker is still set only by a real send, and nothing about the
deferral stores state — but the decision now names its inputs (the sleep opt-in,
the newest recorded night, whether last night is in hand, whether the profile is
still tracking) plus the arrival-side ones #2192 is open about (expected-by, last
sync, provider health). At most one line per profile per day, on the single
attempt band where the gate is consulted, and it **declares** its own decision
rather than being classified from its message text.

This is the OPERATOR record and does not replace #2173, which owns making "this
profile's reminders reach no one" visible to someone who can fix it, derived at
read time from DB state. Nor is it a per-tick audit table: `audit_events` is for
user-attributable writes.
