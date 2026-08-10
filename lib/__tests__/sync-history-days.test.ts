// PURE TIER — the day-grouping / collapse decision, and the drill-in's three
// coverage cases (#1991).
//
// The history was an append-only per-run log. For a source that fires ~70×/day that
// is not a log, it is noise with an anomaly hidden in it. These pin the rule that
// turns it back into information: one line per day, itemizing only what earns it.

import { describe, it, expect } from "vitest";
import {
  drilldownCoverage,
  drilldownRemainderLabel,
  failureRunReason,
  groupSyncDays,
  notableReason,
  syncDayAttention,
  syncDayLabel,
  syncEventDay,
  syncRangeLabel,
} from "@/lib/integrations/sync-history-days";
import { truncatedSyncDetails } from "@/lib/integrations/sync-details";
import type { SyncEventFacts } from "@/lib/integrations/provider-state";

let nextId = 1;

function ev(over: Partial<SyncEventFacts> & { at: string }): SyncEventFacts {
  return {
    id: nextId++,
    ok: 1,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    written: 0,
    skipped: 0,
    ...over,
  };
}

// A routine hourly push: the rolling window re-sent, nothing new.
function routine(at: string, inserted = 0): SyncEventFacts {
  return ev({ at, inserted, unchanged: 73 });
}

describe("a day is the reader's day", () => {
  it("groups by the profile's local date, not the stored UTC one", () => {
    // 23:30 UTC is already the next morning in UTC+13 and still the same evening in
    // UTC−10. A UTC slice would put the push on the wrong side of midnight for both.
    expect(syncEventDay("2026-08-04 23:30:00", "Etc/GMT-13")).toBe(
      "2026-08-05"
    );
    expect(syncEventDay("2026-08-04 23:30:00", "Etc/GMT+10")).toBe(
      "2026-08-04"
    );
    expect(syncEventDay("2026-08-04 23:30:00", "UTC")).toBe("2026-08-04");
  });
});

describe("what earns its own line", () => {
  it("names the anomalies, and only them", () => {
    expect(notableReason(ev({ at: "2026-08-04 10:00:00", ok: 0 }))).toBe(
      "failed"
    );
    expect(
      notableReason(
        ev({ at: "2026-08-04 10:00:00", details: truncatedSyncDetails() })
      )
    ).toBe("partial");
    expect(notableReason(ev({ at: "2026-08-04 10:00:00", skipped: 2 }))).toBe(
      "skipped"
    );
    expect(notableReason(routine("2026-08-04 10:00:00"))).toBeNull();
    // A run that WROTE something is still not an anomaly — the day line already
    // carries the day's totals, and 70 "3 new" rows is the noise being removed.
    expect(notableReason(routine("2026-08-04 10:00:00", 3))).toBeNull();
  });
});

describe("grouping a high-frequency day", () => {
  it("renders one day, with the newest run itemized and the rest a range", () => {
    const events = [
      routine("2026-08-04 14:51:00", 4),
      routine("2026-08-04 14:31:00"),
      routine("2026-08-04 14:11:00", 2),
      routine("2026-08-04 13:51:00"),
      routine("2026-08-04 13:31:00"),
    ];
    const [day] = groupSyncDays(events, "UTC");
    expect(day.day).toBe("2026-08-04");
    expect(day.runs).toBe(5);
    expect(day.entries).toHaveLength(2);
    expect(day.entries[0]).toMatchObject({ kind: "run", reason: "newest" });
    expect(day.entries[1].kind).toBe("range");
    // Every hidden run is accounted for in the range, so nothing vanishes.
    const range = day.entries[1];
    expect(range.kind === "range" && range.runs).toHaveLength(4);
  });

  it("pulls an anomaly out of the middle of the stream", () => {
    const events = [
      routine("2026-08-04 14:51:00"),
      routine("2026-08-04 14:31:00"),
      ev({ at: "2026-08-04 14:11:00", inserted: 3, skipped: 6 }),
      routine("2026-08-04 13:51:00"),
      routine("2026-08-04 13:31:00"),
    ];
    const [day] = groupSyncDays(events, "UTC");
    // newest · range(1 run → itself) · the skip · range(2)
    const kinds = day.entries.map((e) =>
      e.kind === "run" ? e.reason : e.kind
    );
    expect(kinds).toEqual(["newest", "routine", "skipped", "range"]);
    expect(day.skipped).toBe(6);
    expect(syncDayAttention(day)).toEqual({
      label: "6 skipped",
      tone: "caution",
    });
  });

  it("splits days at the local boundary and keeps them newest-first", () => {
    const events = [
      routine("2026-08-05 01:00:00"),
      routine("2026-08-04 23:00:00"),
      routine("2026-08-04 22:00:00"),
    ];
    const days = groupSyncDays(events, "UTC");
    expect(days.map((d) => d.day)).toEqual(["2026-08-05", "2026-08-04"]);
    expect(days[0].entries[0]).toMatchObject({
      kind: "run",
      reason: "newest",
    });
    // "Latest" describes the whole ledger, not the first run of every day. The
    // older day's two routine runs therefore collapse together as one range.
    expect(days[1].entries).toHaveLength(1);
    expect(days[1].entries[0]).toMatchObject({ kind: "range" });
  });

  it("degrades gracefully to one line for a once-a-day import", () => {
    const [day] = groupSyncDays(
      [ev({ at: "2026-08-04 09:00:00", inserted: 12 })],
      "UTC"
    );
    expect(day.runs).toBe(1);
    expect(day.entries).toEqual([
      expect.objectContaining({ kind: "run", reason: "newest" }),
    ]);
    expect(syncDayAttention(day)).toBeNull();
  });

  it("has nothing to group when nothing has run", () => {
    expect(groupSyncDays([], "UTC")).toEqual([]);
  });
});

describe("failures inside a day", () => {
  it("collapses consecutive IDENTICAL failures and keeps different causes apart", () => {
    const events = [
      ev({ at: "2026-08-04 12:00:00", ok: 0, error: "429" }),
      ev({ at: "2026-08-04 11:00:00", ok: 0, error: "429" }),
      ev({ at: "2026-08-04 10:00:00", ok: 0, error: "401" }),
      routine("2026-08-04 09:00:00"),
    ];
    const [day] = groupSyncDays(events, "UTC");
    expect(day.entries[0]).toMatchObject({ kind: "failure-run", error: "429" });
    expect(day.entries[1]).toMatchObject({ kind: "run", reason: "failed" });
    expect(day.entries[2]).toMatchObject({ kind: "run", reason: "routine" });
    expect(day.failed).toBe(3);
    expect(syncDayAttention(day)).toEqual({ label: "3 failed", tone: "bad" });
  });

  it("labels a collapsed failure run with its count-qualified shared reason", () => {
    // #1880 item 3's copy, moved here with the collapse it belongs to.
    expect(failureRunReason(2, "weather fetch failed (503)")).toBe(
      "weather fetch failed (503) — both runs"
    );
    expect(failureRunReason(4, "weather fetch failed (503)")).toBe(
      "weather fetch failed (503) — all 4 runs"
    );
    expect(failureRunReason(2, null)).toBeNull();
  });

  it("ranks a failure above a cut-short run above dropped rows", () => {
    expect(syncDayAttention({ failed: 1, partial: 1, skipped: 5 })).toEqual({
      label: "1 failed",
      tone: "bad",
    });
    expect(syncDayAttention({ failed: 0, partial: 1, skipped: 5 })).toEqual({
      label: "partial",
      tone: "caution",
    });
    expect(syncDayAttention({ failed: 0, partial: 0, skipped: 0 })).toBeNull();
  });
});

describe("the day and range lines", () => {
  it("counts runs in the provider's own noun and drops zero terms", () => {
    expect(syncDayLabel({ runs: 26, inserted: 340, updated: 12 }, "push")).toBe(
      "26 pushes · 340 new · 12 changed"
    );
    expect(syncDayLabel({ runs: 1, inserted: 0, updated: 4 }, "sync")).toBe(
      "1 sync · 4 changed"
    );
    expect(syncDayLabel({ runs: 24, inserted: 0, updated: 0 }, "sync")).toBe(
      "24 syncs · no new data"
    );
  });

  it("speaks the cache dialect for a forecast provider", () => {
    expect(
      syncDayLabel(
        { runs: 24, inserted: 16, updated: 4 },
        "refresh",
        "forecast"
      )
    ).toBe("24 refreshes · 20 readings revised");
    expect(
      syncDayLabel({ runs: 24, inserted: 0, updated: 0 }, "refresh", "forecast")
    ).toBe("24 refreshes · no change");
  });

  it("accounts for a routine range and what it still wrote", () => {
    const runs = [
      routine("2026-08-04 14:51:00", 100),
      routine("2026-08-04 14:31:00", 28),
    ];
    expect(syncRangeLabel(runs, "push")).toBe("2 pushes · 128 new");
    expect(syncRangeLabel([routine("a"), routine("b")], "sync")).toBe(
      "2 syncs"
    );
  });
});

describe("the drill-in counts what it can SHOW", () => {
  it("full coverage: itemizes everything, names no remainder", () => {
    expect(drilldownCoverage(3, 3)).toEqual({
      itemizable: 3,
      remainder: 0,
      offer: true,
    });
    expect(drilldownRemainderLabel(0)).toBeNull();
  });

  it("partial coverage: promises only what it will list, and names the rest", () => {
    // The live defect: written = 30, but recordSyncRows skips minute-grain rows with
    // no row id, so the list had 3. "What this wrote (30)" opened to three rows.
    const coverage = drilldownCoverage(30, 3);
    expect(coverage).toEqual({ itemizable: 3, remainder: 27, offer: true });
    expect(drilldownRemainderLabel(coverage.remainder)).toContain("+27 more");
    expect(drilldownRemainderLabel(coverage.remainder)).toContain(
      "not itemizable"
    );
  });

  it("no coverage: no drill-in at all, not an expander that apologizes", () => {
    // Weather writes cells of a GLOBAL location-keyed forecast cache, which name no
    // user record (#1771).
    expect(drilldownCoverage(365, 0)).toEqual({
      itemizable: 0,
      remainder: 365,
      offer: false,
    });
  });

  it("never promises more than the run wrote, whatever the inputs", () => {
    expect(drilldownCoverage(2, 5).itemizable).toBe(2);
    expect(drilldownCoverage(0, 5)).toEqual({
      itemizable: 0,
      remainder: 0,
      offer: false,
    });
  });
});
