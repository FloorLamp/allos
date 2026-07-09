// SERVER-ACTION TIER — supplement/intake write path.
//
// Covers addSupplement (manual source), the refill invariant on toggleTaken
// (decrement on confirm / re-increment on untoggle), toggleActive, and a
// kind='medication' create.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  addSupplement,
  toggleTaken,
  toggleActive,
} from "@/app/(app)/medicine/actions";
import { getSupplements, getSupplementDoses } from "@/lib/queries";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function itemRow(id: number) {
  return db
    .prepare(
      "SELECT id, name, kind, source, active, quantity_on_hand, qty_per_dose, prescriber FROM intake_items WHERE id = ?"
    )
    .get(id) as {
    id: number;
    name: string;
    kind: string;
    source: string;
    active: number;
    quantity_on_hand: number | null;
    qty_per_dose: number;
    prescriber: string | null;
  };
}

function logCount(doseId: number, date: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { c: number }
  ).c;
}

beforeEach(() => revalidate.mockClear());

describe("addSupplement", () => {
  it("creates a manual-source supplement with a dose", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Creatine", condition: "daily", priority: "high" })
    );

    const items = getSupplements(profile.id);
    expect(items).toHaveLength(1);
    const row = itemRow(items[0].id);
    expect(row.name).toBe("Creatine");
    expect(row.kind).toBe("supplement");
    expect(row.source).toBe("manual");
    // parseDoses always yields at least one dose row.
    expect(getSupplementDoses(profile.id)).toHaveLength(1);
    expect(revalidate).toHaveBeenCalledWith("/medicine");
  });

  it("blank name is rejected (no row)", async () => {
    const { profile } = seedActor();
    await addSupplement(fd({ name: "   " }));
    expect(getSupplements(profile.id)).toHaveLength(0);
  });

  it("creates a kind='medication' row with prescriber", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Lisinopril", kind: "medication", prescriber: "Dr House" })
    );
    const items = getSupplements(profile.id);
    const row = itemRow(items[0].id);
    expect(row.kind).toBe("medication");
    expect(row.prescriber).toBe("Dr House");
  });
});

describe("toggleTaken refill invariant", () => {
  it("confirm decrements on-hand by qty_per_dose; untoggle re-increments", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Vitamin D", quantity_on_hand: 10, qty_per_dose: 2 })
    );
    const suppId = getSupplements(profile.id)[0].id;
    const doseId = getSupplementDoses(profile.id)[0].id;
    const date = today(profile.id);

    // Confirm: log inserted AND supply drops 10 → 8.
    await toggleTaken(fd({ dose_id: doseId }));
    expect(logCount(doseId, date)).toBe(1);
    expect(itemRow(suppId).quantity_on_hand).toBe(8);

    // Untoggle: log removed AND supply restored 8 → 10.
    await toggleTaken(fd({ dose_id: doseId }));
    expect(logCount(doseId, date)).toBe(0);
    expect(itemRow(suppId).quantity_on_hand).toBe(10);
  });

  it("a dose belonging to another profile cannot be toggled", async () => {
    // Owner seeds a tracked supplement.
    const owner = seedActor();
    await addSupplement(
      fd({ name: "Zinc", quantity_on_hand: 5, qty_per_dose: 1 })
    );
    const suppId = getSupplements(owner.profile.id)[0].id;
    const foreignDoseId = getSupplementDoses(owner.profile.id)[0].id;

    // A different actor tries to toggle the owner's dose id.
    const attacker = seedActor();
    await toggleTaken(fd({ dose_id: foreignDoseId }));

    // No log created and the owner's supply is untouched.
    expect(logCount(foreignDoseId, today(owner.profile.id))).toBe(0);
    expect(itemRow(suppId).quantity_on_hand).toBe(5);
    expect(getSupplements(attacker.profile.id)).toHaveLength(0);
  });
});

describe("toggleActive", () => {
  it("flips the active flag for the acting profile's item", async () => {
    const { profile } = seedActor();
    await addSupplement(fd({ name: "Magnesium" }));
    const id = getSupplements(profile.id)[0].id;
    expect(itemRow(id).active).toBe(1);

    await toggleActive(fd({ id }));
    expect(itemRow(id).active).toBe(0);
  });
});
