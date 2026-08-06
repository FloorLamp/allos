// DB INTEGRATION TIER (#2188): per-practice weekly rhythm inference against the real
// practice_logs store, and the rhythm-RETIMED pace nudge — the #1259 builder holding a
// behind practice for its next predicted day and typical hour, falling back to the
// flip-day rule once the week's last predicted day passes, and keeping today's
// schedule byte-for-byte for a practice with no pattern (#558).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getWellnessPractices,
  inferPracticeSchedule,
  isPredictedPracticeDay,
  logPracticeSession,
} from "@/lib/queries";
import {
  behindPractices,
  buildPracticeReminder,
  type PracticeNudgeTiming,
} from "@/lib/notifications/practices";
import { practiceIdentity } from "@/lib/practice";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function practiceTarget(
  profileId: number,
  name: string,
  floor: number,
  ceiling: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
         VALUES (?, 'practice', ?, ?, ?, ?)`
      )
      .run(profileId, name, practiceIdentity(name), floor, ceiling)
      .lastInsertRowid
  );
}

// A weekly habit: one session on `weekday`'s date of each of the `weeks` weeks
// before the week containing `anchor` (0=Sun … 6=Sat; anchor's own week stays
// empty so the target is behind). Inserted directly — the write core's forged-date
// window rightly refuses dates this old, and inference reads the store, not the
// write path.
function seedWeeklyHabit(
  profileId: number,
  practice: string,
  anchor: string,
  weekday: number,
  weeks: number,
  time: string | null
): void {
  const anchorWeekday = new Date(anchor + "T00:00:00Z").getUTCDay();
  const sunday = shiftDateStr(anchor, -anchorWeekday);
  const insert = db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, time) VALUES (?, ?, ?, ?)`
  );
  for (let k = 1; k <= weeks; k++) {
    insert.run(
      profileId,
      practice,
      shiftDateStr(sunday, -k * 7 + weekday),
      time
    );
  }
}

// The default waking window, at a given profile-local moment.
const at = (weekday: number, minuteOfDay: number): PracticeNudgeTiming => ({
  weekday,
  minuteOfDay,
  wakingStartHour: 8,
  wakingEndHour: 21,
});

describe("per-practice rhythm inference + retimed nudge (#2188)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-06-16 is a Tuesday; the (default) calendar week runs Sun 06-14 – Sat 06-20.
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("infers per-practice rhythms in isolation — a daily meditation never bleeds into red-light Wed/Fri", () => {
    const pid = makeProfile("rhythm-isolation");
    const t = today(pid);
    // logPracticeSession refuses dates older than its 30-day window, so seed the
    // 8-week fixture directly (the store is what inference reads either way).
    const insert = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time) VALUES (?, ?, ?, ?)`
    );
    for (let d = 1; d <= 56; d++)
      insert.run(pid, "Meditation", shiftDateStr(t, -d), "07:15");
    const anchorWeekday = 2; // Tuesday
    const sunday = shiftDateStr(t, -anchorWeekday);
    for (let k = 1; k <= 8; k++) {
      insert.run(
        pid,
        "Red light therapy",
        shiftDateStr(sunday, -k * 7 + 3),
        "18:30"
      );
      insert.run(
        pid,
        "Red light therapy",
        shiftDateStr(sunday, -k * 7 + 5),
        "18:30"
      );
    }

    expect(inferPracticeSchedule(pid, "Meditation")).toMatchObject({
      hasPattern: true,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      hour: 7,
    });
    expect(inferPracticeSchedule(pid, "Red light therapy")).toMatchObject({
      hasPattern: true,
      weekdays: [3, 5],
      hour: 18,
    });
    // Spelling variants fold into the same identity before inferring.
    expect(inferPracticeSchedule(pid, " RED LIGHT  THERAPY ")).toMatchObject({
      weekdays: [3, 5],
    });
    expect(isPredictedPracticeDay(pid, "Red light therapy", t)).toBe(false);
    expect(isPredictedPracticeDay(pid, "Meditation", t)).toBe(true);
  });

  it("holds a behind practice for its predicted day and fires at the typical hour", () => {
    const pid = makeProfile("rhythm-retime");
    const t = today(pid); // Tuesday 2026-06-16
    const tid = practiceTarget(pid, "Red light therapy", 3);
    seedWeeklyHabit(pid, "Red light therapy", t, 3, 8, "18:30"); // Wednesdays…
    seedWeeklyHabit(pid, "Red light therapy", t, 5, 8, "18:30"); // …and Fridays

    // Behind on Tuesday under the UNTIMED gather (the pace decision is untouched)…
    expect(behindPractices(pid).map((b) => b.targetId)).toEqual([tid]);
    // …but the timed gather HOLDS: Wednesday is still ahead this week.
    expect(behindPractices(pid, at(2, 8 * 60))).toEqual([]);
    expect(buildPracticeReminder(pid, "n0", "", at(2, 8 * 60))).toBeNull();

    // Wednesday morning: predicted day, but before the typical hour → still held.
    vi.setSystemTime(new Date("2026-06-17T08:00:00Z"));
    expect(behindPractices(pid, at(3, 8 * 60))).toEqual([]);

    // Wednesday at the typical hour → released, and the line names the rhythm as
    // data ("usually Wed/Fri"), not advice.
    const msg = buildPracticeReminder(pid, "n1", "", at(3, 18 * 60))!;
    expect(msg).toBeTruthy();
    expect(msg.body).toContain("Red light therapy — 0 of 3 this week");
    expect(msg.body).toContain("usually Wed/Fri");
    expect(msg.actions?.some((a) => a.data === `pdone:${pid}:${tid}:n1`)).toBe(
      true
    );
  });

  it("falls back to the flip-day rule once the week's last predicted day has passed", () => {
    const pid = makeProfile("rhythm-fallback");
    const t = today(pid);
    const tid = practiceTarget(pid, "Red light therapy", 3);
    seedWeeklyHabit(pid, "Red light therapy", t, 3, 8, "18:30");
    seedWeeklyHabit(pid, "Red light therapy", t, 5, 8, "18:30");

    // Saturday, still behind, Wednesday and Friday both gone: the first waking
    // tick releases — the week's nudge is never silently lost.
    vi.setSystemTime(new Date("2026-06-20T08:00:00Z"));
    expect(behindPractices(pid, at(6, 8 * 60)).map((b) => b.targetId)).toEqual([
      tid,
    ]);
    expect(buildPracticeReminder(pid, "n2", "", at(6, 8 * 60))).not.toBeNull();
  });

  it("a practice with no pattern keeps today's schedule byte-for-byte", () => {
    const pid = makeProfile("rhythm-none");
    const t = today(pid);
    practiceTarget(pid, "Breathwork", 3);
    // One session last week: far under the habitual-weekday gate → no pattern.
    logPracticeSession(pid, "Breathwork", shiftDateStr(t, -8));

    const untimed = buildPracticeReminder(pid, "n3");
    const timed = buildPracticeReminder(pid, "n3", "", at(2, 8 * 60));
    expect(untimed).not.toBeNull();
    // The SAME message at the flip-day moment — the timing changes nothing.
    expect(timed).toEqual(untimed);
    // And no rhythm is named for it (#558: no pattern says nothing).
    expect(untimed!.body).not.toContain("usually");
  });

  it("surfaces: usuallyToday flags a predicted day and stays false with no pattern (#558)", () => {
    const pid = makeProfile("rhythm-surface");
    // Move to Wednesday so the Wed/Fri habit predicts TODAY.
    vi.setSystemTime(new Date("2026-06-17T12:00:00Z"));
    const t = today(pid);
    practiceTarget(pid, "Red light therapy", 3);
    seedWeeklyHabit(pid, "Red light therapy", t, 3, 8, "18:30");
    seedWeeklyHabit(pid, "Red light therapy", t, 5, 8, "18:30");
    practiceTarget(pid, "Breathwork", 3);
    logPracticeSession(pid, "Breathwork", shiftDateStr(t, -1));

    const byName = new Map(
      getWellnessPractices(pid).map((p) => [p.name, p.usuallyToday])
    );
    expect(byName.get("Red light therapy")).toBe(true);
    // The young practice is UNKNOWN, which renders as nothing — never "every day".
    expect(byName.get("Breathwork")).toBe(false);
    expect(isPredictedPracticeDay(pid, "Breathwork", t)).toBeNull();
  });
});
