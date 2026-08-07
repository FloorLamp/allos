// SERVER-ACTION TIER — #1704 cross-writer pin: the web food bar and the Telegram nudge
// must produce the SAME meal_slot, and therefore the same derived WINDOW, for the same
// tap. (The #1016 slot-scoped button count this used to be asserted through was retired
// by #2019 and its query deleted by #2227; the window itself — foodEventWindow, the
// derivation every live tally and placement reads — is what the writers must agree on.)
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
import { foodEventWindow } from "@/lib/food-slot-count";
import { profileFoodSlotBoundaries } from "@/lib/profile-food-slot";
import { getTimezone } from "@/lib/settings";
import { type FoodSlot } from "@/lib/food-slot";
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

// The WINDOW each of the group's events derives to, in ledger order — foodEventWindow
// directly, the one derivation every live tally and placement reads (the retired
// slot-count query used to stand here; #2019/#2227). Works for the reserved __protein__
// row too, which the web meal grouping deliberately filters out.
function derivedWindows(profileId: number, group: string): FoodSlot[] {
  const tz = getTimezone(profileId);
  const boundaries = profileFoodSlotBoundaries(profileId);
  return (
    db
      .prepare(
        `SELECT logged_at, meal_slot, eaten_at FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ?
          ORDER BY id`
      )
      .all(profileId, DATE, group) as {
      logged_at: string;
      meal_slot: FoodSlot | null;
      eaten_at: string | null;
    }[]
  ).map((r) =>
    foodEventWindow(r.logged_at, tz, boundaries, r.meal_slot, r.eaten_at)
  );
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

    // …and therefore an identical derived window — the ASSERTED one, not the Midday
    // the tap instant would have guessed. One window per event, so "and nowhere else"
    // holds by construction.
    for (const p of [web.id, tg.id]) {
      expect(derivedWindows(p, "berries")).toEqual([ASSERTED]);
    }
  });

  it("the protein sibling agrees the same way (#1073/#1379)", () => {
    const login = createLogin({ role: "admin" });
    const actor = createProfile("Protein Writer");
    actAs(login, actor);

    // The Telegram protein button's write: grams + the token's asserted window.
    addProteinGramsCore(actor.id, DATE, 30, LATE_TAP, ASSERTED);
    expect(slotsFor(actor.id, PROTEIN_NUDGE_KEY)).toEqual([ASSERTED]);
    expect(derivedWindows(actor.id, PROTEIN_NUDGE_KEY)).toEqual([ASSERTED]);

    // The web quick-add asserts no window — it logs "now" — so its event stays derived,
    // which is the honest answer for that surface and must NOT be broken into a slot:
    // the second event's window comes from its tap instant (Midday), not the first
    // event's assertion.
    addProteinGramsCore(actor.id, DATE, 30, LATE_TAP);
    expect(slotsFor(actor.id, PROTEIN_NUDGE_KEY)).toEqual([ASSERTED, null]);
    expect(derivedWindows(actor.id, PROTEIN_NUDGE_KEY)).toEqual([
      ASSERTED,
      "Midday",
    ]);
  });
});
