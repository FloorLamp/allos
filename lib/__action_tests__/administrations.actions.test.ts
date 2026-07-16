// SERVER-ACTION TIER — the PRN quick-log write path (logMedicationAdministration,
// #797). Drives the real Server Action (its auth gate + offset parsing) against the
// in-memory DB, mirroring the harness auth mock. Covers: a "now" log, retro offsets
// (30m/1h), the custom same-day time path, the double-tap dedup, and the invalid-
// custom-time / stale-item error returns. The core's own semantics (multiples,
// supply, window guard) are pinned in the DB tier; this tier proves the ACTION wires
// the offset → given_at → core correctly and returns the right FormResult.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
});

// A PRN medication (as_needed=1) with one dose + tracked supply, owned by `profileId`.
function seedPrnMed(profileId: number, quantityOnHand = 10): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed, quantity_on_hand, qty_per_dose)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'high', 1, ?, 1)`
      )
      .run(profileId, quantityOnHand).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', 'any', 'any', 0)`
  ).run(itemId);
  return itemId;
}

function adminRows(itemId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ? AND status = 'taken'"
      )
      .get(itemId) as { c: number }
  ).c;
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

describe("logMedicationAdministration action (#797)", () => {
  it("logs a 'now' administration, decrements supply, and revalidates", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "now" })
    );
    expect(res.ok).toBe(true);
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9);
    expect(revalidate).toHaveBeenCalledWith("/medications");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("logs a retro offset (30m ago) as a distinct administration", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // now, then 30m-ago → two rows (well outside the dedup window).
    expect(
      (await logMedicationAdministration(fd({ id: itemId, offset: "now" }))).ok
    ).toBe(true);
    expect(
      (await logMedicationAdministration(fd({ id: itemId, offset: "30m" }))).ok
    ).toBe(true);
    expect(adminRows(itemId)).toBe(2);
    expect(onHand(itemId)).toBe(8);
  });

  it("logs a custom same-day time via the wall-time → instant conversion", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // 00:01 today is always in the past (guard-safe) regardless of when the test runs.
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "custom", time: "00:01" })
    );
    expect(res.ok).toBe(true);
    const row = db
      .prepare(
        "SELECT given_at FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(itemId) as { given_at: string };
    // Stored as a UTC "YYYY-MM-DD HH:MM:SS" instant (not the raw wall string).
    expect(row.given_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("rejects a malformed custom time without writing", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "custom", time: "not-a-time" })
    );
    expect(res.ok).toBe(false);
    expect(adminRows(itemId)).toBe(0);
  });

  it("collapses an immediate double-submit (now) to one administration", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // Two "now" submits in quick succession are within the dedup window.
    await logMedicationAdministration(fd({ id: itemId, offset: "now" }));
    const second = await logMedicationAdministration(
      fd({ id: itemId, offset: "now" })
    );
    expect(second.ok).toBe(true); // duplicate is still a success (idempotent)
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9); // decremented once
  });

  it("returns an error for a missing / other-profile item", async () => {
    const { profile } = seedActor();
    seedPrnMed(profile.id);
    const res = await logMedicationAdministration(
      fd({ id: 999999, offset: "now" })
    );
    expect(res.ok).toBe(false);
  });
});
