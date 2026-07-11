// Missed-dose escalation orchestration. Gathers the critical
// unconfirmed doses for a profile from already-scoped queries, runs the pure
// escalationsDue decision, and sends a nudge over Telegram (to escalate_chat_id
// when set, else the profile's own chat). Called once per hour from the notify
// tick, independently of whether any reminder slot is due this hour.

import { collectWindowDoses } from "./supplements";
import { escalationMarkerKey } from "./escalation-keys";
import {
  escalationsDue,
  renderEscalationMessage,
  type EscalationCandidate,
  type EscalationWindow,
} from "./escalation";
import { sendTelegramMessage } from "./telegram";
import { getTakenDoseIds, getSkippedDoseIds } from "../queries";
import {
  getProfileSetting,
  setProfileSetting,
  getProfileTelegram,
  getTelegramBotConfig,
  type NotifySchedule,
} from "../settings";
import { createLogger } from "../log";

const log = createLogger("notify");

const WINDOWS: EscalationWindow[] = ["Morning", "Midday", "Evening", "Bedtime"];

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
  // Gather critical, unconfirmed candidates only from windows whose reminder was
  // actually delivered today — there's no missed dose to chase otherwise.
  const candidates: EscalationCandidate[] = [];
  const sentWindows: EscalationWindow[] = [];
  for (const w of WINDOWS) {
    const slotHour = sched.supplementHours[w];
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

  // Delivery gate: the bot must be configured and this profile's Telegram
  // enabled. The target chat is the escalation override when set, else the
  // profile's own chat.
  const { telegramBotToken } = getTelegramBotConfig();
  const { telegramEnabled, telegramChatId } = getProfileTelegram(profileId);
  if (!telegramBotToken || !telegramEnabled) {
    log.info("escalation skipped: no channel", { profile: profileId });
    return { failed: false };
  }

  let failed = false;
  for (const d of due) {
    const target = (d.escalateChatId ?? "").trim() || telegramChatId;
    if (!target) {
      log.info("escalation skipped: no target chat", {
        profile: profileId,
        dose: d.doseId,
      });
      continue;
    }
    try {
      await sendTelegramMessage(
        target,
        renderEscalationMessage(profileName, d, profileId, date)
      );
      setProfileSetting(profileId, escKey(d.doseId), date);
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
  return { failed };
}
