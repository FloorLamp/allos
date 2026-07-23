// Missed-dose escalation orchestration. Gathers the critical
// unconfirmed doses for a profile from already-scoped queries, runs the pure
// escalationsDue decision, and sends a nudge over Telegram (to escalate_chat_id
// when set, else the profile's own chat). Called once per hour from the notify
// tick, independently of whether any reminder slot is due this hour.

import { collectWindowDoses, getPreWorkoutSlotHour } from "./supplements";
import { escalationMarkerKey } from "./escalation-keys";
import {
  escalationsDue,
  renderEscalationMessage,
  type EscalationCandidate,
  type EscalationWindow,
} from "./escalation";
import { sendTelegramMessage } from "./telegram";
import { resolveTelegramRecipients } from "./fan-out";
import { getTakenDoseIds, getSkippedDoseIds } from "../queries";
import {
  getProfileSetting,
  setProfileSetting,
  getTelegramBotConfig,
  type NotifySchedule,
} from "../settings";
import { createLogger } from "../log";

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
  // workout-relative hour. This gather deliberately reads the UNFILTERED
  // collectWindowDoses — the #1156 priority floor never gates the safety tier,
  // so a low-priority CRITICAL item still escalates once its slot's reminder
  // went out.
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
    if (getProfileSetting(profileId, `notify_last_supp_${w}`) !== date)
      continue;
    sentWindows.push(w);
    for (const e of collectWindowDoses(profileId, w, date)) {
      if (!e.supp.critical) continue;
      candidates.push({
        doseId: e.dose.id,
        supplementId: e.supp.id,
        supplementName: e.supp.name,
        amount: e.dose.amount,
        product: e.supp.kind === "medication" ? e.supp.product : null,
        window: w,
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

  // Delivery gate: the bot must be configured. Missed-dose escalation is SAFETY-tier
  // and FANS OUT to every managing login's chat (issue #1072: a co-parent gets the
  // kid's escalation — the #858 co-caregiver intent, structural instead of dependent
  // on a shared chat id). A supplement's escalate_chat_id override, when set, targets
  // that ONE explicit caregiver chat INSTEAD (unchanged) — an intentional per-item
  // routing that predates the fan-out. Fan-out recipients are deduped by chat id so a
  // shared family group never double-fires. Per-recipient send failures are folded,
  // and the per-dose/day marker is stamped once any recipient took the message (the
  // fire decision stays profile+dose+day — one evaluation, unchanged).
  const { telegramBotToken } = getTelegramBotConfig();
  if (!telegramBotToken) {
    log.info("escalation skipped: no bot", { profile: profileId });
    return { failed: false };
  }
  const fanRecipients = resolveTelegramRecipients(profileId);

  let failed = false;
  for (const d of due) {
    const override = (d.escalateChatId ?? "").trim();
    // The override supersedes the fan-out (per-item caregiver routing); else fan out
    // to every managing login's chat. Deduped so a chat that ALSO appears in the
    // fan-out isn't double-hit when an override matches it.
    const targets = override ? [override] : fanRecipients.map((r) => r.chatId);
    if (targets.length === 0) {
      log.info("escalation skipped: no target chat", {
        profile: profileId,
        dose: d.doseId,
      });
      continue;
    }
    let anyDelivered = false;
    for (const target of Array.from(new Set(targets))) {
      try {
        await sendTelegramMessage(
          target,
          renderEscalationMessage(profileName, d, profileId, date)
        );
        anyDelivered = true;
        log.info("escalated missed dose", {
          profile: profileId,
          dose: d.doseId,
          supp: d.supplementName,
        });
      } catch (e) {
        failed = true;
        log.error("escalation send failed", {
          profile: profileId,
          dose: d.doseId,
          err: e instanceof Error ? e : String(e),
        });
      }
    }
    // Mark the dose escalated for the day once ANY recipient received it (the
    // "delivered = at least one recipient ok" semantics the dose-reminder slots use):
    // the safety signal reached a caregiver, so it never re-nags today. A send where
    // EVERY recipient failed leaves the marker unset so the next hour retries.
    if (anyDelivered) setProfileSetting(profileId, escKey(d.doseId), date);
  }
  return { failed };
}
