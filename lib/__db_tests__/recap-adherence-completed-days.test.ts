// DB INTEGRATION TIER — the recap's adherence RATE covers completed days only (#4228 A).
//
// The dashboard card reads the in-progress calendar week (#223), and `windowAdherence`
// walked the window INCLUSIVE OF TODAY, counting every dose due today as missed before
// the day was over. On the week's first morning that rendered "Adherence 0% · 12 missed"
// for doses simply not taken yet. Gather-shaped, so this tier: the rule is about which
// days the per-day dose walk visits, and a pure test over a hand-built `adherence`
// cannot fail for a gather that still visits today.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";
import { setWeekMode, setWeekStart, type WeekStart } from "@/lib/settings";
import { gatherRecapInput } from "@/lib/notifications/recap-data";
import { buildRecap } from "@/lib/recap";

const NOW = new Date("2026-06-17T12:00:00Z");

// A calendar-week profile for whom today is day `dayOfWeek` of the week, with one daily
// `must` medication and NO dose taken today.
function profileOnDay(dayOfWeek: number): {
  pid: number;
  td: string;
  doseId: number;
} {
  const pid = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`recap-adherence-day${dayOfWeek}`).lastInsertRowid
  );
  setWeekMode(pid, "calendar");
  const td = today(pid);
  setWeekStart(
    pid,
    weekdayOfDateStr(shiftDateStr(td, -(dayOfWeek - 1))) as WeekStart
  );
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Daily med (test)', 1, 'medication', 'daily', 'must')`
      )
      .run(pid).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
         VALUES (?, '1 tablet', 'morning', 'any', 0, 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { pid, td, doseId };
}

function takeOn(doseId: number, date: string): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, 'taken')`
  ).run(doseId, date);
}

const adherenceOf = (pid: number, completed: boolean) =>
  gatherRecapInput(pid, "kg", "week", completed).adherence;

describe("the recap's adherence rate covers completed days only (#4228 A)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("THE REPORT: on day 1 of the week, today's pending doses are not misses and no rate renders", () => {
    const { pid } = profileOnDay(1);
    expect(adherenceOf(pid, false)).toBeNull();
    const card = buildRecap(gatherRecapInput(pid, "kg", "week", false));
    expect(card.lines.map((l) => l.key)).not.toContain("adherence");
  });

  it("on day N the rate covers days 1..N-1 — a real miss counts, today does not", () => {
    const { pid, td, doseId } = profileOnDay(3);
    takeOn(doseId, shiftDateStr(td, -2));
    // Day 2 untaken is a miss; today untaken is pending.
    expect(adherenceOf(pid, false)).toEqual({ taken: 1, skipped: 0, due: 2 });
  });

  it("the notification's completed window is unchanged by the rule", () => {
    const { pid, td, doseId } = profileOnDay(3);
    // The last completed calendar week runs td-9..td-3; one take inside it.
    takeOn(doseId, shiftDateStr(td, -5));
    expect(adherenceOf(pid, true)).toEqual({ taken: 1, skipped: 0, due: 7 });
  });
});
