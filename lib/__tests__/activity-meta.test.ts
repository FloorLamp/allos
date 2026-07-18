import { describe, expect, it } from "vitest";
import {
  compositeRollup,
  inferFreeTextType,
  legacyActivityName,
  minutesBetween,
  requiresDistance,
  resolveActivityType,
  shiftHHMM,
  showsDistanceField,
  soleComponentDuration,
  timeOfDay,
  titleCase,
} from "@/lib/activity-meta";
import { isCuratedActivity } from "@/lib/activities-catalog";

describe("resolveActivityType", () => {
  it("classifies known lifts as strength", () => {
    expect(resolveActivityType("Bench Press")).toBe("strength");
    expect(resolveActivityType("Back Squat")).toBe("strength");
  });

  it("classifies cardio keywords", () => {
    expect(resolveActivityType("Morning Run")).toBe("cardio");
    expect(resolveActivityType("Cycling")).toBe("cardio");
    expect(resolveActivityType("Lap Swim")).toBe("cardio");
  });

  it("classifies mixed / class-style cardio", () => {
    expect(resolveActivityType("Mixed Cardio")).toBe("cardio");
    expect(resolveActivityType("Cardio Class")).toBe("cardio");
    expect(resolveActivityType("Bootcamp")).toBe("cardio");
    expect(resolveActivityType("Circuit Training")).toBe("cardio");
    expect(resolveActivityType("CrossFit")).toBe("cardio");
    expect(resolveActivityType("Rollerblading")).toBe("cardio");
  });

  it("classifies sport keywords", () => {
    expect(resolveActivityType("Tennis")).toBe("sport");
    expect(resolveActivityType("Bouldering")).toBe("sport");
  });

  it("classifies recovery / mobility keywords (issue #840)", () => {
    // Yoga/stretch/pilates/etc moved out of SPORT into the HABIT-tier recovery domain
    // so a mobility session never carries sport performance semantics.
    expect(resolveActivityType("Yoga")).toBe("recovery");
    expect(resolveActivityType("Pilates")).toBe("recovery");
    expect(resolveActivityType("Stretching")).toBe("recovery");
    expect(resolveActivityType("Morning Mobility")).toBe("recovery");
    expect(resolveActivityType("Foam Rolling")).toBe("recovery");
    expect(resolveActivityType("Tai Chi")).toBe("recovery");
  });

  it("returns null for empty or unrecognized names", () => {
    expect(resolveActivityType("")).toBeNull();
    expect(resolveActivityType("   ")).toBeNull();
    expect(resolveActivityType("Napping")).toBeNull();
  });
});

describe("inferFreeTextType", () => {
  it("infers cardio and sport from keywords", () => {
    expect(inferFreeTextType("Aqua Jogging")).toBe("cardio");
    expect(inferFreeTextType("Zone 2 Cardio")).toBe("cardio");
    expect(inferFreeTextType("Beach Volleyball")).toBe("sport");
  });

  it("suppresses strength — lifts stay a closed list", () => {
    expect(inferFreeTextType("Bench Press")).toBeNull();
    expect(inferFreeTextType("Back Squat")).toBeNull();
  });

  it("returns null for unknown or blank names", () => {
    expect(inferFreeTextType("Archery")).toBeNull();
    expect(inferFreeTextType("Benchpress")).toBeNull();
    expect(inferFreeTextType("")).toBeNull();
    expect(inferFreeTextType("   ")).toBeNull();
  });
});

describe("showsDistanceField", () => {
  it("keeps the keyword behavior for catalog names", () => {
    expect(showsDistanceField("Morning Run", "cardio", false)).toBe(true);
    expect(showsDistanceField("HIIT", "cardio", false)).toBe(false);
    expect(showsDistanceField("Tennis", "sport", false)).toBe(false);
  });

  it("always offers distance to custom cardio, but not custom sport", () => {
    expect(showsDistanceField("Archery", "cardio", true)).toBe(true);
    expect(showsDistanceField("Archery", "sport", true)).toBe(false);
  });

  it("is false for strength even when a keyword matches", () => {
    expect(showsDistanceField("Farmer's Walk", "strength", false)).toBe(false);
  });

  it("falls back to the keyword check for a null type", () => {
    expect(showsDistanceField("Morning Run", null, false)).toBe(true);
    expect(showsDistanceField("Archery", null, true)).toBe(false);
  });
});

describe("isCuratedActivity", () => {
  it("matches catalog names case-insensitively, ignoring padding", () => {
    expect(isCuratedActivity("Running")).toBe(true);
    expect(isCuratedActivity("  running ")).toBe(true);
    expect(isCuratedActivity("SPIN CLASS")).toBe(true);
    expect(isCuratedActivity("Tennis")).toBe(true);
    expect(isCuratedActivity("Zumba")).toBe(true);
  });

  it("is false for coined names, lifts, and blanks", () => {
    // User-coined names stay non-curated even after they're logged — that's
    // what keeps their custom chips/distance field across sessions.
    expect(isCuratedActivity("Archery")).toBe(false);
    expect(isCuratedActivity("Bench Press")).toBe(false);
    expect(isCuratedActivity("")).toBe(false);
  });
});

describe("legacyActivityName", () => {
  const known = (...names: string[]) => {
    const set = new Set(names.map((n) => n.toLowerCase()));
    return (n: string) => set.has(n.trim().toLowerCase());
  };

  it("prefers the stripped title when the picker knows it", () => {
    expect(
      legacyActivityName("Morning Running Session", known("Running"))
    ).toBe("Running");
  });

  it("falls back to the full title when only IT is known", () => {
    // A row titled "Night Walk" where "Night Walk" is a logged activity but
    // the stripped "Walk" isn't — must not split into a different name.
    expect(legacyActivityName("Night Walk", known("Night Walk"))).toBe(
      "Night Walk"
    );
  });

  it("uses the stripped text for unknown titles (custom activity)", () => {
    expect(
      legacyActivityName("Morning Zwift - Watopia Session", known("Running"))
    ).toBe("Zwift - Watopia");
  });

  it("keeps the raw title when stripping empties it", () => {
    expect(legacyActivityName("", known())).toBe("");
  });
});

describe("requiresDistance", () => {
  it("is true for distance-based activities", () => {
    expect(requiresDistance("Morning Run")).toBe(true);
    expect(requiresDistance("Cycling")).toBe(true);
    expect(requiresDistance("Open Water Swim")).toBe(true);
  });

  it("is false for activities without a meaningful distance", () => {
    expect(requiresDistance("Bench Press")).toBe(false);
    expect(requiresDistance("Yoga")).toBe(false);
  });
});

describe("timeOfDay", () => {
  it("buckets the hour of a HH:MM string", () => {
    expect(timeOfDay("06:30")).toBe("Morning");
    expect(timeOfDay("11:59")).toBe("Morning");
    expect(timeOfDay("12:00")).toBe("Afternoon");
    expect(timeOfDay("16:45")).toBe("Afternoon");
    expect(timeOfDay("17:00")).toBe("Evening");
    expect(timeOfDay("20:59")).toBe("Evening");
    expect(timeOfDay("21:00")).toBe("Night");
    expect(timeOfDay("03:00")).toBe("Night");
  });

  it("returns null for empty or non-numeric input", () => {
    expect(timeOfDay("")).toBeNull();
    expect(timeOfDay("ab:cd")).toBeNull();
  });
});

describe("minutesBetween", () => {
  it("returns the positive span between two times", () => {
    expect(minutesBetween("08:00", "09:30")).toBe(90);
    expect(minutesBetween("10:15", "10:45")).toBe(30);
  });

  it("returns null for zero, negative, or invalid spans", () => {
    expect(minutesBetween("10:00", "10:00")).toBeNull();
    expect(minutesBetween("10:00", "09:00")).toBeNull();
    expect(minutesBetween("", "09:00")).toBeNull();
    expect(minutesBetween("x:y", "09:00")).toBeNull();
  });
});

describe("shiftHHMM", () => {
  it("shifts a time forward and back, staying in-day", () => {
    expect(shiftHHMM("08:00", 90)).toBe("09:30");
    expect(shiftHHMM("09:30", -90)).toBe("08:00");
    expect(shiftHHMM("10:15", 45)).toBe("11:00");
  });

  it("returns null when the shift falls outside the day", () => {
    expect(shiftHHMM("23:30", 45)).toBeNull(); // past midnight
    expect(shiftHHMM("00:15", -30)).toBeNull(); // before midnight
    expect(shiftHHMM("00:00", 1439)).toBe("23:59"); // last minute is in-day
  });

  it("returns null for invalid input", () => {
    expect(shiftHHMM("", 30)).toBeNull();
    expect(shiftHHMM("x:y", 30)).toBeNull();
  });
});

describe("titleCase", () => {
  it("capitalizes all-lowercase words", () => {
    expect(titleCase("morning run")).toBe("Morning Run");
    expect(titleCase("yoga")).toBe("Yoga");
  });

  it("leaves words that already contain capitals untouched", () => {
    expect(titleCase("HIIT session")).toBe("HIIT Session");
    expect(titleCase("McRun")).toBe("McRun");
  });
});

// Multisport ("brick") roll-up (issue #313): collapse the legs into the parent's
// distance/duration — sum-of-parts distance (">0 else null"), clock-time-wins
// duration — plus a "does any leg lift" flag.
describe("compositeRollup", () => {
  const swim = { type: "cardio" as const, distance_km: 1, duration_min: 20 };
  const bike = { type: "cardio" as const, distance_km: 20, duration_min: 40 };
  const lift = {
    type: "strength" as const,
    distance_km: null,
    duration_min: 30,
  };

  it("sums leg distances", () => {
    expect(compositeRollup([swim, bike], null).distanceKm).toBe(21);
  });

  it("collapses a zero total distance to null (strength-only brick)", () => {
    expect(compositeRollup([lift], null).distanceKm).toBeNull();
  });

  it("prefers the clock span over the sum of leg durations", () => {
    // legs sum to 60, but the wall clock says 75 (includes transitions).
    expect(compositeRollup([swim, bike], 75).durationMin).toBe(75);
  });

  it("falls back to the sum of leg durations when there is no clock span", () => {
    expect(compositeRollup([swim, bike], null).durationMin).toBe(60);
  });

  it("collapses a zero summed duration to null with no clock span", () => {
    const noDur = {
      type: "cardio" as const,
      distance_km: 5,
      duration_min: null,
    };
    expect(compositeRollup([noDur], null).durationMin).toBeNull();
  });

  it("uses the clock span even when it is shorter than the parts", () => {
    expect(compositeRollup([swim, bike], 10).durationMin).toBe(10);
  });

  it("reports hasStrength when any leg is a strength leg", () => {
    expect(compositeRollup([swim, lift], null).hasStrength).toBe(true);
    expect(compositeRollup([swim, bike], null).hasStrength).toBe(false);
  });

  it("handles an empty component list", () => {
    expect(compositeRollup([], null)).toEqual({
      distanceKm: null,
      durationMin: null,
      hasStrength: false,
    });
  });
});

describe("soleComponentDuration (#791)", () => {
  it("keeps a component's own duration whenever it has one", () => {
    // Even a mixed session's already-typed leg is untouched.
    expect(
      soleComponentDuration({
        componentDurationMin: 25,
        isSoleComponent: false,
        isStrength: false,
        sessionDurationMin: 90,
      })
    ).toBe(25);
    expect(
      soleComponentDuration({
        componentDurationMin: 25,
        isSoleComponent: true,
        isStrength: false,
        sessionDurationMin: 40,
      })
    ).toBe(25);
  });

  it("fills a lone non-strength leg's missing duration from the session span", () => {
    expect(
      soleComponentDuration({
        componentDurationMin: null,
        isSoleComponent: true,
        isStrength: false,
        sessionDurationMin: 40,
      })
    ).toBe(40);
  });

  it("does not fill when the lone component is strength", () => {
    expect(
      soleComponentDuration({
        componentDurationMin: null,
        isSoleComponent: true,
        isStrength: true,
        sessionDurationMin: 40,
      })
    ).toBeNull();
  });

  it("does not fill a leg of a multi-part composite (no double-counting)", () => {
    // The sole-component guard: a mixed strength+sport session must not attribute
    // the whole session's minutes to its sport/cardio leg.
    expect(
      soleComponentDuration({
        componentDurationMin: null,
        isSoleComponent: false,
        isStrength: false,
        sessionDurationMin: 90,
      })
    ).toBeNull();
  });

  it("returns null when there is no session duration to inherit", () => {
    expect(
      soleComponentDuration({
        componentDurationMin: null,
        isSoleComponent: true,
        isStrength: false,
        sessionDurationMin: null,
      })
    ).toBeNull();
  });
});
