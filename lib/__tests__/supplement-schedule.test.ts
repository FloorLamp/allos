import { describe, expect, it } from "vitest";
import {
  availableConditions,
  CONDITIONS,
  defaultFoodTiming,
  isDueOn,
  parseDosage,
  priorityClass,
  spreadDoseTimes,
  timeBucket,
  WORKOUT_CONDITIONS,
} from "@/lib/supplement-schedule";

describe("availableConditions", () => {
  it("returns every condition when training is not restricted", () => {
    expect(availableConditions(false)).toEqual(CONDITIONS);
  });

  it("drops the workout/rest-day conditions when training is restricted", () => {
    const got = availableConditions(true);
    for (const c of WORKOUT_CONDITIONS) expect(got).not.toContain(c);
    expect(got).toContain("daily");
    expect(got).toContain("situational");
  });

  it("keeps an already-stored workout condition so an edit select stays valid", () => {
    const got = availableConditions(true, "rest_day");
    expect(got).toContain("rest_day");
    // Only the stored one is kept; the other workout conditions stay hidden.
    expect(got).not.toContain("pre_workout");
    expect(got).not.toContain("post_workout");
  });
});

describe("timeBucket", () => {
  it("maps morning words", () => {
    for (const t of ["morning", "AM", "with breakfast", "on wake", "early"]) {
      expect(timeBucket(t)).toBe("Morning");
    }
  });

  it("maps midday words", () => {
    for (const t of ["noon", "with lunch", "midday", "afternoon"]) {
      expect(timeBucket(t)).toBe("Midday");
    }
  });

  it("maps before-sleep words, ahead of generic 'night'", () => {
    for (const t of ["before sleep", "bedtime", "bed", "overnight"]) {
      expect(timeBucket(t)).toBe("Before sleep");
    }
  });

  it("maps evening words", () => {
    for (const t of ["evening", "night", "with dinner", "PM", "supper"]) {
      expect(timeBucket(t)).toBe("Evening");
    }
  });

  it("falls back to Anytime for unknown or empty input", () => {
    expect(timeBucket("with food")).toBe("Anytime");
    expect(timeBucket("")).toBe("Anytime");
    expect(timeBucket(null)).toBe("Anytime");
  });
});

describe("isDueOn", () => {
  const ctx = (
    over: Partial<{ isWorkoutDay: boolean; activeSituations: Set<string> }> = {}
  ) => ({
    isWorkoutDay: false,
    activeSituations: new Set<string>(),
    ...over,
  });

  it("daily is always due", () => {
    expect(isDueOn({ condition: "daily", situation: null }, ctx())).toBe(true);
  });

  it("workout-linked conditions follow the workout-day flag", () => {
    const pre = { condition: "pre_workout" as const, situation: null };
    const post = { condition: "post_workout" as const, situation: null };
    expect(isDueOn(pre, ctx({ isWorkoutDay: true }))).toBe(true);
    expect(isDueOn(pre, ctx({ isWorkoutDay: false }))).toBe(false);
    expect(isDueOn(post, ctx({ isWorkoutDay: true }))).toBe(true);
  });

  it("rest_day is the inverse of a workout day", () => {
    const rest = { condition: "rest_day" as const, situation: null };
    expect(isDueOn(rest, ctx({ isWorkoutDay: false }))).toBe(true);
    expect(isDueOn(rest, ctx({ isWorkoutDay: true }))).toBe(false);
  });

  it("situational is due only when its situation is active", () => {
    const supp = { condition: "situational" as const, situation: "Travel" };
    expect(isDueOn(supp, ctx({ activeSituations: new Set(["Travel"]) }))).toBe(
      true
    );
    expect(isDueOn(supp, ctx({ activeSituations: new Set(["Illness"]) }))).toBe(
      false
    );
    // A situational supplement with no situation set is never due.
    expect(
      isDueOn(
        { condition: "situational", situation: null },
        ctx({ activeSituations: new Set(["Travel"]) })
      )
    ).toBe(false);
  });

  it("an as-needed (PRN) medication is never scheduled-due (#103 Phase C)", () => {
    // Even a daily-condition med is never "due" for a reminder when as_needed=1,
    // so it generates no missed-dose escalation and can't drag adherence down.
    expect(
      isDueOn({ condition: "daily", situation: null, as_needed: 1 }, ctx())
    ).toBe(false);
    // as_needed=0 behaves exactly as before.
    expect(
      isDueOn({ condition: "daily", situation: null, as_needed: 0 }, ctx())
    ).toBe(true);
  });
});

describe("priorityClass", () => {
  it("returns a distinct accent per priority", () => {
    expect(priorityClass("mandatory")).toContain("rose");
    expect(priorityClass("high")).toContain("brand");
    expect(priorityClass("low")).toContain("slate");
  });
});

describe("defaultFoodTiming", () => {
  it("honors an explicit timing over inference", () => {
    expect(defaultFoodTiming("Vitamin D", "with_food")).toBe("with_food");
    expect(defaultFoodTiming("Magnesium", "empty_stomach")).toBe(
      "empty_stomach"
    );
  });

  it("defaults fat-soluble substances to with_fat", () => {
    expect(defaultFoodTiming("Vitamin D3")).toBe("with_fat");
    expect(defaultFoodTiming("Fish Oil")).toBe("with_fat");
    expect(defaultFoodTiming("CoQ10")).toBe("with_fat");
  });

  it("defaults everything else to any", () => {
    expect(defaultFoodTiming("Magnesium Glycinate")).toBe("any");
    expect(defaultFoodTiming("Creatine")).toBe("any");
  });
});

describe("parseDosage", () => {
  it("returns the empty shape for null/empty text", () => {
    expect(parseDosage(null)).toEqual({
      amount: null,
      perDay: 1,
      timeOfDay: null,
    });
    expect(parseDosage("")).toEqual({
      amount: null,
      perDay: 1,
      timeOfDay: null,
    });
  });

  it("splits amount from a 'once daily' frequency", () => {
    expect(parseDosage("5–10 g once daily")).toEqual({
      amount: "5–10 g",
      perDay: 1,
      timeOfDay: null,
    });
  });

  it("takes the lower bound of a frequency range", () => {
    expect(parseDosage("500mg 2-3 times daily")).toEqual({
      amount: "500mg",
      perDay: 2,
      timeOfDay: null,
    });
  });

  it("reads worded frequencies", () => {
    expect(parseDosage("1 capsule twice a day").perDay).toBe(2);
    expect(parseDosage("take thrice daily").perDay).toBe(3);
  });

  it("infers an embedded time of day", () => {
    const r = parseDosage("1 capsule with food in the morning");
    expect(r.timeOfDay).toBe("Morning");
    expect(r.amount).toBe("1 capsule");
  });

  it("treats split/divided/across as one total, not a multiplier", () => {
    expect(parseDosage("split into 3 doses").perDay).toBe(1);
    expect(parseDosage("5 g divided across the day").perDay).toBe(1);
  });

  it("cuts at separation prose to keep just the amount", () => {
    expect(
      parseDosage("500–1000 mg, taken 2+ hours away from other supplements")
    ).toEqual({ amount: "500–1000 mg", perDay: 1, timeOfDay: null });
  });

  it("returns the trimmed text when there is no frequency marker", () => {
    expect(parseDosage("2 tablets")).toEqual({
      amount: "2 tablets",
      perDay: 1,
      timeOfDay: null,
    });
  });
});

describe("spreadDoseTimes", () => {
  it("returns the fallback alone for a single intake", () => {
    expect(spreadDoseTimes(1, "Morning")).toEqual(["Morning"]);
    expect(spreadDoseTimes(0, null)).toEqual([null]);
  });

  it("uses sensible presets for 2–4 intakes", () => {
    expect(spreadDoseTimes(2, null)).toEqual(["Morning", "Evening"]);
    expect(spreadDoseTimes(3, null)).toEqual(["Morning", "Midday", "Evening"]);
    expect(spreadDoseTimes(4, null)).toEqual([
      "Morning",
      "Midday",
      "Evening",
      "Evening",
    ]);
  });

  it("fills with the fallback (or Anytime) beyond the presets", () => {
    expect(spreadDoseTimes(5, "Midday")).toEqual([
      "Midday",
      "Midday",
      "Midday",
      "Midday",
      "Midday",
    ]);
    expect(spreadDoseTimes(5, null)).toEqual([
      "Anytime",
      "Anytime",
      "Anytime",
      "Anytime",
      "Anytime",
    ]);
  });
});
