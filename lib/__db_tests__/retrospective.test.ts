// DB INTEGRATION TIER — the annual retrospective (#2179) end to end from real rows:
// `firstLoggedDay` → the year list → `getRetrospective` → the rendered line model.
//
// This tier is where the gather-shaped half lives. A pure test over a hand-built
// `RecapInput` cannot see which WINDOW the year was gathered over, which is the whole
// question a two-year fixture answers: rows in 2024 must not leak into 2025's counts,
// and 2024's rows must be what 2025's trajectory is compared against.
//
// Every value is synthetic. Runs against a throwaway DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { firstLoggedDay, getRetrospective } from "@/lib/retrospective-data";
import {
  retrospectiveCoverage,
  retrospectiveCoverageSentence,
  retrospectiveYears,
} from "@/lib/retrospective";
import { countsAsRecordAt } from "@/lib/recap";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

// A frozen "today" well inside the year after the fixture's last full year, so the
// closed-year path is the one under test and the suite's own clock never enters it.
const TODAY = "2026-05-20";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// `activities.date` is a profile-LOCAL day column, not an instant, so a day string is
// what the column means — there is no timezone conversion to do at this door.
function addActivity(
  profileId: number,
  date: string,
  type: "strength" | "cardio"
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, ?, ?, 45)`
  ).run(profileId, date, type, `${type} session`);
}

function addWeight(profileId: number, date: string, kg: number): void {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
  ).run(profileId, date, kg);
}

// Twelve strength sessions across 2025 and six across 2024 — enough for a composition
// share to speak (RECAP_MIX_MIN_SESSIONS) in both years, so the trajectory half of the
// page has something to compare.
function twoYearProfile(name: string): number {
  const p = newProfile(name);
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (const m of months)
    addActivity(p, `2025-${String(m).padStart(2, "0")}-10`, "strength");
  for (const m of [2, 4, 6, 8, 10, 12])
    addActivity(p, `2024-${String(m).padStart(2, "0")}-10`, "strength");
  addWeight(p, "2024-01-15", 88);
  addWeight(p, "2024-11-15", 86);
  addWeight(p, "2025-01-15", 85);
  addWeight(p, "2025-11-15", 81);
  return p;
}

describe("the year the retrospective is gathered over (#2179)", () => {
  it("counts only the requested year, with the prior year as its comparison", () => {
    const p = twoYearProfile("retro-two-years");
    const recap = getRetrospective(p, 2025, TODAY);

    expect(recap.scale).toBe("year");
    expect(recap.start).toBe("2025-01-01");
    expect(recap.end).toBe("2025-12-31");

    // Twelve 2025 sessions, and the six 2024 ones did NOT leak in.
    const workouts = recap.lines.find((l) => l.key === "workouts");
    expect(workouts?.value).toBe("12");

    // The prior year is genuinely loaded — the trajectory line's comparison is drawn
    // from it — which is what makes the count line's SILENCE meaningful rather than
    // an artifact of there being nothing to compare against.
    const mix = recap.lines.find((l) => l.key === "training-mix");
    expect(mix?.comparison.kind).toBe("prior");
    expect(mix?.comparison).toMatchObject({
      text: expect.stringContaining("last year"),
    });
  });

  it("keeps the count as a record: no comparison reaches the reader", () => {
    // The commemorative exemption, observed at the surface rather than in the
    // declaration. With six workouts in 2024 sitting right there, a build that dropped
    // the exemption would render "12 — 6 last year".
    const p = twoYearProfile("retro-record-only");
    const recap = getRetrospective(p, 2025, TODAY);
    const workouts = recap.lines.find((l) => l.key === "workouts");
    expect(countsAsRecordAt("workouts", "year")).toBe(true);
    expect(workouts?.comparison).toEqual({ kind: "none" });
    expect(workouts?.notes?.filter(Boolean).join(" ") ?? "").not.toContain(
      "last year"
    );
  });

  it("renders the year still running from Jan 1 through today", () => {
    const p = twoYearProfile("retro-in-progress");
    addActivity(p, "2026-02-11", "cardio");
    addActivity(p, "2026-03-11", "cardio");
    const recap = getRetrospective(p, 2026, TODAY);
    expect(recap.start).toBe("2026-01-01");
    expect(recap.end).toBe(TODAY);
    expect(recap.lines.find((l) => l.key === "workouts")?.value).toBe("2");
  });

  it("reports an untouched year as empty rather than inventing one", () => {
    const p = newProfile("retro-quiet");
    const recap = getRetrospective(p, 2025, TODAY);
    expect(recap.isEmpty).toBe(true);
    expect(recap.lines).toEqual([]);
  });
});

describe("which years a profile actually has", () => {
  it("starts at the first logged day across activities and body metrics", () => {
    const p = newProfile("retro-first-day");
    addActivity(p, "2025-06-01", "strength");
    expect(firstLoggedDay(p)).toBe("2025-06-01");
    // A weigh-in EARLIER than the first activity moves the start — the read spans both
    // stores, and a one-table version of it would silently drop a year.
    addWeight(p, "2024-09-14", 80);
    expect(firstLoggedDay(p)).toBe("2024-09-14");
    expect(retrospectiveYears(firstLoggedDay(p), TODAY)).toEqual([
      2026, 2025, 2024,
    ]);
  });

  it("is scoped to the profile", () => {
    const mine = newProfile("retro-scope-mine");
    const other = newProfile("retro-scope-other");
    addActivity(other, "2019-01-01", "strength");
    addActivity(mine, "2025-03-03", "strength");
    expect(firstLoggedDay(mine)).toBe("2025-03-03");
    expect(firstLoggedDay(other)).toBe("2019-01-01");
  });

  it("answers null for a profile that has logged nothing", () => {
    expect(firstLoggedDay(newProfile("retro-empty"))).toBeNull();
  });

  it("states the partial first year against the real first day", () => {
    const p = newProfile("retro-partial");
    addActivity(p, "2025-03-03", "strength");
    addActivity(p, "2025-09-09", "strength");
    const coverage = retrospectiveCoverage(2025, firstLoggedDay(p), TODAY);
    expect(coverage.partialStart).toBe(true);
    expect(coverage.from).toBe("2025-03-03");
    expect(
      retrospectiveCoverageSentence(coverage, DEFAULT_FORMAT_PREFS)
    ).toContain("when your data begins");
  });
});
