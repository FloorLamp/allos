// SERVER-ACTION TIER — the PRN redose-notice fields on the intake write path (#798).
// Drives addSupplement / updateSupplement and pins the confirm/gate semantics the
// notice's liability posture depends on: the fields persist only for a PRN med, and
// the opt-in flag is forced OFF unless BOTH interval and max are confirmed (an empty
// field ⇒ no notice, ever).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
} from "@/app/(app)/nutrition/supplement-actions";
import { seedActor, fd } from "./harness";

vi.mocked(revalidatePath);

function redoseRow(id: number) {
  return db
    .prepare(
      `SELECT obligation, min_interval_hours AS mih, max_daily_count AS mdc,
              max_daily_amount_mg AS mdmg, redose_notice AS rn
         FROM intake_items WHERE id = ?`
    )
    .get(id) as {
    obligation: string;
    mih: number | null;
    mdc: number | null;
    mdmg: number | null;
    rn: number;
  };
}

function lastItemId(): number {
  return Number(
    (
      db.prepare("SELECT MAX(id) AS id FROM intake_items").get() as {
        id: number;
      }
    ).id
  );
}

beforeEach(() => {
  seedActor();
});

describe("redose fields on addSupplement", () => {
  it("persists interval/max/opt-in for a PRN medication", async () => {
    const r = await addSupplement(
      fd({
        name: "Ibuprofen",
        kind: "medication",
        obligation: "may",
        min_interval_hours: "6",
        max_daily_count: "4",
        redose_notice: "1",
      })
    );
    expect(r.ok).toBe(true);
    const row = redoseRow(lastItemId());
    expect(row.obligation).toBe("may");
    expect(row.mih).toBe(6);
    expect(row.mdc).toBe(4);
    expect(row.rn).toBe(1);
  });

  it("persists the amount-aware mg/day max for a PRN medication, without gating the opt-in (#1854)", async () => {
    const r = await addSupplement(
      fd({
        name: "Ibuprofen 800",
        kind: "medication",
        obligation: "may",
        min_interval_hours: "6",
        max_daily_count: "4",
        max_daily_amount_mg: "1200",
        redose_notice: "1",
      })
    );
    expect(r.ok).toBe(true);
    const row = redoseRow(lastItemId());
    expect(row.mdmg).toBe(1200);
    expect(row.rn).toBe(1);

    // A blank/invalid mg field stays NULL (the mg basis is then unavailable) and
    // never blocks the count-gated opt-in.
    await addSupplement(
      fd({
        name: "Naproxen Sodium",
        kind: "medication",
        obligation: "may",
        min_interval_hours: "8",
        max_daily_count: "3",
        max_daily_amount_mg: "-5",
        redose_notice: "1",
      })
    );
    const row2 = redoseRow(lastItemId());
    expect(row2.mdmg).toBeNull();
    expect(row2.rn).toBe(1);
  });

  it("opt-in is FORCED OFF when a confirmed field is blank (no notice, ever)", async () => {
    await addSupplement(
      fd({
        name: "Acetaminophen",
        kind: "medication",
        obligation: "may",
        // interval left blank
        max_daily_count: "6",
        redose_notice: "1",
      })
    );
    const row = redoseRow(lastItemId());
    expect(row.mih).toBeNull();
    expect(row.rn).toBe(0); // opt-in refused without both confirmed numbers
  });

  it("ignores the fields entirely for a NON-PRN medication", async () => {
    await addSupplement(
      fd({
        name: "Lisinopril",
        kind: "medication",
        // as_needed not set (scheduled med)
        min_interval_hours: "6",
        max_daily_count: "4",
        max_daily_amount_mg: "1200",
        redose_notice: "1",
      })
    );
    const row = redoseRow(lastItemId());
    expect(row.obligation).toBe("must");
    expect(row.mih).toBeNull();
    expect(row.mdc).toBeNull();
    expect(row.mdmg).toBeNull();
    expect(row.rn).toBe(0);
  });
});

describe("redose fields on updateSupplement", () => {
  it("turning PRN off clears the redose fields", async () => {
    await addSupplement(
      fd({
        name: "Naproxen",
        kind: "medication",
        obligation: "may",
        min_interval_hours: "8",
        max_daily_count: "3",
        max_daily_amount_mg: "660",
        redose_notice: "1",
      })
    );
    const id = lastItemId();
    expect(redoseRow(id).rn).toBe(1);
    expect(redoseRow(id).mdmg).toBe(660);

    // Edit it to a scheduled med (as_needed omitted) — the fields must clear.
    const r = await updateSupplement(
      fd({
        id,
        name: "Naproxen",
        kind: "medication",
        min_interval_hours: "8",
        max_daily_count: "3",
        max_daily_amount_mg: "660",
        redose_notice: "1",
      })
    );
    expect(r.ok).toBe(true);
    const row = redoseRow(id);
    expect(row.obligation).toBe("must");
    expect(row.mih).toBeNull();
    expect(row.mdc).toBeNull();
    expect(row.mdmg).toBeNull();
    expect(row.rn).toBe(0);
  });
});
