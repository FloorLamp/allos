// Pure rendering for the supplement reminder — kept DB-free so it's unit-tested
// (lib/__tests__). supplements.ts gathers a window's doses (with taken state and
// recent adherence) and hands them here. Listing already-taken doses (not just
// the pending ones) is what lets a reminder reflect what's been taken this
// session; once every dose is taken the same renderer produces a completion
// summary that lists what was taken, instead of a bare "all done". Each line
// carries its take-with (food) condition plus a streak + adherence percentage.

import type { AdherenceSummary } from "../supplement-adherence";
import { FOOD_TIMING_LABELS, PRIORITY_ORDER } from "../supplement-schedule";
import type { Supplement, SupplementDose } from "../types";
import type { NotificationMessage, NotificationAction } from "./types";

export type ReminderWindow = "Morning" | "Midday" | "Evening" | "Bedtime";

// A dose due in a window, paired with its supplement, whether it's already been
// logged today, and its adherence over the recent window (streak + percentage).
export interface WindowDose {
  dose: SupplementDose;
  supp: Supplement;
  taken: boolean;
  adherence: AdherenceSummary;
}

function byPriority(a: WindowDose, b: WindowDose): number {
  return (
    PRIORITY_ORDER[a.supp.priority] - PRIORITY_ORDER[b.supp.priority] ||
    a.supp.name.localeCompare(b.supp.name)
  );
}

// The take-with condition (food timing), lowercased for inline use; "" when it's
// "with or without food" (nothing worth saying).
function foodNote(dose: SupplementDose): string {
  return dose.food_timing === "any"
    ? ""
    : FOOD_TIMING_LABELS[dose.food_timing].toLowerCase();
}

// Streak (once it's worth celebrating) and adherence percentage, matching the
// supplements page's thresholds.
function adherenceNotes(a: AdherenceSummary): string[] {
  const notes: string[] = [];
  if (a.streak >= 2) notes.push(`🔥 ${a.streak}d`);
  if (a.pct !== null) notes.push(`${a.pct}%`);
  return notes;
}

// One body line: ✅ once taken, otherwise the priority marker (🔴 mandatory, •
// everything else), then the amount and a "·"-separated tail of the take-with
// condition (pending only — it's guidance for taking) and streak/adherence.
function doseLine(e: WindowDose, showFood: boolean): string {
  const amt = e.dose.amount ? ` — ${e.dose.amount}` : "";
  const mark = e.taken ? "✅ " : e.supp.priority === "mandatory" ? "🔴 " : "• ";
  const tail: string[] = [];
  if (showFood) {
    const food = foodNote(e.dose);
    if (food) tail.push(food);
  }
  tail.push(...adherenceNotes(e.adherence));
  const suffix = tail.length ? ` · ${tail.join(" · ")}` : "";
  return `${mark}${e.supp.name}${amt}${suffix}`;
}

// Build the message for a window from its entries. Pending doses (each with a
// tap, and its take-with condition shown) are listed first and already-taken
// ones after, so the message reflects what's been taken this session. When
// nothing is left pending the message becomes a completion summary — the title
// is marked done, the body lists every dose taken with its streak + adherence,
// and there are no buttons.
export function renderWindowMessage(
  profileId: number,
  window: ReminderWindow,
  date: string,
  entries: WindowDose[]
): NotificationMessage {
  const pending = entries.filter((e) => !e.taken).sort(byPriority);
  const taken = entries.filter((e) => e.taken).sort(byPriority);

  if (pending.length === 0) {
    const body = taken.map((e) => doseLine(e, false)).join("\n");
    return {
      title: `💊 ${window} supplements — all ${taken.length} taken ✅`,
      body,
    };
  }

  const body = [
    ...pending.map((e) => doseLine(e, true)),
    ...taken.map((e) => doseLine(e, false)),
  ].join("\n");
  // The dose + supplement id and date are baked into the token so a late tap
  // still logs the correct dose to the correct day.
  const actions: NotificationAction[] = pending.map(({ dose, supp }) => ({
    label: `✅ ${supp.name}`,
    data: `take:${profileId}:${dose.id}:${supp.id}:${date}`,
  }));
  // With more than one dose still pending, offer a single tap that marks the
  // whole session taken, above the per-dose buttons.
  if (pending.length >= 2) {
    actions.unshift({
      label: `✅ All (${pending.length})`,
      data: `all:${profileId}:${window}:${date}`,
    });
  }
  return { title: `💊 ${window} supplements`, body, actions };
}
