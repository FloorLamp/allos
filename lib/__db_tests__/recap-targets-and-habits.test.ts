// DB INTEGRATION TIER — the recap's TARGET VERDICT line (#2395) and its monthly
// FOOD-HABIT and CAP lines (#2397), end to end from real rows through
// gatherRecapInput → buildRecap → the rendered message.
//
// Both are gather-shaped, so both need this tier. #2395's whole point is WHICH READ the
// recap performs — a pure test over a hand-built `targetVerdicts` array cannot fail for
// a recap that never asks the ledger, or for one that asks it about the wrong week.
// #2397's is a measure over a month of food rows plus the profile's own cap targets, and
// the exclusion that keeps a capped group out of the habit sentence lives in the query.
//
// Rolling week mode throughout, so a weekly window is exactly the trailing seven days
// and every offset reads as "N days ago". Every value is synthetic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import { gatherRecapInput } from "@/lib/notifications/recap-data";
import {
  buildRecap,
  recapLineAnnotation,
  renderRecapMessage,
} from "@/lib/recap";
import { plainBody } from "@/lib/notifications/rich-text";

const NOW = new Date("2026-06-17T12:00:00Z");

function newProfile(name: string): number {
  const pid = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setWeekMode(pid, "rolling");
  return pid;
}

const dayBack = (pid: number, back: number) => shiftDateStr(today(pid), -back);

// `created_at` is set explicitly: the column defaults to SQLite's own `datetime('now')`,
// which the fake JS clock does not move, so a defaulted row looks younger than the
// window and trips the cold-start guard.
function makeTarget(
  pid: number,
  kind: string,
  value: string,
  perWeek: number,
  opts: { perWeekMax?: number | null; createdDaysBack?: number } = {}
): void {
  db.prepare(
    `INSERT INTO frequency_targets
       (profile_id, scope_kind, scope_value, per_week, per_week_max, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    pid,
    kind,
    value,
    perWeek,
    opts.perWeekMax ?? null,
    `${dayBack(pid, opts.createdDaysBack ?? 300)} 08:00:00`
  );
}

function logActivity(pid: number, date: string, type: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, source)
     VALUES (?, ?, ?, 'Session', 'manual')`
  ).run(pid, date, type);
}

function logFood(pid: number, date: string, group: string, n = 1): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key)
       DO UPDATE SET servings = servings + excluded.servings`
  ).run(pid, date, group, n);
}

describe("the recap reports the closed week's target verdicts (#2395)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The profile the issue describes: a cardio target it hit, a target it missed, and a
  // count line that mentioned neither.
  function trainingProfile(name: string): number {
    const pid = newProfile(name);
    makeTarget(pid, "type", "cardio", 2);
    makeTarget(pid, "group", "Back", 2);
    for (const back of [1, 4]) logActivity(pid, dayBack(pid, back), "cardio");
    return pid;
  }

  it("names what fell short, beside the count that never mentioned it", () => {
    const pid = trainingProfile("recap-verdict-basic");
    const recap = buildRecap(gatherRecapInput(pid, "kg", "week", true));

    const line = recap.lines.find((l) => l.key === "targets")!;
    expect(line.value).toBe("1 of 2 targets met");
    expect(recapLineAnnotation(line)).toBe("short on Back");

    // The count STAYS (#2395: a count of what happened and a verdict against what was
    // intended are different facts), and the verdict reads directly under it.
    const keys = recap.lines.map((l) => l.key);
    expect(keys).toContain("workouts");
    expect(keys.indexOf("targets")).toBe(keys.indexOf("workouts") + 1);
  });

  it("reads the week the recap is ABOUT, not the week the ledger's default anchor picks", () => {
    // The verdict must belong to the same seven days the rest of the message covers. A
    // cardio session eight days back is in the PREVIOUS window and must not rescue this
    // one's floor.
    const pid = newProfile("recap-verdict-window");
    makeTarget(pid, "type", "cardio", 2);
    logActivity(pid, dayBack(pid, 8), "cardio");
    logActivity(pid, dayBack(pid, 9), "cardio");
    logActivity(pid, dayBack(pid, 2), "cardio");

    const recap = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    const line = recap.lines.find((l) => l.key === "targets")!;
    expect(line.value).toBe("0 of 1 target met");
    expect(recapLineAnnotation(line)).toBe("short on Cardio");
  });

  it("says nothing about a week still in progress — the card gets no verdict", () => {
    // A week that has not ended is under its floor by construction; pace is the morning
    // digest's line and the widget's, not the recap's.
    const pid = trainingProfile("recap-verdict-inprogress");
    const card = buildRecap(gatherRecapInput(pid, "kg", "week", false));
    expect(card.lines.find((l) => l.key === "targets")).toBeUndefined();
  });

  it("says nothing at all for a profile with no targets", () => {
    const pid = newProfile("recap-verdict-none");
    logActivity(pid, dayBack(pid, 1), "cardio");
    const recap = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    expect(recap.lines.find((l) => l.key === "targets")).toBeUndefined();
  });

  it("leaves out a target the user declared part-way through the week", () => {
    // #1670's cold-start exclusion. A target set on Thursday is short by construction,
    // and scoring a week the user had not yet declared anything about is the app
    // inventing a failure.
    const pid = newProfile("recap-verdict-coldstart");
    makeTarget(pid, "type", "cardio", 3, { createdDaysBack: 2 });
    const recap = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    expect(recap.lines.find((l) => l.key === "targets")).toBeUndefined();
  });

  it("reports a cap as over or within, and never with a figure to go", () => {
    // A cap tenant reaches the SAME line, selected by its declared direction — and the
    // floor vocabulary never touches it (#998).
    const pid = trainingProfile("recap-verdict-cap");
    makeTarget(pid, "substance", "alcohol", 7);
    for (const back of [1, 2, 3]) logFood(pid, dayBack(pid, back), "alcohol", 4);

    const recap = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    const line = recap.lines.find((l) => l.key === "targets")!;
    // The head counts FLOORS; the cap is stated in its own vocabulary beside them.
    expect(line.value).toBe("1 of 2 targets met");
    expect(recapLineAnnotation(line)).toBe(
      "short on Back · over the Alcohol cap"
    );

    const body = plainBody(
      renderRecapMessage(recap, "Test profile", null, "https://example.test")!
        .body
    );
    expect(body).toContain("over the Alcohol cap");
    expect(body).not.toMatch(/to go|left|behind on Alcohol|Alcohol \(weekly cap\)/);
  });

  it("states a held cap for a profile whose only targets are caps", () => {
    const pid = newProfile("recap-verdict-caponly");
    makeTarget(pid, "substance", "alcohol", 7);
    logFood(pid, dayBack(pid, 2), "alcohol", 2);
    const recap = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    const line = recap.lines.find((l) => l.key === "targets")!;
    // Never "1 of 1 target met": that is a floor's success condition over a scope with
    // no floor.
    expect(line.value).toBe("1 of 1 weekly cap held");
  });

  it("mentions a range target's weekly maximum only when it was PASSED", () => {
    const pid = newProfile("recap-verdict-ceiling");
    makeTarget(pid, "type", "cardio", 2, { perWeekMax: 3 });
    for (const back of [1, 2, 3]) logActivity(pid, dayBack(pid, back), "cardio");
    const atCeiling = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    // Reaching the maximum is the calm "that's plenty" state, not a fact to report.
    expect(recapLineAnnotation(atCeiling.lines.find((l) => l.key === "targets")!))
      .toBeUndefined();

    logActivity(pid, dayBack(pid, 4), "cardio");
    const passed = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    const line = passed.lines.find((l) => l.key === "targets")!;
    expect(line.value).toBe("1 of 1 target met");
    expect(recapLineAnnotation(line)).toBe("past the weekly maximum on Cardio");
  });
});

describe("the monthly recap observes food habits and declared caps (#2397)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Fourteen logged days inside the in-progress calendar month (June 1–17), with a diet
  // that is recognisable and a drinking pattern that is not the app's to narrate.
  function eatingProfile(name: string): number {
    const pid = newProfile(name);
    const days = Array.from({ length: 14 }, (_, i) => shiftDateStr("2026-06-01", i));
    days.forEach((date, i) => {
      logFood(pid, date, "whole_grains");
      if (i % 2 === 0) logFood(pid, date, "fatty_fish");
      if (i < 5) logFood(pid, date, "leafy_greens");
      if (i < 12) logFood(pid, date, "alcohol", 2);
      if (i < 10) logFood(pid, date, "berries");
    });
    return pid;
  }

  it("states a SHARE of the days food was logged, with the curated reason", () => {
    const pid = eatingProfile("recap-habits-share");
    const recap = buildRecap(gatherRecapInput(pid, "kg", "month"));
    const line = recap.lines.find((l) => l.key === "food-habits")!;

    // The denominator is named, and it says LOGGED — the line reports eating over the
    // days this person recorded, never over a calendar it has no evidence about.
    expect(line.value).toBe("over 14 logged days");
    expect(recapLineAnnotation(line)).toBe(
      [
        "Whole grains 14 of 14 logged days, a source of Magnesium",
        "Fatty fish 7 of 14 logged days, a source of Omega-3 and Vitamin D",
        "Leafy greens 5 of 14 logged days, a source of Folate and Potassium",
      ].join(" · ")
    );
  });

  it("never states the capped group, whatever its share", () => {
    // Alcohol was logged on 12 of the 14 days — the second-highest share in the period —
    // and the habit line does not mention it. "You consistently consume alcohol" is the
    // sentence #2380 refused in a shorter window (#998), and a longer one does not make
    // it sayable.
    const pid = eatingProfile("recap-habits-cap-excluded");
    const recap = buildRecap(gatherRecapInput(pid, "kg", "month"));
    const line = recap.lines.find((l) => l.key === "food-habits")!;
    expect(recapLineAnnotation(line)).not.toMatch(/alcohol/i);
    // Nor does anything else on this recap: no cap was declared, so the app says nothing
    // about the scope at all.
    const body = plainBody(
      renderRecapMessage(recap, "Test profile", null, "https://example.test")!
        .body
    );
    expect(body).not.toMatch(/alcohol/i);
  });

  it("places no food pattern beside a biomarker result", () => {
    // The doctrine constraint, end to end. This profile has BOTH halves of the sentence
    // #2397 forbids on file — fatty fish on half its logged days, and a flagged omega-3
    // panel — and the recap states the first, states nothing about the second, and joins
    // nothing.
    const pid = eatingProfile("recap-habits-no-juxtaposition");
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, unit, flag)
       VALUES (?, '2026-06-05', 'lab', 'Omega-3 Total (OmegaCheck)',
               'Omega-3 Total (OmegaCheck)', '3.1', 3.1, '%', 'low')`
    ).run(pid);

    const recap = buildRecap(gatherRecapInput(pid, "kg", "month"));
    const body = plainBody(
      renderRecapMessage(recap, "Test profile", null, "https://example.test")!
        .body
    );
    expect(body).toContain("Fatty fish 7 of 14 logged days");
    // The nutrient noun is the curated map's own label and may appear; a RESULT may not.
    expect(body).not.toMatch(/OmegaCheck|flag|low|3\.1|biomarker|lab/i);
  });

  it("says nothing for a month whose logging is under the measure's gate", () => {
    // Silence is the answer, and it means NO EXPECTATION — never a habit broken.
    const pid = newProfile("recap-habits-gate");
    for (let i = 0; i < 5; i++)
      logFood(pid, shiftDateStr("2026-06-01", i), "fatty_fish");
    const recap = buildRecap(gatherRecapInput(pid, "kg", "month"));
    expect(recap.lines.find((l) => l.key === "food-habits")).toBeUndefined();
  });

  it("reports a DECLARED cap's record over the period's whole weeks", () => {
    // The restructured shape: the ledger's own verdict on a target the user set. Two
    // whole weeks fit inside June 1–17; the cap was passed in one of them.
    const pid = newProfile("recap-caps-declared");
    makeTarget(pid, "substance", "alcohol", 7);
    for (const back of [1, 2, 3]) logFood(pid, dayBack(pid, back), "alcohol", 4);
    logFood(pid, dayBack(pid, 9), "alcohol", 2);

    const recap = buildRecap(gatherRecapInput(pid, "kg", "month"));
    const line = recap.lines.find((l) => l.key === "caps")!;
    expect(line.value).toBe("over the Alcohol cap in 1 of 2 weeks");
    expect(line.comparison.kind).toBe("none");
    expect(recapLineAnnotation(line)).toBeUndefined();
  });

  it("says a clean period held, rather than going quiet on a cap that worked", () => {
    const pid = newProfile("recap-caps-held");
    makeTarget(pid, "substance", "alcohol", 7);
    logFood(pid, dayBack(pid, 2), "alcohol", 2);
    const recap = buildRecap(gatherRecapInput(pid, "kg", "month"));
    expect(recap.lines.find((l) => l.key === "caps")!.value).toBe(
      "Alcohol cap held all 2 weeks"
    );
  });

  it("says nothing about a capped scope for a profile that declared no cap", () => {
    const pid = eatingProfile("recap-caps-undeclared");
    const recap = buildRecap(gatherRecapInput(pid, "kg", "month"));
    expect(recap.lines.find((l) => l.key === "caps")).toBeUndefined();
  });

  it("keeps both monthly lines off the weekly recap", () => {
    // Declared scale sets, not a runtime guess: a habit is not a week fact and a cap's
    // multi-week record is not either.
    const pid = eatingProfile("recap-habits-scale");
    makeTarget(pid, "substance", "alcohol", 7);
    const week = buildRecap(gatherRecapInput(pid, "kg", "week", true));
    expect(week.lines.find((l) => l.key === "food-habits")).toBeUndefined();
    expect(week.lines.find((l) => l.key === "caps")).toBeUndefined();
  });
});
