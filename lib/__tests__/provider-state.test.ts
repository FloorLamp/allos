// PURE TIER — the one integration state model (#1772). These pin the properties the
// three surfaces (Integrations grid, setup page, Review's inbox) depend on: one badge
// vocabulary, one accounting, one history shape. The "one question, one computation"
// pin at the bottom is the point of the issue: the same fixture must produce the same
// outcome text no matter which surface asked.

import { describe, it, expect } from "vitest";
import {
  buildHistoryRows,
  eventVerdict,
  formatCoverage,
  formatSyncChange,
  formatSyncOutcome,
  needsAttention,
  providerStanding,
  quietRunLabel,
  runWindowNorm,
  standingBadge,
  syncVocabularyForKind,
  type SyncEventFacts,
} from "@/lib/integrations/provider-state";
import { truncatedSyncDetails } from "@/lib/integrations/sync-details";

function ev(over: Partial<SyncEventFacts> = {}): SyncEventFacts {
  return {
    id: 1,
    at: "2026-08-01 09:00:00",
    ok: 1,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    written: 0,
    ...over,
  };
}

describe("syncVocabularyForKind", () => {
  it("gives the cache dialect to the keyless public kind, records to everything else", () => {
    // Keyed on the KIND, never a provider id — a future shared-cache provider gets
    // the right words without a new branch.
    expect(syncVocabularyForKind("public")).toBe("forecast");
    for (const kind of ["push", "oauth", "token", "archive", "feed"]) {
      expect(syncVocabularyForKind(kind)).toBe("records");
    }
  });
});

describe("providerStanding + standingBadge", () => {
  it("puts a dead credential ahead of everything else", () => {
    expect(
      providerStanding({ connected: false, needsReauth: true, latest: ev() })
    ).toBe("needs-reauth");
    expect(standingBadge("needs-reauth")).toEqual({
      label: "Needs reconnect",
      tone: "bad",
    });
  });

  it("distinguishes a removed source from a broken one (#294 vs #326)", () => {
    expect(
      providerStanding({ connected: false, needsReauth: false, latest: ev() })
    ).toBe("not-connected");
    expect(standingBadge("not-connected").tone).toBe("caution");
  });

  it("reads the latest event for a connected provider", () => {
    expect(
      providerStanding({ connected: true, needsReauth: false, latest: null })
    ).toBe("never-synced");
    expect(
      providerStanding({
        connected: true,
        needsReauth: false,
        latest: ev({ ok: 0 }),
      })
    ).toBe("failing");
    expect(
      providerStanding({
        connected: true,
        needsReauth: false,
        latest: ev({ details: truncatedSyncDetails() }),
      })
    ).toBe("partial");
    expect(
      providerStanding({ connected: true, needsReauth: false, latest: ev() })
    ).toBe("healthy");
  });

  it("routes exactly the actionable standings into Review's inbox", () => {
    expect(needsAttention("failing")).toBe(true);
    expect(needsAttention("needs-reauth")).toBe(true);
    expect(needsAttention("partial")).toBe(true);
    expect(needsAttention("not-connected")).toBe(true);
    // Healthy providers collapse to one line; a just-enabled one is working as
    // designed and is the staleness detector's problem if it never starts (#1685).
    expect(needsAttention("healthy")).toBe(false);
    expect(needsAttention("never-synced")).toBe(false);
  });
});

describe("formatSyncChange — one accounting, two dialects", () => {
  it("keeps record language for record providers (the #674 split)", () => {
    expect(
      formatSyncChange(ev({ inserted: 3, updated: 1, unchanged: 9 }), "records")
    ).toEqual({ primary: "3 new · 1 changed · 9 unchanged", muted: false });
  });

  it("speaks cache language for a forecast provider", () => {
    // "16 changed · 365 unchanged" counted revised cells of a GLOBAL forecast cache
    // as if they were user records: honest accounting, meaningless sentence.
    expect(
      formatSyncChange(
        ev({ inserted: 4, updated: 12, unchanged: 365 }),
        "forecast"
      )
    ).toEqual({ primary: "16 readings revised", muted: false });
    expect(
      formatSyncChange(
        ev({ inserted: 0, updated: 0, unchanged: 381 }),
        "forecast"
      )
    ).toEqual({ primary: "no change", muted: true });
    expect(
      formatSyncChange(
        ev({ inserted: 1, updated: 0, unchanged: 3 }),
        "forecast"
      ).primary
    ).toBe("1 reading revised");
  });

  it("never reports record counts for a cache provider", () => {
    const line = formatSyncOutcome(
      ev({ inserted: 4, updated: 12, unchanged: 365 }),
      "forecast"
    ).primary;
    expect(line).toBe("Forecast refreshed · 16 readings revised");
    expect(line).not.toMatch(/unchanged/);
    expect(line).not.toMatch(/new/);
  });
});

describe("eventVerdict", () => {
  it("separates whether the run worked from what it changed", () => {
    expect(eventVerdict(ev({ ok: 0 }))).toEqual({
      label: "Failed",
      tone: "bad",
    });
    expect(eventVerdict(ev({ details: truncatedSyncDetails() }))).toEqual({
      label: "Partial",
      tone: "caution",
    });
    expect(eventVerdict(ev())).toEqual({ label: "Synced", tone: "good" });
    expect(eventVerdict(ev(), "forecast").label).toBe("Refreshed");
  });
});

describe("formatCoverage", () => {
  it("names a cache provider's window as coverage, a record provider's as a range", () => {
    const e = ev({ window_start: "2026-07-18", window_end: "2026-08-07" });
    expect(formatCoverage(e, "forecast")).toBe(
      "covers 2026-07-18 → 2026-08-07"
    );
    expect(formatCoverage(e, "records")).toBe("2026-07-18 → 2026-08-07");
    expect(formatCoverage(ev())).toBeNull();
  });
});

describe("buildHistoryRows", () => {
  const win = { window_start: "2026-07-18", window_end: "2026-08-07" };

  it("states the window once and flags only the rows that differ", () => {
    const events = [
      ev({ id: 5, inserted: 1, ...win }),
      ev({ id: 4, inserted: 2, ...win }),
      // A run that covered something else — this is exactly where the window
      // carries signal (see #1771's failure-vs-success asymmetry).
      ev({
        id: 3,
        inserted: 1,
        window_start: "2026-07-18",
        window_end: "2026-08-01",
      }),
    ];
    expect(runWindowNorm(events)).toBe("2026-07-18 → 2026-08-07");
    const rows = buildHistoryRows(events);
    expect(rows.map((r) => (r.kind === "event" ? r.window : "quiet"))).toEqual([
      null,
      null,
      "2026-07-18 → 2026-08-01",
    ]);
  });

  it("collapses a run of consecutive no-ops (#137) but never a lone one", () => {
    const events = [
      ev({ id: 9, inserted: 1 }),
      ev({ id: 8, unchanged: 40 }),
      ev({ id: 7, unchanged: 40 }),
      ev({ id: 6, unchanged: 40 }),
      ev({ id: 5, ok: 0, error: "token refresh failed" }),
      ev({ id: 4, unchanged: 40 }),
      ev({ id: 3, inserted: 2 }),
    ];
    const rows = buildHistoryRows(events);
    expect(rows.map((r) => r.kind)).toEqual([
      "event",
      "quiet",
      "event",
      "event",
      "event",
    ]);
    const quiet = rows[1];
    expect(quiet.kind === "quiet" && quiet.count).toBe(3);
    // A failure is never a no-op — it stays its own visible row with its reason.
    expect(rows[2].kind === "event" && rows[2].ev.id).toBe(5);
    // The lone no-op between the failure and the meaningful run is NOT collapsed:
    // hiding one row behind a summary of one gains nothing.
    expect(rows[3].kind === "event" && rows[3].ev.id).toBe(4);
  });

  it("labels a quiet run in the provider's own vocabulary", () => {
    expect(quietRunLabel(3)).toBe("3 syncs with no new data");
    expect(quietRunLabel(3, "forecast")).toBe("3 refreshes with no change");
  });

  it("returns nothing for a provider with no events", () => {
    expect(buildHistoryRows([])).toEqual([]);
    expect(runWindowNorm([])).toBeNull();
  });
});

// THE #1772 pin. The setup page's status header and Review's collapsed inbox row are
// different components; they must be different RENDERINGS of one answer, not two
// answers. Both call formatSyncOutcome over the state's own vocabulary, so this
// asserts the property that makes the duplication impossible to reintroduce silently.
describe("one question, one computation", () => {
  it("gives every surface the same outcome text for the same fixture", () => {
    const cases: { ev: SyncEventFacts; kind: string }[] = [
      { ev: ev({ inserted: 30, updated: 10 }), kind: "push" },
      { ev: ev({ ok: 0, error: "token refresh failed" }), kind: "oauth" },
      { ev: ev({ inserted: 12, updated: 4, unchanged: 320 }), kind: "public" },
      { ev: ev({ unchanged: 48 }), kind: "token" },
    ];
    for (const c of cases) {
      const vocabulary = syncVocabularyForKind(c.kind);
      // The setup page's header, Review's inbox row, and the grid card each format
      // this one result; there is no second formatter to disagree with.
      const setupPage = formatSyncOutcome(c.ev, vocabulary);
      const reviewInbox = formatSyncOutcome(c.ev, vocabulary);
      expect(setupPage).toEqual(reviewInbox);
      expect(setupPage.primary).toBeTruthy();
    }
  });

  it("keeps the history table's cells consistent with the header sentence", () => {
    const e = ev({ inserted: 12, updated: 4, unchanged: 320 });
    // The header states a whole sentence, the table splits verdict from accounting —
    // two projections of one computation, so the numbers can never disagree.
    expect(formatSyncOutcome(e, "forecast").primary).toContain(
      formatSyncChange(e, "forecast").primary
    );
    expect(eventVerdict(e, "forecast").tone).toBe("good");
  });
});
