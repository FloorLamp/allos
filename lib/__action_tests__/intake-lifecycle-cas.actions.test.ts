// SERVER-ACTION TIER — the intake lifecycle CAS fixes (#2139/#2132/#2131).
//
// Every case here is the STALE-ACTOR case: a second accept of the same suggestion, a
// second Stop of a stopped med, a Restore of a dose someone else already restored. The
// contract under test is one rule stated three ways: the compare runs inside the
// transaction, exactly one racer's write lands, and the loser gets a typed refusal the
// caller renders — never a second row, an inverted flag, or an unconditional formOk().

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
  acceptSuggestion,
  restoreDose,
  toggleTaken,
} from "@/app/(app)/nutrition/supplement-actions";
import {
  stopMedication,
  restartMedication,
} from "@/app/(app)/medications/actions";
import {
  getSupplements,
  getSupplementDoses,
  getSupplementDosesForHistory,
  getRetiredDoses,
  getMedicationCourses,
  unretireDose,
} from "@/lib/queries";
import { doseOnDay } from "@/lib/intake-cadence";
import { shiftDateStr } from "@/lib/date";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

const dosesJson = (
  doses: { id?: number; amount: string; time_of_day: string }[]
) => JSON.stringify(doses.map((d) => ({ ...d, food_timing: "any" })));

// ---- #2139: acceptSuggestion claims with an in-transaction CAS -------------

describe("acceptSuggestion pending-claim CAS (#2139)", () => {
  function seedSuggestion(profileId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO intake_item_suggestions
             (name, dosage, condition, obligation, rationale, status, profile_id)
           VALUES ('Vitamin K2', '100 mcg once daily', 'daily', 'should',
                   'Pairs with your D3.', 'pending', ?)`
        )
        .run(profileId).lastInsertRowid
    );
  }

  it("two accepts of one suggestion produce ONE item and one typed refusal", async () => {
    const { profile } = seedActor();
    const sid = seedSuggestion(profile.id);

    const first = await acceptSuggestion(fd({ id: sid }));
    expect(first).toEqual({ ok: true });
    const second = await acceptSuggestion(fd({ id: sid }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/no longer available/);

    const items = getSupplements(profile.id).filter(
      (s) => s.name === "Vitamin K2"
    );
    expect(items).toHaveLength(1);
    const status = (
      db
        .prepare("SELECT status FROM intake_item_suggestions WHERE id = ?")
        .get(sid) as { status: string }
    ).status;
    expect(status).toBe("accepted");
  });

  it("a dismissed suggestion refuses without minting", async () => {
    const { profile } = seedActor();
    const sid = seedSuggestion(profile.id);
    db.prepare(
      "UPDATE intake_item_suggestions SET status = 'dismissed' WHERE id = ?"
    ).run(sid);
    const res = await acceptSuggestion(fd({ id: sid }));
    expect(res.ok).toBe(false);
    expect(getSupplements(profile.id)).toHaveLength(0);
  });
});

// ---- #2132: course transitions render typed outcomes through the actions ---

describe("stop/restart render the course core's refusals (#2132)", () => {
  async function seedMed() {
    const { profile } = seedActor();
    await addSupplement(fd({ name: "Lisinopril", kind: "medication" }));
    const id = getSupplements(profile.id)[0].id;
    return { profile, id };
  }

  it("a second Stop refuses; a second Restart refuses; state is untouched", async () => {
    const { profile, id } = await seedMed();
    const openCourses = () =>
      getMedicationCourses(profile.id).filter((c) => c.stopped_on == null);
    expect(openCourses()).toHaveLength(1);

    expect(await stopMedication(fd({ id, stop_reason: "other" }))).toEqual({
      ok: true,
    });
    expect(openCourses()).toHaveLength(0);

    const secondStop = await stopMedication(fd({ id, stop_reason: "other" }));
    expect(secondStop.ok).toBe(false);
    if (!secondStop.ok) expect(secondStop.error).toMatch(/Already stopped/);

    expect(await restartMedication(fd({ id }))).toEqual({ ok: true });
    expect(openCourses()).toHaveLength(1);

    const secondRestart = await restartMedication(fd({ id }));
    expect(secondRestart.ok).toBe(false);
    if (!secondRestart.ok)
      expect(secondRestart.error).toMatch(/Already active/);
    // No second open course was stacked by the refused restart.
    expect(openCourses()).toHaveLength(1);
  });

  it("a forged id refuses instead of confirming", async () => {
    await seedMed();
    const res = await stopMedication(fd({ id: 999999, stop_reason: "other" }));
    expect(res.ok).toBe(false);
    const res2 = await restartMedication(fd({ id: 999999 }));
    expect(res2.ok).toBe(false);
  });
});

// ---- #2131: dose retire / un-retire lifecycle -------------------------------

describe("dose retire → restore lifecycle (#2131)", () => {
  async function seedRetiredMorning() {
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
    // Log the morning dose so removing it retires (rather than deletes) it.
    await toggleTaken(fd({ dose_id: morning.id }));
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([
          {
            id: evening.id,
            amount: evening.amount ?? "500 mg",
            time_of_day: evening.time_of_day ?? "20:00",
          },
        ]),
      })
    );
    return { profile, suppId, morning, evening };
  }

  it("restore puts the SAME dose id back on the schedule, due from today and never retroactively", async () => {
    const { profile, morning } = await seedRetiredMorning();
    const todayStr = today(profile.id);

    // Retired: off the schedule, listed for the Restore affordance, dueness closed
    // from the retire day (the appended closing version) while past days keep their
    // original rule.
    expect(getSupplementDoses(profile.id).map((d) => d.id)).not.toContain(
      morning.id
    );
    expect(getRetiredDoses(profile.id).map((d) => d.id)).toContain(morning.id);
    const retiredView = getSupplementDosesForHistory(profile.id).find(
      (d) => d.id === morning.id
    )!;
    expect(doseOnDay(retiredView, todayStr)).toBe(false);
    expect(doseOnDay(retiredView, shiftDateStr(todayStr, -1))).toBe(true);

    const res = await restoreDose(fd({ dose_id: morning.id }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.dose.id).toBe(morning.id);

    // Back on the schedule under its ORIGINAL id (the #2000 stability argument), and
    // due again from the restore day.
    expect(getSupplementDoses(profile.id).map((d) => d.id)).toContain(
      morning.id
    );
    expect(getRetiredDoses(profile.id).map((d) => d.id)).not.toContain(
      morning.id
    );
    const restoredView = getSupplementDosesForHistory(profile.id).find(
      (d) => d.id === morning.id
    )!;
    expect(doseOnDay(restoredView, todayStr)).toBe(true);
    // The taken history was never rewritten by either transition.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM intake_item_logs WHERE dose_id = ?"
          )
          .get(morning.id) as { c: number }
      ).c
    ).toBe(1);
  });

  it("a second restore refuses (already on the schedule)", async () => {
    const { morning } = await seedRetiredMorning();
    await restoreDose(fd({ dose_id: morning.id }));
    const res = await restoreDose(fd({ dose_id: morning.id }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already on the schedule/);
  });

  it("a live dose in the same slot blocks the restore with schedule-conflict", async () => {
    const { profile, suppId, morning, evening } = await seedRetiredMorning();
    // A NEW live dose now occupies the retired dose's 08:00 slot.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([
          {
            id: evening.id,
            amount: evening.amount ?? "500 mg",
            time_of_day: evening.time_of_day ?? "20:00",
          },
          { amount: "1000 mg", time_of_day: "08:00" },
        ]),
      })
    );
    const res = await restoreDose(fd({ dose_id: morning.id }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already covers that time slot/);
    // Still retired — the refused restore wrote nothing.
    expect(getRetiredDoses(profile.id).map((d) => d.id)).toContain(morning.id);
  });

  it("core refusals: not-found for a forged/cross-profile id", async () => {
    const { profile, morning } = await seedRetiredMorning();
    expect(unretireDose(profile.id, 999999).kind).toBe("not-found");
    // Another profile's id can't reach this dose.
    const other = seedActor();
    const res = await restoreDose(fd({ dose_id: morning.id }));
    expect(res.ok).toBe(false);
    void other;
  });
});
