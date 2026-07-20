// Missed-dose escalation decision — pure, no DB/network, so
// it's unit-tested in lib/__tests__. Given the critical doses in play, which
// reminder windows actually went out today, what's been confirmed, what's already
// been escalated, and the current profile-local time, it returns exactly the
// escalations that are now due. The DB gather + Telegram send live in ./escalate.
//
// The rule for a critical dose to escalate: its window's reminder was delivered
// today, the dose is still unconfirmed, it hasn't already been escalated today,
// and enough time (escalateAfterMin) has elapsed since the window's slot hour.

import type { NotificationMessage } from "./types";
import type { LifecycleSuppressionPolicy } from "../lifecycle";
import { formatMedicationDoseProduct } from "../medication-dose-format";

export type EscalationWindow = "Morning" | "Midday" | "Evening" | "Bedtime";

// Missed-dose escalation is the FIRST lifecycle tenant (issue #942, #860 Track A): its
// suppression stage is declared here as the shared "safety-ungated" policy rather than
// left as the scattered "escalate.ts just never imports the bus" convention. This is
// the #449 carve-out expressed as DATA — a page dismissal must NEVER silence a
// possibly-critical medication escalation, so `isHiddenUnderPolicy(this, …)` is always
// false (pinned in lib/__tests__/lifecycle.test.ts). The escalation send path
// DELIBERATELY still never consults the bus at all — structural non-consultation is the
// stronger guarantee — so this constant is the lifecycle DECLARATION of that fact, and
// the notify-orchestrators harness proves a page-dismissed dose still escalates.
export const ESCALATION_SUPPRESSION_POLICY: LifecycleSuppressionPolicy =
  "safety-ungated";

// A single unconfirmed critical dose that COULD escalate; escalationsDue applies
// the timing/dedup rules to decide whether it actually does this tick.
export interface EscalationCandidate {
  doseId: number;
  supplementId: number;
  supplementName: string;
  amount: string | null;
  product?: string | null;
  window: EscalationWindow;
  // The window's scheduled reminder hour (0–23, profile-local), so the elapsed
  // check anchors on when the reminder went out.
  slotHour: number;
  // Minutes after the slot hour to wait before escalating an unconfirmed dose.
  escalateAfterMin: number;
  // Optional override chat for this escalation (else the profile's own chat).
  escalateChatId: string | null;
}

export interface EscalationDecisionInput {
  candidates: EscalationCandidate[];
  // Windows whose reminder was actually delivered today (the notify_last_supp_*
  // dedup markers). An undelivered window never escalates — there was no reminder
  // to miss.
  sentWindows: Iterable<EscalationWindow>;
  // Dose ids confirmed (taken) today.
  confirmedDoseIds: Iterable<number>;
  // Dose ids deliberately SKIPPED today (issue #232). A skip is a DECISION, not a
  // lapse, so a skipped critical dose must NOT escalate — the caregiver digest can
  // still show it ("2 skipped this week"), visibility without alarm.
  skippedDoseIds?: Iterable<number>;
  // Dose ids already escalated today (per-day/slot dedup).
  escalatedDoseIds: Iterable<number>;
  // Minutes since profile-local midnight (the hourly tick passes hour*60).
  nowMinutes: number;
}

export interface EscalationDue {
  doseId: number;
  supplementId: number;
  supplementName: string;
  amount: string | null;
  product?: string | null;
  window: EscalationWindow;
  escalateChatId: string | null;
}

// The hourly tick's clock never advances past 23:00: nowMinutes = hour*60 with
// hour ∈ [0,23], so its maximum is 23*60 = 1380. An escalation threshold beyond
// that final tick is unreachable and the escalation silently never fires — the
// shipped Bedtime slot (22:00) with the default 120-min wait computes 22*60+120 =
// 1440 (midnight). We clamp the effective threshold to the day's last tick so a
// late-evening critical dose still escalates once, at 23:00, instead of never.
//
// We deliberately do NOT wrap the escalation past midnight to recover it the next
// day: the per-dose escalation dedup marker (notify_last_esc_<dose>, set by
// ./escalate) is keyed only by the calendar date, so an escalation carried into
// and marked on the new day would then suppress that day's OWN real escalation —
// the same date-keyed drift ./schedule.ts avoids by not wrapping its retry hour.
// Clamping keeps every escalation same-day, so the existing once-per-episode
// dedup stays intact with no cross-midnight ambiguity. (#189)
const LAST_TICK_MINUTES = 23 * 60;

export function escalationsDue(
  input: EscalationDecisionInput
): EscalationDue[] {
  const sent = new Set(input.sentWindows);
  const confirmed = new Set(input.confirmedDoseIds);
  const skipped = new Set(input.skippedDoseIds ?? []);
  const escalated = new Set(input.escalatedDoseIds);

  const out: EscalationDue[] = [];
  for (const c of input.candidates) {
    if (!sent.has(c.window)) continue; // reminder never went out
    if (confirmed.has(c.doseId)) continue; // already taken
    if (skipped.has(c.doseId)) continue; // deliberately skipped — a decision (#232)
    if (escalated.has(c.doseId)) continue; // already escalated today
    // Clamp so a slotHour+escalateAfterMin past the day's last tick still fires
    // at 23:00 rather than never (see LAST_TICK_MINUTES). #189
    const threshold = Math.min(
      c.slotHour * 60 + c.escalateAfterMin,
      LAST_TICK_MINUTES
    );
    if (input.nowMinutes < threshold) continue;
    out.push({
      doseId: c.doseId,
      supplementId: c.supplementId,
      supplementName: c.supplementName,
      amount: c.amount,
      ...(c.product ? { product: c.product } : {}),
      window: c.window,
      escalateChatId: c.escalateChatId,
    });
  }
  return out;
}

// The escalation message. Always names the profile (escalations may land in a
// shared/caregiver chat where whose dose it is isn't obvious — see the chat-id
// ambiguity fix). Two caregiver buttons (issue #233): ✅ Confirmed taken routes
// through markDoseTaken's outcome union (a stale tap never falsely logs a critical
// med), and 👍 I'm on it acknowledges + suppresses re-nudge WITHOUT claiming the
// dose was taken. Both authorize by chat id — the escalation may go to the supp's
// escalate_chat_id, which the tap handler now accepts alongside the profile's own
// chat. The token carries ids only (profile/dose/supp) plus the day, so a late tap
// still resolves the right dose to the right date.
export function renderEscalationMessage(
  profileName: string,
  due: EscalationDue,
  profileId: number,
  date: string
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const dose = formatMedicationDoseProduct(due.amount, due.product);
  const amt = dose ? ` (${dose})` : "";
  const suppId = due.supplementId;
  return {
    title: `⚠️ Missed dose: ${who}${due.supplementName}`,
    body: `The ${due.window.toLowerCase()} dose of ${due.supplementName}${amt} hasn't been confirmed yet. Check in.`,
    kind: "escalation",
    actions: [
      {
        label: "✅ Confirmed taken",
        data: `esctake:${profileId}:${due.doseId}:${suppId}:${date}`,
        row: "esc",
      },
      {
        label: "👍 I'm on it",
        data: `escack:${profileId}:${due.doseId}:${suppId}:${date}`,
        row: "esc",
      },
    ],
  };
}
