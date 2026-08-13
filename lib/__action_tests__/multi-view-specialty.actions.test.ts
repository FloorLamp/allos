// SERVER-ACTION TIER — the Records › Specialty panes adopt multi-view (issue #2557).
//
// Dental and Vision now LIST every profile in view, so a row's edit/delete posts the
// ROW's OWN profile and gates through the shared gateItemProfile →
// requireProfileWriteAccess. That gate is the whole point of the issue: `ProfileScope`
// is data, never a write authorization (AGENTS.md), so a row being visible must prove
// nothing about the caller's right to change it. This tier pins all three branches —
// a GRANTED target's write lands on the target, an UNGRANTED target is refused BEFORE
// any write, and a form posting no `profile_id` still falls back to the acting profile
// (the single-view path, which must stay byte-identical). Auth is mocked (harness),
// DB is real.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  updateDentalProcedure,
  deleteDentalProcedure,
} from "@/app/(app)/records/specialty/dental/actions";
import {
  updateOpticalPrescription,
  deleteOpticalPrescription,
} from "@/app/(app)/records/specialty/vision/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

function seedDental(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO dental_procedures (name, status, procedure_date, source, profile_id)
         VALUES (?, 'completed', '2026-03-01', NULL, ?)`
      )
      .run(name, profileId).lastInsertRowid
  );
}
function dentalName(id: number): string | undefined {
  return (
    db.prepare("SELECT name FROM dental_procedures WHERE id = ?").get(id) as
      { name: string } | undefined
  )?.name;
}

function seedRx(profileId: number, brand: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO optical_prescriptions (kind, brand, issued_date, source, profile_id)
         VALUES ('glasses', ?, '2026-03-01', NULL, ?)`
      )
      .run(brand, profileId).lastInsertRowid
  );
}
function rxBrand(id: number): string | null | undefined {
  return (
    db
      .prepare("SELECT brand FROM optical_prescriptions WHERE id = ?")
      .get(id) as { brand: string | null } | undefined
  )?.brand;
}

describe("Dental writes gate the ITEM's profile (#2557)", () => {
  it("updateDentalProcedure with a posted profile_id writes the ITEM's row, not the actor's", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Dental Acting", login.id);
    const other = createProfile("Dental Other", login.id);
    actAs(login, acting);
    const recordId = seedDental(other.id, "Filling 14");

    await updateDentalProcedure(
      fd({
        id: recordId,
        name: "Filling 14 (revised)",
        status: "completed",
        profile_id: other.id,
      })
    );

    expect(dentalName(recordId)).toBe("Filling 14 (revised)");
    const actingRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM dental_procedures WHERE profile_id = ?"
      )
      .get(acting.id) as { n: number };
    expect(actingRows.n).toBe(0);
  });

  it("deleteDentalProcedure with a posted profile_id removes the ITEM's row", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Dental Acting 2", login.id);
    const other = createProfile("Dental Other 2", login.id);
    actAs(login, acting);
    const recordId = seedDental(other.id, "Crown 30");

    await deleteDentalProcedure(fd({ id: recordId, profile_id: other.id }));
    expect(dentalName(recordId)).toBeUndefined();
  });

  it("refuses a dental edit targeting an UNGRANTED profile before any write", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Dental Member", login.id);
    const stranger = createProfile("Dental Stranger");
    actAs(login, acting);
    const recordId = seedDental(stranger.id, "Extraction 1");

    await expect(
      updateDentalProcedure(
        fd({
          id: recordId,
          name: "Hacked",
          status: "completed",
          profile_id: stranger.id,
        })
      )
    ).rejects.toThrow();
    expect(dentalName(recordId)).toBe("Extraction 1");
  });

  it("refuses a dental DELETE targeting an UNGRANTED profile before any write", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Dental Member 2", login.id);
    const stranger = createProfile("Dental Stranger 2");
    actAs(login, acting);
    const recordId = seedDental(stranger.id, "Sealant 3");

    await expect(
      deleteDentalProcedure(fd({ id: recordId, profile_id: stranger.id }))
    ).rejects.toThrow();
    expect(dentalName(recordId)).toBe("Sealant 3");
  });

  it("falls back to the acting profile when no profile_id is posted (single view)", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Dental Solo", login.id);
    actAs(login, acting);
    const recordId = seedDental(acting.id, "Cleaning");

    await updateDentalProcedure(
      fd({ id: recordId, name: "Cleaning (edited)", status: "completed" })
    );
    expect(dentalName(recordId)).toBe("Cleaning (edited)");
  });
});

describe("Vision writes gate the ITEM's profile (#2557)", () => {
  it("updateOpticalPrescription with a posted profile_id writes the ITEM's row", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Vision Acting", login.id);
    const other = createProfile("Vision Other", login.id);
    actAs(login, acting);
    const rxId = seedRx(other.id, "Frames 12");

    await updateOpticalPrescription(
      fd({
        id: rxId,
        kind: "glasses",
        brand: "Frames 34",
        profile_id: other.id,
      })
    );

    expect(rxBrand(rxId)).toBe("Frames 34");
    const actingRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM optical_prescriptions WHERE profile_id = ?"
      )
      .get(acting.id) as { n: number };
    expect(actingRows.n).toBe(0);
  });

  it("deleteOpticalPrescription with a posted profile_id removes the ITEM's row", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Vision Acting 2", login.id);
    const other = createProfile("Vision Other 2", login.id);
    actAs(login, acting);
    const rxId = seedRx(other.id, "Frames 56");

    await deleteOpticalPrescription(fd({ id: rxId, profile_id: other.id }));
    expect(rxBrand(rxId)).toBeUndefined();
  });

  it("refuses a prescription delete targeting an UNGRANTED profile before any write", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Vision Member", login.id);
    const stranger = createProfile("Vision Stranger");
    actAs(login, acting);
    const rxId = seedRx(stranger.id, "Frames 78");

    await expect(
      deleteOpticalPrescription(fd({ id: rxId, profile_id: stranger.id }))
    ).rejects.toThrow();
    expect(rxBrand(rxId)).toBe("Frames 78");
  });

  it("falls back to the acting profile when no profile_id is posted (single view)", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Vision Solo", login.id);
    actAs(login, acting);
    const rxId = seedRx(acting.id, "Frames 90");

    await updateOpticalPrescription(
      fd({ id: rxId, kind: "glasses", brand: "Frames 91" })
    );
    expect(rxBrand(rxId)).toBe("Frames 91");
  });
});
