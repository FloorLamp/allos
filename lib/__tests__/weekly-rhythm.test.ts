// The shared weekly-rhythm inference (#2188): the workout-schedule shape
// (#558) extracted so the practice inference is the same computation. These
// tests pin the gate matrix, the practice fallback-hour ladder, and the honesty
// rule that no-pattern is UNKNOWN — plus the rhythm-retimed nudge release
// decision (practiceNudgeReleased, lib/practice.ts).

import { describe, it, expect } from "vitest";
import {
  inferPracticeRhythm,
  inferWeeklyRhythm,
  modalHour,
  predictedOnDay,
  rhythmMinDates,
  rhythmMomentOpen,
  RHYTHM_MOMENT_MIN,
  RHYTHM_EVENING_FALLBACK_HOUR,
  RHYTHM_WINDOW_WEEKS,
  type RhythmRow,
} from "@/lib/weekly-rhythm";
import {
  practiceNudgeReleased,
  practiceRhythmDaysText,
  type PracticeNudgeMoment,
} from "@/lib/practice";

// 2026-06-16 is a Tuesday. Weekday helper: 2026-06-14 = Sunday.
const ASOF = "2026-06-16";

// `count` dated rows on the given weekday, weekly, ending `endWeeksAgo` weeks
// before ASOF. Weekday 0=Sun … 6=Sat; the Sunday of ASOF's week is 2026-06-14.
function weeklyRows(
  weekday: number,
  count: number,
  time: string | null = null,
  endWeeksAgo = 1
): RhythmRow[] {
  const sunday = Date.UTC(2026, 5, 14);
  const rows: RhythmRow[] = [];
  for (let k = 0; k < count; k++) {
    const d = new Date(
      sunday - (endWeeksAgo + k) * 7 * 86400000 + weekday * 86400000
    );
    rows.push({ date: d.toISOString().slice(0, 10), time });
  }
  return rows;
}

describe("rhythmMinDates — the shared habitual-weekday gate", () => {
  it("is 40% of the window's weeks, floored at 2", () => {
    expect(rhythmMinDates(RHYTHM_WINDOW_WEEKS)).toBe(4); // ceil(8 × 0.4)
    expect(rhythmMinDates(2)).toBe(2); // the floor
    expect(rhythmMinDates(1)).toBe(2); // never 1 — one log is not a habit
  });
});

describe("inferWeeklyRhythm — the gate matrix (#558 shape)", () => {
  it("a young practice (below the gate) has NO pattern — the every-day fallback", () => {
    // Three Mondays in an 8-week window: under the gate of 4.
    const inf = inferWeeklyRhythm(weeklyRows(1, 3));
    expect(inf.hasPattern).toBe(false);
    expect(inf.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("a stable Mon/Wed/Fri habit infers exactly those weekdays", () => {
    const rows = [
      ...weeklyRows(1, 6),
      ...weeklyRows(3, 6),
      ...weeklyRows(5, 6),
    ];
    const inf = inferWeeklyRhythm(rows);
    expect(inf).toMatchObject({ hasPattern: true, weekdays: [1, 3, 5] });
  });

  it("a weekday logged often enough joins; a stray single day does not", () => {
    const rows = [
      ...weeklyRows(2, 5), // Tuesdays, over the gate
      ...weeklyRows(6, 1), // one Saturday
    ];
    expect(inferWeeklyRhythm(rows).weekdays).toEqual([2]);
  });

  it("two same-day sessions count as ONE distinct date for the gate", () => {
    const day = weeklyRows(4, 1)[0];
    const rows = [
      ...weeklyRows(4, 3),
      { ...day }, // a second session on an already-counted date
    ];
    expect(inferWeeklyRhythm(rows).hasPattern).toBe(false);
  });
});

describe("modalHour + the practice fallback ladder (#2188)", () => {
  it("takes the modal valid hour and ignores unparseable times", () => {
    expect(modalHour(["07:30", "07:05", "18:00", null, "xx:yy"])).toBe(7);
    expect(modalHour([null, null])).toBeNull();
    expect(modalHour([])).toBeNull();
  });

  it("uses the window's modal time when one exists", () => {
    const rows = [...weeklyRows(1, 6, "06:45"), ...weeklyRows(3, 6, "19:10")];
    // Tie between 6 and 19 at 6 apiece? No — both have 6; first to reach the
    // top count in row order wins, and Mondays come first here.
    expect(inferPracticeRhythm(rows, ASOF).hour).toBe(6);
  });

  it("falls back to the practice's OWN historical hour when the window has no times", () => {
    const rows = [
      // Recent one-tap logs carry no time…
      ...weeklyRows(2, 6, null),
      // …but the practice's older history was always an 07:00 habit.
      ...weeklyRows(2, 4, "07:00", 20),
    ];
    const inf = inferPracticeRhythm(rows, ASOF);
    expect(inf.hour).toBe(7);
    // The aged-out rows feed ONLY the hour fallback, never the weekday gate:
    // the pattern comes from the in-window Tuesdays alone.
    expect(inf.weekdays).toEqual([2]);
  });

  it("settles on the shared evening default when no time was ever logged", () => {
    const inf = inferPracticeRhythm(weeklyRows(2, 6, null), ASOF);
    expect(inf.hour).toBe(RHYTHM_EVENING_FALLBACK_HOUR);
  });
});

describe("inferPracticeRhythm — the window (#2188)", () => {
  it("a drifted habit ages out of the 8-week window", () => {
    // A solid Monday habit that ended 10 weeks ago: nothing in the window.
    const inf = inferPracticeRhythm(weeklyRows(1, 8, "07:00", 10), ASOF);
    expect(inf.hasPattern).toBe(false);
  });

  it("keys the window off asOf, not off the rows", () => {
    const rows = weeklyRows(1, 6, null, 1);
    expect(inferPracticeRhythm(rows, ASOF).hasPattern).toBe(true);
    // The same rows viewed from 20 weeks later have all aged out.
    expect(inferPracticeRhythm(rows, "2026-11-03").hasPattern).toBe(false);
  });
});

// The window is closed at BOTH ends (#4030). The workout sibling's gather bounds its
// SQL at `asOf` (#4026); this one filtered on the window's start alone, so a session
// logged for a day that had not happened counted toward the habit — and the two
// siblings answered "what was inferable as of D" differently.
describe("inferPracticeRhythm — the window is closed at both ends (#4030)", () => {
  // Mondays. Two of them have happened as of ASOF (a Tuesday); two are logged ahead.
  const MONDAYS = ["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"];
  const rows = MONDAYS.map((date) => ({ date, time: null }));

  it("a session logged for a day that has not happened does not build the habit", () => {
    expect(inferPracticeRhythm(rows, ASOF).hasPattern).toBe(false);
    // The converse, so the assertion above cannot pass on rows that were never a
    // habit: once all four days HAVE happened, the same rows infer the Monday.
    expect(inferPracticeRhythm(rows, "2026-06-29")).toMatchObject({
      hasPattern: true,
      weekdays: [1],
    });
  });

  it("nor does a time logged ahead set the habitual hour", () => {
    // The fallback ladder reads the practice's own history, and a not-yet day is not
    // history: 07:00 is logged only on days after ASOF.
    const timed = [
      { date: "2026-06-02", time: null },
      { date: "2026-06-09", time: null },
      { date: "2026-06-23", time: "07:00" },
    ];
    expect(inferPracticeRhythm(timed, ASOF).hour).toBe(
      RHYTHM_EVENING_FALLBACK_HOUR
    );
    expect(inferPracticeRhythm(timed, "2026-06-30").hour).toBe(7);
  });
});

describe("predictedOnDay — the #558 honesty rule", () => {
  it("answers null (UNKNOWN) when no pattern exists — never 'yes, every day'", () => {
    const young = inferWeeklyRhythm(weeklyRows(1, 2));
    expect(young.hasPattern).toBe(false);
    expect(predictedOnDay(young, ASOF)).toBeNull();
  });

  it("answers the weekday membership for a real pattern", () => {
    const inf = inferWeeklyRhythm([...weeklyRows(2, 6), ...weeklyRows(4, 6)]);
    expect(predictedOnDay(inf, "2026-06-16")).toBe(true); // a Tuesday
    expect(predictedOnDay(inf, "2026-06-17")).toBe(false); // a Wednesday
  });
});

// ---- The rhythm-retimed nudge release (#2188 constraint 3) ------------------

const rhythm = (weekdays: number[], hour = 18) => ({
  weekdays,
  hour,
  hasPattern: true,
});

const moment = (over: Partial<PracticeNudgeMoment>): PracticeNudgeMoment => ({
  weekday: 2, // Tuesday
  minuteOfDay: 8 * 60,
  wakingStartHour: 8,
  wakingEndHour: 21,
  daysLeftInWindow: 4, // Wed–Sat of a Sunday-start calendar week
  ...over,
});

describe("practiceNudgeReleased", () => {
  it("no pattern → released unconditionally (today's behavior byte-for-byte)", () => {
    const none = {
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      hour: 18,
      hasPattern: false,
    };
    expect(practiceNudgeReleased(none, moment({}))).toBe(true);
    expect(practiceNudgeReleased(none, moment({ minuteOfDay: 0 }))).toBe(true);
  });

  it("holds on a non-predicted day while a predicted day is still ahead this week", () => {
    // Tuesday, predicted {Wed, Fri}: Wednesday is ahead → hold.
    expect(practiceNudgeReleased(rhythm([3, 5]), moment({}))).toBe(false);
  });

  it("on a predicted day, releases at the typical hour — not before", () => {
    const m = moment({ weekday: 3, daysLeftInWindow: 3 }); // Wednesday
    expect(
      practiceNudgeReleased(rhythm([3, 5], 18), { ...m, minuteOfDay: 8 * 60 })
    ).toBe(false);
    expect(
      practiceNudgeReleased(rhythm([3, 5], 18), {
        ...m,
        minuteOfDay: 17 * 60 + 59,
      })
    ).toBe(false);
    expect(
      practiceNudgeReleased(rhythm([3, 5], 18), { ...m, minuteOfDay: 18 * 60 })
    ).toBe(true);
    // A missed tick still fires at the NEXT waking tick, not never.
    expect(
      practiceNudgeReleased(rhythm([3, 5], 18), { ...m, minuteOfDay: 20 * 60 })
    ).toBe(true);
  });

  it("falls back to the flip-day rule once the week's last predicted day has passed", () => {
    // Saturday, predicted {Wed, Fri}, week ends today: released at any waking minute.
    expect(
      practiceNudgeReleased(
        rhythm([3, 5]),
        moment({ weekday: 6, daysLeftInWindow: 0, minuteOfDay: 8 * 60 })
      )
    ).toBe(true);
  });

  it("clamps a typical hour outside the waking window INTO it — never earlier than waking start", () => {
    // Typical hour 6, waking 8–21: releases at 08:00, not 06:00.
    const m = moment({ weekday: 3, daysLeftInWindow: 3 });
    expect(
      practiceNudgeReleased(rhythm([3], 6), { ...m, minuteOfDay: 8 * 60 })
    ).toBe(true);
    // Typical hour 23, waking 8–21: clamps to the window END (21), the closest
    // waking minute to the habit.
    expect(
      practiceNudgeReleased(rhythm([3], 23), { ...m, minuteOfDay: 20 * 60 })
    ).toBe(false);
    expect(
      practiceNudgeReleased(rhythm([3], 23), { ...m, minuteOfDay: 21 * 60 })
    ).toBe(true);
  });

  it("orders a wrapped (night-shift) waking window from its start", () => {
    // Waking 20→08, typical hour 22: 21:00 is before the habit, 01:00 is after
    // it (the post-midnight tail of the SAME waking stretch).
    const m = moment({
      weekday: 3,
      daysLeftInWindow: 3,
      wakingStartHour: 20,
      wakingEndHour: 8,
    });
    expect(
      practiceNudgeReleased(rhythm([3], 22), { ...m, minuteOfDay: 21 * 60 })
    ).toBe(false);
    expect(
      practiceNudgeReleased(rhythm([3], 22), { ...m, minuteOfDay: 1 * 60 })
    ).toBe(true);
  });

  it("rolling mode (daysLeftInWindow 0) defers within a day but never across days", () => {
    // Tuesday not predicted, rolling window: no 'later this week' exists → the
    // flip-day rule stands, so the week's nudge can never be silently lost.
    expect(
      practiceNudgeReleased(
        rhythm([3, 5]),
        moment({ daysLeftInWindow: 0, minuteOfDay: 8 * 60 })
      )
    ).toBe(true);
    // …while a predicted 'today' still waits for the typical hour.
    expect(
      practiceNudgeReleased(
        rhythm([2], 18),
        moment({ daysLeftInWindow: 0, minuteOfDay: 8 * 60 })
      )
    ).toBe(false);
  });
});

describe("practiceRhythmDaysText — data, not advice", () => {
  it("names the inferred days", () => {
    expect(practiceRhythmDaysText([1, 3, 5])).toBe("usually Mon/Wed/Fri");
    expect(practiceRhythmDaysText([0])).toBe("usually Sun");
  });
});

// ---- The dashboard's rhythm MOMENT (#3224) ----------------------------------
//
// The Now window for a weekly target's log action. Distinct from the nudge
// release above: this closes again after the moment passes, and no-pattern is
// never an open window.

describe("rhythmMomentOpen", () => {
  // 2026-06-17 is a Wednesday (weekday 3); 2026-06-18 a Thursday.
  const WED = "2026-06-17";
  const THU = "2026-06-18";

  it("no pattern is never an open moment — the honesty rule, un-negotiated", () => {
    const none = {
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      hour: 18,
      hasPattern: false,
    };
    for (const minute of [0, 8 * 60, 18 * 60, 23 * 60 + 59]) {
      expect(rhythmMomentOpen(none, WED, minute)).toBe(false);
      expect(rhythmMomentOpen(none, THU, minute)).toBe(false);
    }
  });

  it("opens on a predicted day around the typical hour and closes again", () => {
    const r = rhythm([3], 18);
    expect(rhythmMomentOpen(r, WED, 18 * 60)).toBe(true);
    expect(rhythmMomentOpen(r, WED, 18 * 60 - RHYTHM_MOMENT_MIN)).toBe(true);
    expect(rhythmMomentOpen(r, WED, 18 * 60 + RHYTHM_MOMENT_MIN)).toBe(true);
    // One minute past either edge the moment is over — a window, not a span.
    expect(rhythmMomentOpen(r, WED, 18 * 60 - RHYTHM_MOMENT_MIN - 1)).toBe(
      false
    );
    expect(rhythmMomentOpen(r, WED, 18 * 60 + RHYTHM_MOMENT_MIN + 1)).toBe(
      false
    );
    // Nowhere near the habit, on the right day, is still not the moment.
    expect(rhythmMomentOpen(r, WED, 8 * 60)).toBe(false);
  });

  it("stays shut on a day the rhythm does not predict, at any hour", () => {
    const r = rhythm([3], 18);
    for (const minute of [0, 8 * 60, 18 * 60, 23 * 60 + 59]) {
      expect(rhythmMomentOpen(r, THU, minute)).toBe(false);
    }
  });

  it("reaches across midnight for a habit at the edge of the day", () => {
    // Typical hour 00: 23:00 the same evening is inside the band, 22:00 is not.
    const r = rhythm([3], 0);
    expect(rhythmMomentOpen(r, WED, 23 * 60)).toBe(true);
    expect(rhythmMomentOpen(r, WED, 22 * 60)).toBe(false);
    expect(rhythmMomentOpen(r, WED, 60)).toBe(true);
  });
});
