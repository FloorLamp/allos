import { describe, expect, it } from "vitest";
import {
  isOwnProfile,
  isViewingSelf,
  writeSubjectName,
  subjectActionLabel,
} from "@/lib/own-profile";

// The self-vs-other predicate + not-self naming (issue #1013). The whole matrix is
// pure, so it's pinned here without a DB: own set + acting self / other / no
// own-profile, and the label composition.

describe("isOwnProfile", () => {
  it("is true only when own is set and equals the profile", () => {
    expect(isOwnProfile(1, 1)).toBe(true);
    expect(isOwnProfile(1, 2)).toBe(false);
  });
  it("is false when no own-profile is set (null-safe)", () => {
    expect(isOwnProfile(null, 1)).toBe(false);
    expect(isOwnProfile(null, 2)).toBe(false);
  });
});

describe("isViewingSelf", () => {
  it("acting AS own profile → self", () => {
    expect(isViewingSelf({ actingProfileId: 1, ownProfileId: 1 })).toBe(true);
  });
  it("acting as someone else → not self", () => {
    expect(isViewingSelf({ actingProfileId: 2, ownProfileId: 1 })).toBe(false);
  });
  it("no own-profile → never self (a caregiver-only login)", () => {
    expect(isViewingSelf({ actingProfileId: 1, ownProfileId: null })).toBe(
      false
    );
  });
});

describe("writeSubjectName", () => {
  it("names the subject when the target is not the login's own profile", () => {
    expect(writeSubjectName(1, 2, "Mia")).toBe("Mia");
  });
  it("returns null for the login's own profile (self needs no naming)", () => {
    expect(writeSubjectName(1, 1, "Me")).toBeNull();
  });
  it("returns null when no own-profile is set — the distinction is off", () => {
    // A caregiver-only login has no defined self, so nothing is named as 'not you'
    // here (plain #1096 disambiguation still names cross-profile items elsewhere).
    expect(writeSubjectName(null, 2, "Mia")).toBeNull();
    expect(writeSubjectName(null, 1, "Sam")).toBeNull();
  });
});

describe("subjectActionLabel", () => {
  it("appends the subject with an em dash when named", () => {
    expect(subjectActionLabel("Log dose", "Mia")).toBe("Log dose — Mia");
    expect(subjectActionLabel("Finish workout", "Mia")).toBe(
      "Finish workout — Mia"
    );
  });
  it("returns the base label unchanged when the subject is null (self)", () => {
    expect(subjectActionLabel("Confirm", null)).toBe("Confirm");
    expect(subjectActionLabel("Log", null)).toBe("Log");
  });
});
