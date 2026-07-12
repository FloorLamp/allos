import { describe, it, expect } from "vitest";
import {
  REST_PRESETS_SEC,
  REST_MIN_SEC,
  REST_MAX_SEC,
  suggestedRestSec,
  clampRestSec,
  leadExerciseName,
} from "../live-workout";

describe("suggestedRestSec", () => {
  it("gives isolation/accessory lifts the shortest rest", () => {
    expect(suggestedRestSec("Barbell Curl")).toBe(90);
    expect(suggestedRestSec("Lateral Raise")).toBe(90);
    expect(suggestedRestSec("Triceps Pushdown")).toBe(90);
  });

  it("gives big lower-body compounds the longest rest", () => {
    expect(suggestedRestSec("Back Squat")).toBe(180);
    expect(suggestedRestSec("Deadlift")).toBe(180);
    expect(suggestedRestSec("Leg Press")).toBe(180);
  });

  it("gives other compounds / upper lifts the middle default", () => {
    expect(suggestedRestSec("Barbell Bench Press")).toBe(120);
    expect(suggestedRestSec("Overhead Press")).toBe(120);
  });

  it("falls back to the middle default for an unknown/blank name", () => {
    expect(suggestedRestSec("")).toBe(120);
    expect(suggestedRestSec("Something Unlisted")).toBe(120);
  });

  it("reuses the same heavy classification as the next-set increment", () => {
    // Every preset is one of the offered chip values, so the suggested default
    // is always selectable in the UI.
    for (const name of ["Back Squat", "Barbell Curl", "Bench Press"]) {
      expect(REST_PRESETS_SEC).toContain(
        suggestedRestSec(name) as (typeof REST_PRESETS_SEC)[number]
      );
    }
  });
});

describe("clampRestSec", () => {
  it("clamps into the allowed range and rounds", () => {
    expect(clampRestSec(-30)).toBe(REST_MIN_SEC);
    expect(clampRestSec(9999)).toBe(REST_MAX_SEC);
    expect(clampRestSec(90.4)).toBe(90);
    expect(clampRestSec(90.6)).toBe(91);
  });

  it("returns the floor for a non-finite value", () => {
    expect(clampRestSec(NaN)).toBe(REST_MIN_SEC);
    expect(clampRestSec(Infinity)).toBe(REST_MIN_SEC);
  });
});

describe("leadExerciseName", () => {
  it("returns the last non-empty name (the part being worked)", () => {
    expect(leadExerciseName(["Bench Press", "Barbell Row"])).toBe(
      "Barbell Row"
    );
  });

  it("skips trailing blanks and trims", () => {
    expect(leadExerciseName(["Back Squat", "  ", ""])).toBe("Back Squat");
    expect(leadExerciseName(["  Deadlift  "])).toBe("Deadlift");
  });

  it("returns empty string when nothing is named", () => {
    expect(leadExerciseName([])).toBe("");
    expect(leadExerciseName(["", "  "])).toBe("");
  });
});
