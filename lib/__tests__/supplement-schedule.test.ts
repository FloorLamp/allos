import { describe, expect, it } from "vitest";
import {
  availableConditions,
  CONDITIONS,
  contributesToDailyLimit,
  defaultFoodTiming,
  isDueOn,
  isPostWorkoutReady,
  parseDosage,
  priorityClass,
  spreadDoseTimes,
  timeBucket,
  workoutDaySubtitleLabel,
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
    over: Partial<{
      isWorkoutDay: boolean;
      activeSituations: Set<string>;
      predictedWorkoutDay: boolean | null;
      postWorkoutReady: boolean;
    }> = {}
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

  // #558: pre_workout keys on the PREDICTED training day, so it's due before a
  // session is logged; on a predicted rest day it stays hidden. The logged flag is
  // only the fallback when no cadence can be inferred (predictedWorkoutDay == null).
  it("pre_workout is due on a predicted workout day with NO logged activity", () => {
    const pre = { condition: "pre_workout" as const, situation: null };
    expect(
      isDueOn(pre, ctx({ isWorkoutDay: false, predictedWorkoutDay: true }))
    ).toBe(true);
    expect(
      isDueOn(pre, ctx({ isWorkoutDay: false, predictedWorkoutDay: false }))
    ).toBe(false);
    // predictedWorkoutDay wins over the logged flag when known.
    expect(
      isDueOn(pre, ctx({ isWorkoutDay: true, predictedWorkoutDay: false }))
    ).toBe(false);
    // null → fall back to the logged flag (old behavior).
    expect(
      isDueOn(pre, ctx({ isWorkoutDay: true, predictedWorkoutDay: null }))
    ).toBe(true);
  });

  // #558: post_workout keeps the actually-logged gate (post = after) and stays
  // hidden until the session's end time when the postWorkoutReady flag says so.
  it("post_workout needs a logged session and its end time", () => {
    const post = { condition: "post_workout" as const, situation: null };
    // A predicted workout day alone does not make it due — it needs a logged session.
    expect(
      isDueOn(post, ctx({ isWorkoutDay: false, predictedWorkoutDay: true }))
    ).toBe(false);
    // Logged but session not over yet → not due.
    expect(
      isDueOn(post, ctx({ isWorkoutDay: true, postWorkoutReady: false }))
    ).toBe(false);
    // Logged and session over → due.
    expect(
      isDueOn(post, ctx({ isWorkoutDay: true, postWorkoutReady: true }))
    ).toBe(true);
  });

  it("rest_day is the inverse of a workout day", () => {
    const rest = { condition: "rest_day" as const, situation: null };
    expect(isDueOn(rest, ctx({ isWorkoutDay: false }))).toBe(true);
    expect(isDueOn(rest, ctx({ isWorkoutDay: true }))).toBe(false);
  });

  // #558: rest_day follows the same predicted-vs-logged decision as pre_workout,
  // so a rest-day supplement doesn't wait until end-of-day to confirm no workout.
  it("rest_day follows the predicted signal when known", () => {
    const rest = { condition: "rest_day" as const, situation: null };
    expect(
      isDueOn(rest, ctx({ isWorkoutDay: false, predictedWorkoutDay: true }))
    ).toBe(false);
    expect(
      isDueOn(rest, ctx({ isWorkoutDay: true, predictedWorkoutDay: false }))
    ).toBe(true);
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

  it("an as-needed (PRN) medication is never scheduled-due", () => {
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

describe("contributesToDailyLimit (#635)", () => {
  it("counts an unconditional daily item", () => {
    expect(contributesToDailyLimit({ condition: "daily", as_needed: 0 })).toBe(
      true
    );
    // as_needed omitted defaults to not-PRN.
    expect(contributesToDailyLimit({ condition: "daily" })).toBe(true);
  });

  it("excludes a PRN (as_needed) item even when daily", () => {
    expect(contributesToDailyLimit({ condition: "daily", as_needed: 1 })).toBe(
      false
    );
  });

  it("excludes workout/rest/situational items (not taken every day)", () => {
    for (const condition of [
      "pre_workout",
      "post_workout",
      "rest_day",
      "situational",
    ] as const) {
      expect(contributesToDailyLimit({ condition, as_needed: 0 })).toBe(false);
    }
  });
});

describe("isPostWorkoutReady", () => {
  it("is ready on a past day (nowMinutes null)", () => {
    expect(isPostWorkoutReady(["18:00"], null)).toBe(true);
  });

  it("holds until the earliest logged session's end time on today", () => {
    // Two sessions ending 09:30 and 18:00; earliest is 09:30 (570 min).
    expect(isPostWorkoutReady(["18:00", "09:30"], 9 * 60)).toBe(false); // 09:00
    expect(isPostWorkoutReady(["18:00", "09:30"], 9 * 60 + 30)).toBe(true); // 09:30
    expect(isPostWorkoutReady(["18:00", "09:30"], 12 * 60)).toBe(true); // 12:00
  });

  it("is ready as soon as logged when no end time is known", () => {
    expect(isPostWorkoutReady([null, undefined], 6 * 60)).toBe(true);
    expect(isPostWorkoutReady([], 6 * 60)).toBe(true);
  });

  it("accepts HH:MM:SS and ignores malformed times", () => {
    expect(isPostWorkoutReady(["07:15:00"], 7 * 60 + 20)).toBe(true);
    expect(isPostWorkoutReady(["07:15:00"], 7 * 60 + 10)).toBe(false);
    // A single malformed value leaves no usable end time → ready.
    expect(isPostWorkoutReady(["notatime"], 5 * 60)).toBe(true);
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

describe("workoutDaySubtitleLabel (#747)", () => {
  it("labels a predicted training day 'Workout day'", () => {
    expect(workoutDaySubtitleLabel(true, false)).toBe("Workout day");
    expect(workoutDaySubtitleLabel(true, true)).toBe("Workout day");
  });

  it("labels a predicted rest day with no logged workout 'Rest day'", () => {
    expect(workoutDaySubtitleLabel(false, false)).toBe("Rest day");
  });

  it("names the mismatch when a rest day has an unplanned logged workout", () => {
    // The bug this fixes: a due post-workout supplement sat under a bare
    // "Rest day". Cadence says rest, but a session WAS logged.
    expect(workoutDaySubtitleLabel(false, true)).toBe(
      "Rest day — unplanned workout logged"
    );
  });

  it("falls back to the logged session when no cadence is inferred (null)", () => {
    // Preserves the pre-#747 `predictedWorkoutDay ?? isWorkoutDay` behavior.
    expect(workoutDaySubtitleLabel(null, true)).toBe("Workout day");
    expect(workoutDaySubtitleLabel(null, false)).toBe("Rest day");
  });
});
