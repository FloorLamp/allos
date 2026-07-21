// Pure rendering for the supplement reminder — kept DB-free so it's unit-tested
// (lib/__tests__). supplements.ts gathers a window's doses (with taken state and
// recent adherence) and hands them here. Listing already-taken doses (not just
// the pending ones) is what lets a reminder reflect what's been taken this
// session; once every dose is taken the same renderer produces a completion
// summary that lists what was taken, instead of a bare "all done". Each line
// carries its take-with (food) condition plus a streak + adherence percentage.

import type { AdherenceSummary } from "../supplement-adherence";
import {
  matchFoodInteractions,
  foodGuidanceReminderNote,
} from "../food-drug-interactions";
import { FOOD_TIMING_LABELS, PRIORITY_ORDER } from "../supplement-schedule";
import { parseRxcuiIngredients } from "../rxnorm";
import type { Supplement, SupplementDose, SupplementKind } from "../types";
import type { NotificationMessage, NotificationAction } from "./types";
import { formatMedicationDoseProduct } from "../medication-dose-format";

export type ReminderWindow = "Morning" | "Midday" | "Evening" | "Bedtime";

// The noun a reminder/summary uses for its items, chosen from the ACTUAL kinds in
// the window (#380): a medications-only profile — the archetypal elderly-parent
// caregiver setup — must not get prescription reminders titled "supplements". Both
// kinds present reads "supplements & meds" (matching the nav "Supplements & Meds").
// The bare "&" is escaped by the Telegram HTML renderer at send time.
export function intakeWindowNoun(kinds: Iterable<SupplementKind>): string {
  let hasMed = false;
  let hasSupp = false;
  for (const k of kinds) {
    if (k === "medication") hasMed = true;
    else hasSupp = true;
  }
  if (hasMed && hasSupp) return "supplements & meds";
  if (hasMed) return "medications";
  return "supplements";
}

// The SINGULAR adjectival form of the same kinds, for a "N ___ dose(s)" phrasing
// where the noun modifies "dose" ("3 medication doses", "1 supplement dose").
export function intakeItemNoun(kinds: Iterable<SupplementKind>): string {
  let hasMed = false;
  let hasSupp = false;
  for (const k of kinds) {
    if (k === "medication") hasMed = true;
    else hasSupp = true;
  }
  if (hasMed && hasSupp) return "supplement & med";
  if (hasMed) return "medication";
  return "supplement";
}

// A dose due in a window, paired with its supplement, whether it's already been
// taken or deliberately skipped (#232) today, and its adherence over the recent
// window (streak + percentage). A dose is "pending" only when neither taken nor
// skipped — both resolutions clear it from the reminder.
export interface WindowDose {
  dose: SupplementDose;
  supp: Supplement;
  taken: boolean;
  skipped: boolean;
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

// One body line: ✅ once taken, ⏭ once deliberately skipped (#232), otherwise the
// priority marker (🔴 mandatory, • everything else), then the amount and a
// "·"-separated tail of the take-with condition (pending only — it's guidance for
// taking) and streak/adherence.
function doseLine(
  e: WindowDose,
  showFood: boolean,
  age: number | null
): string {
  const doseDetail =
    e.supp.kind === "medication"
      ? formatMedicationDoseProduct(e.dose.amount, e.supp.product)
      : e.dose.amount;
  const amt = doseDetail ? ` — ${doseDetail}` : "";
  const mark = e.taken
    ? "✅ "
    : e.skipped
      ? "⏭ "
      : e.supp.priority === "mandatory"
        ? "🔴 "
        : "• ";
  const tail: string[] = [];
  if (showFood) {
    const food = foodNote(e.dose);
    if (food) tail.push(food);
    // Food–drug guidance (issue #154): a per-item food note for a matching
    // medication/supplement (e.g. "⚠️ Avoid grapefruit juice …"). Same pure
    // matcher the /medicine row + item-form notice format over. Pending doses
    // only — it's guidance for taking this dose now.
    //
    // SAFETY-TIER, DELIBERATELY UN-GATED (#435): this note rides the scheduled
    // dose reminder, a safety-tier send that is NOT bus-gated (a page dismissal must
    // never silence a possibly-critical medication reminder — the same #171/#227
    // reasoning as the dose reminder itself). So unlike the /medicine food-guidance
    // LINE (which carries a food-timing:<itemId>:<ruleId> key and is dismissible
    // through the findings bus), the reminder tail intentionally ignores those
    // dismissals and always appends the note when the dose is being reminded.
    const foodDrug = foodGuidanceReminderNote(
      matchFoodInteractions(
        {
          name: e.supp.name,
          rxcui: e.supp.rxcui,
          rxcuiIngredients: parseRxcuiIngredients(e.supp.rxcui_ingredients),
        },
        age
      )
    );
    if (foodDrug) tail.push(foodDrug);
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
  entries: WindowDose[],
  // The profile's age in whole years (issue #851 item 4), so an age-gated food note
  // (alcohol → adult) is dropped from a child's reminder tail. Null = unknown = shown.
  age: number | null = null
): NotificationMessage {
  const pending = entries
    .filter((e) => !e.taken && !e.skipped)
    .sort(byPriority);
  // Resolved doses (taken or skipped) list after the pending ones; ⏭ marks a skip.
  const resolved = entries.filter((e) => e.taken || e.skipped).sort(byPriority);

  // Name the items by their actual kinds so a medications-only window isn't
  // titled "supplements" (#380). Derived from every entry in the window (taken +
  // pending) so the noun is stable across the session's messages.
  const noun = intakeWindowNoun(entries.map((e) => e.supp.kind));

  if (pending.length === 0) {
    const takenN = resolved.filter((e) => e.taken).length;
    const skippedN = resolved.length - takenN;
    const body = resolved.map((e) => doseLine(e, false, age)).join("\n");
    // Title reflects the whole session: "all N taken" when nothing was skipped,
    // else a taken/skipped breakdown so a skip isn't misread as a take.
    const title =
      skippedN === 0
        ? `💊 ${window} ${noun} — all ${takenN} taken ✅`
        : `💊 ${window} ${noun} — ${takenN} taken · ${skippedN} skipped`;
    return { title, body };
  }

  const body = [
    ...pending.map((e) => doseLine(e, true, age)),
    ...resolved.map((e) => doseLine(e, false, age)),
  ].join("\n");
  // Each pending dose gets a ✅ take and a ⏭ skip button, side by side (same
  // `row` group). The dose + supplement id and date are baked into each token so
  // a late tap still resolves the correct dose to the correct day. There is NO
  // "skip all" — a blanket skip is a footgun (#232); skip stays per-dose only.
  const actions: NotificationAction[] = [];
  // With more than one dose still pending, offer a single tap that marks the
  // whole session taken, on its own row above the per-dose buttons.
  if (pending.length >= 2) {
    actions.push({
      label: `✅ All (${pending.length})`,
      data: `all:${profileId}:${window}:${date}`,
    });
  }
  for (const { dose, supp } of pending) {
    const row = `dose:${dose.id}`;
    actions.push({
      label: `✅ ${supp.name}`,
      data: `take:${profileId}:${dose.id}:${supp.id}:${date}`,
      row,
    });
    actions.push({
      label: "⏭ Skip",
      data: `skip:${profileId}:${dose.id}:${supp.id}:${date}`,
      row,
    });
  }
  return { title: `💊 ${window} ${noun}`, body, actions, kind: "dose" };
}
