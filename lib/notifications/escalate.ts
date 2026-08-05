// Missed-dose escalation orchestration. Gathers the critical
// unconfirmed doses for a profile from already-scoped queries, runs the pure
// escalationsDue decision, and DISPATCHES the nudge to every configured channel.
// Called once per hour from the notify tick, independently of whether any reminder
// slot is due this hour.
//
// THROUGH THE CHOKEPOINT, LIKE EVERY OTHER BUILDER (issue #1716). This used to call
// sendTelegramMessage directly, which made the loudest safety-tier message in the app
// the only one that (a) reached Telegram ONLY — while the settings matrix offered
// per-channel routing for `escalation` and the Home Assistant channel advertises
// escalation light-flashes, neither of which could structurally happen; (b) bypassed
// dispatch()'s recordDeliveryOutcome, so a BROKEN SAFETY CHANNEL never set the
// delivery-health marker and stayed invisible in Settings; and (c) bypassed the
// per-login disabled-kinds gate inside telegramChannel.send. The per-item
// `escalate_chat_id` caregiver override (#615) survives as a dispatch OPTION, so it
// keeps its explicit routing AND gains the accounting.
//
// The fan-out's warn-never-block posture on a muted safety kind is unchanged: a mute
// is the user's explicit, warned choice, and the delivery accounting is honest either
// way.

import { collectWindowDoses, getPreWorkoutSlotHour } from "./supplements";
import { escalationMarkerKey } from "./escalation-keys";
import { intakeSlotMarkerKey } from "./send-markers";
import {
  escalationsDue,
  renderEscalationMessage,
  type EscalationCandidate,
  type EscalationWindow,
} from "./escalation";
import { dispatch } from "./index";
import { getTakenDoseIds, getSkippedDoseIds } from "../queries";
import {
  getProfileSetting,
  setProfileSetting,
  getPublicUrl,
  type NotifySchedule,
} from "../settings";
import { createLogger } from "../log";
import { escalatesOnMiss } from "../supplement-schedule";

const log = createLogger("notify");

const WINDOWS = ["Morning", "Midday", "Evening", "Bedtime"] as const;

// Default wait after a slot's reminder before escalating an unconfirmed critical
// dose, when the supplement leaves escalate_after_min unset.
export const DEFAULT_ESCALATE_AFTER_MIN = 120;

// The per-dose escalation dedup marker key now lives in a pure module (issue #328)
// so delete seams can sweep it without importing this Telegram-carrying module;
// re-exported here so the existing `./escalate` import path keeps working.
export { escalationMarkerKey };
const escKey = escalationMarkerKey;

// Send any due missed-dose escalations for one profile. Returns whether a send
// failed (so the tick can aggregate into its exit code). Never throws for an
// ordinary send failure.
export async function runEscalations(
  profileId: number,
  profileName: string,
  date: string,
  hour: number,
  sched: NotifySchedule
): Promise<{ failed: boolean }> {
  // Gather critical, unconfirmed candidates only from slots whose reminder was
  // actually delivered today — there's no missed dose to chase otherwise. The
  // PreWorkout pseudo-slot (#1154) is chased like a window, anchored on its
  // workout-relative hour.
  //
  // The gather reads the UNFILTERED collectWindowDoses on purpose: the SEND floor is
  // applied at send assembly, never here, so the safety tier can never be silenced by
  // a display-layer filter. The obligation gate that DOES apply is
  // `escalatesOnMiss` — `must` only (#1505). A `should` miss is a tracked shortfall,
  // and chasing it with a second message is exactly the over-contact this model
  // exists to remove; a `may` item has no miss to chase and never reaches here
  // anyway, since isDueOn short-circuits it out of the window entirely.
  const candidates: EscalationCandidate[] = [];
  const sentWindows: EscalationWindow[] = [];
  const preWorkoutHour = getPreWorkoutSlotHour(profileId);
  const slots: { w: EscalationWindow; slotHour: number | null }[] = [
    ...WINDOWS.map((w) => ({
      w: w as EscalationWindow,
      slotHour: sched.supplementHours[w],
    })),
    { w: "PreWorkout" as EscalationWindow, slotHour: preWorkoutHour },
  ];
  for (const { w, slotHour } of slots) {
    if (slotHour == null) continue;
    if (getProfileSetting(profileId, intakeSlotMarkerKey(w)) !== date) continue;
    sentWindows.push(w);
    for (const e of collectWindowDoses(profileId, w, date)) {
      // TWO gates, both required and neither redundant: `must` is the obligation
      // tier that may escalate at all, and `critical` is the per-item opt-in INSIDE
      // it. Dropping either would widen the loudest surface in the app.
      if (!escalatesOnMiss(e.supp)) continue;
      if (!e.supp.critical) continue;
      candidates.push({
        doseId: e.dose.id,
        supplementId: e.supp.id,
        supplementName: e.supp.name,
        amount: e.dose.amount,
        product: e.supp.kind === "medication" ? e.supp.product : null,
        window: w,
        kind: e.supp.kind,
        slotHour,
        escalateAfterMin:
          e.supp.escalate_after_min ?? DEFAULT_ESCALATE_AFTER_MIN,
        escalateChatId: e.supp.escalate_chat_id,
      });
    }
  }
  if (candidates.length === 0) return { failed: false };

  const confirmed = getTakenDoseIds(profileId, date);
  const skipped = getSkippedDoseIds(profileId, date);
  const escalatedDoseIds = candidates
    .filter((c) => getProfileSetting(profileId, escKey(c.doseId)) === date)
    .map((c) => c.doseId);

  const due = escalationsDue({
    candidates,
    sentWindows,
    confirmedDoseIds: confirmed,
    skippedDoseIds: skipped,
    escalatedDoseIds,
    // The tick is hourly, so the elapsed check works at hour granularity.
    nowMinutes: hour * 60,
  });
  if (due.length === 0) return { failed: false };

  // DELIVERY. Every configured channel, through dispatch() — so Web Push and Home
  // Assistant finally receive the escalations their routing already promised, and a
  // failed send folds into the delivery-health marker like any other send. The
  // supplement's escalate_chat_id override (#615), when set, REPLACES the Telegram
  // fan-out for that item's message (per-item caregiver routing, unchanged in effect)
  // and rides as a dispatch option so the accounting still applies. The per-dose/day
  // marker is stamped once ANY channel took the message (the fire decision stays
  // profile+dose+day — one evaluation, unchanged).
  const deepLinkBase = getPublicUrl();

  let failed = false;
  for (const d of due) {
    const override = (d.escalateChatId ?? "").trim();
    const results = await dispatch(
      profileId,
      renderEscalationMessage(profileName, d, profileId, date, deepLinkBase),
      override ? { telegramChatIds: [override] } : undefined
    );
    if (results.length === 0) {
      // No configured channel at all — leave the marker unset so the next tick retries.
      log.info("escalation skipped: no configured channel", {
        profile: profileId,
        dose: d.doseId,
      });
      continue;
    }
    const anyDelivered = results.some((r) => r.ok);
    if (results.some((r) => !r.ok)) failed = true;
    if (anyDelivered) {
      setProfileSetting(profileId, escKey(d.doseId), date);
      log.info("escalated missed dose", {
        profile: profileId,
        dose: d.doseId,
        supp: d.supplementName,
      });
    }
  }
  return { failed };
}
