// SERVER-ACTION TIER — the protein-goal write path (issue #1503) through the real
// saveProteinGoal action + the (mocked) auth guard.
//
// The bug this closes: `training_goal` was READ by the protein-band engine and written
// by nothing, so every profile silently sat on the "active" band regardless of the phase
// they were in. This tier proves the write exists, is auth-gated, validates against the
// accepted vocabulary, and actually moves the band the Nutrition surfaces read — plus
// that the fitness onboarding path seeds the default EXPLICITLY.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { revalidatePath } from "next/cache";
import { saveProteinGoal } from "@/app/(app)/settings/profile/actions";
import { saveOnboardingFocuses } from "@/app/(app)/onboarding/actions";
import {
  getProteinGoalLevel,
  hasProteinGoalLevel,
  setOnboardingState,
  setProteinGoalLevel,
} from "@/lib/settings";
import {
  initialOnboardingState,
  onboardingWithProfilePath,
} from "@/lib/onboarding";
import { db } from "@/lib/db";
import { getProteinAdequacy } from "@/lib/queries";
import { proteinGoalBand } from "@/lib/protein";
import { createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function goalForm(value: string): FormData {
  const form = new FormData();
  form.set("protein_goal", value);
  return form;
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("saveProteinGoal", () => {
  it("round-trips a pick and revalidates the surfaces that read the band", async () => {
    const login = createLogin();
    const profile = createProfile("protein-goal-write", login.id);
    actAs(login, profile);

    // Unset reads as the documented default rather than "nothing".
    expect(hasProteinGoalLevel(profile.id)).toBe(false);
    expect(getProteinGoalLevel(profile.id)).toBe("active");

    expect(await saveProteinGoal(goalForm("cut"))).toEqual({ ok: true });
    expect(getProteinGoalLevel(profile.id)).toBe("cut");
    expect(hasProteinGoalLevel(profile.id)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
    expect(revalidate).toHaveBeenCalledWith("/settings/nutrition");
  });

  it("accepts the whole vocabulary, including its synonyms, canonically", async () => {
    const login = createLogin();
    const profile = createProfile("protein-goal-vocab", login.id);
    actAs(login, profile);

    for (const [submitted, stored] of [
      ["rda", "rda"],
      ["hypertrophy", "hypertrophy"],
      ["muscle_gain", "hypertrophy"], // a synonym normalizes to the level
      ["active", "active"],
    ] as const) {
      expect(await saveProteinGoal(goalForm(submitted))).toEqual({ ok: true });
      expect(getProteinGoalLevel(profile.id)).toBe(stored);
    }
  });

  it("refuses a value outside the vocabulary instead of storing junk", async () => {
    const login = createLogin();
    const profile = createProfile("protein-goal-junk", login.id);
    actAs(login, profile);

    await saveProteinGoal(goalForm("cut"));
    const res = await saveProteinGoal(goalForm("keto-maxxing"));
    expect(res.ok).toBe(false);
    // The earlier pick survives — a forged post can neither store junk nor silently
    // reset the person's goal to the default.
    expect(getProteinGoalLevel(profile.id)).toBe("cut");
  });

  it("a read-only grant cannot write", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("protein-goal-ro", login.id);
    actAs(login, profile, "read");
    await expect(saveProteinGoal(goalForm("cut"))).rejects.toThrow(/read-only/);
  });

  it("the stored goal moves the band the adequacy engine reports", async () => {
    const login = createLogin();
    const profile = createProfile("protein-goal-band", login.id);
    actAs(login, profile);
    // A bodyweight to scale the band by (no lean mass → total-bodyweight basis) and
    // one quick-add protein entry, so the adequacy model has both halves.
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, date('now'), 80)`
    ).run(profile.id);
    db.prepare(
      `INSERT INTO protein_log (profile_id, date, grams) VALUES (?, date('now'), 120)`
    ).run(profile.id);

    await saveProteinGoal(goalForm("cut"));
    const cut = getProteinAdequacy(profile.id);
    expect(cut?.target.goal).toBe("cut");
    expect(cut?.target.gPerKgLow).toBe(proteinGoalBand("cut").low);

    await saveProteinGoal(goalForm("rda"));
    const rda = getProteinAdequacy(profile.id);
    expect(rda?.target.goal).toBe("rda");
    expect(rda!.target.gramsLow).toBeLessThan(cut!.target.gramsLow);
  });
});

describe("onboarding seeds the protein goal on the fitness path (#1503)", () => {
  async function pickFocuses(profileId: number, focuses: string[]) {
    setOnboardingState(
      profileId,
      onboardingWithProfilePath(
        initialOnboardingState(),
        "self",
        new Date().toISOString()
      )
    );
    const form = new FormData();
    for (const f of focuses) form.append("focus", f);
    // The action redirects to the next step on success.
    await expect(saveOnboardingFocuses(form)).rejects.toThrow(/NEXT_REDIRECT/);
  }

  it("writes the default explicitly when fitness is a chosen outcome", async () => {
    const login = createLogin();
    const profile = createProfile("protein-goal-onboard", login.id);
    actAs(login, profile);

    expect(hasProteinGoalLevel(profile.id)).toBe(false);
    await pickFocuses(profile.id, ["fitness"]);
    // Stored, not merely defaulted — so the Settings picker shows a real pick.
    expect(hasProteinGoalLevel(profile.id)).toBe(true);
    expect(getProteinGoalLevel(profile.id)).toBe("active");
  });

  it("never overwrites a goal the person already picked", async () => {
    const login = createLogin();
    const profile = createProfile("protein-goal-onboard-keep", login.id);
    actAs(login, profile);
    setProteinGoalLevel(profile.id, "hypertrophy");

    await pickFocuses(profile.id, ["fitness"]);
    expect(getProteinGoalLevel(profile.id)).toBe("hypertrophy");
  });

  it("leaves it unset when fitness is not a chosen outcome", async () => {
    const login = createLogin();
    const profile = createProfile("protein-goal-onboard-none", login.id);
    actAs(login, profile);

    await pickFocuses(profile.id, ["metrics-labs"]);
    expect(hasProteinGoalLevel(profile.id)).toBe(false);
  });
});
