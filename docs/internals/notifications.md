# Notification architecture

This is the maintainer contract for `lib/notifications/`. For channel setup, read
[Notifications](../notifications.md). For reach and consent, read
[Findings and attention](findings.md). Change existing planners and dispatch paths
rather than introducing another notification state model.

## Ownership and routing

An event belongs to a profile; Telegram, Web Push, and email channels belong to
logins. Fan-out uses explicit grants plus the login's own profile, subject to
channel configuration and mute preferences. Admin access to every profile does
not imply consent to receive every profile's reminders. Admin notification
opt-ins are explicit. Home Assistant's webhook remains profile-scoped.

`fan-out.ts` resolves recipients and deduplicates Telegram chats. `routing.ts`
derives setup gaps: a profile that would send but has no reachable channel can
show a setup note only when some channel technology is configured on the
instance. This differs from an attempted delivery failing. Missing optional
credentials degrade gracefully; no channel is not a transport error.

## Tick, dispatch, and markers

- `tick.ts` is import-safe; the CLI in `scripts/notify.ts` owns process behavior.
- Global retention sweeps run independently after notification fan-out. A thrown
  cleanup error is logged without stopping later sweeps or changing the exit code.
- Reminder evaluation and integration polling have separate cadences. Increasing
  tick frequency must not multiply external polling or a slot's retry budget.
- Reminder slots permit two attempt bands, an hour apart. Travel-skipped slots
  skip both bands. Use the existing schedule planners, not a wider due window.
- Route sends through the shared dispatch path, including safety escalation.
  Preserve per-channel routing, delivery outcomes, and delivery-health reporting.
- Telegram attempts every eligible chat even when another recipient fails. Any
  failure keeps the channel failed, while partial delivery records that someone
  received the message. Slot retries may therefore send healthy chats a second
  copy. Permanent failures remain visible in delivery health and do not silently
  change a login's channel preferences. Explicit chat overrides follow the same
  isolation and retry behavior without claiming a login's delivery outcome.
- A send marker records delivered content. A failed send must not consume it.
  Keep the existing marker vocabulary in `send-markers.ts` and the kind cadence
  declaration; do not build marker keys ad hoc in callers.
- Tick-scoped memoization uses `lib/tick-cache.ts`. Each memo must explain why
  no writer can change its rows during that scope. React request caching and
  module-level TTL state do not supply the tick's lifetime.

## Suppression and safety

Bus-gated findings use the same `dedupeKey` as their Upcoming representation and
consult the shared suppression bus. Refill, preventive, workout, and illness-care
nudges must honor relevant dismissal/snooze decisions. Suppression freezes the
send marker as well as preventing a send; unsnoozing must not re-send an already
notified episode.

Scheduled dose reminders, missed-dose escalation, and PRN redose notices are
safety reminders and do not use that dismissal bus. Their own slot or
administration markers provide deduplication. Intake obligation controls ordinary
reminder reach; safety assessment must not disappear when an item becomes `may`.
See [intake obligations](supplements.md#obligation-and-safety).

Temperature red flags are assessed from the latest reading in an open episode.
The waking tick is a fallback; immediate write-path dispatch can respond outside
quiet hours when a caregiver is actively recording a reading. Preserve those
different triggers. History correction must not re-arm a consumed escalation.

## Compositions and cadence

- The morning digest is one merged message. `digest-schedule.ts` decides when;
  digest gatherers and builders decide what. Keep the configured fixed/sleep-aware
  timing distinction and explain unavailable timing evidence without guessing.
- Arrival news folds into the content it describes. Do not report import plumbing
  or duplicate an arrival in multiple sections. No news means no news section.
- `lib/recap.ts` computes the periodic review once for every surface. Larger
  periods replace smaller ones at a shared boundary. Rates use completed local
  days; content must have the coverage needed for the claim.
- Workout completion is keyed to a session, not whichever imported row survived
  a merge. Reconciliation must preserve the one-contact-per-session guarantee.
  Delayed completion and no-finish fallback reuse that ownership.
- Physiology uses the shared `lib/event-physiology.ts` computation. Missing
  coverage stays unknown; comparisons use the person's baseline. Recovery
  context rides an already permitted send rather than creating a delayed one.
- A bedtime wear reminder needs explicit consent and a supported quiet-stream
  condition. Source failure/reauth takes precedence. Onboarding/offboarding
  offers do not themselves push.
- A food or practice observation decorates an eligible message and describes the
  log, not inferred behavior. Ranking offers must not invent a coaching priority.

## Telegram actions and live messages

`telegram-commands.ts` owns command vocabulary and matching. Unknown commands,
unlinked chats, and temporarily unavailable actions receive distinct answers.
Callbacks authorize the current actor and resolve current ledger state; message
text is not write authority. Acknowledge once the action outcome is known.

`telegram-time-correction.ts` derives offers from stored ledger state and names
absolute local times. Correction is relative to the recorded instant, not the
latest tap. Show the corrected time in the appropriate message and preserve each
domain's local-day attribution rule. A dose stores `occurred_at` separately from
its immutable `recorded_at` capture stamp. `dosetime` moves `occurred_at` and nothing else;
the scheduled date and slot remain fixed. Food time correction can also change
its local day, because a serving's day follows when it was eaten.

`message-pointers.ts`, `reconcile-registry.ts`, and `reconcile.ts` own live-message
state. A button whose action would now be refused must be updated or removed.
Both send-time and reconciliation edits record the keyboard actually delivered.
Keep one live re-issuable keyboard per chat/kind; family declarations decide
expiry and closing outcomes. Edits must obey the original send's safety, size,
and consent constraints. An edit that notifies is a send for consent purposes.

Overlapping sweeps claim work through the existing database mechanism. Classify
an edit failure before retiring a pointer: transient transport failure is not
proof the message is gone. One pointer's failure must not stop the other pointers.

## Message content

Use `message-line.ts`, the glyph vocabulary, and `rich-text.ts` for shared message
structure and channel rendering. Convert to profile display units at this boundary.
Qualifiers must remain legible in plain-text channels. Never mention a button or
interaction that the destination channel strips.

For a change, inspect the existing planner tests, DB delivery/marker tests, and
callback tests for that family. Add coverage only for a distinct uncovered failure;
follow the [shared policy](../change-policy.md).
