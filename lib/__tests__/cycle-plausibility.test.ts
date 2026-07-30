import { describe, it, expect } from "vitest";
import {
  REOPEN_PERIOD_MAX_AGE_DAYS,
  canReopenLastPeriodOn,
  canStartPeriodOn,
  checkPeriodWrite,
  cycleControlState,
  cycleRefusalMessage,
  cycleStateLine,
  lastEndedPeriodIn,
  openPeriodIn,
} from "@/lib/cycle-plausibility";
import { MIN_PLAUSIBLE_PERIOD_GAP_DAYS, type CyclePeriod } from "@/lib/cycle";

// Pure-tier: the cycle plausibility guards (#1681 quick-action offer conditions, #1682
// write refusals). No DB, no clock — every function takes the profile's own `today`.
// These are the predicates BOTH the surface and the write core read, so their boundaries
// are pinned here once.

function period(id: number, start: string, end: string | null): CyclePeriod {
  return { id, period_start: start, period_end: end, flow: null, note: null };
}

const TODAY = "2026-04-20";

describe("openPeriodIn / lastEndedPeriodIn", () => {
  it("picks the latest-started open period and the latest-ended closed one", () => {
    const rows = [
      period(1, "2026-02-01", "2026-02-05"),
      period(2, "2026-03-01", "2026-03-06"),
      period(3, "2026-04-01", null),
    ];
    expect(openPeriodIn(rows)?.id).toBe(3);
    expect(lastEndedPeriodIn(rows)?.id).toBe(2);
  });

  it("returns null when there is nothing of that kind", () => {
    expect(openPeriodIn([period(1, "2026-02-01", "2026-02-05")])).toBeNull();
    expect(lastEndedPeriodIn([period(1, "2026-04-01", null)])).toBeNull();
  });
});

describe("canStartPeriodOn (#1681 bug 2 — the plausible gap)", () => {
  it("offers the start with NO history at all", () => {
    expect(canStartPeriodOn([], TODAY)).toBe(true);
  });

  it("never offers the start while a period is open", () => {
    expect(canStartPeriodOn([period(1, "2026-04-18", null)], TODAY)).toBe(
      false
    );
  });

  it("refuses the day a period ends — the back-to-back case the bug created", () => {
    const sameDay = [period(1, "2026-04-16", TODAY)];
    expect(canStartPeriodOn(sameDay, TODAY)).toBe(false);
  });

  it("is false one day below the gap and true exactly at it", () => {
    expect(MIN_PLAUSIBLE_PERIOD_GAP_DAYS).toBe(10);
    // Ends 04-11 → gap 9 on 04-20.
    expect(
      canStartPeriodOn([period(1, "2026-04-07", "2026-04-11")], TODAY)
    ).toBe(false);
    // Ends 04-10 → gap 10 on 04-20.
    expect(
      canStartPeriodOn([period(1, "2026-04-06", "2026-04-10")], TODAY)
    ).toBe(true);
  });

  it("measures the gap from the LATEST end, not the latest start", () => {
    const rows = [
      period(1, "2026-01-01", "2026-01-05"),
      period(2, "2026-04-14", "2026-04-18"), // recent → still too soon
    ];
    expect(canStartPeriodOn(rows, TODAY)).toBe(false);
  });
});

describe("canReopenLastPeriodOn (#1681 bug 3 — the recovery window)", () => {
  it("offers the reopen inside the window and refuses outside it", () => {
    expect(REOPEN_PERIOD_MAX_AGE_DAYS).toBe(3);
    const endedToday = [period(1, "2026-04-16", TODAY)];
    expect(canReopenLastPeriodOn(endedToday, TODAY)).toBe(true);
    // Boundary: exactly REOPEN_PERIOD_MAX_AGE_DAYS days ago is still repairable.
    expect(
      canReopenLastPeriodOn([period(1, "2026-04-13", "2026-04-17")], TODAY)
    ).toBe(true);
    // One day beyond — the dated form owns that edit; the tap can't merge two cycles.
    expect(
      canReopenLastPeriodOn([period(1, "2026-04-12", "2026-04-16")], TODAY)
    ).toBe(false);
  });

  it("refuses with nothing closed, or while a period is open", () => {
    expect(canReopenLastPeriodOn([], TODAY)).toBe(false);
    expect(canReopenLastPeriodOn([period(1, "2026-04-19", null)], TODAY)).toBe(
      false
    );
  });
});

describe("cycleStateLine / cycleControlState (#1681 — the contextual state)", () => {
  it("is null before any recorded period", () => {
    expect(cycleStateLine([], TODAY)).toBeNull();
  });

  it("formats cycle day and phase for a mid-cycle day", () => {
    // Started 04-15 → day 6 on 04-20, ended 04-19 → follicular.
    expect(cycleStateLine([period(1, "2026-04-15", "2026-04-19")], TODAY)).toBe(
      "Day 6 · Follicular"
    );
  });

  it("reads menstrual while a period is open", () => {
    expect(cycleStateLine([period(1, "2026-04-18", null)], TODAY)).toBe(
      "Day 3 · Menstrual"
    );
  });

  it("open period: the end action is the only one offered", () => {
    const s = cycleControlState([period(1, "2026-04-18", null)], TODAY);
    expect(s.openPeriodId).toBe(1);
    expect(s.staleOpenPeriod).toBe(false);
    expect(s.canStart).toBe(false);
    expect(s.canReopen).toBe(false);
  });

  it("just ended: state line + reopen, and NO start CTA", () => {
    const s = cycleControlState([period(1, "2026-04-16", TODAY)], TODAY);
    expect(s.openPeriodId).toBeNull();
    // The end is INCLUSIVE, so the day it ends is still a bleeding day.
    expect(s.stateLine).toBe("Day 5 · Menstrual");
    expect(s.canStart).toBe(false);
    expect(s.canReopen).toBe(true);
  });

  it("mid-cycle: the start CTA returns and the reopen has expired", () => {
    const s = cycleControlState([period(1, "2026-04-01", "2026-04-05")], TODAY);
    expect(s.canStart).toBe(true);
    expect(s.canReopen).toBe(false);
    expect(s.stateLine).toBe("Day 20 · Follicular");
  });

  it("stale open period: flagged, and the phase has already stopped claiming menstrual", () => {
    const s = cycleControlState([period(1, "2026-04-05", null)], TODAY);
    expect(s.staleOpenPeriod).toBe(true);
    expect(s.stateLine).toBe("Day 16 · Follicular");
  });
});

describe("checkPeriodWrite (#1682 c/d — refusals that name their conflict)", () => {
  const existing = [
    period(1, "2026-01-01", "2026-01-10"),
    period(2, "2026-02-01", "2026-02-05"),
  ];

  it("allows a plausible new period", () => {
    expect(
      checkPeriodWrite(
        { id: null, start: "2026-03-01", end: "2026-03-05" },
        existing,
        TODAY
      )
    ).toBeNull();
  });

  it("refuses a future start and a future end at the today boundary", () => {
    expect(
      checkPeriodWrite({ id: null, start: TODAY, end: TODAY }, [], TODAY)
    ).toBeNull(); // today itself is fine
    expect(
      checkPeriodWrite({ id: null, start: "2026-04-21", end: null }, [], TODAY)
    ).toEqual({ kind: "future-start" });
    expect(
      checkPeriodWrite(
        { id: null, start: "2026-04-19", end: "2026-04-21" },
        [],
        TODAY
      )
    ).toEqual({ kind: "future-end" });
  });

  it("leaves arbitrarily old backfill alone", () => {
    expect(
      checkPeriodWrite(
        { id: null, start: "2011-06-01", end: "2011-06-05" },
        existing,
        TODAY
      )
    ).toBeNull();
  });

  it("refuses an end before the start", () => {
    expect(
      checkPeriodWrite(
        { id: null, start: "2026-03-10", end: "2026-03-01" },
        [],
        TODAY
      )
    ).toEqual({ kind: "end-before-start" });
  });

  it("refuses a SECOND open period, naming the one already open", () => {
    const open = [...existing, period(3, "2026-04-18", null)];
    const r = checkPeriodWrite(
      { id: null, start: "2026-04-19", end: null },
      open,
      TODAY
    );
    expect(r?.kind).toBe("second-open");
    expect(cycleRefusalMessage(r!)).toMatch(
      /already open \(2026-04-18 – ongoing\)/
    );
  });

  it("detects overlap, containment, and leaves touching ranges alone", () => {
    // Contained inside Jan 1–10.
    expect(
      checkPeriodWrite(
        { id: null, start: "2026-01-05", end: "2026-01-08" },
        existing,
        TODAY
      )
    ).toMatchObject({ kind: "overlap", conflict: { id: 1 } });
    // Straddling the start.
    expect(
      checkPeriodWrite(
        { id: null, start: "2025-12-28", end: "2026-01-02" },
        existing,
        TODAY
      )
    ).toMatchObject({ kind: "overlap", conflict: { id: 1 } });
    // Touching but NOT overlapping: starts the day after Jan 10 ends.
    expect(
      checkPeriodWrite(
        { id: null, start: "2026-01-11", end: "2026-01-15" },
        existing,
        TODAY
      )
    ).toBeNull();
    // Touching on the other side: ends the day before Feb 1 starts.
    expect(
      checkPeriodWrite(
        { id: null, start: "2026-01-20", end: "2026-01-31" },
        existing,
        TODAY
      )
    ).toBeNull();
  });

  it("names the conflicting period in the overlap message", () => {
    const r = checkPeriodWrite(
      { id: null, start: "2026-01-05", end: "2026-01-08" },
      existing,
      TODAY
    );
    expect(cycleRefusalMessage(r!)).toBe(
      "A period is already recorded 2026-01-01 – 2026-01-10. Adjust the dates so they don't overlap."
    );
  });

  it("an edit is never a conflict with itself, but IS refused when reordered into one", () => {
    // Re-saving row 2 unchanged.
    expect(
      checkPeriodWrite(
        { id: 2, start: "2026-02-01", end: "2026-02-05" },
        existing,
        TODAY
      )
    ).toBeNull();
    // Extending row 2's start back past row 1's end — an overlap it did not have before.
    expect(
      checkPeriodWrite(
        { id: 2, start: "2026-01-08", end: "2026-02-05" },
        existing,
        TODAY
      )
    ).toMatchObject({ kind: "overlap", conflict: { id: 1 } });
  });

  it("an OPEN candidate that would swallow a later period is an overlap", () => {
    const rows = [period(1, "2026-03-01", "2026-03-05")];
    expect(
      checkPeriodWrite(
        { id: null, start: "2026-02-20", end: null },
        rows,
        TODAY
      )
    ).toMatchObject({ kind: "overlap", conflict: { id: 1 } });
  });
});
