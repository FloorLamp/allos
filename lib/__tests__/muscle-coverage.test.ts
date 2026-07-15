import { describe, expect, it } from "vitest";
import {
  coverageFromSets,
  coverageList,
  musclesWorked,
  SECONDARY_CREDIT,
  type CoverageSet,
} from "@/lib/muscle-coverage";

// A fixed "today" for trailing-window math. Sets are dated relative to it.
const TODAY = "2026-07-15";

describe("coverageFromSets — attribution", () => {
  it("credits 1.0 to each primary and 0.5 to each secondary muscle", () => {
    // Bench Press → primary [chest], secondary [front-delts, triceps].
    const cov = coverageFromSets(
      [{ exercise: "Barbell Bench Press", date: TODAY }],
      TODAY
    );
    expect(cov.get("chest")?.sets).toBe(1.0);
    expect(cov.get("front-delts")?.sets).toBe(SECONDARY_CREDIT);
    expect(cov.get("triceps")?.sets).toBe(SECONDARY_CREDIT);
    // No credit leaks to an untrained muscle.
    expect(cov.get("lats")).toBeUndefined();
  });

  it("accumulates across multiple sets of the same exercise", () => {
    const sets: CoverageSet[] = [
      { exercise: "Back Squat", date: TODAY },
      { exercise: "Back Squat", date: TODAY },
      { exercise: "Back Squat", date: TODAY },
    ];
    // Back Squat: primary quads, secondary glutes/hamstrings/lower-back.
    const cov = coverageFromSets(sets, TODAY);
    expect(cov.get("quads")?.sets).toBe(3);
    expect(cov.get("glutes")?.sets).toBe(1.5);
    expect(cov.get("hamstrings")?.sets).toBe(1.5);
  });

  it("uses the secondary constant, not a hard-coded 0.5", () => {
    const cov = coverageFromSets(
      [{ exercise: "Deadlift", date: TODAY }],
      TODAY
    );
    // Deadlift secondary includes glutes.
    expect(cov.get("glutes")?.sets).toBe(SECONDARY_CREDIT);
  });
});

describe("coverageFromSets — variant collapse via exerciseHistoryKey", () => {
  it("credits Barbell Curl and the bare Curl identically", () => {
    const a = coverageFromSets(
      [{ exercise: "Barbell Curl", date: TODAY }],
      TODAY
    );
    const b = coverageFromSets([{ exercise: "Curl", date: TODAY }], TODAY);
    // Curl: primary biceps, secondary forearms.
    expect(a.get("biceps")?.sets).toBe(1);
    expect(a.get("forearms")?.sets).toBe(SECONDARY_CREDIT);
    expect(b.get("biceps")?.sets).toBe(a.get("biceps")?.sets);
    expect(b.get("forearms")?.sets).toBe(a.get("forearms")?.sets);
  });

  it("merges variant spellings into one accumulated history", () => {
    const cov = coverageFromSets(
      [
        { exercise: "Barbell Curl", date: TODAY },
        { exercise: "Dumbbell Curl", date: TODAY },
        { exercise: "Curl", date: TODAY },
      ],
      TODAY
    );
    // Three sets, all collapse to "curl" → biceps gets 3.0.
    expect(cov.get("biceps")?.sets).toBe(3);
  });
});

describe("coverageFromSets — custom-lift exclusion", () => {
  it("contributes nothing for a non-catalog exercise name", () => {
    const cov = coverageFromSets(
      [{ exercise: "Zercher Kettlebell Thruster", date: TODAY }],
      TODAY
    );
    expect(cov.size).toBe(0);
  });

  it("does not credit a custom lift via liftInfo's loose contains-fallback", () => {
    // "Front Squat Variation" is custom; it must NOT be credited as Front Squat.
    const cov = coverageFromSets(
      [{ exercise: "Front Squat Variation", date: TODAY }],
      TODAY
    );
    expect(cov.size).toBe(0);
  });
});

describe("coverageFromSets — trailing-window boundaries", () => {
  it("includes today and excludes sets windowDays days ago", () => {
    const sets: CoverageSet[] = [
      { exercise: "Back Squat", date: TODAY }, // 0 days ago — in
      { exercise: "Back Squat", date: "2026-07-09" }, // 6 days ago — in (window 7)
      { exercise: "Back Squat", date: "2026-07-08" }, // 7 days ago — OUT
    ];
    const cov = coverageFromSets(sets, TODAY, 7);
    // Two in-window sets → quads 2.0.
    expect(cov.get("quads")?.sets).toBe(2);
  });

  it("excludes future-dated sets", () => {
    const cov = coverageFromSets(
      [{ exercise: "Back Squat", date: "2026-07-16" }],
      TODAY,
      7
    );
    expect(cov.size).toBe(0);
  });

  it("attributes every set when no window is given", () => {
    const cov = coverageFromSets(
      [{ exercise: "Back Squat", date: "2020-01-01" }],
      TODAY
    );
    expect(cov.get("quads")?.sets).toBe(1);
  });
});

describe("coverageFromSets — lastTrained", () => {
  it("tracks the most recent date a muscle was credited", () => {
    const sets: CoverageSet[] = [
      { exercise: "Back Squat", date: "2026-07-10" },
      { exercise: "Back Squat", date: "2026-07-14" },
      { exercise: "Back Squat", date: "2026-07-12" },
    ];
    const cov = coverageFromSets(sets, TODAY);
    expect(cov.get("quads")?.lastTrained).toBe("2026-07-14");
  });

  it("carries recency across different exercises sharing a muscle", () => {
    const sets: CoverageSet[] = [
      { exercise: "Back Squat", date: "2026-07-10" }, // glutes (secondary)
      { exercise: "Hip Thrust", date: "2026-07-13" }, // glutes (primary)
    ];
    const cov = coverageFromSets(sets, TODAY);
    expect(cov.get("glutes")?.lastTrained).toBe("2026-07-13");
    expect(cov.get("glutes")?.sets).toBe(SECONDARY_CREDIT + 1);
  });
});

describe("musclesWorked — per-session union", () => {
  it("is the set of muscles credited across a session's sets", () => {
    const worked = musclesWorked([
      { exercise: "Barbell Bench Press", date: TODAY },
      { exercise: "Tricep Pushdown", date: TODAY },
    ]);
    expect(worked.has("chest")).toBe(true);
    expect(worked.has("front-delts")).toBe(true);
    expect(worked.has("triceps")).toBe(true);
    // A muscle no exercise touched is absent.
    expect(worked.has("quads")).toBe(false);
  });

  it("drops custom lifts from the union", () => {
    const worked = musclesWorked([
      { exercise: "My Made-Up Lift", date: TODAY },
    ]);
    expect(worked.size).toBe(0);
  });
});

describe("coverageList — sorted formatter", () => {
  it("sorts by set volume descending, then label ascending", () => {
    const cov = coverageFromSets(
      [
        { exercise: "Back Squat", date: TODAY }, // quads 1, glutes/hams/lower-back 0.5
        { exercise: "Back Squat", date: TODAY }, // quads 2
        { exercise: "Barbell Bench Press", date: TODAY }, // chest 1
      ],
      TODAY
    );
    const list = coverageList(cov);
    // Highest volume first.
    expect(list[0].muscle).toBe("quads");
    expect(list[0].sets).toBe(2);
    // Descending, non-increasing.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].sets).toBeGreaterThanOrEqual(list[i].sets);
    }
    // Ties broken by label ascending (glutes/hamstrings/lower-back all 0.5,
    // plus chest 1.0 sits above them).
    const half = list.filter((r) => r.sets === 0.5).map((r) => r.label);
    expect(half).toEqual([...half].sort((a, b) => a.localeCompare(b)));
  });

  it("carries the display label, region, and recency onto each row", () => {
    const cov = coverageFromSets(
      [{ exercise: "Back Squat", date: "2026-07-14" }],
      TODAY
    );
    const quads = coverageList(cov).find((r) => r.muscle === "quads");
    expect(quads?.label).toBe("Quads");
    expect(quads?.region).toBe("Legs");
    expect(quads?.lastTrained).toBe("2026-07-14");
  });
});
