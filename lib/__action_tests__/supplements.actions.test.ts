// SERVER-ACTION TIER — supplement/intake write path.
//
// Covers addSupplement (manual source), the refill invariant on toggleTaken
// (decrement on confirm / re-increment on untoggle), toggleActive, a
// kind='medication' create, and the updateSupplement dose reconcile —
// specifically that a schedule edit can never destroy or rewrite adherence
// history (removed-but-logged doses are retired, not cascaded; confirmed
// amounts are snapshotted onto the log).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
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

describe("updateSupplement dose reconcile", () => {
  const dosesJson = (
    doses: {
      id?: number;
      amount: string;
      time_of_day: string;
    }[]
  ) => JSON.stringify(doses.map((d) => ({ ...d, food_timing: "any" })));

  async function seedSplitDose() {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Omega-3",
        doses: dosesJson([
          { amount: "500 mg", time_of_day: "08:00" },
          { amount: "500 mg", time_of_day: "20:00" },
        ]),
      })
    );
    const suppId = getSupplements(profile.id)[0].id;
    const [morning, evening] = getSupplementDoses(profile.id);
    return { profile, suppId, morning, evening };
  }

  function doseRow(id: number) {
    return db
      .prepare("SELECT amount, retired FROM intake_item_doses WHERE id = ?")
      .get(id) as { amount: string | null; retired: number } | undefined;
  }

  it("retires a removed dose that has logs; hard-deletes an unlogged one", async () => {
    const { profile, suppId, morning, evening } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));

    // Restructure 2×500 mg → 1×1000 mg: neither old dose is resubmitted.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([{ amount: "1000 mg", time_of_day: "08:00" }]),
      })
    );

    // The logged dose is RETIRED — its row and taken-history survive. Before
    // the retired flag this DELETE cascaded the log away (history destroyed).
    expect(doseRow(morning.id)?.retired).toBe(1);
    expect(logCount(morning.id, date)).toBe(1);
    // The never-logged dose is hard-deleted (nothing referenced it).
    expect(doseRow(evening.id)).toBeUndefined();
    // The current schedule shows only the new dose.
    const current = getSupplementDoses(profile.id);
    expect(current).toHaveLength(1);
    expect(current[0].amount).toBe("1000 mg");
  });

  it("a later edit leaves already-retired doses untouched", async () => {
    const { profile, suppId, morning } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([{ amount: "1000 mg", time_of_day: "08:00" }]),
      })
    );
    const keptId = getSupplementDoses(profile.id)[0].id;

    // Second edit resubmits only the live dose (as the form does) — the
    // retired row must not be swept up by the reconcile's delete.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([
          { id: keptId, amount: "1000 mg", time_of_day: "09:00" },
        ]),
      })
    );
    expect(doseRow(morning.id)?.retired).toBe(1);
    expect(logCount(morning.id, date)).toBe(1);
  });

  it("an in-place amount edit keeps the dose id but not the logged amount", async () => {
    const { profile, suppId, morning, evening } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));

    // Brand switch, same schedule shape: both doses resubmitted WITH ids.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        brand: "NewBrand",
        doses: dosesJson([
          { id: morning.id, amount: "1000 mg", time_of_day: "08:00" },
          { id: evening.id, amount: "1000 mg", time_of_day: "20:00" },
        ]),
      })
    );

    // Same dose row (Telegram buttons carrying the id stay valid), log intact…
    expect(doseRow(morning.id)).toEqual({ amount: "1000 mg", retired: 0 });
    expect(logCount(morning.id, date)).toBe(1);
    // …and the log still records what was ACTUALLY taken (500 mg), not the
    // post-edit amount — history is snapshotted at confirm time.
    const log = db
      .prepare(
        "SELECT amount FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(morning.id, date) as { amount: string | null };
    expect(log.amount).toBe("500 mg");
  });

  it("toggleTaken refuses a retired dose", async () => {
    const { profile, suppId, morning } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([{ amount: "1000 mg", time_of_day: "08:00" }]),
      })
    );

    // A second toggle on the retired dose must be a no-op — NOT an untoggle
    // that deletes the historical log.
    await toggleTaken(fd({ dose_id: morning.id }));
    expect(logCount(morning.id, date)).toBe(1);
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
