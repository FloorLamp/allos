// PURE TIER — the routing matrix's column select-all (#1868 §2).
//
// The piece that must never regress is the SAFETY EXCLUSION: a column sweep may not
// touch dose reminders, missed-dose escalation, or the PRN redose notice, so no single
// undifferentiated tap can silence a safety signal (#928). Everything else here is the
// tri-state derivation the column header renders.

import { describe, it, expect } from "vitest";
import type { NotificationKind } from "@/lib/notifications/types";
import {
  applyColumnBulk,
  columnBulkLabel,
  columnBulkState,
  nextColumnBulkTarget,
  sweepableKinds,
} from "@/lib/notifications/matrix-bulk";
import {
  NOTIFICATION_KIND_REGISTRY,
  NON_CONFIGURABLE_KINDS,
  SAFETY_NOTIFICATION_KINDS,
} from "@/lib/notifications/kinds";

const ROW_KINDS = NOTIFICATION_KIND_REGISTRY.map((e) => e.kind);

describe("sweepableKinds — the safety exclusion", () => {
  it("drops every safety kind and keeps every other cell", () => {
    const sweep = sweepableKinds(ROW_KINDS);
    for (const k of SAFETY_NOTIFICATION_KINDS) {
      expect(sweep, `safety kind ${k} must never be swept`).not.toContain(k);
    }
    const expected = ROW_KINDS.filter((k) => !SAFETY_NOTIFICATION_KINDS.has(k));
    expect(sweep).toEqual(expected);
  });

  it("keeps the matrix's actual safety rows out by name", () => {
    const sweep = sweepableKinds(ROW_KINDS);
    expect(sweep).not.toContain("dose");
    expect(sweep).not.toContain("escalation");
    // `redose` is safety-classed without being a registry row, so it can only reach a
    // sweep through a caller passing it — and it is excluded there too.
    expect(sweepableKinds(["redose", "refill"])).toEqual(["refill"]);
    expect(sweep).toContain("refill");
    expect(sweep).toContain("digest");
  });

  it("cannot reach a NON_CONFIGURABLE kind — those have no cell to pass in", () => {
    // #1873's `followup` has no registry row, so it never enters the caller's cell
    // list. Pinned here because "invisible in the matrix" and "untouched by a sweep"
    // are the same guarantee.
    for (const kind of Object.keys(NON_CONFIGURABLE_KINDS)) {
      expect(ROW_KINDS).not.toContain(kind as NotificationKind);
    }
  });
});

describe("columnBulkState — the tri-state derivation", () => {
  const sweep: NotificationKind[] = ["refill", "digest", "milestone"];

  it("is `all` when nothing sweepable is disabled", () => {
    expect(columnBulkState(sweep, new Set())).toBe("all");
    // A DISABLED safety kind does not make the column mixed — it is not swept.
    expect(columnBulkState(sweep, new Set<NotificationKind>(["dose"]))).toBe(
      "all"
    );
  });

  it("is `none` when every sweepable kind is disabled", () => {
    expect(columnBulkState(sweep, new Set(sweep))).toBe("none");
  });

  it("is `mixed` in between", () => {
    expect(columnBulkState(sweep, new Set<NotificationKind>(["digest"]))).toBe(
      "mixed"
    );
  });

  it("reads `none` for a column with nothing to sweep", () => {
    expect(columnBulkState([], new Set())).toBe("none");
  });
});

describe("nextColumnBulkTarget", () => {
  it("turns a full column off, and turns a mixed or empty one on", () => {
    expect(nextColumnBulkTarget("all")).toBe(false);
    expect(nextColumnBulkTarget("mixed")).toBe(true);
    expect(nextColumnBulkTarget("none")).toBe(true);
  });
});

describe("applyColumnBulk", () => {
  const sweep: NotificationKind[] = ["refill", "digest", "milestone"];

  it("turning a column OFF disables exactly the sweepable kinds", () => {
    expect(new Set(applyColumnBulk([], sweep, false))).toEqual(new Set(sweep));
  });

  it("turning a column OFF leaves the safety kinds exactly as stored", () => {
    // dose was deliberately disabled here and escalation deliberately left on; a sweep
    // must change neither.
    const next = applyColumnBulk(["dose"], sweep, false);
    expect(next).toContain("dose");
    expect(next).not.toContain("escalation");
    expect(next).not.toContain("redose");
  });

  it("turning a column ON re-enables the sweepable kinds and nothing else", () => {
    const next = applyColumnBulk(
      ["dose", "escalation", "refill", "digest"],
      sweep,
      true
    );
    // The safety disables survive — a sweep can't un-silence them either.
    expect(new Set(next)).toEqual(new Set(["dose", "escalation"]));
  });

  it("carries through a disabled kind that has no cell in this column", () => {
    // push × food is inherently undeliverable, so `food` is never in push's sweep set
    // and a stored `food` disable must survive a push sweep in both directions.
    expect(applyColumnBulk(["food"], sweep, false)).toContain("food");
    expect(applyColumnBulk(["food"], sweep, true)).toEqual(["food"]);
  });

  it("is idempotent and never duplicates", () => {
    const once = applyColumnBulk([], sweep, false);
    const twice = applyColumnBulk(once, sweep, false);
    expect(twice).toEqual(once);
    expect(new Set(twice).size).toBe(twice.length);
  });

  it("off-then-on leaves only the non-swept disables (a sweep is a bulk SET, not undo)", () => {
    // `digest` was individually off before the sweep and comes back ON — a column
    // "turn everything on" means exactly that. `dose` is untouched in both directions.
    const off = applyColumnBulk(["dose", "digest"], sweep, false);
    expect(applyColumnBulk(off, sweep, true)).toEqual(["dose"]);
  });
});

describe("columnBulkLabel", () => {
  it("states the safety carve-out on the turn-off tap", () => {
    const label = columnBulkLabel("Telegram", "all");
    expect(label).toContain("Telegram");
    expect(label).toMatch(/except safety reminders/i);
  });

  it("says plainly what a turn-on tap does", () => {
    expect(columnBulkLabel("Web Push", "mixed")).toMatch(/turn on every kind/i);
    expect(columnBulkLabel("Home Assistant", "none")).toMatch(
      /turn on every kind/i
    );
  });
});
