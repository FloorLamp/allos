// SERVER-ACTION TIER — the training-restriction gate is symmetric (issue #488). The
// min_training_age restriction hides the activity VIEW/edit/delete surfaces for an
// under-age profile (/training redirects, the nav item and "Log activity" button are
// hidden), but the CREATE path (reachable via the command palette / a stale editor)
// was un-gated, so a restricted profile could persist an activity it can never see
// that still fed coaching/recap. saveActivity now refuses at the write boundary. Pins
// that a restricted profile's create is blocked server-side (writes NO row), and that
// lifting the restriction — or an unknown/at-or-over-age profile — still saves.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { setMinTrainingAge } from "@/lib/age-gate";
import { setStoredAge } from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => {
  revalidate.mockClear();
  // Reset the instance-wide gate between tests (it's a global setting).
  setMinTrainingAge(null);
});

const cardio = JSON.stringify([
  { name: "Soccer match", type: "sport", distance: null, duration_min: 60 },
]);

function activityCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

function saveSoccer(type = "sport") {
  return saveActivity(
    fd({
      type,
      title: "Soccer match",
      date: "2026-07-05",
      components: cardio,
      sets: "[]",
    })
  );
}

describe("saveActivity training-restriction gate (issue #488)", () => {
  it("refuses the create for a restricted (under-age) profile and writes nothing", async () => {
    const login = createLogin();
    const profile = createProfile("restricted-kid", login.id);
    actAs(login, profile);
    setMinTrainingAge(13);
    setStoredAge(profile.id, 10); // below the minimum → restricted

    const res = await saveSoccer();
    expect(res).toEqual({ ok: false, reason: "restricted" });
    expect(activityCount(profile.id)).toBe(0);
    // A refused write never revalidates the activity surfaces.
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("still refuses an EDIT for a restricted profile (leaving the row untouched)", async () => {
    // Seed a row while unrestricted, then turn the gate on and attempt an edit.
    const login = createLogin();
    const profile = createProfile("was-adult", login.id);
    actAs(login, profile);
    const created = await saveSoccer();
    if (!created.ok) throw new Error("setup save failed");

    setMinTrainingAge(13);
    setStoredAge(profile.id, 10);
    const res = await saveActivity(
      fd({
        id: created.id,
        type: "sport",
        title: "Edited title",
        date: "2026-07-05",
        components: cardio,
        sets: "[]",
      })
    );
    expect(res).toEqual({ ok: false, reason: "restricted" });
    const row = db
      .prepare("SELECT title FROM activities WHERE id = ?")
      .get(created.id) as { title: string };
    expect(row.title).toBe("Soccer match");
  });

  it("saves for a profile at/over the minimum age (not restricted)", async () => {
    const login = createLogin();
    const profile = createProfile("teen", login.id);
    actAs(login, profile);
    setMinTrainingAge(13);
    setStoredAge(profile.id, 13); // at the minimum → not restricted

    const res = await saveSoccer();
    expect(res.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });

  it("saves for an unknown-age profile (missing data is never restricted)", async () => {
    const login = createLogin();
    const profile = createProfile("no-age", login.id);
    actAs(login, profile);
    setMinTrainingAge(13); // gate on, but the profile has no stored age

    const res = await saveSoccer();
    expect(res.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });

  it("saves when the gate is off entirely, even for a young profile", async () => {
    const login = createLogin();
    const profile = createProfile("young-no-gate", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 8); // young, but no min_training_age set

    const res = await saveSoccer();
    expect(res.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });
});
