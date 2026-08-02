// PURE TIER — the one integration state model (#1772). These pin the properties the
// three surfaces (Integrations grid, setup page, Review's inbox) depend on: one badge
// vocabulary, one accounting, one history shape. The "one question, one computation"
// pin at the bottom is the point of the issue: the same fixture must produce the same
// outcome text no matter which surface asked.

import { describe, it, expect } from "vitest";
import {
  buildHistoryRows,
  consecutiveLeadingFailures,
  escalationPolicyLabel,
  eventVerdict,
  failureConsequence,
  failureRunReason,
  FAILING_CONSECUTIVE_RUNS,
  formatCoverage,
  formatSyncChange,
  formatSyncOutcome,
  intermittentReassurance,
  intermittentRunsLabel,
  needsAttention,
  providerStanding,
  quietRunLabel,
  runWindowNorm,
  standingBadge,
  standingEscalates,
  syncVocabularyForKind,
  windowDivergence,
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

// The recent run window: newest-first, `fails` leading failures then `oks`
// successes behind them.
function runs(fails: number, oks: number): SyncEventFacts[] {
  const out: SyncEventFacts[] = [];
  let id = 100;
  for (let i = 0; i < fails; i++)
    out.push(ev({ id: id--, ok: 0, error: "weather fetch failed (503)" }));
  for (let i = 0; i < oks; i++) out.push(ev({ id: id--, inserted: 1 }));
  return out;
}

// A connected provider's standing over a window, with the staleness facts a real
// caller (getIntegrationState) supplies. Defaults: last success well inside the
// threshold.
function standingOf(
  window: SyncEventFacts[],
  over: Partial<Parameters<typeof providerStanding>[0]> = {}
) {
  return providerStanding({
    connected: true,
    needsReauth: false,
    latest: window[0] ?? null,
    recentRuns: window,
    lastSuccessAt: "2026-08-01 08:00:00",
    thresholdDays: 2,
    today: "2026-08-01",
    ...over,
  });
}

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

  it("reads the run window for a connected provider", () => {
    expect(
      providerStanding({ connected: true, needsReauth: false, latest: null })
    ).toBe("never-synced");
    expect(
      standingOf([ev({ details: truncatedSyncDetails() }), ev(), ev()])
    ).toBe("partial");
    expect(standingOf(runs(0, 6))).toBe("healthy");
  });

  // THE #1880 headline: flapping is not failing. The boundary is
  // FAILING_CONSECUTIVE_RUNS — 2 consecutive failures with a recent success stay a
  // calm amber `intermittent`; the third escalates.
  it("classifies 2 consecutive failures as intermittent and 3 as failing", () => {
    expect(FAILING_CONSECUTIVE_RUNS).toBe(3);
    expect(standingOf(runs(1, 5))).toBe("intermittent");
    expect(standingOf(runs(2, 5))).toBe("intermittent");
    expect(standingOf(runs(3, 5))).toBe("failing");
    expect(consecutiveLeadingFailures(runs(2, 5))).toBe(2);
    // A success at the head resets the streak — a flap is not an outage.
    expect(consecutiveLeadingFailures(runs(0, 3))).toBe(0);
  });

  it("keeps a provider with old failures inside the window intermittent, not healthy", () => {
    // Latest run SUCCEEDED, but the window carries failures: the pattern is
    // intermittency, and hiding it would make the amber chip flap on and off with
    // every alternation — exactly the latest-event-wins disease.
    const window = [ev({ inserted: 2 }), ...runs(1, 4)];
    expect(standingOf(window)).toBe("intermittent");
  });

  // The staleness interplay (#1685 composed, not duplicated): the SAME failure
  // pattern escalates or not depending on whether a success landed inside the
  // provider's staleness window.
  it("escalates a flap once the last success falls outside the staleness window", () => {
    const window = runs(1, 5);
    expect(
      standingOf(window, {
        lastSuccessAt: "2026-07-31 08:00:00",
        today: "2026-08-01",
      })
    ).toBe("intermittent"); // success inside the 2-day window
    expect(
      standingOf(window, {
        lastSuccessAt: "2026-07-25 08:00:00",
        today: "2026-08-01",
      })
    ).toBe("failing"); // success outside it — the #1685 breach escalates
  });

  it("escalates a QUIET stop too — no failures recorded, just no success in the window", () => {
    expect(
      standingOf([ev({ at: "2026-07-20 08:00:00" })], {
        lastSuccessAt: "2026-07-20 08:00:00",
        today: "2026-08-01",
      })
    ).toBe("failing");
    // An exempt provider (null threshold) never goes stale (#1685).
    expect(
      standingOf([ev({ at: "2026-07-20 08:00:00" })], {
        lastSuccessAt: "2026-07-20 08:00:00",
        thresholdDays: null,
        today: "2026-08-01",
      })
    ).toBe("healthy");
  });

  it("stays calm for a provider that has only ever failed once or twice", () => {
    // No success EVER: staleness cannot fire (#1685's never-succeeded exemption)
    // and the streak is below the escalation threshold — the provider's own page
    // shows the failure; nothing escalates until the third consecutive miss.
    expect(standingOf(runs(2, 0), { lastSuccessAt: null })).toBe(
      "intermittent"
    );
    expect(standingOf(runs(3, 0), { lastSuccessAt: null })).toBe("failing");
  });

  it("routes exactly the escalating standings to the badge/digest, and intermittent to nowhere", () => {
    // standingEscalates is what the Review badge, Needs attention, the hero item,
    // and the digest 🔌 lines read — the reach of a flapping source only narrows.
    expect(standingEscalates("failing")).toBe(true);
    expect(standingEscalates("needs-reauth")).toBe(true);
    for (const s of [
      "intermittent",
      "partial",
      "not-connected",
      "healthy",
      "never-synced",
    ] as const) {
      expect(standingEscalates(s)).toBe(false);
    }
    // needsAttention decides which sources EXPAND with a reason; intermittent
    // deliberately collapses to a one-liner (#1880 item 1).
    expect(needsAttention("intermittent")).toBe(false);
    expect(needsAttention("partial")).toBe(true);
    expect(needsAttention("not-connected")).toBe(true);
    // Healthy providers collapse to one line; a just-enabled one is working as
    // designed and is the staleness detector's problem if it never starts (#1685).
    expect(needsAttention("healthy")).toBe(false);
    expect(needsAttention("never-synced")).toBe(false);
  });

  it("names the intermittent standing with a calm caution badge", () => {
    expect(standingBadge("intermittent")).toEqual({
      label: "Intermittent",
      tone: "caution",
    });
  });
});

describe("flap + escalation copy (#1880)", () => {
  it("states the honest run tally and the vocabulary-true reassurance", () => {
    expect(intermittentRunsLabel(3, 10)).toBe("3 of the last 10 runs failed");
    expect(intermittentRunsLabel(1, 1)).toBe("1 of the last 1 run failed");
    expect(intermittentReassurance("forecast")).toContain("nothing missing");
    expect(intermittentReassurance("records")).toContain("catches up");
  });

  it("states the escalation policy with the provider's own staleness threshold", () => {
    const withStale = escalationPolicyLabel(2);
    expect(withStale).toContain("after 3 consecutive failures");
    expect(withStale).toContain("no run has succeeded in 2 days");
    expect(withStale).toContain("the same rule the Review badge");
    // An exempt provider states only the consecutive half — no invented threshold.
    const exempt = escalationPolicyLabel(null);
    expect(exempt).toContain("after 3 consecutive failures");
    expect(exempt).not.toContain("no run has succeeded");
  });

  it("prefers the provider's declared consequence and falls back generically", () => {
    expect(
      failureConsequence(
        "Withings",
        "Measurements from your scale and cuff have stopped arriving."
      )
    ).toBe("Measurements from your scale and cuff have stopped arriving.");
    expect(failureConsequence("Oura Ring", null)).toBe(
      "New data from Oura Ring has stopped arriving."
    );
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
        window_start: "2026-07-10",
        window_end: "2026-08-01",
      }),
    ];
    expect(runWindowNorm(events)).toBe("2026-07-18 → 2026-08-07");
    const rows = buildHistoryRows(events);
    expect(rows.map((r) => (r.kind === "event" ? r.window : "quiet"))).toEqual([
      null,
      null,
      "2026-07-10 → 2026-08-01",
    ]);
  });

  // #1880 item 4: the norm is the LATEST run's window, never a majority vote over
  // stale history — so after a day rollover the header agrees with the newest row
  // and the OLDER rows note their divergence.
  it("derives the norm from the latest run, with older rows noting the day roll", () => {
    const events = [
      // The newest run reaches → 08-09 (the day rolled)…
      ev({
        id: 9,
        inserted: 1,
        window_start: "2026-07-20",
        window_end: "2026-08-09",
      }),
      // …while every older run covered → 08-08. Under the majority rule the
      // HEADER would claim → 08-08 and contradict the newest row.
      ev({
        id: 8,
        inserted: 2,
        window_start: "2026-07-20",
        window_end: "2026-08-08",
      }),
      ev({
        id: 7,
        inserted: 3,
        window_start: "2026-07-20",
        window_end: "2026-08-08",
      }),
    ];
    expect(runWindowNorm(events)).toBe("2026-07-20 → 2026-08-09");
    const rows = buildHistoryRows(events);
    expect(rows.map((r) => (r.kind === "event" ? r.window : "?"))).toEqual([
      null,
      "covered → 2026-08-08 (before the day rolled)",
      "covered → 2026-08-08 (before the day rolled)",
    ]);
  });

  it("keeps the day-roll phrase for exactly a one-day gap, and states other divergence plainly", () => {
    const norm = { start: "2026-07-20", end: "2026-08-09" };
    // Same start, end more than a day short: shortened but no rollover claim.
    expect(
      windowDivergence(
        ev({ window_start: "2026-07-20", window_end: "2026-08-01" }),
        norm
      )
    ).toBe("covered → 2026-08-01");
    // A different start states the whole window.
    expect(
      windowDivergence(
        ev({ window_start: "2026-07-10", window_end: "2026-08-09" }),
        norm
      )
    ).toBe("2026-07-10 → 2026-08-09");
    // Matching the norm says nothing at all.
    expect(
      windowDivergence(
        ev({ window_start: "2026-07-20", window_end: "2026-08-09" }),
        norm
      )
    ).toBeNull();
  });

  it("skips windowless failures when picking the norm", () => {
    const events = [
      ev({ id: 5, ok: 0, error: "weather fetch failed (503)" }),
      ev({ id: 4, inserted: 1, ...win }),
    ];
    expect(runWindowNorm(events)).toBe("2026-07-18 → 2026-08-07");
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
    // A LONE failure is never collapsed — it stays its own visible row with its
    // reason.
    expect(rows[2].kind === "event" && rows[2].ev.id).toBe(5);
    // The lone no-op between the failure and the meaningful run is NOT collapsed:
    // hiding one row behind a summary of one gains nothing.
    expect(rows[3].kind === "event" && rows[3].ev.id).toBe(4);
  });

  // #1880 item 3: consecutive IDENTICAL failures group like consecutive no-ops do,
  // so an alternating Failed/Refreshed hour reads as a pattern, not a zebra.
  it("groups consecutive identical failures into one ×N row", () => {
    const err = "weather fetch failed (503)";
    const events = [
      ev({ id: 9, ok: 0, at: "2026-08-01 09:00:00", error: err }),
      ev({ id: 8, inserted: 5, at: "2026-08-01 08:00:00" }),
      ev({ id: 7, ok: 0, at: "2026-08-01 07:00:00", error: err }),
      ev({ id: 6, ok: 0, at: "2026-08-01 06:00:00", error: err }),
      ev({ id: 5, inserted: 3, at: "2026-08-01 05:00:00" }),
    ];
    const rows = buildHistoryRows(events);
    expect(rows.map((r) => r.kind)).toEqual([
      "event", // the lone newest failure stays a row with its reason
      "event",
      "failure-run", // 07:00 + 06:00 collapse
      "event",
    ]);
    const run = rows[2];
    if (run.kind !== "failure-run") throw new Error("expected failure-run");
    expect(run.count).toBe(2);
    expect(run.newestAt).toBe("2026-08-01 07:00:00");
    expect(run.oldestAt).toBe("2026-08-01 06:00:00");
    expect(run.error).toBe(err);
  });

  it("never groups consecutive failures with DIFFERENT reasons", () => {
    const events = [
      ev({ id: 9, ok: 0, error: "rate limit reached (429)" }),
      ev({ id: 8, ok: 0, error: "token refresh failed (401)" }),
      ev({ id: 7, inserted: 1 }),
    ];
    const rows = buildHistoryRows(events);
    // Two causes, two rows — collapsing them would hide which failure said what.
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("labels a failure run with its count-qualified shared reason", () => {
    expect(failureRunReason(2, "weather fetch failed (503)")).toBe(
      "weather fetch failed (503) — both runs"
    );
    expect(failureRunReason(4, "weather fetch failed (503)")).toBe(
      "weather fetch failed (503) — all 4 runs"
    );
    expect(failureRunReason(2, null)).toBeNull();
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
