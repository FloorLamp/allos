// SERVER-ACTION TIER — the finding follow-up chain write paths (#700).
//
// Drives the real trackImagingFollowUp (imaging) + resolveFollowUp (upcoming)
// actions against the REAL throwaway temp DB, with the auth boundary mocked by
// setup.ts. Asserts: the create writes a linked, dated care_plan_item; the resolve
// records the outcome + closes the loop confirm-first; the auth/validation gates
// (read-only refusal, cross-profile refusal, bad outcome, missing ids); and that a
// deleted source study de-links the follow-up without a FK-500 (row-ops #700).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  trackImagingFollowUp,
  deleteImagingStudy,
} from "@/app/(app)/imaging/actions";
import { resolveFollowUp } from "@/app/(app)/upcoming/actions";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function addStudy(
  profileId: number,
  studyDate: string | null,
  modality = "ct"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO imaging_studies (profile_id, modality, body_region, contrast, study_date)
         VALUES (?, ?, 'Chest', 0, ?)`
      )
      .run(profileId, modality, studyDate).lastInsertRowid
  );
}

function carePlanRow(id: number) {
  return db
    .prepare(
      `SELECT description, planned_date, source_kind, source_imaging_study_id AS src,
              recommended_interval_days AS interval, status, resolution,
              resolved_by_imaging_study_id AS resolvedBy
         FROM care_plan_items WHERE id = ?`
    )
    .get(id) as
    | {
        description: string;
        planned_date: string | null;
        source_kind: string | null;
        src: number | null;
        interval: number | null;
        status: string | null;
        resolution: string | null;
        resolvedBy: number | null;
      }
    | undefined;
}

describe("trackImagingFollowUp action", () => {
  it("creates a linked, dated follow-up from a study", async () => {
    const { profile } = seedActor();
    const now = today(profile.id);
    const studyDate = shiftDateStr(now, -30);
    const studyId = addStudy(profile.id, studyDate);

    const res = await trackImagingFollowUp(
      fd({ study_id: studyId, interval_days: 365 })
    );
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT id FROM care_plan_items
           WHERE profile_id = ? AND source_imaging_study_id = ?`
      )
      .get(profile.id, studyId) as { id: number };
    const cp = carePlanRow(row.id)!;
    expect(cp.source_kind).toBe("imaging");
    expect(cp.src).toBe(studyId);
    expect(cp.interval).toBe(365);
    expect(cp.planned_date).toBe(shiftDateStr(studyDate, 365));
    expect(cp.status).toBeNull(); // open
    expect(revalidate).toHaveBeenCalledWith("/upcoming");
  });

  it("rejects a missing study id and a bad interval", async () => {
    seedActor();
    expect((await trackImagingFollowUp(fd({ interval_days: 365 }))).ok).toBe(
      false
    );
    const { profile } = seedActor();
    const studyId = addStudy(profile.id, today(profile.id));
    expect(
      (await trackImagingFollowUp(fd({ study_id: studyId, interval_days: 0 })))
        .ok
    ).toBe(false);
  });

  it("refuses a read-only acting session (requireWriteAccess)", async () => {
    const login = createLogin({});
    const profile = createProfile("ro", login.id);
    actAs(login, profile, "read");
    const studyId = addStudy(profile.id, today(profile.id));
    await expect(
      trackImagingFollowUp(fd({ study_id: studyId, interval_days: 365 }))
    ).rejects.toThrow();
  });
});

describe("resolveFollowUp action", () => {
  async function seedFollowUp() {
    const { profile } = seedActor();
    const now = today(profile.id);
    const studyId = addStudy(profile.id, shiftDateStr(now, -365));
    await trackImagingFollowUp(fd({ study_id: studyId, interval_days: 365 }));
    const cpId = (
      db
        .prepare(
          "SELECT id FROM care_plan_items WHERE profile_id = ? AND source_imaging_study_id = ?"
        )
        .get(profile.id, studyId) as { id: number }
    ).id;
    const laterId = addStudy(profile.id, shiftDateStr(now, -5));
    return { profile, cpId, laterId };
  }

  it("records the outcome + closes the loop (confirm-first)", async () => {
    const { cpId, laterId } = await seedFollowUp();
    const res = await resolveFollowUp(
      fd({
        care_plan_item_id: cpId,
        resolution: "stable",
        resolving_study_id: laterId,
      })
    );
    expect(res.ok).toBe(true);
    const cp = carePlanRow(cpId)!;
    expect(cp.status).toBe("completed");
    expect(cp.resolution).toBe("stable");
    expect(cp.resolvedBy).toBe(laterId);
    expect(revalidate).toHaveBeenCalledWith("/imaging");
  });

  it("rejects a bad outcome and an unknown follow-up", async () => {
    const { cpId } = await seedFollowUp();
    expect(
      (
        await resolveFollowUp(
          fd({ care_plan_item_id: cpId, resolution: "grew" })
        )
      ).ok
    ).toBe(false);
    expect(
      (
        await resolveFollowUp(
          fd({ care_plan_item_id: 999999, resolution: "resolved" })
        )
      ).ok
    ).toBe(false);
  });

  it("cannot resolve another profile's follow-up", async () => {
    const { cpId } = await seedFollowUp();
    // Switch to a different acting login/profile.
    const otherLogin = createLogin({});
    const otherProfile = createProfile("other", otherLogin.id);
    actAs(otherLogin, otherProfile, "write");
    const res = await resolveFollowUp(
      fd({ care_plan_item_id: cpId, resolution: "resolved" })
    );
    expect(res.ok).toBe(false);
    // Untouched.
    expect(carePlanRow(cpId)!.status).toBeNull();
  });
});

describe("deleteImagingStudy row-ops (#700)", () => {
  it("de-links a follow-up when its source study is deleted (no FK-500)", async () => {
    const { profile } = seedActor();
    const now = today(profile.id);
    const studyId = addStudy(profile.id, shiftDateStr(now, -30));
    await trackImagingFollowUp(fd({ study_id: studyId, interval_days: 365 }));
    const cpId = (
      db
        .prepare(
          "SELECT id FROM care_plan_items WHERE profile_id = ? AND source_imaging_study_id = ?"
        )
        .get(profile.id, studyId) as { id: number }
    ).id;

    const res = await deleteImagingStudy(fd({ id: studyId }));
    expect(res.ok).toBe(true);
    // The follow-up survives (not cascade-dropped), degraded to a generic item.
    const cp = carePlanRow(cpId)!;
    expect(cp.source_kind).toBeNull();
    expect(cp.src).toBeNull();
    // The study is gone.
    expect(
      db.prepare("SELECT id FROM imaging_studies WHERE id = ?").get(studyId)
    ).toBeUndefined();
  });
});
