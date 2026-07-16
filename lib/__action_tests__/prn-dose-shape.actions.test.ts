// SERVER-ACTION TIER — a PRN (as-needed) medication collapses to a single
// amount-only dose (#851 item 9). A scheduled item keeps its per-slot doses; a PRN
// med has no schedule, so its multiple slotted dose rows collapse to ONE dose with a
// NULL time_of_day (the amount + food-timing of the first row preserved). The collapse
// is collapsePrnDoses, applied by addSupplement/updateSupplement before insert; these
// drive the real actions and read back the stored dose rows.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";
import { seedActor, fd } from "./harness";

vi.mocked(revalidatePath);

function lastItemId(): number {
  return Number(
    (
      db.prepare("SELECT MAX(id) AS id FROM intake_items").get() as {
        id: number;
      }
    ).id
  );
}

function liveDoses(itemId: number) {
  return db
    .prepare(
      `SELECT id, amount, time_of_day, food_timing
         FROM intake_item_doses
        WHERE item_id = ? AND retired = 0
        ORDER BY sort, id`
    )
    .all(itemId) as {
    id: number;
    amount: string | null;
    time_of_day: string | null;
    food_timing: string;
  }[];
}

const TWO_SLOTTED = JSON.stringify([
  { amount: "200 mg", time_of_day: "Morning", food_timing: "with_food" },
  { amount: "200 mg", time_of_day: "Evening", food_timing: "any" },
]);

beforeEach(() => {
  seedActor();
});

describe("PRN medication dose collapse (#851 item 9)", () => {
  it("collapses two slotted doses to ONE amount-only dose (time_of_day NULL, food preserved)", async () => {
    const r = await addSupplement(
      fd({
        name: "Ibuprofen",
        kind: "medication",
        as_needed: "1",
        doses: TWO_SLOTTED,
      })
    );
    expect(r.ok).toBe(true);
    const doses = liveDoses(lastItemId());
    expect(doses).toHaveLength(1);
    expect(doses[0].time_of_day).toBeNull();
    expect(doses[0].amount).toBe("200 mg");
    // The first row's food timing rides onto the collapsed dose.
    expect(doses[0].food_timing).toBe("with_food");
  });

  it("keeps BOTH slotted doses for a SCHEDULED medication (no collapse)", async () => {
    const r = await addSupplement(
      fd({
        name: "Lisinopril",
        kind: "medication",
        // as_needed omitted ⇒ scheduled
        doses: TWO_SLOTTED,
      })
    );
    expect(r.ok).toBe(true);
    const doses = liveDoses(lastItemId());
    expect(doses).toHaveLength(2);
    expect(doses.map((d) => d.time_of_day)).toEqual(["Morning", "Evening"]);
  });
});
