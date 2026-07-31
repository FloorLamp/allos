// SERVER-ACTION TIER — #1704 cross-writer pin: the web food bar and the Telegram nudge
// must produce the SAME meal_slot, and therefore the same #1016 slot-scoped button count,
// for the same tap.
//
// This is the guard that stops the drift recurring on the OTHER side. `meal_slot` exists
// so a window can be asserted rather than derived from the tap instant, and the two
// writers reach the one auth-blind core (logFoodServingCore / addProteinGramsCore) by
// different routes:
//
//   • web bar  — FoodLogBar posts group_key + date + meal_slot=<activeSlot> to the
//     logFoodServing Server Action, which parses meal_slot and forwards it.
//   • Telegram — handleFoodLog forwards the window baked into the callback token.
//
// Both are exercised here at the boundary each really uses (the action's FormData for the
// bar; the core call the handler makes for the nudge — the handler itself is driven
// end-to-end in lib/__db_tests__/food-nudge-late-tap-slot.test.ts), and the assertion is
// that the stored slot and the resulting counts are byte-identical. The tap instants are
// deliberately in a window that is NOT the asserted one, so a writer that dropped the slot
// would derive a different window and fail.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { logFoodServing } from "@/app/(app)/nutrition/actions";
import { logFoodServingCore } from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-log-write";
import { getFoodSlotServingsOnDate } from "@/lib/queries";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { createLogin, createProfile, actAs, fd } from "./harness";

const DATE = "2026-07-15";
// A tap instant well inside Midday under the default 11:00/15:00 boundaries, while both
// writers assert MORNING — the mismatch that made the Telegram count read 0 (#1704).
const LATE_TAP = `${DATE}T12:30:00Z`;
const ASSERTED = "Morning" as const;

function slotsFor(profileId: number, group: string): (string | null)[] {
  return (
    db
      .prepare(
        `SELECT meal_slot FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ?
          ORDER BY id`
      )
      .all(profileId, DATE, group) as { meal_slot: string | null }[]
  ).map((r) => r.meal_slot);
}

describe("web bar and Telegram nudge agree on meal_slot (#1704)", () => {
  it("both writers store the ASSERTED window and count in it, not the tap-derived one", async () => {
    const login = createLogin({ role: "admin" });
    const web = createProfile("Web Writer");
    const tg = createProfile("Telegram Writer");
    actAs(login, web);

    // ---- writer 1: the web one-tap bar, through its real Server Action ----
    // Exactly the FormData FoodLogBar.bump() sends (group_key + date + meal_slot).
    const res = await logFoodServing(
      fd({ group_key: "berries", date: DATE, meal_slot: ASSERTED })
    );
    expect(res.ok).toBe(true);

    // ---- writer 2: the Telegram nudge, through the call handleFoodLog now makes ----
    // The token's window is passed as the explicit slot; loggedAt stays the tap instant.
    logFoodServingCore(tg.id, "berries", DATE, LATE_TAP, ASSERTED);

    // Identical stored slot — the property that makes the two surfaces one computation.
    expect(slotsFor(web.id, "berries")).toEqual([ASSERTED]);
    expect(slotsFor(tg.id, "berries")).toEqual(slotsFor(web.id, "berries"));

    // …and therefore identical counts, in the asserted window and nowhere else.
    for (const p of [web.id, tg.id]) {
      expect(getFoodSlotServingsOnDate(p, ASSERTED, DATE).get("berries")).toBe(
        1
      );
      expect(
        getFoodSlotServingsOnDate(p, "Midday", DATE).get("berries")
      ).toBeUndefined();
    }
  });

  it("the protein sibling agrees the same way (#1073/#1379)", () => {
    const login = createLogin({ role: "admin" });
    const actor = createProfile("Protein Writer");
    actAs(login, actor);

    // The Telegram protein button's write: grams + the token's asserted window.
    addProteinGramsCore(actor.id, DATE, 30, LATE_TAP, ASSERTED);
    expect(slotsFor(actor.id, PROTEIN_NUDGE_KEY)).toEqual([ASSERTED]);
    expect(
      getFoodSlotServingsOnDate(actor.id, ASSERTED, DATE).get(PROTEIN_NUDGE_KEY)
    ).toBe(1);

    // The web quick-add asserts no window — it logs "now" — so its event stays derived,
    // which is the honest answer for that surface and must NOT be broken into a slot.
    addProteinGramsCore(actor.id, DATE, 30, LATE_TAP);
    expect(slotsFor(actor.id, PROTEIN_NUDGE_KEY)).toEqual([ASSERTED, null]);
    expect(
      getFoodSlotServingsOnDate(actor.id, "Midday", DATE).get(PROTEIN_NUDGE_KEY)
    ).toBe(1);
  });
});
