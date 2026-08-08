// SERVER-ACTION TIER — the PRN quick-log write path (logMedicationAdministration,
// #797). Drives the real Server Action (its auth gate + offset parsing) against the
// in-memory DB, mirroring the harness auth mock. Covers: a "now" log, the custom
// same-day time path (the shared when-control's wire, #2236 — the relative 30m/1h
// offsets are retired), the double-tap dedup, and the invalid-custom-time /
// stale-item error returns. The core's own semantics (multiples, supply, window
// guard) are pinned in the DB tier; this tier proves the ACTION wires the offset →
// recorded_at → core correctly and returns the right FormResult.

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
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', ?, 1)`
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
    expect(res).toEqual({ ok: true, outcome: "logged" });
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9);
    expect(revalidate).toHaveBeenCalledWith("/medications");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("logs a stated earlier time as a distinct administration (#2236)", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // Frozen at midday so "now" and the stated 00:01 are hours apart — a real run
    // straddling midnight could otherwise land both inside the dedup window.
    const prev = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = `${today(profile.id)}T12:00:00Z`;
    try {
      expect(
        (await logMedicationAdministration(fd({ id: itemId, offset: "now" })))
          .ok
      ).toBe(true);
      expect(
        (
          await logMedicationAdministration(
            fd({ id: itemId, offset: "custom", time: "00:01" })
          )
        ).ok
      ).toBe(true);
    } finally {
      if (prev == null) delete process.env.ALLOS_TEST_NOW;
      else process.env.ALLOS_TEST_NOW = prev;
    }
    expect(adminRows(itemId)).toBe(2);
    expect(onHand(itemId)).toBe(8);
  });

  it("a legacy relative offset is no vocabulary: it resolves as 'now' (#2236)", async () => {
    const { profile } = seedActor();
    const itemId = seedPrnMed(profile.id);
    // The rendered page states absolute times; "30m" no longer names an offset, so
    // a stale client submitting one gets the default "now" semantics — and a second
    // one inside the dedup window collapses instead of minting a back-dated row.
    await logMedicationAdministration(fd({ id: itemId, offset: "now" }));
    const legacy = await logMedicationAdministration(
      fd({ id: itemId, offset: "30m" })
    );
    expect(legacy).toEqual({ ok: true, outcome: "duplicate" });
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9);
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
        "SELECT recorded_at FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(itemId) as { recorded_at: string };
    // Stored as a UTC "YYYY-MM-DD HH:MM:SS" instant (not the raw wall string).
    expect(row.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
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
    expect(second).toEqual({ ok: true, outcome: "duplicate" });
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
