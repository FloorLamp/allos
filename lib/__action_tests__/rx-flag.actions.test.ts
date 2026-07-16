// SERVER-ACTION TIER — the Rx / OTC flag on the intake write path (#851 items 1–2).
//
// A medication is either prescription (Rx=1) or over-the-counter (Rx=0); a plain
// supplement is ALWAYS OTC. The form submits an explicit "rx" 0/1, but a lean caller
// (quick-add) may omit it — in which case addSupplement/updateSupplement derive the
// flag the same way the migration-045 backfill does (a recorded prescriber or Rx
// number ⇒ Rx, else OTC). These drive the real Server Actions against the throwaway
// temp DB and read back the stored `rx` bit.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
} from "@/app/(app)/nutrition/supplement-actions";
import { seedActor, fd } from "./harness";

vi.mocked(revalidatePath);

function rxOf(id: number): number {
  return (
    db.prepare("SELECT rx FROM intake_items WHERE id = ?").get(id) as {
      rx: number;
    }
  ).rx;
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

describe("Rx flag on addSupplement", () => {
  it("persists an explicit rx=0 (OTC) for a medication", async () => {
    const r = await addSupplement(
      fd({ name: "Ibuprofen", kind: "medication", rx: "0" })
    );
    expect(r.ok).toBe(true);
    expect(rxOf(lastItemId())).toBe(0);
  });

  it("persists an explicit rx=1 (prescription) for a medication", async () => {
    const r = await addSupplement(
      fd({ name: "Atorvastatin", kind: "medication", rx: "1" })
    );
    expect(r.ok).toBe(true);
    expect(rxOf(lastItemId())).toBe(1);
  });

  it("derives rx=1 from a recorded prescriber when the rx field is absent", async () => {
    // A lean caller (quick-add) sends no `rx`; a prescriber ⇒ prescription.
    await addSupplement(
      fd({ name: "Lisinopril", kind: "medication", prescriber: "Dr. Ada Test" })
    );
    expect(rxOf(lastItemId())).toBe(1);
  });

  it("derives rx=1 from a recorded Rx number when the rx field is absent", async () => {
    await addSupplement(
      fd({ name: "Metformin", kind: "medication", rx_number: "RX-000123" })
    );
    expect(rxOf(lastItemId())).toBe(1);
  });

  it("defaults to rx=0 (OTC) for a medication with neither prescriber/Rx-number nor rx field", async () => {
    await addSupplement(fd({ name: "Acetaminophen", kind: "medication" }));
    expect(rxOf(lastItemId())).toBe(0);
  });

  it("forces rx=0 for a plain supplement even when an rx field is sent", async () => {
    await addSupplement(fd({ name: "Vitamin D", kind: "supplement", rx: "1" }));
    expect(rxOf(lastItemId())).toBe(0);
  });
});

describe("Rx flag on updateSupplement", () => {
  it("flips rx 0 → 1 and back 1 → 0", async () => {
    await addSupplement(fd({ name: "Naproxen", kind: "medication", rx: "0" }));
    const id = lastItemId();
    expect(rxOf(id)).toBe(0);

    const up1 = await updateSupplement(
      fd({ id, name: "Naproxen", kind: "medication", rx: "1" })
    );
    expect(up1.ok).toBe(true);
    expect(rxOf(id)).toBe(1);

    const up2 = await updateSupplement(
      fd({ id, name: "Naproxen", kind: "medication", rx: "0" })
    );
    expect(up2.ok).toBe(true);
    expect(rxOf(id)).toBe(0);
  });
});
