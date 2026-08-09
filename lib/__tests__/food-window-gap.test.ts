// PURE TIER — "did a food window close with nothing in it?" (issue #2376). DB-free: the
// gather hands a ledger slice (which windows each date derived) and the profile-local
// now, and this pins the whole decision — the cyclic predecessor, the closure check, the
// emptiness check, the habit gate, and the three ways a profile stays silent.

import { describe, it, expect } from "vitest";
import {
  foodWindowGap,
  foodWindowGapDates,
  foodWindowHabit,
  foodWindowCloseMinute,
  isHabitualFoodWindow,
  previousFoodWindow,
  FOOD_WINDOW_HABIT_DAYS,
  FOOD_WINDOW_HABIT_MIN_DAYS,
  type LoggedFoodWindows,
} from "@/lib/food-window-gap";
import {
  DEFAULT_MIDDAY_BOUNDARY_MIN,
  DEFAULT_EVENING_BOUNDARY_MIN,
  FOOD_SLOTS,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
import { RIGHTSIZE_WINDOW_DAYS } from "@/lib/target-rightsize";
import { FOOD_REGULARITY_SPAN_DAYS } from "@/lib/food-regularity";
import { shiftDateStr } from "@/lib/date";
import {
  foodWindowGapLine,
  renderFoodNudge,
} from "@/lib/notifications/food-format";
import { foodGroupSlugs } from "@/lib/food-groups";
import { plainBody } from "@/lib/notifications/rich-text";
import { formatMessageLine } from "@/lib/notifications/message-line";

const DATE = "2026-07-15";
const B: FoodSlotBoundaries = {
  midday: DEFAULT_MIDDAY_BOUNDARY_MIN, // 11:00
  evening: DEFAULT_EVENING_BOUNDARY_MIN, // 15:00
};

// A ledger where `windowDays` of the trailing days carry `window`, `otherDays` carry a
// different window only, and everything else is absent (nobody logged, or the day
// predates the events ledger — indistinguishable and equally not evidence).
function ledger(
  gapDate: string,
  opts: {
    window: FoodSlot;
    windowDays: number;
    otherDays?: number;
    other?: FoodSlot;
    gapDayWindows?: FoodSlot[];
  }
): LoggedFoodWindows {
  const map = new Map<string, Set<FoodSlot>>();
  const other = opts.other ?? "Evening";
  let day = 1;
  for (let i = 0; i < opts.windowDays; i++)
    map.set(shiftDateStr(gapDate, -day++), new Set([opts.window]));
  for (let i = 0; i < (opts.otherDays ?? 0); i++)
    map.set(shiftDateStr(gapDate, -day++), new Set([other]));
  if (opts.gapDayWindows?.length) map.set(gapDate, new Set(opts.gapDayWindows));
  return map;
}

// The profile-local now at the end of the nudge's own day, so closure is never the thing
// under test unless a case says so.
const LATE = { date: DATE, minuteOfDay: 23 * 60 };

describe("previousFoodWindow", () => {
  it("is the cyclic predecessor, with Morning reaching back to yesterday", () => {
    expect(previousFoodWindow("Midday")).toEqual({
      window: "Morning",
      dayOffset: 0,
    });
    expect(previousFoodWindow("Evening")).toEqual({
      window: "Midday",
      dayOffset: 0,
    });
    // Evening has no later window to carry it, so its report rides the NEXT day's
    // Morning nudge — which is the only reason Evening is reportable at all.
    expect(previousFoodWindow("Morning")).toEqual({
      window: "Evening",
      dayOffset: -1,
    });
  });

  it("gives every window exactly one reporting slot", () => {
    const reported = FOOD_SLOTS.map((w) => previousFoodWindow(w).window);
    expect(new Set(reported)).toEqual(new Set(FOOD_SLOTS));
  });
});

describe("foodWindowCloseMinute", () => {
  it("closes each window at its own boundary, Evening at midnight", () => {
    expect(foodWindowCloseMinute("Morning", B)).toBe(B.midday);
    expect(foodWindowCloseMinute("Midday", B)).toBe(B.evening);
    expect(foodWindowCloseMinute("Evening", B)).toBe(24 * 60);
  });
});

describe("foodWindowHabit / isHabitualFoodWindow", () => {
  it("counts only days that derived something, not calendar days", () => {
    const dates = ["2026-07-01", "2026-07-02", "2026-07-03"];
    const logged = new Map<string, Set<FoodSlot>>([
      ["2026-07-01", new Set<FoodSlot>(["Morning"])],
      ["2026-07-03", new Set<FoodSlot>(["Evening"])],
    ]);
    expect(foodWindowHabit(logged, dates, "Morning")).toEqual({
      loggingDays: 2,
      windowDays: 1,
    });
  });

  it("needs a STRICT majority — a tie is 'sometimes', not a habit", () => {
    expect(isHabitualFoodWindow({ loggingDays: 14, windowDays: 7 })).toBe(
      false
    );
    expect(isHabitualFoodWindow({ loggingDays: 14, windowDays: 8 })).toBe(true);
  });

  it("needs enough logging days for 'a majority' to mean anything", () => {
    const n = FOOD_WINDOW_HABIT_MIN_DAYS - 1;
    expect(isHabitualFoodWindow({ loggingDays: n, windowDays: n })).toBe(false);
    expect(
      isHabitualFoodWindow({
        loggingDays: FOOD_WINDOW_HABIT_MIN_DAYS,
        windowDays: FOOD_WINDOW_HABIT_MIN_DAYS,
      })
    ).toBe(true);
  });
});

describe("foodWindowGap", () => {
  it("reports the previous window of the same day when it closed empty", () => {
    const gap = foodWindowGap({
      window: "Evening",
      date: DATE,
      now: LATE,
      boundaries: B,
      logged: ledger(DATE, { window: "Midday", windowDays: 10 }),
    });
    expect(gap).toEqual({ window: "Midday", date: DATE, sameDay: true });
  });

  it("reports YESTERDAY's Evening on the Morning nudge", () => {
    const yesterday = shiftDateStr(DATE, -1);
    const gap = foodWindowGap({
      window: "Morning",
      date: DATE,
      now: { date: DATE, minuteOfDay: 7 * 60 },
      boundaries: B,
      logged: ledger(yesterday, { window: "Evening", windowDays: 10 }),
    });
    expect(gap).toEqual({ window: "Evening", date: yesterday, sameDay: false });
  });

  it("says nothing while the window is still open", () => {
    const logged = ledger(DATE, { window: "Morning", windowDays: 10 });
    const at = (minuteOfDay: number) =>
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: { date: DATE, minuteOfDay },
        boundaries: B,
        logged,
      });
    // A partially configured schedule keeps the fixed 11:00 boundary while the Midday
    // slot can sit anywhere, so a 10:30 nudge would otherwise call a live window empty.
    expect(at(B.midday - 1)).toBeNull();
    expect(at(B.midday)).not.toBeNull();
  });

  it("treats an earlier day as closed and a later one as not yet started", () => {
    const logged = ledger(DATE, { window: "Morning", windowDays: 10 });
    // A rebuild running the next morning still states yesterday's gap.
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: { date: shiftDateStr(DATE, 1), minuteOfDay: 0 },
        boundaries: B,
        logged,
      })
    ).not.toBeNull();
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: { date: shiftDateStr(DATE, -1), minuteOfDay: 23 * 60 },
        boundaries: B,
        logged,
      })
    ).toBeNull();
  });

  it("says nothing when the window derived an event", () => {
    expect(
      foodWindowGap({
        window: "Evening",
        date: DATE,
        now: LATE,
        boundaries: B,
        logged: ledger(DATE, {
          window: "Midday",
          windowDays: 10,
          gapDayWindows: ["Midday"],
        }),
      })
    ).toBeNull();
  });

  // The three silent cases the feature must never break, stated as their own tests.
  it("says nothing to a profile that has never logged food", () => {
    for (const window of FOOD_SLOTS)
      expect(
        foodWindowGap({
          window,
          date: DATE,
          now: LATE,
          boundaries: B,
          logged: new Map(),
        })
      ).toBeNull();
  });

  it("says nothing about a window the profile does not habitually log", () => {
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: LATE,
        boundaries: B,
        // Logs most days, but breakfast only twice in ten: telling this person daily
        // that breakfast is missing is the failure mode the gate exists for.
        logged: ledger(DATE, {
          window: "Morning",
          windowDays: 2,
          otherDays: 8,
        }),
      })
    ).toBeNull();
  });

  it("says nothing on too small a sample, even at 100%", () => {
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: LATE,
        boundaries: B,
        logged: ledger(DATE, {
          window: "Morning",
          windowDays: FOOD_WINDOW_HABIT_MIN_DAYS - 1,
        }),
      })
    ).toBeNull();
  });

  it("does not count unwindowed days against the habit", () => {
    // Five logging days inside the trailing window, every one of them a Morning day;
    // the other nine derived nothing (nobody logged, or the day predates the events
    // ledger). Those are not gaps and must not dilute the majority.
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: LATE,
        boundaries: B,
        logged: ledger(DATE, {
          window: "Morning",
          windowDays: FOOD_WINDOW_HABIT_MIN_DAYS,
        }),
      })
    ).not.toBeNull();
  });

  it("keeps the gap day out of its own evidence", () => {
    // 3 Morning days + 2 other-window days = 5 logging days, 3 > 2.5 → habitual. The
    // gap day itself logged an Evening serving; counting it would make the denominator
    // 6 and sink the majority, which is exactly the self-referential gate to avoid.
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: LATE,
        boundaries: B,
        logged: ledger(DATE, {
          window: "Morning",
          windowDays: 3,
          otherDays: 2,
          gapDayWindows: ["Evening"],
        }),
      })
    ).not.toBeNull();
  });

  it("ignores logging days older than the evidence window", () => {
    const logged = new Map<string, Set<FoodSlot>>();
    for (let i = 1; i <= FOOD_WINDOW_HABIT_DAYS + 5; i++)
      logged.set(shiftDateStr(DATE, -i), new Set<FoodSlot>(["Morning"]));
    // Inside the window it is unanimous, so the notice fires…
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: LATE,
        boundaries: B,
        logged,
      })
    ).not.toBeNull();
    // …and a history that stops just before the window leaves no evidence at all.
    const stale = new Map<string, Set<FoodSlot>>();
    for (
      let i = FOOD_WINDOW_HABIT_DAYS + 1;
      i <= FOOD_WINDOW_HABIT_DAYS + 10;
      i++
    )
      stale.set(shiftDateStr(DATE, -i), new Set<FoodSlot>(["Morning"]));
    expect(
      foodWindowGap({
        window: "Midday",
        date: DATE,
        now: LATE,
        boundaries: B,
        logged: stale,
      })
    ).toBeNull();
  });
});

describe("foodWindowGapDates", () => {
  it("covers the gap day and exactly the evidence days before it", () => {
    expect(foodWindowGapDates("Evening", DATE)).toEqual({
      from: shiftDateStr(DATE, -FOOD_WINDOW_HABIT_DAYS),
      to: DATE,
    });
    // Morning's gap day is yesterday, so the whole slice shifts back with it.
    expect(foodWindowGapDates("Morning", DATE)).toEqual({
      from: shiftDateStr(DATE, -(FOOD_WINDOW_HABIT_DAYS + 1)),
      to: shiftDateStr(DATE, -1),
    });
  });

  it("nests strictly inside every other engine reading the same ledger", () => {
    // The window-coherence convention (docs/internals/findings.md §4): engines reading
    // one ledger must not be able to fire off the same evidence and disagree.
    expect(FOOD_WINDOW_HABIT_DAYS).toBeLessThan(RIGHTSIZE_WINDOW_DAYS);
    // #2380's regularity span is the closest neighbour — the same events, asked a
    // different question (which GROUPS recur inside a logged window, versus whether the
    // window is logged at all). Its own denominator draws that line deliberately.
    expect(FOOD_WINDOW_HABIT_DAYS).toBeLessThan(FOOD_REGULARITY_SPAN_DAYS);
  });
});

describe("foodWindowGapLine", () => {
  it("states what the LEDGER holds, naming the window and the day", () => {
    expect(
      plainBody(
        foodWindowGapLine({ window: "Midday", date: DATE, sameDay: true })
      )
    ).toBe("📋 Nothing logged for Midday today.");
    expect(
      plainBody(
        foodWindowGapLine({ window: "Evening", date: DATE, sameDay: false })
      )
    ).toBe("📋 Nothing logged for Evening yesterday.");
  });

  it("rides the nudge's body without adding a button or changing its kind", () => {
    const ranked = foodGroupSlugs().slice(0, 4);
    const gap = { window: "Morning" as const, date: DATE, sameDay: true };
    const plain = renderFoodNudge(1, "Midday", DATE, ranked, new Map());
    const withGap = renderFoodNudge(1, "Midday", DATE, ranked, new Map(), {
      gap,
    });
    expect(plainBody(withGap.body)).toContain("📋 Nothing logged for Morning");
    // The notice is a CLAUSE, not a message: same title, same kind, same keyboard.
    expect(withGap.title).toBe(plain.title);
    expect(withGap.kind).toBe(plain.kind);
    expect(withGap.actions).toEqual(plain.actions);
    // Null is the common case and renders exactly the message that shipped before.
    expect(
      plainBody(renderFoodNudge(1, "Midday", DATE, ranked, new Map(), {}).body)
    ).toBe(plainBody(plain.body));
  });

  it("sits with the day's other ledger statements, above the protein line", () => {
    const ranked = foodGroupSlugs().slice(0, 4);
    const lines = plainBody(
      renderFoodNudge(1, "Evening", DATE, ranked, new Map([[ranked[0], 2]]), {
        gap: { window: "Midday", date: DATE, sameDay: true },
        proteinLine: "Protein 40 g today",
      }).body
    ).split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("✓ Today:")).toBeGreaterThanOrEqual(0);
    expect(at("Nothing logged for Midday")).toBe(at("✓ Today:") + 1);
    expect(at("Protein 40 g")).toBe(at("Nothing logged for Midday") + 1);
  });

  it("never accuses the person or borrows adherence language", () => {
    for (const window of FOOD_SLOTS)
      for (const sameDay of [true, false]) {
        const text = plainBody(
          foodWindowGapLine({ window, date: DATE, sameDay })
        );
        // No agent, no dueness: the app cannot tell a forgotten log from a skipped
        // meal, so the sentence may only be about the log.
        expect(text).not.toMatch(
          /\byou\b|\byour\b|missed?\b|overdue|skipped?\b|forgot|remember/i
        );
        expect(text).toContain("Nothing logged");
      }
  });

  // THE HEAD-ONLY CASE, on the real producer (#2391). lib/__tests__/message-line.test.ts
  // pins that the formatter invents no punctuation for a line with no qualifiers; this
  // pins that the notice IS that line — every qualifier role deliberately absent, so
  // composing through the shared grammar cannot put a dash, a dot or a word between the
  // sentence and the reader.
  it("renders through the formatter with no invented punctuation", () => {
    for (const window of FOOD_SLOTS)
      for (const sameDay of [true, false]) {
        const text = plainBody(
          foodWindowGapLine({ window, date: DATE, sameDay })
        );
        // Neither separator, and neither the parenthesis grammar #2389 found nor a
        // trailing orphan of either one.
        expect(text).not.toMatch(/[—·()]/);
        expect(text).toBe(
          // The SAME parts through the plain formatter: the glyph join is the only
          // punctuation either rendering adds, so the emphasized line and the plain one
          // can differ in emphasis and in nothing else.
          formatMessageLine({
            glyph: "📋",
            head: `Nothing logged for ${window} ${sameDay ? "today" : "yesterday"}.`,
          })
        );
      }
  });

  it("emphasizes the window name inside the one clause it writes", () => {
    // The head is OPAQUE by design: the type models no structure inside it, so the
    // emphasized token lands where this sentence needs it rather than in a slot.
    const body = foodWindowGapLine({
      window: "Midday",
      date: DATE,
      sameDay: true,
    });
    expect(typeof body === "string" ? [] : body.spans).toEqual([
      { text: "📋 Nothing logged for " },
      { text: "Midday", bold: true },
      { text: " today." },
    ]);
  });
});
