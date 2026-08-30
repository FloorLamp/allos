import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { getSymptomDaysInRange } from "@/lib/queries/symptoms";
import {
  RECURRING_MIN_DAYS,
  RECURRING_MIN_MONTHS,
  buildSymptomAnalysis,
  symptomAnalysisWindow,
} from "@/lib/symptom-analysis";
import { shiftDateStr } from "@/lib/date";

// #1852, the analysis half. Every count assertion below carries a NON-VACUITY control —
// the rows that exist, or the rows the window deliberately excludes — because "0 days out
// of 0 rows" is what a deleted aggregation and a correct one both print.

// 02:00 UTC on the first of March: a March day in UTC and still a February day twelve
// hours west. The whole timezone question lives in that gap.
const FROZEN_NOW = "2026-03-01T02:00:00.000Z";
let previousNow: string | undefined;

beforeEach(() => {
  previousNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = FROZEN_NOW;
});

afterEach(() => {
  if (previousNow === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = previousNow;
});

function profile(timezone = "UTC"): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Symptom analysis')").run()
      .lastInsertRowid
  );
  setTimezone(id, timezone);
  return id;
}

function log(
  profileId: number,
  date: string,
  symptom: string,
  severity = 2
): void {
  db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, date, symptom, severity);
}

function rowCount(profileId: number, symptom?: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM symptom_logs WHERE profile_id = ?${
          symptom ? " AND symptom = ?" : ""
        }`
      )
      .get(...(symptom ? [profileId, symptom] : [profileId])) as { n: number }
  ).n;
}

function monthDays(
  entry: { months: { month: string; days: number }[] },
  month: string
): number | undefined {
  return entry.months.find((m) => m.month === month)?.days;
}

describe("symptom analysis window", () => {
  it("is the current profile-local month plus the eleven before it", () => {
    const window = symptomAnalysisWindow("2026-03-01");
    expect(window.months).toHaveLength(12);
    expect(window.months[0]).toBe("2025-04-01");
    expect(window.months[11]).toBe("2026-03-01");
    expect(window.from).toBe("2025-04-01");
    expect(window.to).toBe("2026-03-01");
  });
});

describe("monthly symptom day-counts", () => {
  it("buckets days by calendar month and drops what falls before the window", () => {
    const profileId = profile();
    // Inside the window (starts 2025-04-01).
    log(profileId, "2026-02-02", "migraine", 3);
    log(profileId, "2026-02-11", "migraine", 1);
    log(profileId, "2026-01-05", "migraine", 4);
    log(profileId, "2025-12-24", "migraine", 2);
    // Older than the window — the control that makes the count a count.
    log(profileId, "2025-03-15", "migraine", 4);
    log(profileId, "2026-02-02", "nausea", 2);

    const analysis = buildSymptomAnalysis(profileId, today(profileId));
    const migraine = analysis.entries.find((e) => e.symptom === "migraine");

    // NON-VACUITY: five migraine rows exist; the window counts four. A reader that
    // returned nothing, and one that ignored the window, both fail here.
    expect(rowCount(profileId, "migraine")).toBe(5);
    expect(migraine?.days).toBe(4);
    expect(migraine?.months).toHaveLength(12);
    expect(monthDays(migraine!, "2026-02-01")).toBe(2);
    expect(monthDays(migraine!, "2026-01-01")).toBe(1);
    expect(monthDays(migraine!, "2025-12-01")).toBe(1);
    // A month with no logs is still an axis position, not a missing bar.
    expect(monthDays(migraine!, "2025-11-01")).toBe(0);
    expect(monthDays(migraine!, "2025-03-01")).toBeUndefined();
    // The severity strip is one point per symptom-day, oldest first.
    expect(migraine?.severity).toEqual([
      { date: "2025-12-24", severity: 2 },
      { date: "2026-01-05", severity: 4 },
      { date: "2026-02-02", severity: 3 },
      { date: "2026-02-11", severity: 1 },
    ]);
    // A second symptom on a shared day is its own entry, not a merge.
    expect(analysis.entries.find((e) => e.symptom === "nausea")?.days).toBe(1);
  });

  it("keeps a closed window complete and bounds explicit requests newest-first", () => {
    const profileId = profile();
    const todayStr = today(profileId);
    for (let i = 0; i < 300; i++)
      log(profileId, shiftDateStr(todayStr, -i), "migraine", 2);

    const { from, to } = symptomAnalysisWindow(todayStr);
    const complete = getSymptomDaysInRange(profileId, from, to);
    expect(complete).toHaveLength(300);
    expect(complete.at(-1)?.date).toBe(shiftDateStr(todayStr, -299));
    const bounded = getSymptomDaysInRange(profileId, from, to, 250);
    expect(bounded).toHaveLength(250);
    expect(bounded.at(-1)?.date).toBe(shiftDateStr(todayStr, -249));
    expect(rowCount(profileId)).toBe(300);
    const migraine = buildSymptomAnalysis(profileId, todayStr).entries[0];
    expect(migraine.days).toBe(300);
    expect(migraine.months.reduce((n, m) => n + m.days, 0)).toBe(300);
  });

  it("never counts another profile's symptom-days", () => {
    const profileId = profile();
    const otherId = profile();
    log(profileId, "2026-02-02", "migraine", 2);
    for (const date of ["2026-02-03", "2026-02-04", "2026-01-09"])
      log(otherId, date, "migraine", 4);

    expect(rowCount(otherId, "migraine")).toBe(3);
    expect(
      buildSymptomAnalysis(profileId, today(profileId)).entries
    ).toHaveLength(1);
    expect(
      buildSymptomAnalysis(profileId, today(profileId)).entries[0].days
    ).toBe(1);
  });
});

describe("which symptoms are recurring", () => {
  // The threshold is two-sided on purpose: days alone promotes one week of flu, months
  // alone promotes a symptom logged twice a year. Each row sits exactly one step from
  // the boundary on one axis.
  const cases: [string, string[], boolean, string][] = [
    [
      "migraine",
      ["2026-02-02", "2026-02-11", "2026-01-05"],
      true,
      "exactly at both thresholds",
    ],
    ["nausea", ["2026-02-02", "2026-01-05"], false, "one day below"],
    [
      "fever",
      ["2026-02-02", "2026-02-11", "2026-02-20"],
      false,
      "one month below",
    ],
    [
      "cough",
      ["2026-02-02", "2026-01-05", "2025-12-24", "2025-12-25", "2025-11-30"],
      true,
      "clear of both",
    ],
  ];

  it("names its thresholds as three days across two months", () => {
    expect([RECURRING_MIN_DAYS, RECURRING_MIN_MONTHS]).toEqual([3, 2]);
  });

  it("takes at least three days across at least two months", () => {
    const profileId = profile();
    for (const [symptom, dates] of cases)
      for (const date of dates) log(profileId, date, symptom, 2);

    const analysis = buildSymptomAnalysis(profileId, today(profileId));
    // NON-VACUITY: all four symptoms are PRESENT in the analysis, so "not recurring"
    // below is a verdict rather than an absent row.
    expect(analysis.entries.map((e) => e.symptom).sort()).toEqual([
      "cough",
      "fever",
      "migraine",
      "nausea",
    ]);
    expect(
      cases.map(([symptom, dates]) => {
        const entry = analysis.entries.find((e) => e.symptom === symptom)!;
        return [symptom, entry.days, entry.recurring];
      })
    ).toEqual(
      cases.map(([symptom, dates, recurring]) => [
        symptom,
        dates.length,
        recurring,
      ])
    );
    expect(analysis.recurring.map((e) => e.symptom).sort()).toEqual([
      "cough",
      "migraine",
    ]);
  });
});

describe("the window is the PROFILE's day, not the server's", () => {
  it("puts one instant in different months for two profiles twelve hours apart", () => {
    const eastId = profile("UTC");
    const westId = profile("Etc/GMT+12");

    // Logged through the write core at each profile's OWN today — the same instant.
    for (const id of [eastId, westId])
      logSymptomCore(id, "migraine", 2, today(id), "page");

    expect(today(eastId)).toBe("2026-03-01");
    expect(today(westId)).toBe("2026-02-28");
    // NON-VACUITY: the fixture really did diverge — one row each, on different days.
    expect(
      db
        .prepare(
          `SELECT profile_id, date FROM symptom_logs
            WHERE profile_id IN (?, ?) ORDER BY profile_id`
        )
        .all(eastId, westId)
    ).toEqual([
      { profile_id: eastId, date: "2026-03-01" },
      { profile_id: westId, date: "2026-02-28" },
    ]);

    const east = buildSymptomAnalysis(eastId, today(eastId));
    const west = buildSymptomAnalysis(westId, today(westId));

    expect([east.from, east.months.at(-1)]).toEqual([
      "2025-04-01",
      "2026-03-01",
    ]);
    expect([west.from, west.months.at(-1)]).toEqual([
      "2025-03-01",
      "2026-02-01",
    ]);
    expect(monthDays(east.entries[0], "2026-03-01")).toBe(1);
    expect(monthDays(east.entries[0], "2026-02-01")).toBe(0);
    // The west profile's window does not even CONTAIN March; its day is February's.
    expect(monthDays(west.entries[0], "2026-03-01")).toBeUndefined();
    expect(monthDays(west.entries[0], "2026-02-01")).toBe(1);
  });
});
