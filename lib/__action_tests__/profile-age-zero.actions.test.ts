// SERVER-ACTION TIER — Settings → Profile accepts an age of 0 (#2992 R3).
//
// WHY THIS FILE EXISTS. #2992 relaxed the `age > 0` bound in six places, and the
// adversarial pass found that exactly one of them was unpinned: reverting the single
// token at app/(app)/settings/profile/actions.ts left the ENTIRE action tier green
// (185 files, 1380 tests). That is the site that most needs a test, because onboarding
// runs once — this is the path a caregiver takes to CORRECT an age later, including
// the "I entered 1, the baby is actually a newborn" edit.
//
// The distinction the assertions turn on: 0 is a VALUE and the blank field is the
// absence. The action's own structure makes these two different branches, so a test
// that only checked "0 is stored" would not notice if clearing broke.

import { describe, it, expect } from "vitest";
import { saveProfileSettings } from "@/app/(app)/settings/profile/actions";
import {
  getStoredAge,
  getProfileBirthdate,
} from "@/lib/settings/profile-attrs";
import { fastAdultOnlyRefusal } from "@/lib/fast-write";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings";
import { createLogin, createProfile, actAs } from "./harness";

// The Profile form posts every field on each save (see ProfileForm's `save`), so the
// fixture mirrors that rather than posting the age alone.
function profileForm(fields: { age?: string; birthdate?: string }): FormData {
  const f = new FormData();
  f.set("sex", "female");
  f.set("birthdate", fields.birthdate ?? "");
  f.set("age", fields.age ?? "");
  f.set("timezone", "America/New_York");
  f.set("week_start", "monday");
  f.set("week_mode", "calendar");
  return f;
}

describe("saveProfileSettings — an age of 0 (#2992)", () => {
  function caregiverEditing(name: string) {
    const login = createLogin({ username: `age-zero-${name}` });
    const profile = createProfile(`Age Zero ${name}`, login.id);
    actAs(login, profile);
    return profile;
  }

  it("stores an entered age of 0 instead of ignoring it", async () => {
    const profile = caregiverEditing("newborn");
    await saveProfileSettings(profileForm({ age: "0" }));

    expect(getProfileBirthdate(profile.id)).toBeNull();
    expect(getStoredAge(profile.id)).toBe(0);
  });

  it("corrects a previously-entered age DOWN to 0", async () => {
    // The realistic edit, and the one the old bound silently discarded: the value was
    // already 1, so "ignore an invalid number so a fat-fingered entry can't wipe a good
    // value" left the wrong age standing with no error shown.
    const profile = caregiverEditing("correct-down");
    await saveProfileSettings(profileForm({ age: "1" }));
    expect(getStoredAge(profile.id)).toBe(1);

    await saveProfileSettings(profileForm({ age: "0" }));
    expect(getStoredAge(profile.id)).toBe(0);
  });

  it("makes the life-stage gates see the infant after the save", async () => {
    // The point of storing it: a value that never reaches a gate is not a fix.
    const profile = caregiverEditing("gates");
    await saveProfileSettings(profileForm({ age: "0" }));

    expect(getProfileAge(profile.id)).toBe(0);
    expect(isFoodLoggingRelevant(getProfileAge(profile.id))).toBe(false);
    expect(fastAdultOnlyRefusal(profile.id)).toBe(true);
  });

  it("still treats a BLANK age as clearing it back to unknown", async () => {
    // 0 and "unknown" must stay different answers on the write side too — this is the
    // branch that would break if someone "simplified" the validator by treating a
    // falsy age as absent.
    const profile = caregiverEditing("clear");
    await saveProfileSettings(profileForm({ age: "0" }));
    expect(getStoredAge(profile.id)).toBe(0);

    await saveProfileSettings(profileForm({ age: "" }));
    expect(getStoredAge(profile.id)).toBeNull();
    expect(fastAdultOnlyRefusal(profile.id)).toBe(false); // unknown → permissive
  });

  it("still ignores values no real age can take", async () => {
    const profile = caregiverEditing("junk");
    await saveProfileSettings(profileForm({ age: "0" }));
    for (const junk of ["-1", "150", "abc", "0.5"]) {
      await saveProfileSettings(profileForm({ age: junk }));
      // Unchanged — a bad entry never overwrites a good value.
      expect(getStoredAge(profile.id)).toBe(0);
    }
  });

  it("a birthdate still supersedes and clears the stored 0", async () => {
    const profile = caregiverEditing("birthdate");
    await saveProfileSettings(profileForm({ age: "0" }));
    await saveProfileSettings(profileForm({ birthdate: "1990-01-01" }));

    expect(getProfileBirthdate(profile.id)).toBe("1990-01-01");
    expect(getStoredAge(profile.id)).toBeNull();
  });
});
