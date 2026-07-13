// SERVER-ACTION TIER — setting/correcting a profile's birthdate or age must
// re-reconcile stored biomarker flags (#628).
//
// 26 analytes carry age-banded reference ranges (ranges_by_age). A reading stored
// with no birthdate is flagged against the ADULT fallback band; filling in the
// birthdate later (or a stored age) must recompute each historical reading against
// its own reading-date age — reconcileFlags already does this, the fix is just to
// TRIGGER it from the birthdate/age write path (it previously fired only on a
// sex / reproductive-status change).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveProfileSettings } from "@/app/(app)/settings/profile/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// Alkaline Phosphatase: adult ref_high 129 U/L; the age 1–10 band is 140–420, so a
// child's 320 U/L is HIGH against the adult fallback but NORMAL for an 8-year-old.
function seedAlp(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, flag, canonical_name)
         VALUES (?, '2024-06-01', 'lab', 'Alkaline Phosphatase', '320', 320, 'U/L', 'high', 'Alkaline Phosphatase')`
      )
      .run(profileId).lastInsertRowid
  );
}

function flagOf(id: number): string | null {
  return (
    db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as {
      flag: string | null;
    }
  ).flag;
}

beforeEach(() => revalidate.mockClear());

describe("saveProfileSettings re-reconciles flags when birthdate is set (#628)", () => {
  it("recomputes a pediatric-band reading flagged against the adult band", async () => {
    const login = createLogin();
    const profile = createProfile("child-no-birthdate", login.id);
    actAs(login, profile);
    const id = seedAlp(profile.id);
    expect(flagOf(id)).toBe("high"); // adult fallback verdict

    // Parent fills in the birthdate: child is 8 on the 2024-06-01 reading date.
    await saveProfileSettings(fd({ birthdate: "2016-06-01" }));

    expect(flagOf(id)).toBeNull(); // pediatric band → normal, flag cleared
    expect(revalidate).toHaveBeenCalledWith("/biomarkers");
  });

  it("recomputes when the stored-age fallback is set (no birthdate)", async () => {
    const login = createLogin();
    const profile = createProfile("child-stored-age", login.id);
    actAs(login, profile);
    const id = seedAlp(profile.id);
    expect(flagOf(id)).toBe("high");

    // Stored age 8 (birthdate blank). ageForRecord uses the age proxy for a record
    // whose date has no derivable birthdate age.
    await saveProfileSettings(fd({ age: "8" }));

    expect(flagOf(id)).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/biomarkers");
  });

  it("does not reconcile (or revalidate biomarkers) when birthdate is unchanged", async () => {
    const login = createLogin();
    const profile = createProfile("no-demo-change", login.id);
    actAs(login, profile);
    const id = seedAlp(profile.id);

    // No birthdate/age/sex fields → nothing demographic changed.
    await saveProfileSettings(fd({ timezone: "America/New_York" }));

    expect(flagOf(id)).toBe("high"); // untouched
    expect(revalidate).not.toHaveBeenCalledWith("/biomarkers");
  });
});
