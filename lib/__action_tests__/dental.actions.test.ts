// SERVER-ACTION TIER — dental-procedure write path (#705). Exercises add / update /
// delete / track-follow-up against a real (temp) SQLite handle to prove every mutation
// is profile-scoped, that the status / tooth_system strings are normalized onto the DB
// CHECK sets (an off-vocabulary form can never trip the constraint), that a manual row
// carries NULL provenance, and that the dental follow-up chain (create + delete unlink)
// works. The static source scan can't see across the action boundary; this is the
// dynamic guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  addDentalProcedure,
  updateDentalProcedure,
  deleteDentalProcedure,
  trackDentalFollowUp,
} from "@/app/(app)/dental/actions";
import { db } from "@/lib/db";
import {
  getDentalProcedures,
  getDentalProcedureFollowUps,
} from "@/lib/queries";
import { seedActor, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

describe("addDentalProcedure", () => {
  it("stores a profile-scoped record and normalizes the enum fields", async () => {
    const { profile } = seedActor();
    const res = await addDentalProcedure(
      fd({
        name: "Composite filling",
        status: "Treatment Plan", // → planned
        tooth: " 14 ",
        tooth_system: "ADA", // → universal
        surface: "mod", // → MOD
        cdt_code: "D2392",
        procedure_date: "2026-02-01",
        finding: "watch mesial",
        follow_up_interval_days: "180",
      })
    );
    expect(res.ok).toBe(true);

    const rows = getDentalProcedures(profile.id);
    expect(rows).toHaveLength(1);
    const d = rows[0];
    expect(d.name).toBe("Composite filling");
    expect(d.status).toBe("planned");
    expect(d.tooth).toBe("14");
    expect(d.tooth_system).toBe("universal");
    expect(d.surface).toBe("MOD");
    expect(d.cdt_code).toBe("D2392");
    expect(d.follow_up_interval_days).toBe(180);
    // Manual rows carry no import provenance.
    expect(d.source).toBeNull();
    expect(d.document_id).toBeNull();
    expect(d.external_id).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/dental");
  });

  it("rejects an empty name", async () => {
    seedActor();
    const res = await addDentalProcedure(fd({ name: "  " }));
    expect(res.ok).toBe(false);
  });
});

describe("updateDentalProcedure is profile-scoped", () => {
  it("won't edit another profile's record", async () => {
    seedActor();
    const other = createProfile("other-subject");
    const otherId = Number(
      db
        .prepare(
          `INSERT INTO dental_procedures (profile_id, name, status) VALUES (?, 'X', 'completed')`
        )
        .run(other.id).lastInsertRowid
    );
    const res = await updateDentalProcedure(
      fd({ id: String(otherId), name: "Hacked" })
    );
    // Action returns ok (no row matched the WHERE id AND profile_id) but nothing changed.
    expect(res.ok).toBe(true);
    const row = db
      .prepare("SELECT name FROM dental_procedures WHERE id = ?")
      .get(otherId) as { name: string };
    expect(row.name).toBe("X");
  });
});

describe("trackDentalFollowUp + deleteDentalProcedure (the #700 chain)", () => {
  it("creates a linked follow-up and de-links it on delete (never cascade-drops)", async () => {
    const { profile } = seedActor();
    await addDentalProcedure(
      fd({
        name: "Caries watch",
        status: "watch",
        tooth: "30",
        procedure_date: "2026-03-01",
      })
    );
    const recId = getDentalProcedures(profile.id)[0].id;

    const tracked = await trackDentalFollowUp(
      fd({ record_id: String(recId), interval_days: "182" })
    );
    expect(tracked.ok).toBe(true);

    let followUps = getDentalProcedureFollowUps(profile.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].sourceDentalProcedureId).toBe(recId);
    const cpId = followUps[0].carePlanItemId;

    // Idempotent — a second track returns the same open follow-up (no duplicate).
    await trackDentalFollowUp(
      fd({ record_id: String(recId), interval_days: "182" })
    );
    expect(getDentalProcedureFollowUps(profile.id)).toHaveLength(1);

    // Delete the source record: the follow-up survives, de-linked (source cleared).
    await deleteDentalProcedure(fd({ id: String(recId) }));
    expect(getDentalProcedures(profile.id)).toHaveLength(0);
    const cp = db
      .prepare(
        "SELECT source_kind, source_dental_procedure_id FROM care_plan_items WHERE id = ?"
      )
      .get(cpId) as {
      source_kind: string | null;
      source_dental_procedure_id: number | null;
    };
    expect(cp.source_kind).toBeNull();
    expect(cp.source_dental_procedure_id).toBeNull();
  });
});
