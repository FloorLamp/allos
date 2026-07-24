// SERVER-ACTION TIER — cross-profile writes for the multi-view Medications boards
// (issue #1373 Part 1). Auth is mocked (harness); the DB is real.
//
// A caregiver viewing several profiles confirms a household member's SCHEDULED dose
// from that member's board WITHOUT switching the acting profile. The board's
// DoseStatusControl posts an explicit `profileId`, and setDoseStatus gates on the
// TARGET via requireProfileWriteAccess (the #31/#858 cross-profile gate) — a granted
// member writes the target's dose, an ungranted / read-only member is refused before
// any write, and an absent profileId falls back to the active profile (byte-identical
// single-view / Supplements-row behavior).
//
// The board's DEEP management (stop/edit/delete/refill) carries NO cross-profile seam —
// it stays acting-only. The board renders those affordances only on the acting board,
// and this tier pins the belt-and-braces backstop: even if a stop were posted for
// another member's med id, requireWriteAccess scopes the write to the ACTING profile,
// so the target member's med is untouched (never a wrong-target management write).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  setDoseStatus,
  deleteSupplement,
} from "@/app/(app)/nutrition/supplement-actions";
import { stopMedication } from "@/app/(app)/medications/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

// A daily scheduled medication + one dose for `profileId`; returns the dose id.
function seedScheduledDose(profileId: number): {
  itemId: number;
  doseId: number;
} {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed)
         VALUES (?, 'Lisinopril', 1, 'medication', 'daily', 'high', 0)`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '10 mg', 'any', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function doseStatus(doseId: number, date: string): string | undefined {
  return (
    db
      .prepare(
        "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { status: string } | undefined
  )?.status;
}

function isActive(itemId: number): number {
  return (
    db.prepare("SELECT active FROM intake_items WHERE id = ?").get(itemId) as {
      active: number;
    }
  ).active;
}

// A caregiver MEMBER login granted: home (write, acting), kid (write), readonly (read),
// and a stranger (not granted). Mirrors the illness-hero cross-profile fixture.
function seedCaregiver() {
  const login = createLogin({ role: "member" });
  const home = createProfile("MV Home", login.id);
  const kid = createProfile("MV Kid", login.id);
  const readonly = createProfile("MV Readonly", login.id);
  db.prepare(
    "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
  ).run(login.id, readonly.id);
  const stranger = createProfile("MV Stranger"); // ungranted
  actAs(login, home);
  return { login, home, kid, readonly, stranger };
}

describe("cross-profile scheduled dose confirm (#1373)", () => {
  it("confirms a granted member's dose from their board (posts the target profileId)", async () => {
    const { kid } = seedCaregiver();
    const { doseId } = seedScheduledDose(kid.id);

    const res = await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", profileId: kid.id })
    );
    expect(res.ok).toBe(true);
    expect(doseStatus(doseId, today(kid.id))).toBe("taken");
  });

  it("refuses a cross-profile confirm on an UNGRANTED target", async () => {
    const { stranger } = seedCaregiver();
    const { doseId } = seedScheduledDose(stranger.id);
    await expect(
      setDoseStatus(
        fd({ dose_id: doseId, status: "taken", profileId: stranger.id })
      )
    ).rejects.toThrow(/not accessible/);
    expect(doseStatus(doseId, today(stranger.id))).toBeUndefined();
  });

  it("refuses a cross-profile confirm on a READ-ONLY grant", async () => {
    const { readonly } = seedCaregiver();
    const { doseId } = seedScheduledDose(readonly.id);
    await expect(
      setDoseStatus(
        fd({ dose_id: doseId, status: "taken", profileId: readonly.id })
      )
    ).rejects.toThrow(/read-only/);
    expect(doseStatus(doseId, today(readonly.id))).toBeUndefined();
  });

  it("writes the ACTING profile when no profileId is posted (byte-identical fallback)", async () => {
    const { home } = seedCaregiver();
    const { doseId } = seedScheduledDose(home.id);
    const res = await setDoseStatus(fd({ dose_id: doseId, status: "taken" }));
    expect(res.ok).toBe(true);
    expect(doseStatus(doseId, today(home.id))).toBe("taken");
  });

  it("a cross-profile confirm never touches a dose the target doesn't own (scoped no-op)", async () => {
    const { kid, home } = seedCaregiver();
    // A dose that belongs to HOME, but posted with the KID as target.
    const { doseId } = seedScheduledDose(home.id);
    const res = await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", profileId: kid.id })
    );
    // The gate passes (kid is write-granted) but applyDoseStatus scopes the dose to
    // the kid, so home's dose is untouched — no cross-profile leak.
    expect(res.ok).toBe(true);
    expect(doseStatus(doseId, today(kid.id))).toBeUndefined();
    expect(doseStatus(doseId, today(home.id))).toBeUndefined();
  });
});

describe("deep management stays acting-only on the boards (#1373 edit gate)", () => {
  it("stopMedication is scoped to the ACTING profile — a kid's med id is a no-op", async () => {
    const { kid } = seedCaregiver();
    const { itemId } = seedScheduledDose(kid.id);
    // Acting as HOME, post the KID's med id. There is no cross-profile seam, so the
    // active-profile-scoped write finds nothing and the kid's med stays active.
    await stopMedication(fd({ id: itemId, stop_reason: "completed_course" }));
    expect(isActive(itemId)).toBe(1);
  });

  it("deleteSupplement is scoped to the ACTING profile — a kid's med id is a no-op", async () => {
    const { kid } = seedCaregiver();
    const { itemId } = seedScheduledDose(kid.id);
    await deleteSupplement(fd({ id: itemId }));
    // Still present (the delete was scoped to the acting home profile).
    const row = db
      .prepare("SELECT id FROM intake_items WHERE id = ?")
      .get(itemId);
    expect(row).toBeTruthy();
  });
});
