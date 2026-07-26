import { describe, it, expect } from "vitest";
import {
  adherenceSummary,
  aggregateDoseDay,
  doseExistsSince,
  doseStrip,
  doseWindowSince,
  indexTakenByDose,
  supplementAdherenceStrip,
  STRIP_DAYS,
  type AdherenceState,
} from "@/lib/supplement-adherence";
import type { Supplement, SupplementCondition } from "@/lib/types";

// Build a strip (oldest-first) from a compact state string: each char maps to a
// state, so "mttt" is [missed, taken, taken, taken] with the last as today.
const S: Record<string, AdherenceState> = {
  t: "taken",
  p: "partial",
  m: "missed",
  n: "na",
  s: "skipped",
};
const strip = (s: string) =>
  [...s].map((c, i) => ({ date: `d${i}`, state: S[c] }));

describe("adherenceSummary", () => {
  it("counts a full window as a complete streak at 100%", () => {
    const r = adherenceSummary(strip("tttttttttttttt"));
    expect(r).toMatchObject({ streak: 14, pct: 100, applicableDays: 14 });
  });

  it("treats an untaken today (trailing missed) as pending, not a break", () => {
    // 5 taken, today not logged yet.
    const r = adherenceSummary(strip("tttttm"));
    expect(r.streak).toBe(5);
  });

  it("excludes a still-pending today from the percentage, not just the streak", () => {
    // 4 taken, today not logged yet → a perfect record reads 100%, not 80%.
    const r = adherenceSummary(strip("ttttm"));
    expect(r.pct).toBe(100);
    expect(r.streak).toBe(4);
    expect(r.applicableDays).toBe(4);
  });

  it("counts today when it is already taken", () => {
    const r = adherenceSummary(strip("tttttt"));
    expect(r.streak).toBe(6);
  });

  it("ends the streak on a real missed day mid-window", () => {
    // ...taken, missed, taken, taken (today taken) → streak of 2.
    const r = adherenceSummary(strip("ttmtt"));
    expect(r.streak).toBe(2);
  });

  it("treats na days as transparent to the streak", () => {
    // taken, na, taken, na, taken(today) → streak spans the na gaps = 3.
    const r = adherenceSummary(strip("tntnt"));
    expect(r.streak).toBe(3);
  });

  it("keeps the streak alive through a partial day", () => {
    // taken, taken, partial, taken, taken(today) → partial doesn't break it = 5.
    const r = adherenceSummary(strip("ttptt"));
    expect(r.streak).toBe(5);
  });

  it("counts a partial today toward the streak and half toward the percentage", () => {
    const r = adherenceSummary(strip("ttttp"));
    expect(r.streak).toBe(5);
    expect(r.takenDays).toBe(4);
    expect(r.partialDays).toBe(1);
    expect(r.applicableDays).toBe(5);
    // (4 + 0.5) / 5 = 90%.
    expect(r.pct).toBe(90);
  });

  it("counts partial days as half toward the percentage", () => {
    // 2 taken, 2 partial → (2 + 1) / 4 = 75%.
    const r = adherenceSummary(strip("ttpp"));
    expect(r.takenDays).toBe(2);
    expect(r.partialDays).toBe(2);
    expect(r.pct).toBe(75);
  });

  it("computes percentage over due days only, excluding na", () => {
    // 6 taken, 2 missed, 2 na → 6/8 = 75%.
    const r = adherenceSummary(strip("ttttttmmnn"));
    expect(r.applicableDays).toBe(8);
    expect(r.takenDays).toBe(6);
    expect(r.pct).toBe(75);
  });

  it("returns null percentage and zero streak when nothing was due", () => {
    const r = adherenceSummary(strip("nnnnnn"));
    expect(r.pct).toBeNull();
    expect(r.streak).toBe(0);
    expect(r.applicableDays).toBe(0);
  });

  // Three-way adherence (#232): a deliberate skip is excluded from the
  // denominator (it wasn't an intended dose) and is transparent to the streak,
  // yet counted on its own — distinct from a "missed" lapse.
  describe("skipped days (#232)", () => {
    it("excludes skips from the denominator but counts them separately", () => {
      // 3 taken, 1 skipped, 1 missed over the settled window (today = taken).
      const r = adherenceSummary(strip("tsmtt"));
      expect(r.skippedDays).toBe(1);
      // Denominator is 4 (3 taken + 1 missed), not 5 — 75%, not 60%.
      expect(r.applicableDays).toBe(4);
      expect(r.takenDays).toBe(3);
      expect(r.pct).toBe(75);
    });

    it("keeps a skip transparent to the streak (neither counts nor breaks it)", () => {
      // …taken, skipped, taken → the skip doesn't end the run.
      const r = adherenceSummary(strip("ttstt"));
      expect(r.streak).toBe(5 - 1); // 4 taken days, skip is invisible
      expect(r.skippedDays).toBe(1);
    });

    it("a missed day still breaks the streak even with skips present", () => {
      const r = adherenceSummary(strip("tsmtt"));
      expect(r.streak).toBe(2); // the two trailing taken days
    });

    it("reports null percentage when every settled day was skipped or na", () => {
      const r = adherenceSummary(strip("nssn"));
      expect(r.pct).toBeNull();
      expect(r.applicableDays).toBe(0);
      expect(r.skippedDays).toBe(2);
    });
  });

  it("handles an empty window", () => {
    const r = adherenceSummary([]);
    expect(r).toEqual({
      streak: 0,
      pct: null,
      takenDays: 0,
      partialDays: 0,
      skippedDays: 0,
      applicableDays: 0,
    });
  });
});

describe("indexTakenByDose", () => {
  it("groups log rows into taken/skipped date sets per dose id", () => {
    const m = indexTakenByDose([
      { dose_id: 1, date: "d0" }, // status omitted → taken (pre-#232 default)
      { dose_id: 2, date: "d0", status: "taken" },
      { dose_id: 1, date: "d1" },
      { dose_id: 1, date: "d1" }, // duplicate collapses in the set
      { dose_id: 1, date: "d2", status: "skipped" }, // #232
    ]);
    expect(m.get(1)?.taken).toEqual(new Set(["d0", "d1"]));
    expect(m.get(1)?.skipped).toEqual(new Set(["d2"]));
    expect(m.get(2)?.taken).toEqual(new Set(["d0"]));
    expect(m.get(2)?.skipped).toEqual(new Set());
    expect(m.get(3)).toBeUndefined();
  });

  it("returns an empty map for no rows", () => {
    expect(indexTakenByDose([]).size).toBe(0);
  });
});

describe("doseStrip", () => {
  const dates = ["d0", "d1", "d2", "d3"];

  it("marks days not due as na, logged days taken, and the rest missed", () => {
    const strip = doseStrip(
      dates,
      (d) => d !== "d1", // not due on d1
      new Set(["d0", "d3"])
    );
    expect(strip).toEqual([
      { date: "d0", state: "taken" },
      { date: "d1", state: "na" },
      { date: "d2", state: "missed" },
      { date: "d3", state: "taken" },
    ]);
  });

  it("feeds adherenceSummary end-to-end: a due-every-day dose taken all but today", () => {
    // d3 is today and not yet logged → pending, so 3/3 = 100% and streak 3.
    const strip = doseStrip(dates, () => true, new Set(["d0", "d1", "d2"]));
    const r = adherenceSummary(strip);
    expect(r.streak).toBe(3);
    expect(r.pct).toBe(100);
  });

  it("marks a deliberately skipped day as skipped, not missed (#232)", () => {
    const strip = doseStrip(
      dates,
      () => true,
      new Set(["d0"]), // taken
      new Set(["d2"]) // skipped
    );
    expect(strip).toEqual([
      { date: "d0", state: "taken" },
      { date: "d1", state: "missed" },
      { date: "d2", state: "skipped" },
      { date: "d3", state: "missed" },
    ]);
  });
});

// Roll per-dose outcomes into one supplement-day state (#232).
describe("aggregateDoseDay", () => {
  it("is taken only when every due dose was taken", () => {
    expect(aggregateDoseDay(2, 2, 0)).toBe("taken");
    expect(aggregateDoseDay(1, 1, 0)).toBe("taken");
  });

  it("is partial when some (but not all) doses were taken", () => {
    expect(aggregateDoseDay(2, 1, 0)).toBe("partial");
    expect(aggregateDoseDay(3, 1, 1)).toBe("partial"); // any take wins
  });

  it("is skipped when every due dose was deliberately skipped", () => {
    expect(aggregateDoseDay(2, 0, 2)).toBe("skipped");
    expect(aggregateDoseDay(1, 0, 1)).toBe("skipped");
  });

  it("is missed when nothing was resolved, or a skip left a real miss", () => {
    expect(aggregateDoseDay(2, 0, 0)).toBe("missed");
    // one skipped, one neither taken nor skipped → an unhandled miss remains
    expect(aggregateDoseDay(2, 0, 1)).toBe("missed");
  });
});

// Per-supplement windowed adherence strip (issue #313): compose isDueOn (per-date
// workout/situational context) with aggregateDoseDay over the supplement's doses.
describe("supplementAdherenceStrip", () => {
  function supp(over: Partial<Supplement> = {}): Supplement {
    return {
      condition: "daily" as SupplementCondition,
      situation: null,
      as_needed: 0,
      ...over,
    } as Supplement;
  }

  // Doses with no stored created_at: no known lifetime bound, so the whole window
  // is in scope. The lifetime clamp gets its own describe block below.
  const doses = (...ids: number[]) => ids.map((id) => ({ id }));
  const TZ = "UTC";

  it("exposes STRIP_DAYS = 14", () => {
    expect(STRIP_DAYS).toBe(14);
  });

  it("marks each date taken/partial/missed by aggregating the doses", () => {
    const dates = ["d0", "d1", "d2"];
    const takenByDose = indexTakenByDose([
      { dose_id: 1, date: "d0", status: "taken" },
      { dose_id: 2, date: "d0", status: "taken" }, // d0: both taken → taken
      { dose_id: 1, date: "d1", status: "taken" }, // d1: one of two → partial
      // d2: neither → missed
    ]);
    const strip = supplementAdherenceStrip(
      supp(),
      doses(1, 2),
      dates,
      new Set(),
      () => new Set(),
      takenByDose,
      TZ
    );
    expect(strip).toEqual([
      { date: "d0", state: "taken" },
      { date: "d1", state: "partial" },
      { date: "d2", state: "missed" },
    ]);
  });

  it("marks a date na when the supplement is not due (rest-day on a workout day)", () => {
    const strip = supplementAdherenceStrip(
      supp({ condition: "rest_day" as SupplementCondition }),
      doses(1),
      ["d0", "d1"],
      new Set(["d0"]), // d0 was a workout day → rest_day supp not due
      () => new Set(),
      indexTakenByDose([{ dose_id: 1, date: "d1", status: "taken" }]),
      TZ
    );
    expect(strip).toEqual([
      { date: "d0", state: "na" },
      { date: "d1", state: "taken" },
    ]);
  });

  it("marks a deliberately-skipped day skipped, not missed (#232)", () => {
    const strip = supplementAdherenceStrip(
      supp(),
      doses(1),
      ["d0"],
      new Set(),
      () => new Set(),
      indexTakenByDose([{ dose_id: 1, date: "d0", status: "skipped" }]),
      TZ
    );
    expect(strip).toEqual([{ date: "d0", state: "skipped" }]);
  });

  it("respects the per-day situation resolver for a situational supplement", () => {
    const dates = ["d0", "d1"];
    const s = supp({
      condition: "situational" as SupplementCondition,
      situation: "travel",
    });
    // An always-active resolver makes every date due.
    const active = supplementAdherenceStrip(
      s,
      doses(1),
      dates,
      new Set(),
      () => new Set(["travel"]),
      indexTakenByDose([{ dose_id: 1, date: "d0", status: "taken" }]),
      TZ
    );
    expect(active.map((d) => d.state)).toEqual(["taken", "missed"]);

    const inactive = supplementAdherenceStrip(
      s,
      doses(1),
      dates,
      new Set(),
      () => new Set(),
      indexTakenByDose([]),
      TZ
    );
    expect(inactive.map((d) => d.state)).toEqual(["na", "na"]);
  });

  it("scores each day against the situation set active THAT day (#654)", () => {
    const dates = ["d0", "d1", "d2"];
    const s = supp({
      condition: "situational" as SupplementCondition,
      situation: "travel",
    });
    // Travel turned on only on d2 — a per-day resolver keeps d0/d1 "na" even though
    // the situation is active "now", instead of retroactively marking them missed.
    const situationsOn = (date: string) =>
      date >= "d2" ? new Set(["travel"]) : new Set<string>();
    const strip = supplementAdherenceStrip(
      s,
      doses(1),
      dates,
      new Set(),
      situationsOn,
      indexTakenByDose([]),
      TZ
    );
    expect(strip.map((d) => d.state)).toEqual(["na", "na", "missed"]);
  });

  it("feeds adherenceSummary end-to-end", () => {
    const dates = ["d0", "d1", "d2"];
    const strip = supplementAdherenceStrip(
      supp(),
      doses(1),
      dates,
      new Set(),
      () => new Set(),
      indexTakenByDose([
        { dose_id: 1, date: "d0", status: "taken" },
        { dose_id: 1, date: "d1", status: "taken" },
        // d2 = today, not logged → pending
      ]),
      TZ
    );
    const r = adherenceSummary(strip);
    expect(r.streak).toBe(2);
    expect(r.pct).toBe(100);
  });
});

// The cold-start boundary (#1442). A quick-added medication read "0% adherence"
// seconds after it was created: the fixed 14-day lookback scored thirteen days on
// which the item did not exist as outright misses. The distinction the whole fix
// turns on is "no applicable dose-slot has elapsed yet" (no history — pct null)
// versus "slots elapsed and none were taken" (an honest 0%), and BOTH halves are
// pinned here, because a clamp that swallows the genuine zero is just as wrong.
describe("dose-lifetime clamp / the no-history boundary (#1442)", () => {
  const TZ = "UTC";
  const DATES = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"];
  // The window's last day is "today" — adherenceSummary treats a trailing miss on it
  // as still-pending, so a slot must have elapsed on an EARLIER day to count.
  const TODAY = DATES[DATES.length - 1];

  function med(createdAt: string): Supplement {
    return {
      id: 1,
      name: "Ibuprofen (test)",
      condition: "daily" as SupplementCondition,
      situation: null,
      as_needed: 0,
      created_at: createdAt,
    } as Supplement;
  }

  const build = (
    supp: Supplement,
    doses: { id: number; created_at?: string | null }[],
    logs: { dose_id: number; date: string; status?: "taken" | "skipped" }[] = []
  ) =>
    supplementAdherenceStrip(
      supp,
      doses,
      DATES,
      new Set(),
      () => new Set(),
      indexTakenByDose(logs),
      TZ
    );

  describe("doseExistsSince", () => {
    it("takes the later of the item's and the dose's creation day", () => {
      expect(
        doseExistsSince("2026-07-20 08:00:00", "2026-07-22 09:30:00", TZ)
      ).toBe("2026-07-22");
      // A dose can't predate its item; the item's day wins if it is later.
      expect(
        doseExistsSince("2026-07-22 08:00:00", "2026-07-20 09:30:00", TZ)
      ).toBe("2026-07-22");
    });

    it("falls back to whichever timestamp is stored, else null (no bound)", () => {
      expect(doseExistsSince("2026-07-22 08:00:00", null, TZ)).toBe(
        "2026-07-22"
      );
      expect(doseExistsSince(null, "2026-07-22 08:00:00", TZ)).toBe(
        "2026-07-22"
      );
      expect(doseExistsSince(null, null, TZ)).toBeNull();
    });

    it("resolves the UTC timestamp onto the PROFILE's calendar day", () => {
      // 23:00 UTC is already the next morning in Tokyo and still the same
      // afternoon in Los Angeles. Slicing the raw UTC string would put a Tokyo
      // user's brand-new item on "yesterday" and hand the strip a phantom miss.
      const at = "2026-07-22 23:00:00";
      expect(doseExistsSince(at, at, "Asia/Tokyo")).toBe("2026-07-23");
      expect(doseExistsSince(at, at, "America/Los_Angeles")).toBe("2026-07-22");
      expect(doseExistsSince(at, at, "UTC")).toBe("2026-07-22");
    });
  });

  it("no elapsed slot yet: a med added moments ago reports no history, not 0%", () => {
    const createdToday = `${TODAY} 09:15:00`;
    const s = build(med(createdToday), [{ id: 1, created_at: createdToday }]);
    // Every prior day is outside the item's lifetime; today is still pending.
    expect(s.map((d) => d.state)).toEqual(["na", "na", "na", "missed"]);
    const r = adherenceSummary(s);
    expect(r.applicableDays).toBe(0);
    expect(r.pct).toBeNull(); // the card hides the line rather than printing 0%
    expect(r.streak).toBe(0);
  });

  it("one elapsed slot, unconfirmed: a real 0% survives the clamp", () => {
    // Added yesterday and not taken — a settled, genuinely missed day.
    const created = `${DATES[2]} 08:00:00`;
    const s = build(med(created), [{ id: 1, created_at: created }]);
    expect(s.map((d) => d.state)).toEqual(["na", "na", "missed", "missed"]);
    const r = adherenceSummary(s);
    expect(r.applicableDays).toBe(1);
    expect(r.pct).toBe(0);
  });

  it("keeps a full honest 0% for a week of elapsed, untaken slots", () => {
    const s = build(med("2026-01-04 08:00:00"), [
      { id: 1, created_at: "2026-01-04 08:00:00" },
    ]);
    expect(s.map((d) => d.state)).toEqual([
      "missed",
      "missed",
      "missed",
      "missed",
    ]);
    expect(adherenceSummary(s).pct).toBe(0);
  });

  it("an item with no live dose row has nothing to miss (na, not 0%)", () => {
    // The only dose was retired, so the current schedule is empty. Previously
    // aggregateDoseDay's max(total, 1) floor scored every due day as missed.
    const s = build(med("2026-01-04 08:00:00"), []);
    expect(s.map((d) => d.state)).toEqual(["na", "na", "na", "na"]);
    expect(adherenceSummary(s).pct).toBeNull();
  });

  it("scores each day against only the doses that existed on it", () => {
    // A second dose added on d2: d0/d1 are a one-dose day (fully taken → taken),
    // and only d2 onward is judged against both.
    const created = "2026-01-04 08:00:00";
    const s = build(
      med(created),
      [
        { id: 1, created_at: created },
        { id: 2, created_at: `${DATES[2]} 07:00:00` },
      ],
      [
        { dose_id: 1, date: DATES[0], status: "taken" },
        { dose_id: 1, date: DATES[1], status: "taken" },
        { dose_id: 1, date: DATES[2], status: "taken" },
      ]
    );
    expect(s.map((d) => d.state)).toEqual([
      "taken",
      "taken",
      "partial", // dose 2 now exists and wasn't taken
      "missed",
    ]);
  });

  it("a schedule re-time does NOT erase the days the dose was really taken", () => {
    // doseExistsSince deliberately ignores updated_at (unlike doseAdherenceSince,
    // whose pattern window restarts at a re-time) — a history percentage must keep
    // showing follow-through logged while the dose sat in its old slot.
    const created = "2026-01-04 08:00:00";
    const s = build(
      med(created),
      // updated_at is not part of the existence bound; passing only created_at is
      // the whole point — the strip never sees a re-time.
      [{ id: 1, created_at: created }],
      DATES.map((date) => ({ dose_id: 1, date, status: "taken" as const }))
    );
    expect(s.every((d) => d.state === "taken")).toBe(true);
    expect(adherenceSummary(s).pct).toBe(100);
  });

  it("keeps a deliberate skip visible on a brand-new item (never a phantom miss)", () => {
    const created = `${DATES[2]} 08:00:00`;
    const s = build(
      med(created),
      [{ id: 1, created_at: created }],
      [{ dose_id: 1, date: DATES[2], status: "skipped" }]
    );
    expect(s.map((d) => d.state)).toEqual(["na", "na", "skipped", "missed"]);
    const r = adherenceSummary(s);
    expect(r.pct).toBeNull(); // a skip is a decision, not a due day
    expect(r.skippedDays).toBe(1);
  });

  describe("doseWindowSince: logged history widens the bound", () => {
    const dates = (...ds: string[]) => ({
      taken: new Set(ds),
      skipped: new Set<string>(),
    });

    it("extends back to the earliest log when it predates created_at", () => {
      // A med reconciled off an imported document: the row was WRITTEN today but
      // carries weeks of real adherence. A log is proof the dose existed that day,
      // so the history the user actually has must not be clamped away.
      expect(
        doseWindowSince(
          "2026-07-22 09:00:00",
          "2026-07-22 09:00:00",
          dates("2026-07-10", "2026-07-14"),
          TZ
        )
      ).toBe("2026-07-10");
    });

    it("counts a deliberate skip as existence evidence too", () => {
      expect(
        doseWindowSince(
          "2026-07-22 09:00:00",
          null,
          { taken: new Set<string>(), skipped: new Set(["2026-07-11"]) },
          TZ
        )
      ).toBe("2026-07-11");
    });

    it("never moves the bound FORWARD past the creation day", () => {
      expect(
        doseWindowSince("2026-07-10 09:00:00", null, dates("2026-07-20"), TZ)
      ).toBe("2026-07-10");
    });

    it("leaves the cold start alone: no logs, no widening", () => {
      expect(doseWindowSince("2026-07-22 09:00:00", null, undefined, TZ)).toBe(
        "2026-07-22"
      );
      expect(doseWindowSince(null, null, dates("2026-07-01"), TZ)).toBeNull();
    });

    it("keeps a backfilled history visible on the strip", () => {
      // Created today, but every prior day in the window is logged taken — the
      // percentage must read 100%, not "no history".
      const created = `${TODAY} 09:00:00`;
      const s = build(
        med(created),
        [{ id: 1, created_at: created }],
        DATES.slice(0, 3).map((date) => ({
          dose_id: 1,
          date,
          status: "taken" as const,
        }))
      );
      expect(s.map((d) => d.state)).toEqual([
        "taken",
        "taken",
        "taken",
        "missed",
      ]);
      expect(adherenceSummary(s).pct).toBe(100);
    });
  });

  it("leaves an unbounded (timestamp-less) item scoring the whole window", () => {
    // Backward compatibility: no stored lifetime → no clamp, the pre-#1442 shape.
    const s = build(
      {
        ...med("2026-01-04 08:00:00"),
        created_at: null,
      } as unknown as Supplement,
      [{ id: 1 }]
    );
    expect(s.map((d) => d.state)).toEqual([
      "missed",
      "missed",
      "missed",
      "missed",
    ]);
  });
});
