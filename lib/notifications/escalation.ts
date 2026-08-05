// Missed-dose escalation decision — pure, no DB/network, so
// it's unit-tested in lib/__tests__. Given the critical doses in play, which
// reminder windows actually went out today, what's been confirmed, what's already
// been escalated, and the current profile-local time, it returns exactly the
// escalations that are now due. The DB gather + Telegram send live in ./escalate.
//
// The rule for a critical dose to escalate: its window's reminder was delivered
// today, the dose is still unconfirmed, it hasn't already been escalated today,
// and enough time (escalateAfterMin) has elapsed since the window's slot hour.

import type { NotificationAction, NotificationMessage } from "./types";
import type { LifecycleSuppressionPolicy } from "../lifecycle";
import type { SupplementKind } from "../types/intake";
import { formatMedicationDoseProduct } from "../medication-dose-format";
import { intakeHref } from "../hrefs";

// The send slots escalation chases: the four fixed windows plus the PreWorkout
// pseudo-slot (#1154) — a critical `anytime` pre_workout dose whose reminder
// moved to the workout-relative send must keep its missed-dose safety net.
export type EscalationWindow =
  "Morning" | "Midday" | "Evening" | "Bedtime" | "PreWorkout";

// Human phrase for the message body ("the pre-workout dose of …").
export function escalationWindowPhrase(w: EscalationWindow): string {
  return w === "PreWorkout" ? "pre-workout" : w.toLowerCase();
}

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
  // Which surface the item lives on, so the message can carry the right deep link
  // (#1716) — a medication points at Medications, a supplement at the Supplements tab.
  kind: SupplementKind;
  // The window's scheduled reminder minute of day (0–1439, profile-local), so the
  // elapsed check anchors on when the reminder went out (#2121 minute grain).
  slotMinute: number;
  // Minutes after the slot time to wait before escalating an unconfirmed dose.
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
  // Minutes since profile-local midnight (the tick passes the real minute of day
  // since #2121 — no longer quantised to hour*60, so finer ticks shrink the
  // escalation latency by construction).
  nowMinutes: number;
}

export interface EscalationDue {
  doseId: number;
  supplementId: number;
  supplementName: string;
  amount: string | null;
  product?: string | null;
  window: EscalationWindow;
  kind: SupplementKind;
  // Minutes since the window's own slot hour — the fact that MADE this fire, which
  // the message states outright (#1716). Anchored on the slot, not on the escalation
  // threshold: "unconfirmed for 2h 40m" is time since the dose was due, which is what
  // a caregiver is deciding on.
  unconfirmedMinutes: number;
  escalateChatId: string | null;
}

// The day's last GUARANTEED tick is 23:00: the coarsest supported scheduler (a
// host crontab on `0 * * * *`) never advances nowMinutes past 23*60 = 1380. An
// escalation threshold beyond that tick would be unreachable on such a deployment
// and the escalation would silently never fire — the shipped Bedtime slot (22:00)
// with the default 120-min wait computes 22*60+120 = 1440 (midnight). We clamp
// the effective threshold to that last guaranteed tick so a late-evening critical
// dose still escalates once, by 23:00, instead of never. The clamp deliberately
// stays at the HOURLY deployment's final tick even now that the sidecar ticks
// finer (#2121): a finer tick fires the clamped escalation a few minutes earlier
// at worst, while raising the clamp would make hourly deployments skip it.
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
    // Clamp so a slotMinute+escalateAfterMin past the day's last guaranteed tick
    // still fires by 23:00 rather than never (see LAST_TICK_MINUTES). #189
    const threshold = Math.min(
      c.slotMinute + c.escalateAfterMin,
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
      kind: c.kind,
      unconfirmedMinutes: Math.max(0, input.nowMinutes - c.slotMinute),
      escalateChatId: c.escalateChatId,
    });
  }
  return out;
}

// How long a dose has been unconfirmed, in the redose formatter's phrasing register
// (`redose-format.ts` is the audit's exemplar): "2h 40m", "3h", "45m". Never invents
// precision it doesn't have — a whole-hour elapsed drops the minutes half, and under
// an hour reads in minutes alone.
export function elapsedLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// The escalation message. Always names the profile (escalations may land in a
// shared/caregiver chat where whose dose it is isn't obvious — see the chat-id
// ambiguity fix).
//
// THE BODY STATES THE FACT THAT MADE IT FIRE (#1716): the slot AND how long the dose
// has been unconfirmed. "hasn't been confirmed yet. Check in." never said how long,
// though the elapsed time was computed to decide the send in the first place.
//
// THREE caregiver affordances, not two (#233 + #1716): ✅ Confirmed taken routes
// through markDoseTaken's outcome union (a stale tap never falsely logs a critical
// med), ⏭ Skip records the DELIBERATE decision through markDoseSkipped — exactly the
// dose reminder's own precedent, and a skipped dose already ends the escalation loop —
// and 👍 I'm on it acknowledges + suppresses re-nudge WITHOUT claiming the dose was
// taken. Without Skip, "we decided not to give it" forced a false confirm, an
// indefinite ack, or an app visit. All three authorize by chat id — the escalation may
// go to the supp's escalate_chat_id, which the tap handler accepts alongside the
// profile's own chat. The token carries ids only (profile/dose/supp) plus the day, so
// a late tap still resolves the right dose to the right date. A deep link rides along
// when a public URL is configured (every sibling builder carries one).
export function renderEscalationMessage(
  profileName: string,
  due: EscalationDue,
  profileId: number,
  date: string,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const dose = formatMedicationDoseProduct(due.amount, due.product);
  const amt = dose ? ` (${dose})` : "";
  const suppId = due.supplementId;
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] = [
    {
      label: "✅ Confirmed taken",
      data: `esctake:${profileId}:${due.doseId}:${suppId}:${date}`,
      row: "esc",
    },
    {
      label: "⏭ Skip",
      data: `escskip:${profileId}:${due.doseId}:${suppId}:${date}`,
      row: "esc",
    },
    {
      label: "👍 I'm on it",
      data: `escack:${profileId}:${due.doseId}:${suppId}:${date}`,
      row: "esc",
    },
  ];
  if (base) {
    actions.push({
      label:
        due.kind === "medication" ? "Open medications →" : "Open supplements →",
      url: `${base}${intakeHref(due.kind)}`,
    });
  }
  return {
    title: `⚠️ Missed dose: ${who}${due.supplementName}`,
    body:
      `${due.supplementName}${amt} — ${escalationWindowPhrase(due.window)} slot, ` +
      `unconfirmed for ${elapsedLabel(due.unconfirmedMinutes)}.`,
    kind: "escalation",
    actions,
  };
}
