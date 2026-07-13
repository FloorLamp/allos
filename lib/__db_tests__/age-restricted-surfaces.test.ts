// DB INTEGRATION TIER — surface parity for the type-aware age gate (#489/#618).
//
// #489 un-gated duration logging (sport/cardio) for a restricted profile: the
// /training page renders those sessions via RestrictedActivityView while keeping
// strength + goals adult-gated. #618 propagates that split to the two surfaces it
// missed — the Timeline (+ sidebar calendar dates) and Cmd-K Search — so a child's
// soccer session is visible/findable while strength and goals stay hidden.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getTimelineEvents, getTimelineDates } from "@/lib/timeline";
import { searchAll } from "@/lib/queries";
import { setMinTrainingAge } from "@/lib/age-gate";
import { setStoredAge } from "@/lib/settings";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function seedActivity(
  profileId: number,
  type: string,
  title: string,
  date: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, ?, ?, 30)`
      )
      .run(profileId, date, type, title).lastInsertRowid
  );
}

afterEach(() => setMinTrainingAge(null));

describe("restricted profile: sport/cardio survive on Timeline + Search, strength/goals hidden (#618)", () => {
  function restrictedProfile(): {
    p: number;
    sportDate: string;
    strengthDate: string;
  } {
    const p = newProfile("age restricted surfaces");
    setStoredAge(p, 8);
    setMinTrainingAge(18); // 8 < 18 → restricted
    const sportDate = "2024-04-10";
    const strengthDate = "2024-04-11";
    seedActivity(p, "sport", "RSURF Soccer Practice", sportDate);
    seedActivity(p, "cardio", "RSURF Morning Swim", "2024-04-09");
    seedActivity(p, "strength", "RSURF Bench Press", strengthDate);
    db.prepare(
      `INSERT INTO goals (profile_id, title, status) VALUES (?, 'RSURF Squat Goal', 'active')`
    ).run(p);
    return { p, sportDate, strengthDate };
  }

  it("Timeline shows sport/cardio, hides strength and goals", () => {
    const { p } = restrictedProfile();
    const events = getTimelineEvents(p, { restricted: true });
    const titles = events.map((e) => e.title);
    expect(titles).toContain("RSURF Soccer Practice");
    expect(titles).toContain("RSURF Morning Swim");
    expect(titles).not.toContain("RSURF Bench Press"); // strength gated
    expect(events.some((e) => e.category === "goal")).toBe(false); // goals gated
  });

  it("calendar dates include the sport day, exclude the strength day", () => {
    const { p, sportDate, strengthDate } = restrictedProfile();
    const dates = getTimelineDates(p, { restricted: true });
    expect(dates).toContain(sportDate);
    expect(dates).not.toContain(strengthDate);
  });

  it("Search finds the sport session, not the strength one or the goal", () => {
    const { p } = restrictedProfile();
    const sport = searchAll(p, "RSURF Soccer");
    expect(
      sport
        .find((g) => g.domain === "activity")
        ?.hits.some((h) => h.title === "RSURF Soccer Practice")
    ).toBe(true);

    const strength = searchAll(p, "RSURF Bench");
    expect(strength.find((g) => g.domain === "activity")).toBeUndefined();

    const goal = searchAll(p, "RSURF Squat");
    expect(goal.find((g) => g.domain === "goal")).toBeUndefined();

    // The Training palette entry is reachable (page adapts itself, #618).
    const page = searchAll(p, "Training");
    expect(
      page
        .find((g) => g.domain === "page")
        ?.hits.some((h) => h.title === "Training")
    ).toBe(true);
  });

  it("an UNrestricted profile still sees strength and goals everywhere", () => {
    const p = newProfile("unrestricted surfaces");
    setStoredAge(p, 30);
    setMinTrainingAge(18); // 30 >= 18 → not restricted
    seedActivity(p, "strength", "USURF Bench Press", "2024-04-11");
    db.prepare(
      `INSERT INTO goals (profile_id, title, status) VALUES (?, 'USURF Squat Goal', 'active')`
    ).run(p);

    const events = getTimelineEvents(p, { restricted: false });
    expect(events.some((e) => e.title === "USURF Bench Press")).toBe(true);
    expect(events.some((e) => e.category === "goal")).toBe(true);

    expect(
      searchAll(p, "USURF Bench")
        .find((g) => g.domain === "activity")
        ?.hits.some((h) => h.title === "USURF Bench Press")
    ).toBe(true);
    expect(
      searchAll(p, "USURF Squat").find((g) => g.domain === "goal")
    ).toBeTruthy();
  });
});
