// DB INTEGRATION TIER — the recap gather's GOAL lines (#2394) and FOOD line (#2396),
// end to end from real rows through gatherRecapInput → buildRecap → the rendered message.
//
// Both are gather-shaped defects, so both need this tier to see them. #2394's whole bug
// was WHICH COLUMN the window test ran against: a pure test over a hand-built
// `goalsCompleted: string[]` cannot fail for it, because by then the wrong rows have
// already been chosen. #2396's is a line that never existed, and its inputs are three
// separate reads of real food, protein and fibre rows.
//
// Every value is synthetic. Runs against a throwaway DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { utcInstant } from "@/lib/date";
import { gatherRecapInput } from "@/lib/notifications/recap-data";
import { buildRecap, recapLineAnnotation } from "@/lib/recap";
import { getTimezone, setWeekMode } from "@/lib/settings";
import { zonedWallTimeToUtc } from "@/lib/date";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // ROLLING, so the window under test is a full trailing seven days whatever weekday the
  // suite runs on. The calendar-mode window is a partial week-to-date, which would make
  // "6 of 7 days" mean a different thing on a Tuesday than on a Saturday — the week-mode
  // axis itself is already pinned in lib/__tests__/recap.test.ts.
  setWeekMode(id, "rolling");
  return id;
}

// The canonical instant that lands at midday of a profile-LOCAL day. The recap windows
// in profile-local days and `achieved_at` is a UTC instant, so a naive `${day}T12:00:00Z`
// would drift across the date line for a profile whose timezone is far from UTC.
function localMiddayInstant(profileId: number, day: string): string {
  const at = zonedWallTimeToUtc(getTimezone(profileId), day, "12:00");
  if (!at) throw new Error(`unresolvable local midday for ${day}`);
  return utcInstant(at);
}

function addGoal(
  profileId: number,
  fields: {
    title: string;
    status?: "active" | "achieved";
    target_date?: string | null;
    achieved_at?: string | null;
    archived?: 0 | 1;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO goals (profile_id, title, status, target_date, achieved_at, archived)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        fields.title,
        fields.status ?? "active",
        fields.target_date ?? null,
        fields.achieved_at ?? null,
        fields.archived ?? 0
      ).lastInsertRowid
  );
}

describe("recap goal lines key on the achievement, not the deadline (#2394)", () => {
  it("reports a goal achieved this week that has NO target date at all", () => {
    // The profile the issue was filed from: every goal deadline-free, so the old
    // `target_date != null` filter made the line unreachable for all of them.
    const p = newProfile("recap-goal-nodate");
    const td = today(p);
    addGoal(p, {
      title: "Get resting HR down",
      status: "achieved",
      target_date: null,
      achieved_at: localMiddayInstant(p, td),
    });

    const recap = buildRecap(gatherRecapInput(p));
    const line = recap.lines.find((l) => l.key === "goals")!;
    expect(line.value).toBe("1");
    expect(recapLineAnnotation(line)).toBe("Get resting HR down");
  });

  it("announces an EARLY achievement in the week it happened, not the deadline's week", () => {
    const p = newProfile("recap-goal-early");
    const td = today(p);
    addGoal(p, {
      title: "Bench 100 kg",
      status: "achieved",
      // The deadline is a month out — under the old filter this week said nothing and
      // the announcement waited for a window that arrives long after the moment did.
      target_date: shiftDateStr(td, 30),
      achieved_at: localMiddayInstant(p, td),
    });

    expect(gatherRecapInput(p).goalsCompleted).toEqual(["Bench 100 kg"]);
  });

  it("announces a LATE achievement, which used to be announced never", () => {
    const p = newProfile("recap-goal-late");
    const td = today(p);
    addGoal(p, {
      title: "Run a 10k",
      status: "achieved",
      // The deadline is already behind every future window, so keying on it meant this
      // goal could never be reported at all.
      target_date: shiftDateStr(td, -40),
      achieved_at: localMiddayInstant(p, td),
    });

    const input = gatherRecapInput(p);
    expect(input.goalsCompleted).toEqual(["Run a 10k"]);
    // And it is NOT also reported as a miss: it was reached, however late.
    expect(input.goalsMissed).toEqual([]);
  });

  it("never announces an achieved goal with no recorded achievement instant", () => {
    // Every goal achieved before migration 182 is in this state. Announcing it would
    // report a months-old achievement in whatever week the deploy happened to land in.
    const p = newProfile("recap-goal-pre182");
    addGoal(p, {
      title: "Legacy goal",
      status: "achieved",
      target_date: today(p),
      achieved_at: null,
    });

    expect(gatherRecapInput(p).goalsCompleted).toEqual([]);
  });

  it("ignores an achievement outside the window, and an archived goal entirely", () => {
    const p = newProfile("recap-goal-outside");
    const td = today(p);
    addGoal(p, {
      title: "Last month's win",
      status: "achieved",
      achieved_at: localMiddayInstant(p, shiftDateStr(td, -30)),
    });
    addGoal(p, {
      title: "Filed away",
      status: "achieved",
      achieved_at: localMiddayInstant(p, td),
      archived: 1,
    });

    expect(gatherRecapInput(p).goalsCompleted).toEqual([]);
  });

  it("reports a deadline that passed unmet this week — once, and factually", () => {
    const p = newProfile("recap-goal-missed");
    const td = today(p);
    addGoal(p, { title: "Deadlift 180 kg", target_date: td });
    // Archived: the user retired the question, so the app does not raise it.
    addGoal(p, {
      title: "Retired plan",
      target_date: td,
      archived: 1,
    });
    // A deadline still ahead is not a miss.
    addGoal(p, { title: "Sub-20 5k", target_date: shiftDateStr(td, 10) });

    const input = gatherRecapInput(p);
    expect(input.goalsMissed).toEqual(["Deadlift 180 kg"]);

    const line = buildRecap(input).lines.find((l) => l.key === "goals-missed")!;
    expect(line.label).toBe("Goals not met");
    expect(recapLineAnnotation(line)).toBe(
      "Deadlift 180 kg · target date reached"
    );
  });

  it("does not re-report a miss in the following period", () => {
    const p = newProfile("recap-goal-missed-once");
    const td = today(p);
    // A deadline that passed a fortnight ago is behind this window's start.
    addGoal(p, { title: "Old deadline", target_date: shiftDateStr(td, -14) });

    expect(gatherRecapInput(p).goalsMissed).toEqual([]);
  });
});

describe("recap food line (#2396)", () => {
  const logFood = (
    profileId: number,
    date: string,
    slug: string,
    servings = 1
  ) =>
    db
      .prepare(
        "INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)"
      )
      .run(profileId, date, slug, servings);

  it("reports the week's coverage and variety — and no serving total", () => {
    const p = newProfile("recap-food-coverage");
    const td = today(p);
    // Six of the seven window days, three groups, deliberately uneven serving counts:
    // nothing on the line may add them up.
    for (let i = 0; i < 6; i++) {
      const d = shiftDateStr(td, -i);
      logFood(p, d, "leafy_greens", 3);
      logFood(p, d, "lean_fish", 2);
    }
    logFood(p, td, "berries", 4);

    const input = gatherRecapInput(p);
    expect(input.food).toMatchObject({ daysLogged: 6, groups: 3 });

    const recap = buildRecap(input);
    const line = recap.lines.find((l) => l.key === "food")!;
    expect(line.value).toBe("6/7 days");
    expect(recapLineAnnotation(line)).toContain("3 food groups");
    // #2178's never-re-total rule: 34 servings were logged and the line says so nowhere.
    expect(`${line.value} ${recapLineAnnotation(line)}`).not.toMatch(/34|serving/);
  });

  it("a week whose only logging is food still produces a recap to send", () => {
    // The acceptance criterion, end to end: before #2396 this profile used the app every
    // day, and its recap was both empty and unsent.
    const p = newProfile("recap-food-only");
    const td = today(p);
    for (let i = 0; i < 7; i++) logFood(p, shiftDateStr(td, -i), "leafy_greens");

    const recap = buildRecap(gatherRecapInput(p));
    expect(recap.isEmpty).toBe(false);
    expect(recap.lines.map((l) => l.key)).toContain("food");
  });

  it("omits the line — and stays empty — when nothing was eaten into the app", () => {
    const p = newProfile("recap-food-none");
    const recap = buildRecap(gatherRecapInput(p));
    expect(gatherRecapInput(p).food ?? null).toBeNull();
    expect(recap.lines.map((l) => l.key)).not.toContain("food");
    expect(recap.isEmpty).toBe(true);
  });

  it("counts fibre days on target against the days it could POSITION, not the window", () => {
    // Fibre positions on any day with quantified intake; protein needs a bodyweight to
    // scale its band, which this profile has never recorded — so protein positions on no
    // day and is dropped rather than reported as "0 of 0 days".
    const p = newProfile("recap-food-nutrients");
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')"
    ).run(p);
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1990-04-02')"
    ).run(p);
    const td = today(p);
    // Two days of heavy fibre, two days of a token amount. `legumes` and
    // `whole_grains` are the catalog slugs the fibre estimator actually scores.
    for (const [i, servings] of [6, 6, 1, 1].entries()) {
      logFood(p, shiftDateStr(td, -i), "legumes", servings);
      logFood(p, shiftDateStr(td, -i), "whole_grains", servings);
    }

    const food = gatherRecapInput(p).food!;
    expect(food.daysLogged).toBe(4);
    const fiber = food.nutrients.find((n) => n.nutrient === "fiber")!;
    expect(fiber.days).toBe(4);
    expect(fiber.onTarget).toBeGreaterThan(0);
    expect(fiber.onTarget).toBeLessThan(4);
    expect(food.nutrients.some((n) => n.nutrient === "protein")).toBe(false);
  });
});
