import { describe, it, expect } from "vitest";
import {
  summarizeSync,
  dateWindow,
  formatWindow,
  currentlyFailingProviders,
  emptyCounts,
  foldCounts,
  summarizeSplit,
  formatSplitLabel,
  rowsEqual,
  isEditLocked,
  isNoOpSyncEvent,
  shouldShowConnectedSource,
} from "@/lib/integrations/sync-log";

describe("isEditLocked", () => {
  it("treats a set flag (1) as locked", () => {
    expect(isEditLocked(1)).toBe(true);
  });
  it("treats 0 / null / undefined as unlocked", () => {
    expect(isEditLocked(0)).toBe(false);
    expect(isEditLocked(null)).toBe(false);
    expect(isEditLocked(undefined)).toBe(false);
  });
});

describe("summarizeSync", () => {
  it("splits received into written + skipped", () => {
    expect(summarizeSync(7, 3)).toEqual({
      received: 10,
      written: 7,
      skipped: 3,
    });
  });

  it("handles an all-persisted batch (nothing skipped)", () => {
    expect(summarizeSync(5, 0)).toEqual({
      received: 5,
      written: 5,
      skipped: 0,
    });
  });

  it("handles a batch where every row was skipped (nothing written)", () => {
    expect(summarizeSync(0, 12)).toEqual({
      received: 12,
      written: 0,
      skipped: 12,
    });
  });

  it("clamps negatives to zero and rounds fractional inputs", () => {
    expect(summarizeSync(-4, -1)).toEqual({
      received: 0,
      written: 0,
      skipped: 0,
    });
    expect(summarizeSync(2.4, 1.6)).toEqual({
      received: 4,
      written: 2,
      skipped: 2,
    });
  });
});

describe("foldCounts", () => {
  it("returns an all-zero total for no parts", () => {
    expect(foldCounts([])).toEqual(emptyCounts());
    expect(emptyCounts()).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
  });

  it("sums each field across parts", () => {
    expect(
      foldCounts([
        { inserted: 3, updated: 1, unchanged: 5 },
        { inserted: 0, updated: 2, unchanged: 4 },
        { inserted: 1, updated: 0, unchanged: 0 },
      ])
    ).toEqual({ inserted: 4, updated: 3, unchanged: 9 });
  });
});

describe("summarizeSplit", () => {
  it("derives received as inserted + updated + unchanged + skipped", () => {
    expect(
      summarizeSplit({ inserted: 3, updated: 2, unchanged: 5 }, 4)
    ).toEqual({
      inserted: 3,
      updated: 2,
      unchanged: 5,
      skipped: 4,
      received: 14,
    });
  });

  it("handles an all-unchanged batch (received still counts the unchanged rows)", () => {
    expect(
      summarizeSplit({ inserted: 0, updated: 0, unchanged: 6 }, 0)
    ).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 6,
      skipped: 0,
      received: 6,
    });
  });

  it("clamps negatives to zero and rounds fractional inputs", () => {
    expect(
      summarizeSplit({ inserted: -1, updated: 2.4, unchanged: 1.6 }, -3)
    ).toEqual({
      inserted: 0,
      updated: 2,
      unchanged: 2,
      skipped: 0,
      received: 4,
    });
  });
});

describe("formatSplitLabel", () => {
  it("lists every non-zero segment when the split is present", () => {
    expect(
      formatSplitLabel({
        inserted: 3,
        updated: 2,
        unchanged: 5,
        written: 10,
      })
    ).toEqual({ primary: "3 new · 2 changed · 5 unchanged", muted: false });
  });

  it("omits zero segments", () => {
    expect(
      formatSplitLabel({ inserted: 4, updated: 0, unchanged: 0, written: 4 })
    ).toEqual({ primary: "4 new", muted: false });
    expect(
      formatSplitLabel({ inserted: 0, updated: 1, unchanged: 3, written: 4 })
    ).toEqual({ primary: "1 changed · 3 unchanged", muted: false });
  });

  it("collapses an all-unchanged batch to a muted 'nothing new'", () => {
    expect(
      formatSplitLabel({ inserted: 0, updated: 0, unchanged: 7, written: 7 })
    ).toEqual({ primary: "nothing new", muted: true });
    // Also when the whole batch was empty.
    expect(
      formatSplitLabel({ inserted: 0, updated: 0, unchanged: 0, written: 0 })
    ).toEqual({ primary: "nothing new", muted: true });
  });

  it("falls back to the flat written count on a legacy (all-null-split) event", () => {
    expect(
      formatSplitLabel({
        inserted: null,
        updated: null,
        unchanged: null,
        written: 5,
      })
    ).toEqual({ primary: "5 records", muted: false });
    expect(
      formatSplitLabel({
        inserted: null,
        updated: null,
        unchanged: null,
        written: 1,
      })
    ).toEqual({ primary: "1 record", muted: false });
    expect(
      formatSplitLabel({
        inserted: null,
        updated: null,
        unchanged: null,
        written: null,
      })
    ).toEqual({ primary: "0 records", muted: false });
  });
});

describe("rowsEqual", () => {
  it("is true when every compared column matches", () => {
    expect(rowsEqual(["a", "b"], { a: 1, b: "x" }, { a: 1, b: "x" })).toBe(
      true
    );
  });

  it("treats null and undefined (missing) as equal", () => {
    expect(rowsEqual(["a"], { a: null }, {})).toBe(true);
    expect(rowsEqual(["a"], { a: undefined }, { a: null })).toBe(true);
  });

  it("is false when any compared column differs and ignores uncompared columns", () => {
    expect(rowsEqual(["a"], { a: 1 }, { a: 2 })).toBe(false);
    // `b` differs but isn't in the compared set → still equal.
    expect(rowsEqual(["a"], { a: 1, b: 9 }, { a: 1, b: 8 })).toBe(true);
  });
});

describe("dateWindow", () => {
  it("returns nulls for an empty / all-blank list", () => {
    expect(dateWindow([])).toEqual({ start: null, end: null });
    expect(dateWindow([null, undefined, ""])).toEqual({
      start: null,
      end: null,
    });
  });

  it("returns min/max across an unsorted list, ignoring blanks", () => {
    expect(
      dateWindow(["2024-03-02", null, "2024-03-01", "2024-03-05", ""])
    ).toEqual({ start: "2024-03-01", end: "2024-03-05" });
  });

  it("collapses a single date to start === end", () => {
    expect(dateWindow(["2024-06-01"])).toEqual({
      start: "2024-06-01",
      end: "2024-06-01",
    });
  });
});

describe("formatWindow", () => {
  it("renders an em dash when there is no window", () => {
    expect(formatWindow(null, null)).toBe("—");
  });

  it("renders a single date when start === end (or only one side)", () => {
    expect(formatWindow("2024-06-01", "2024-06-01")).toBe("2024-06-01");
    expect(formatWindow("2024-06-01", null)).toBe("2024-06-01");
    expect(formatWindow(null, "2024-06-02")).toBe("2024-06-02");
  });

  it("renders a range when start !== end", () => {
    expect(formatWindow("2024-06-01", "2024-06-03")).toBe(
      "2024-06-01 → 2024-06-03"
    );
  });
});

describe("isNoOpSyncEvent", () => {
  it("is true for a successful all-unchanged re-scan (0 inserted, 0 updated)", () => {
    expect(
      isNoOpSyncEvent({ ok: 1, inserted: 0, updated: 0, unchanged: 6 })
    ).toBe(true);
  });

  it("is true for a wholly empty successful sync (0/0/0)", () => {
    expect(
      isNoOpSyncEvent({ ok: 1, inserted: 0, updated: 0, unchanged: 0 })
    ).toBe(true);
  });

  it("is false when anything was inserted or updated", () => {
    expect(
      isNoOpSyncEvent({ ok: 1, inserted: 3, updated: 0, unchanged: 0 })
    ).toBe(false);
    expect(
      isNoOpSyncEvent({ ok: 1, inserted: 0, updated: 2, unchanged: 5 })
    ).toBe(false);
  });

  it("is false for a FAILURE even with an empty split (a failure is always signal)", () => {
    expect(
      isNoOpSyncEvent({ ok: 0, inserted: 0, updated: 0, unchanged: 0 })
    ).toBe(false);
    expect(
      isNoOpSyncEvent({ ok: 0, inserted: null, updated: null, unchanged: null })
    ).toBe(false);
  });

  it("is false for a legacy event whose split columns are all null (kept visible)", () => {
    expect(
      isNoOpSyncEvent({ ok: 1, inserted: null, updated: null, unchanged: null })
    ).toBe(false);
  });
});

describe("currentlyFailingProviders", () => {
  // Events are newest-first, as the queries return them.
  it("returns providers whose most-recent event is a failure", () => {
    const events = [
      { provider: "strava", ok: 0 }, // strava currently broken
      { provider: "health-connect", ok: 1 }, // HC currently fine
      { provider: "strava", ok: 1 }, // older strava success — ignored
    ];
    expect(currentlyFailingProviders(events)).toEqual([
      { provider: "strava", ok: 0 },
    ]);
  });

  it("clears a provider once its latest event succeeds", () => {
    const events = [
      { provider: "strava", ok: 1 }, // recovered
      { provider: "strava", ok: 0 }, // earlier failure — superseded
    ];
    expect(currentlyFailingProviders(events)).toEqual([]);
  });

  it("keeps only the newest event per failing provider", () => {
    const events = [
      { provider: "strava", ok: 0, id: 2 },
      { provider: "strava", ok: 0, id: 1 },
    ];
    expect(currentlyFailingProviders(events)).toEqual([
      { provider: "strava", ok: 0, id: 2 },
    ]);
  });

  it("returns an empty array when there are no events", () => {
    expect(currentlyFailingProviders([])).toEqual([]);
  });
});

describe("shouldShowConnectedSource", () => {
  it("shows a currently-connected source with no history yet", () => {
    // Just connected, no sync landed — still belongs in the section.
    expect(
      shouldShowConnectedSource({ connected: true, hasHistory: false })
    ).toBe(true);
  });

  it("shows a connected source that also has history", () => {
    expect(
      shouldShowConnectedSource({ connected: true, hasHistory: true })
    ).toBe(true);
  });

  it("shows a disconnected source that still has historical logs (Reconnect case)", () => {
    // Was connected, later removed: keep its logs visible with a Reconnect link.
    expect(
      shouldShowConnectedSource({ connected: false, hasHistory: true })
    ).toBe(true);
  });

  it("hides a source that was never set up (not connected, no history)", () => {
    expect(
      shouldShowConnectedSource({ connected: false, hasHistory: false })
    ).toBe(false);
  });
});
