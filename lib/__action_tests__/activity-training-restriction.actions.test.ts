// SERVER-ACTION TIER — the training restriction is TYPE-AWARE (issue #489, evolving
// #488). The min_training_age restriction protects the ADULT strength apparatus, not
// the age-neutral activity domain: a restricted (under-age) profile may create/edit
// duration-based SPORT/CARDIO sessions (its lightweight activity log) but still cannot
// log a STRENGTH session. saveActivity enforces this at the write boundary via the pure
// isActivityTypeAllowed rule, so the create/view paths agree regardless of the UI. Pins
// that a restricted profile's sport/cardio save persists, its strength save is refused
// (writes NO row), and that lifting the restriction — or an unknown/at-or-over-age
// profile — still saves every type.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity, deleteActivity } from "@/app/(app)/journal/actions";
import { setMinTrainingAge } from "@/lib/age-gate";
import { setStoredAge } from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => {
  revalidate.mockClear();
  // Reset the instance-wide gate between tests (it's a global setting).
  setMinTrainingAge(null);
});

const sportPart = JSON.stringify([
  { name: "Soccer match", type: "sport", distance: null, duration_min: 60 },
]);
const strengthPart = JSON.stringify([
  { name: "Bench press", type: "strength", distance: null, duration_min: null },
]);

function activityCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

function saveSport() {
  return saveActivity(
    fd({
      type: "sport",
      title: "Soccer match",
      date: "2026-07-05",
      components: sportPart,
      sets: "[]",
    })
  );
}

function saveStrength() {
  return saveActivity(
    fd({
      type: "strength",
      title: "Bench press",
      date: "2026-07-05",
      components: strengthPart,
      sets: JSON.stringify([{ exercise: "Bench press", weight: 60, reps: 5 }]),
    })
  );
}

describe("saveActivity type-aware training restriction (issue #489)", () => {
  function restrictedKid() {
    const login = createLogin();
    const profile = createProfile("restricted-kid", login.id);
    actAs(login, profile);
    setMinTrainingAge(13);
    setStoredAge(profile.id, 10); // below the minimum → restricted
    return { login, profile };
  }

  it("lets a restricted profile log a SPORT session (age-neutral domain)", async () => {
    const { profile } = restrictedKid();
    const res = await saveSport();
    expect(res.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });

  it("refuses a restricted profile's STRENGTH create and writes nothing", async () => {
    const { profile } = restrictedKid();
    const res = await saveStrength();
    expect(res).toEqual({ ok: false, reason: "restricted" });
    expect(activityCount(profile.id)).toBe(0);
    // A refused write never revalidates the activity surfaces.
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("lets a restricted profile edit its own sport session", async () => {
    // Seed a sport row while unrestricted, then restrict and edit it.
    const login = createLogin();
    const profile = createProfile("sport-editor", login.id);
    actAs(login, profile);
    const created = await saveSport();
    if (!created.ok) throw new Error("setup save failed");

    setMinTrainingAge(13);
    setStoredAge(profile.id, 10);
    const res = await saveActivity(
      fd({
        id: created.id,
        type: "sport",
        title: "Soccer practice",
        date: "2026-07-05",
        components: sportPart,
        sets: "[]",
      })
    );
    expect(res.ok).toBe(true);
    const row = db
      .prepare("SELECT title FROM activities WHERE id = ?")
      .get(created.id) as { title: string };
    expect(row.title).toBe("Soccer practice");
  });

  it("lets a restricted profile delete its own sport session", async () => {
    const login = createLogin();
    const profile = createProfile("sport-deleter", login.id);
    actAs(login, profile);
    const created = await saveSport();
    if (!created.ok) throw new Error("setup save failed");

    setMinTrainingAge(13);
    setStoredAge(profile.id, 10);
    const res = await deleteActivity(fd({ id: created.id }));
    expect(res.undoId).not.toBeNull();
    expect(activityCount(profile.id)).toBe(0);
  });

  it("saves every type for a profile at/over the minimum age (not restricted)", async () => {
    const login = createLogin();
    const profile = createProfile("teen", login.id);
    actAs(login, profile);
    setMinTrainingAge(13);
    setStoredAge(profile.id, 13); // at the minimum → not restricted

    expect((await saveSport()).ok).toBe(true);
    expect((await saveStrength()).ok).toBe(true);
    expect(activityCount(profile.id)).toBe(2);
  });

  it("saves strength for an unknown-age profile (missing data is never restricted)", async () => {
    const login = createLogin();
    const profile = createProfile("no-age", login.id);
    actAs(login, profile);
    setMinTrainingAge(13); // gate on, but the profile has no stored age

    const res = await saveStrength();
    expect(res.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });

  it("saves strength when the gate is off entirely, even for a young profile", async () => {
    const login = createLogin();
    const profile = createProfile("young-no-gate", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 8); // young, but no min_training_age set

    const res = await saveStrength();
    expect(res.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });
});
