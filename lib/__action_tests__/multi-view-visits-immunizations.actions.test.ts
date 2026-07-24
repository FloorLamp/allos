// SERVER-ACTION TIER — Tier-1b bespoke-list per-item writes (issue #1359).
//
// The flat sub-lists of the Visits and Immunizations surfaces adopt multi-view: a
// Past-encounter edit/delete and a recorded-dose edit/delete each post the ROW's OWN
// profileId and gate via the shared gateItemProfile → requireProfileWriteAccess. This
// tier pins that gate: a GRANTED target's write lands on the target; an UNGRANTED
// target is refused BEFORE any write; and with no `profile_id` the action falls back
// to the acting profile (the single-view path). Auth is mocked (harness), DB is real.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  updateEncounter,
  deleteEncounter,
} from "@/app/(app)/encounters/actions";
import {
  updateImmunization,
  deleteImmunization,
} from "@/app/(app)/immunizations/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

function seedEncounter(profileId: number, type: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO encounters (type, date, source, profile_id) VALUES (?, '2026-03-01', NULL, ?)"
      )
      .run(type, profileId).lastInsertRowid
  );
}
function encounterType(id: number): string | undefined {
  return (
    db.prepare("SELECT type FROM encounters WHERE id = ?").get(id) as
      { type: string } | undefined
  )?.type;
}
function seedImmunization(profileId: number, vaccine: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO immunizations (vaccine, date, source, profile_id) VALUES (?, '2026-03-01', NULL, ?)"
      )
      .run(vaccine, profileId).lastInsertRowid
  );
}
function immunizationVaccine(id: number): string | undefined {
  return (
    db.prepare("SELECT vaccine FROM immunizations WHERE id = ?").get(id) as
      { vaccine: string } | undefined
  )?.vaccine;
}

describe("Tier-1b multi-view writes gate the ITEM's profile (#1359)", () => {
  it("updateEncounter with posted profile_id writes to the ITEM's profile, not the acting one", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const encId = seedEncounter(other.id, "Well-child visit");

    await updateEncounter(
      fd({
        id: encId,
        date: "2026-03-02",
        type: "Well-child visit (updated)",
        profile_id: other.id,
      })
    );

    expect(encounterType(encId)).toBe("Well-child visit (updated)");
    const actingRows = db
      .prepare("SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ?")
      .get(acting.id) as { n: number };
    expect(actingRows.n).toBe(0);
  });

  it("deleteEncounter with posted profile_id deletes the ITEM's row", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const encId = seedEncounter(other.id, "ED visit");

    await deleteEncounter(fd({ id: encId, profile_id: other.id }));
    expect(encounterType(encId)).toBeUndefined();
  });

  it("refuses an encounter edit targeting an UNGRANTED profile before any write", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Member self", login.id);
    const stranger = createProfile("Stranger");
    actAs(login, acting);
    const encId = seedEncounter(stranger.id, "Private visit");

    await expect(
      updateEncounter(
        fd({
          id: encId,
          date: "2026-03-02",
          type: "Hacked",
          profile_id: stranger.id,
        })
      )
    ).rejects.toThrow();
    expect(encounterType(encId)).toBe("Private visit");
  });

  it("encounter edit with NO profile_id falls back to the acting profile (single-view path)", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    actAs(login, acting);
    const encId = seedEncounter(acting.id, "Physical");

    await updateEncounter(
      fd({ id: encId, date: "2026-03-02", type: "Physical (edited)" })
    );
    expect(encounterType(encId)).toBe("Physical (edited)");
  });

  it("updateImmunization + deleteImmunization target the ITEM's profile", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const immId = seedImmunization(other.id, "influenza");

    await updateImmunization(
      fd({
        id: immId,
        date: "2026-03-02",
        vaccine: "mmr",
        profile_id: other.id,
      })
    );
    // Normalized to a catalog code; the point is the ROW changed on the OTHER profile.
    expect(immunizationVaccine(immId)).not.toBe("influenza");
    const actingRows = db
      .prepare("SELECT COUNT(*) AS n FROM immunizations WHERE profile_id = ?")
      .get(acting.id) as { n: number };
    expect(actingRows.n).toBe(0);

    await deleteImmunization(fd({ id: immId, profile_id: other.id }));
    expect(immunizationVaccine(immId)).toBeUndefined();
  });

  it("refuses an immunization edit targeting an UNGRANTED profile before any write", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Member self", login.id);
    const stranger = createProfile("Stranger");
    actAs(login, acting);
    const immId = seedImmunization(stranger.id, "hepb");

    await expect(
      deleteImmunization(fd({ id: immId, profile_id: stranger.id }))
    ).rejects.toThrow();
    expect(immunizationVaccine(immId)).toBe("hepb");
  });
});
