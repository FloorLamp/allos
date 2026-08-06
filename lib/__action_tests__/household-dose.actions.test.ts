// SERVER-ACTION TIER — the household card's per-member dose confirm (issue #31,
// hardened by #2106).
//
// confirmDoseAction targets the CARD's profile (from the form), not the acting one,
// and now returns markDoseTaken's typed outcome: its one-tap registry entry declares
// `outcome-toast`, so a refusal — the item paused, the dose retired by a schedule
// edit — must reach the surface instead of being swallowed into a void return that
// re-renders the row unchanged.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { confirmDoseAction } from "@/app/(app)/household/actions";
import { getTakenDoseIds } from "@/lib/queries";
import { db, today } from "@/lib/db";
import { seedActor, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

// A supplement + one dose for the given (card) profile, returning both ids.
function seedDose(profileId: number): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active)
         VALUES (?, 'Vitamin D', 'supplement', 1)`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1000 IU', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

describe("confirmDoseAction (#31/#2106)", () => {
  it("confirms another household profile's dose and answers from the outcome", async () => {
    const { login } = seedActor();
    const member = createProfile("Card Member", login.id);
    const { doseId } = seedDose(member.id);

    expect(
      await confirmDoseAction(fd({ profileId: member.id, dose_id: doseId }))
    ).toEqual({ ok: true, outcome: "logged" });
    expect(getTakenDoseIds(member.id, today(member.id)).has(doseId)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/household");

    // The idempotent repeat is stated, never re-confirmed as a fresh log.
    expect(
      await confirmDoseAction(fd({ profileId: member.id, dose_id: doseId }))
    ).toEqual({ ok: true, outcome: "already-taken" });
    expect(getTakenDoseIds(member.id, today(member.id)).size).toBe(1);
  });

  it("a paused item refuses with `inactive` — the stale-card scenario", async () => {
    const { login } = seedActor();
    const member = createProfile("Paused Member", login.id);
    const { itemId, doseId } = seedDose(member.id);
    // The card rendered while the item was active; it is paused by the time the
    // caregiver taps Confirm.
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(itemId);

    expect(
      await confirmDoseAction(fd({ profileId: member.id, dose_id: doseId }))
    ).toEqual({ ok: true, outcome: "inactive" });
    expect(getTakenDoseIds(member.id, today(member.id)).size).toBe(0);
  });

  it("a retired dose refuses with `stale-dose`", async () => {
    const { login } = seedActor();
    const member = createProfile("Retired Member", login.id);
    const { doseId } = seedDose(member.id);
    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      doseId
    );

    expect(
      await confirmDoseAction(fd({ profileId: member.id, dose_id: doseId }))
    ).toEqual({ ok: true, outcome: "stale-dose" });
    expect(getTakenDoseIds(member.id, today(member.id)).size).toBe(0);
  });

  it("a tampered dose id from a different profile answers stale-dose, not a log", async () => {
    const { login } = seedActor();
    const cardMember = createProfile("Card A", login.id);
    const other = createProfile("Card B", login.id);
    const { doseId } = seedDose(other.id);

    // The write is gated on the CARD's profile; the dose belongs to someone else,
    // so markDoseTaken's own chain check refuses it.
    expect(
      await confirmDoseAction(fd({ profileId: cardMember.id, dose_id: doseId }))
    ).toEqual({ ok: true, outcome: "stale-dose" });
    expect(getTakenDoseIds(other.id, today(other.id)).size).toBe(0);
  });

  it("missing ids answer a typed error instead of void", async () => {
    const { profile } = seedActor();
    const res = await confirmDoseAction(fd({ profileId: profile.id }));
    expect(res.ok).toBe(false);
  });
});
