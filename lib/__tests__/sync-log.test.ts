import { describe, it, expect } from "vitest";
import {
  summarizeSync,
  dateWindow,
  formatWindow,
  currentlyFailingProviders,
  latestEventPerProvider,
  emptyCounts,
  foldCounts,
  summarizeSplit,
  formatSplitLabel,
  rowsEqual,
  isEditLocked,
  isNoOpSyncEvent,
  shouldShowConnectedSource,
  planSyncEventPrune,
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
    expect(emptyCounts()).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
  });

  it("sums each field across parts", () => {
    expect(
      foldCounts([
        { inserted: 3, updated: 1, unchanged: 5, suppressed: 1, edited: 2 },
        { inserted: 0, updated: 2, unchanged: 4, suppressed: 0, edited: 0 },
        { inserted: 1, updated: 0, unchanged: 0, suppressed: 2, edited: 1 },
      ])
    ).toEqual({
      inserted: 4,
      updated: 3,
      unchanged: 9,
      suppressed: 3,
      edited: 3,
    });
  });
});

describe("summarizeSplit", () => {
  it("derives received as inserted + updated + unchanged + suppressed + edited + skipped", () => {
    expect(
      summarizeSplit(
        { inserted: 3, updated: 2, unchanged: 5, suppressed: 1, edited: 2 },
        4
      )
    ).toEqual({
      inserted: 3,
      updated: 2,
      unchanged: 5,
      suppressed: 1,
      edited: 2,
      skipped: 4,
      received: 17,
    });
  });

  it("handles an all-unchanged batch (received still counts the unchanged rows)", () => {
    expect(
      summarizeSplit(
        { inserted: 0, updated: 0, unchanged: 6, suppressed: 0, edited: 0 },
        0
      )
    ).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 6,
      suppressed: 0,
      edited: 0,
      skipped: 0,
      received: 6,
    });
  });

  it("counts tombstone-suppressed rows in received (no silent cap)", () => {
    expect(
      summarizeSplit(
        { inserted: 0, updated: 0, unchanged: 0, suppressed: 2, edited: 0 },
        0
      )
    ).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 2,
      edited: 0,
      skipped: 0,
      received: 2,
    });
  });

  it("counts edit-locked skips in received (no silent cap, #659)", () => {
    expect(
      summarizeSplit(
        { inserted: 0, updated: 0, unchanged: 0, suppressed: 0, edited: 3 },
        0
      )
    ).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 3,
      skipped: 0,
      received: 3,
    });
  });

  it("clamps negatives to zero and rounds fractional inputs", () => {
    expect(
      summarizeSplit(
        {
          inserted: -1,
          updated: 2.4,
          unchanged: 1.6,
          suppressed: -2,
          edited: 1.4,
        },
        -3
      )
    ).toEqual({
      inserted: 0,
      updated: 2,
      unchanged: 2,
      suppressed: 0,
      edited: 1,
      skipped: 0,
      received: 5,
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

  it("shows a suppressed segment, even when nothing else landed (#507)", () => {
    expect(
      formatSplitLabel({
        inserted: 0,
        updated: 0,
        unchanged: 0,
        written: 0,
        suppressed: 2,
      })
    ).toEqual({ primary: "2 suppressed", muted: false });
    expect(
      formatSplitLabel({
        inserted: 1,
        updated: 0,
        unchanged: 3,
        written: 1,
        suppressed: 1,
      })
    ).toEqual({ primary: "1 new · 3 unchanged · 1 suppressed", muted: false });
  });

  it("still collapses to 'nothing new' when suppressed is absent/zero", () => {
    expect(
      formatSplitLabel({
        inserted: 0,
        updated: 0,
        unchanged: 4,
        written: 4,
        suppressed: 0,
      })
    ).toEqual({ primary: "nothing new", muted: true });
  });

  it("shows an edited segment, even when nothing else landed (#659)", () => {
    expect(
      formatSplitLabel({
        inserted: 0,
        updated: 0,
        unchanged: 0,
        written: 0,
        edited: 2,
      })
    ).toEqual({ primary: "2 edited", muted: false });
    expect(
      formatSplitLabel({
        inserted: 1,
        updated: 0,
        unchanged: 3,
        written: 1,
        suppressed: 1,
        edited: 2,
      })
    ).toEqual({
      primary: "1 new · 3 unchanged · 1 suppressed · 2 edited",
      muted: false,
    });
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

  it("is NOT a no-op when the only activity was a suppressed or edit-locked skip", () => {
    // A tombstone blocked a resurrection (#507) — meaningful, must stay visible.
    expect(
      isNoOpSyncEvent({
        ok: 1,
        inserted: 0,
        updated: 0,
        unchanged: 3,
        suppressed: 2,
      })
    ).toBe(false);
    // An edit-lock held off an overwrite (#659) — likewise meaningful.
    expect(
      isNoOpSyncEvent({
        ok: 1,
        inserted: 0,
        updated: 0,
        unchanged: 3,
        edited: 1,
      })
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

  // A needs_reauth provider (issue #326) records an ok:0 sync event the moment its
  // token dies and the tick then stops re-syncing it, so its most-recent event stays
  // that failure — it must still be reported as currently failing when it's the
  // provider's latest event (issue #304's "compose" requirement).
  it("catches a needs_reauth provider whose latest event is the auth failure", () => {
    const events = [
      { provider: "health-connect", ok: 1 }, // chatty provider, currently fine
      { provider: "strava", ok: 0 }, // dead token → needs_reauth, latest is the failure
    ];
    expect(currentlyFailingProviders(events)).toEqual([
      { provider: "strava", ok: 0 },
    ]);
  });
});

describe("latestEventPerProvider", () => {
  // Events are newest-first, as the queries return them.
  it("keeps exactly one (the newest) event per provider", () => {
    const events = [
      { provider: "strava", ok: 0, id: 5 }, // newest strava
      { provider: "health-connect", ok: 1, id: 4 },
      { provider: "strava", ok: 1, id: 3 }, // older strava — dropped
      { provider: "health-connect", ok: 1, id: 2 }, // older HC — dropped
    ];
    expect(latestEventPerProvider(events)).toEqual([
      { provider: "strava", ok: 0, id: 5 },
      { provider: "health-connect", ok: 1, id: 4 },
    ]);
  });

  it("preserves newest-first order across providers", () => {
    const events = [
      { provider: "a", id: 3 },
      { provider: "b", id: 2 },
      { provider: "c", id: 1 },
    ];
    expect(latestEventPerProvider(events).map((e) => e.provider)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns an empty array when there are no events", () => {
    expect(latestEventPerProvider([])).toEqual([]);
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

describe("planSyncEventPrune", () => {
  // Structurally-typed events; `at` values are ISO strings ordered lexicographically.
  type Ev = { id: number; profile_id: number; provider: string; at: string };

  it("prunes events older than the cutoff", () => {
    const evs: Ev[] = [
      { id: 1, profile_id: 1, provider: "strava", at: "2024-01-01" },
      { id: 2, profile_id: 1, provider: "strava", at: "2024-02-01" },
      { id: 3, profile_id: 1, provider: "strava", at: "2024-03-01" },
    ];
    // cutoff 2024-02-15: id 1 old, id 2 old but newest? no — id 3 is newest and kept.
    // id 2 (2024-02-01) is < cutoff and not newest → pruned. id 1 likewise.
    expect(planSyncEventPrune(evs, "2024-02-15")).toEqual([1, 2]);
  });

  it("always keeps the newest event per (profile, provider) even when it's ancient", () => {
    const evs: Ev[] = [
      { id: 1, profile_id: 1, provider: "strava", at: "2020-01-01" },
    ];
    // The only event is old but is the newest for its provider → kept.
    expect(planSyncEventPrune(evs, "2024-01-01")).toEqual([]);
  });

  it("keeps newest-per-provider independently across providers and profiles", () => {
    const evs: Ev[] = [
      { id: 1, profile_id: 1, provider: "strava", at: "2020-01-01" },
      { id: 2, profile_id: 1, provider: "strava", at: "2020-02-01" }, // newest strava/p1
      { id: 3, profile_id: 1, provider: "oura", at: "2020-01-15" }, // newest oura/p1
      { id: 4, profile_id: 2, provider: "strava", at: "2020-01-20" }, // newest strava/p2
    ];
    // cutoff far in the future → everything is "old"; only the newest per key survives.
    expect(planSyncEventPrune(evs, "2099-01-01")).toEqual([1]);
  });

  it("keeps events at or after the cutoff (strictly-older only)", () => {
    const evs: Ev[] = [
      { id: 1, profile_id: 1, provider: "strava", at: "2024-01-01" }, // newest → kept
      { id: 2, profile_id: 1, provider: "oura", at: "2024-02-01" }, // == cutoff → kept
      { id: 3, profile_id: 1, provider: "oura", at: "2024-02-05" }, // newest oura → kept
    ];
    expect(planSyncEventPrune(evs, "2024-02-01")).toEqual([]);
  });

  it("returns [] for no events", () => {
    expect(planSyncEventPrune([], "2024-01-01")).toEqual([]);
  });

  it("returns prunable ids sorted ascending", () => {
    const evs: Ev[] = [
      { id: 5, profile_id: 1, provider: "strava", at: "2020-05-01" },
      { id: 2, profile_id: 1, provider: "strava", at: "2020-02-01" },
      { id: 9, profile_id: 1, provider: "strava", at: "2020-09-01" }, // newest → kept
      { id: 1, profile_id: 1, provider: "strava", at: "2020-01-01" },
    ];
    expect(planSyncEventPrune(evs, "2099-01-01")).toEqual([1, 2, 5]);
  });
});
