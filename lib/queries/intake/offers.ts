// The `may` offer gather for one slot — the DB half of the digest's "➕ Doses" tail
// (#1505) and of the withheld line beside it (#5321).
//
// ITS OWN MODULE, and that is the point of the split rather than a side effect of it:
// `lib/queries/intake/adherence.ts` is the dose LEDGER — what was taken, skipped,
// corrected — and this asks the opposite question, what is merely available and has
// never been owed. It moved out under #5670 (a change into a file over 1,500 lines
// leaves it shorter), and it moved as a whole concern rather than as a slice. Every
// name is re-exported through the `lib/queries/intake` barrel, so no caller changed.

import { db, today } from "@/lib/db";
import {
  heldByWorkoutTiming,
  isOfferedOn,
  slotHintCoversNow,
} from "../../intake-schedule";
import { formatMedicationDoseProduct } from "../../medication-dose-format";
import { getSituations } from "../../settings";
import { intakeDayContext } from "./day-context";
import type { IntakeCondition, IntakeItemKind } from "../../types";

// ---- The offer tail's gather (issue #1505) --------------------------------

// The `may` items this profile may be OFFERED right now, scoped by their slot hint
// against the profile-local wall clock — the DB half of the "➕ Doses" tail.
//
// Two filters, both load-bearing and both evaluated at CALL time (which is TAP time
// for the tail): the item's day CONDITION must apply today (a rest-day magnesium is
// not offered on a training day), and its slot HINT must cover the current bucket (a
// bedtime item is not offered at breakfast). A hint-less item passes the second
// filter always — no hint means no opinion, and refusing to show it anywhere would
// make "may with no slot" unreachable, defeating the guaranteed-access rule.
//
// Unlike getPrnMedicationsForQuickLog this is NOT medication-only: `may` is a shape,
// not a kind, so a may supplement (magnesium, a preworkout) is offered on exactly the
// same terms as a PRN med. That is the whole point of the collapse — the two were
// always the same thing wearing different flags.
export interface OfferedIntakeItem {
  itemId: number;
  name: string;
  kind: IntakeItemKind;
  product: string | null;
  detail: string | null;
  countToday: number;
}

// The slot's offers AND what the workout timing gate is holding back from them, from
// ONE read (#5321). The digest wants both halves and must not pay twice for them: the
// row read, the day context and the slot filter are the same question, and a second
// call would mean a second `intakeDayContext` — a second timezone resolution per tick,
// on the path the budget gate in tick-gather-budget.test.ts measures.
//
// `heldByWorkoutTiming` is the item NAMES, not rows: the only reader is a message line
// that names them (offerHeldByWorkoutLine), and returning rows would invite a second
// surface to start offering what this set exists to say is NOT offered.
export interface SlotIntakeOffers {
  offered: OfferedIntakeItem[];
  heldByWorkoutTiming: string[];
}

export function getOfferedIntakeForSlot(
  profileId: number,
  nowHhmm: string
): OfferedIntakeItem[] {
  return getIntakeOffersForSlot(profileId, nowHhmm).offered;
}

export function getIntakeOffersForSlot(
  profileId: number,
  nowHhmm: string
): SlotIntakeOffers {
  const date = today(profileId);
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.name AS name, s.kind AS kind, s.product AS product,
              s.condition AS condition, s.situation AS situation,
              s.pause_situation_id AS pauseSituationId,
              (SELECT d.amount FROM intake_item_doses d
                WHERE d.item_id = s.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS amount,
              (SELECT d.time_of_day FROM intake_item_doses d
                WHERE d.item_id = s.id AND d.retired = 0
                ORDER BY d.sort, d.id LIMIT 1) AS timeOfDay,
              (SELECT COUNT(*) FROM intake_item_logs l
                WHERE l.item_id = s.id AND l.date = ? AND l.status = 'taken')
                AS countToday
         FROM intake_items s
        WHERE s.profile_id = ? AND s.active = 1 AND s.obligation = 'may'
        ORDER BY s.name, s.id`
    )
    .all(date, profileId) as {
    id: number;
    name: string;
    kind: IntakeItemKind;
    product: string | null;
    condition: IntakeCondition;
    situation: string | null;
    pauseSituationId: number | null;
    amount: string | null;
    timeOfDay: string | null;
    countToday: number;
  }[];
  if (rows.length === 0) return { offered: [], heldByWorkoutTiming: [] };

  // The day context, resolved ONCE per call, THROUGH THE SHARED BUILDER (#5321) — so
  // an offer cannot disagree with the medications page about the same item on the same
  // day. That includes the field this gather used to leave out: `postWorkoutReady` is
  // read as `?? true`, so omitting it did not lose a condition, it defaulted to
  // permissive and put a post-workout dose one tap away while the page still held it.
  // The sheet is tapped LIVE, so the live verdict is the right one here.
  const ctx = intakeDayContext(profileId, date);
  const pauseNames = new Map(
    getSituations(profileId).map((s) => [s.id, s.name])
  );

  // The slot hint is applied FIRST and to both halves, so the withheld line can only
  // name an item that would otherwise be on offer in this very slot. Naming a bedtime
  // item at breakfast as "waiting" would be true and useless.
  const inSlot = rows.filter((r) => slotHintCoversNow(r.timeOfDay, nowHhmm));
  const itemFor = (r: (typeof inSlot)[number]) => ({
    obligation: "may" as const,
    condition: r.condition,
    situation: r.situation,
    pause_situation:
      r.pauseSituationId != null
        ? (pauseNames.get(r.pauseSituationId) ?? null)
        : null,
  });
  return {
    offered: inSlot
      .filter((r) => isOfferedOn(itemFor(r), ctx))
      .map((r) => ({
        itemId: r.id,
        name: r.name,
        kind: r.kind,
        product: r.product,
        detail:
          r.kind === "medication"
            ? formatMedicationDoseProduct(r.amount, r.product)
            : r.amount,
        countToday: r.countToday,
      })),
    heldByWorkoutTiming: inSlot
      .filter((r) => heldByWorkoutTiming(itemFor(r), ctx))
      .map((r) => r.name),
  };
}
