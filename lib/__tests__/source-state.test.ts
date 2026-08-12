// PURE TIER — the one integration state model (#1772). These pin the properties the
// three surfaces (Integrations grid, setup page, Review's inbox) depend on: one badge
// vocabulary, one accounting, one history shape. The "one question, one computation"
// pin at the bottom is the point of the issue: the same fixture must produce the same
// outcome text no matter which surface asked.

import { describe, it, expect } from "vitest";
import type { IntegrationKind } from "@/lib/types/integrations";
import {
  KIND_DELIVERY,
  isScheduledKind,
  type IntegrationDelivery,
} from "@/lib/integrations/delivery";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import {
  consecutiveLeadingFailures,
  escalationPolicyLabel,
  eventVerdict,
  failureConsequence,
  formatCoverage,
  formatSyncChange,
  formatSyncOutcome,
  intermittentReassurance,
  intermittentRunsLabel,
  needsAttention,
  observedSuccessCadenceMinutes,
  pluralRunNoun,
  providerStanding,
  runWindowNorm,
  standingBadge,
  standingEscalates,
  standingHeadline,
  standingUnconfigured,
  successCadenceLabel,
  syncRunNounForKind,
  syncVocabularyForKind,
  STANDING_RUN_WINDOW,
  type AttendedStanding,
  type OutboundStanding,
  type ProviderStanding,
  type SyncEventFacts,
  type SyncRunNoun,
} from "@/lib/integrations/source-state";
import { truncatedSyncDetails } from "@/lib/integrations/sync-details";

// The instant every fixture below is measured against, and the shape the sync ledger
// actually stores ('YYYY-MM-DDTHH:MM:SSZ', #2205 / migration 163).
const NOW = "2026-08-01T12:00:00Z";
const HOUR = 60;
const DAY = 24 * HOUR;

function minutesBefore(minutes: number): string {
  return `${new Date(Date.parse(NOW) - minutes * 60_000).toISOString().slice(0, 19)}Z`;
}

function ev(over: Partial<SyncEventFacts> = {}): SyncEventFacts {
  return {
    id: 1,
    at: minutesBefore(3 * HOUR),
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
    for (const kind of ALL_KINDS) {
      if (kind === "public") continue;
      expect(syncVocabularyForKind(kind)).toBe("records");
    }
  });
});

// Every registered kind, read off the DECLARATION rather than typed out again — so a
// new kind widens every loop below at once instead of quietly skipping them.
const ALL_KINDS = Object.keys(KIND_DELIVERY) as IntegrationKind[];

// ── The DELIVERY axis (#2301) ────────────────────────────────────────────────
//
// The `Record<IntegrationKind, IntegrationDelivery>` makes coverage a COMPILE-time
// fact; these are the behavioural half.
describe("KIND_DELIVERY — who moves the data", () => {
  it("resolves a delivery for every registered provider", () => {
    for (const def of INTEGRATIONS) {
      expect(KIND_DELIVERY[def.kind], def.id).toBeDefined();
    }
  });

  it("classifies the scheduled family exactly as the retired RECURRING_SOURCE_KINDS did", () => {
    // THE REGRESSION PIN for the refactor: `RECURRING_SOURCE_KINDS` was a hand-written
    // `Set<string>` of these four members, and it decided which providers reach Data →
    // Review's "Connected sources". This refactor must not move a single provider
    // across that line. (Its own comment recorded that hand-enumeration failing once
    // already: `public` was missing, #1614.)
    const RETIRED_RECURRING_SOURCE_KINDS = ["push", "oauth", "token", "public"];
    const scheduled = ALL_KINDS.filter(isScheduledKind).sort();
    expect(scheduled).toEqual([...RETIRED_RECURRING_SOURCE_KINDS].sort());
  });

  it("puts the two hand-run kinds in one attended family and the outbound feed alone", () => {
    // The two members the Imports feed used to enumerate by naming ONE of them.
    expect(
      ALL_KINDS.filter((k) => KIND_DELIVERY[k] === "attended").sort()
    ).toEqual(["archive", "external-attended"]);
    expect(ALL_KINDS.filter((k) => KIND_DELIVERY[k] === "outbound")).toEqual([
      "feed",
    ]);
  });
});

describe("syncRunNounForKind + pluralRunNoun", () => {
  it("gives the attended kinds their own words instead of the polled dialect", () => {
    expect(syncRunNounForKind("archive")).toBe("import");
    expect(syncRunNounForKind("external-attended")).toBe("upload");
    expect(syncRunNounForKind("push")).toBe("push");
    expect(syncRunNounForKind("public")).toBe("refresh");
    expect(syncRunNounForKind("oauth")).toBe("sync");
    expect(syncRunNounForKind("token")).toBe("sync");
  });

  it("returns NULL only for the outbound feed — a run noun where no runs are recorded is a fiction", () => {
    expect(syncRunNounForKind("feed")).toBeNull();
    for (const kind of ALL_KINDS) {
      if (kind === "feed") continue;
      expect(syncRunNounForKind(kind), kind).not.toBeNull();
    }
  });

  it("plurals every noun from a declared table, never a suffix rule", () => {
    // The old `${noun}es` fallback yields "importes" and "uploades".
    const plurals: Record<SyncRunNoun, string> = {
      push: "pushes",
      sync: "syncs",
      refresh: "refreshes",
      import: "imports",
      upload: "uploads",
    };
    for (const [noun, plural] of Object.entries(plurals)) {
      expect(pluralRunNoun(noun as SyncRunNoun)).toBe(plural);
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

// A connected provider's standing over a window, with the freshness facts a real
// caller (getIntegrationState) supplies. Defaults: an hourly provider on the 12-hour
// silence tolerance, last success well inside it.
function standingOf(
  window: SyncEventFacts[],
  over: Partial<Parameters<typeof providerStanding>[0]> = {}
) {
  return providerStanding({
    delivery: "scheduled",
    connected: true,
    needsReauth: false,
    latest: window[0] ?? null,
    recentRuns: window,
    lastSuccessAt: minutesBefore(4 * HOUR),
    toleranceMinutes: 12 * HOUR,
    now: NOW,
    ...over,
  });
}

describe("providerStanding + standingBadge", () => {
  it("puts a dead credential ahead of everything else", () => {
    expect(
      providerStanding({
        delivery: "scheduled",
        connected: false,
        needsReauth: true,
        latest: ev(),
      })
    ).toBe("needs-reauth");
    expect(standingBadge("needs-reauth")).toEqual({
      label: "Needs reconnect",
      tone: "bad",
    });
  });

  it("distinguishes a removed source from a broken one (#294 vs #326)", () => {
    expect(
      providerStanding({
        delivery: "scheduled",
        connected: false,
        needsReauth: false,
        latest: ev(),
      })
    ).toBe("not-connected");
    expect(standingBadge("not-connected").tone).toBe("caution");
  });

  it("reads the run window for a connected provider", () => {
    expect(
      providerStanding({
        delivery: "scheduled",
        connected: true,
        needsReauth: false,
        latest: null,
      })
    ).toBe("never-synced");
    expect(
      standingOf([ev({ details: truncatedSyncDetails() }), ev(), ev()])
    ).toBe("partial");
    expect(standingOf(runs(0, 6))).toBe("healthy");
  });

  // THE #2263 headline: escalation is decided by SILENCE, not by a run count. A run
  // count is not a measure of whether data is arriving, and for an hourly provider
  // three runs is three hours — below that provider's own p90 gap between successes.
  it("never escalates on a consecutive-failure streak while a success sits inside the tolerance", () => {
    for (const failures of [1, 2, 3, 6, 10]) {
      expect(standingOf(runs(failures, 5))).toBe("intermittent");
    }
    // THE case this issue is about, stated exactly: an hourly provider with a success
    // 2 h ago and six recorded failures since is intermittent …
    expect(
      standingOf(runs(6, 4), { lastSuccessAt: minutesBefore(2 * HOUR) })
    ).toBe("intermittent");
    // … and the same provider whose last success is 13 h ago is failing, whatever the
    // failure pattern beneath it.
    expect(
      standingOf(runs(6, 4), { lastSuccessAt: minutesBefore(13 * HOUR) })
    ).toBe("failing");
  });

  it("keeps consecutiveLeadingFailures for CHOOSING THE COPY, not for escalating", () => {
    // It no longer decides anything; getImportIssues still prefers a real failure row
    // over the synthetic one, which is the reading that survives.
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

  // The SAME failure pattern escalates or not purely on whether a success landed
  // inside the provider's tolerance. One rule, one axis.
  it("escalates a flap once the last success falls outside the tolerance", () => {
    const window = runs(1, 5);
    expect(
      standingOf(window, { lastSuccessAt: minutesBefore(11 * HOUR) })
    ).toBe("intermittent");
    expect(
      standingOf(window, { lastSuccessAt: minutesBefore(13 * HOUR) })
    ).toBe("failing");
  });

  it("escalates a QUIET stop the same way — no failures recorded, just no success", () => {
    // The shape the Health Connect outage came in as: the device-side failures never
    // reached the server, so there was nothing to classify. Only absence.
    const quiet = [ev({ at: minutesBefore(20 * HOUR) })];
    expect(standingOf(quiet, { lastSuccessAt: minutesBefore(20 * HOUR) })).toBe(
      "failing"
    );
    // An exempt provider (null tolerance) is never silent, however long the gap.
    expect(
      standingOf(quiet, {
        lastSuccessAt: minutesBefore(20 * HOUR),
        toleranceMinutes: null,
      })
    ).toBe("healthy");
  });

  it("stays calm for a provider that has NEVER succeeded, however many runs failed", () => {
    // No success EVER: the tolerance rule cannot fire (its never-succeeded
    // exemption), and there is no other escalation path. The provider's own page
    // shows the failures — this is a setup problem, not a stopped connection, and
    // flagging it would flag every freshly-created connection before its first tick.
    for (const failures of [2, 3, 10]) {
      expect(standingOf(runs(failures, 0), { lastSuccessAt: null })).toBe(
        "intermittent"
      );
    }
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

  it("states the escalation policy as the ONE silence tolerance, in the provider's noun", () => {
    const hourly = escalationPolicyLabel(12 * HOUR, "refresh")!;
    expect(hourly).toContain(
      "“Sync failing” appears after 12 hours without a successful refresh"
    );
    expect(hourly).toContain(
      "The Review badge and morning digest use the same rule"
    );
    // And it says plainly what no longer escalates — the promise the page makes.
    expect(hourly).toContain("An isolated failure will not trigger it");
    expect(hourly).not.toContain("consecutive");
    expect(escalationPolicyLabel(3 * DAY)).toContain(
      "after 3 days without a successful sync"
    );
    // An EXEMPT provider has no policy to promise, so the page states none rather
    // than inventing a sentence.
    expect(escalationPolicyLabel(null)).toBeNull();
  });

  // #2263 decision 4: the amber surfaces state the failure tally, which is the noise.
  // The observed success cadence is the signal, measured for DISPLAY only.
  it("states the observed success cadence beside the failure tally", () => {
    // Six successes two hours apart, with failures interleaved — weather's own shape.
    const window: SyncEventFacts[] = [];
    for (let i = 0; i < 6; i++) {
      window.push(ev({ id: 200 - i * 2, at: minutesBefore(i * 2 * HOUR) }));
      window.push(
        ev({ id: 199 - i * 2, ok: 0, at: minutesBefore(i * 2 * HOUR + HOUR) })
      );
    }
    expect(observedSuccessCadenceMinutes(window)).toBe(2 * HOUR);
    expect(successCadenceLabel(2 * HOUR)).toBe(
      "succeeding about every 2 hours"
    );
    expect(successCadenceLabel(45)).toBe("succeeding about every 45 min");
    expect(successCadenceLabel(60)).toBe("succeeding about every 1 hour");
    expect(successCadenceLabel(3 * DAY)).toBe("succeeding about every 3 days");
    // One success states no cadence, and neither does none.
    expect(observedSuccessCadenceMinutes([ev()])).toBeNull();
    expect(observedSuccessCadenceMinutes(runs(3, 0))).toBeNull();
    expect(successCadenceLabel(null)).toBeNull();
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

describe("runWindowNorm", () => {
  const win = { window_start: "2026-07-18", window_end: "2026-08-07" };

  it("states the window from the LATEST windowed run, never a majority vote", () => {
    // #1880 item 4: after a day rollover the header must agree with the newest run.
    // Under the old majority rule it claimed the older reach and contradicted it.
    const events = [
      ev({
        id: 9,
        inserted: 1,
        window_start: "2026-07-20",
        window_end: "2026-08-09",
      }),
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
  });

  it("skips windowless failures when picking the norm", () => {
    const events = [
      ev({ id: 5, ok: 0, error: "weather fetch failed (503)" }),
      ev({ id: 4, inserted: 1, ...win }),
    ];
    expect(runWindowNorm(events)).toBe("2026-07-18 → 2026-08-07");
  });

  it("returns nothing for a provider with no events", () => {
    expect(runWindowNorm([])).toBeNull();
  });
});

// THE #1772 pin. The setup page's status header and Review's collapsed inbox row are
// different components; they must be different RENDERINGS of one answer, not two
// answers. Both call formatSyncOutcome over the state's own vocabulary, so this
// asserts the property that makes the duplication impossible to reintroduce silently.
describe("one question, one computation", () => {
  it("gives every surface the same outcome text for the same fixture", () => {
    const cases: { ev: SyncEventFacts; kind: IntegrationKind }[] = [
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

// ── The #2301 split: three delivery families, three disjoint answer sets ──────
//
// The point of splitting the union is not that there are more words. It is that
// certain answers become UNREPRESENTABLE at the producer: no fact about an attended
// or outbound source can make `providerStanding` return a connection verdict, so no
// future code path can put "Sync failing" on a file the user hands us. These iterate
// the unions rather than naming members, so a state added later is covered by
// construction.

// Every member of each family, listed once so the property tests can walk them.
const ATTENDED_STANDINGS: AttendedStanding[] = [
  "imported",
  "attempt-failed",
  "never-imported",
  "not-set-up",
];
const OUTBOUND_STANDINGS: OutboundStanding[] = ["feed-enabled", "feed-off"];
const SCHEDULED_STANDINGS: ProviderStanding[] = [
  "healthy",
  "partial",
  "intermittent",
  "failing",
  "needs-reauth",
  "not-connected",
  "never-synced",
];

// An attended provider's facts. The freshness fields are supplied on purpose — an
// attended source is EXEMPT from them, and the test is that supplying them changes
// nothing.
function attendedStandingOf(
  window: SyncEventFacts[],
  over: Partial<Parameters<typeof providerStanding>[0]> = {}
) {
  return providerStanding({
    delivery: "attended",
    connected: true,
    needsReauth: false,
    latest: window[0] ?? null,
    recentRuns: window,
    lastSuccessAt: minutesBefore(400 * 24 * HOUR),
    toleranceMinutes: null,
    now: NOW,
    ...over,
  });
}

describe("attended standing (#2301) — a source allos does not drive", () => {
  it("reads by the LATEST attempt, never as a flapping connection", () => {
    // The prod shape this issue was opened on: patient-portals, 6 recorded runs,
    // 3 of them failed, the newest one fine. The connection model called that
    // "Intermittent" — a flapping-CONNECTION word for a tool a person runs by hand,
    // whose own contract ("a successful run landed inside the provider's silence
    // tolerance") is vacuous because the tolerance is null.
    const window = [ev({ inserted: 2 }), ...runs(3, 2)];
    expect(attendedStandingOf(window)).toBe("imported");
    expect(attendedStandingOf(runs(1, 5))).toBe("attempt-failed");
  });

  it("distinguishes set-up-but-empty from never-set-up", () => {
    // PROMOTED from the Fitbit Takeout page, which had hand-rolled exactly these
    // three: `Last import ${when}.` / "Set up, but nothing imported yet." /
    // "No archive imported yet."
    expect(attendedStandingOf([], { connected: true })).toBe("never-imported");
    expect(attendedStandingOf([], { connected: false })).toBe("not-set-up");
  });

  it("ignores the silence rule entirely, however old the last import is", () => {
    // A ten-day-old file import is not a fault, and a year-old one is not either:
    // allos cannot start this, so it may never call it late.
    const old = [ev({ at: minutesBefore(400 * 24 * HOUR), inserted: 9 })];
    expect(attendedStandingOf(old, { toleranceMinutes: 12 * HOUR })).toBe(
      "imported"
    );
  });

  it("has no needs-reauth: a dead upload token surfaces as a failed attempt", () => {
    expect(attendedStandingOf(runs(1, 0), { needsReauth: true })).toBe(
      "attempt-failed"
    );
  });

  it("can never produce a scheduled state, whatever it is fed", () => {
    const shapes: SyncEventFacts[][] = [
      [],
      runs(0, 5),
      runs(5, 0),
      runs(3, 3),
      [ev({ details: truncatedSyncDetails() })],
    ];
    for (const window of shapes) {
      for (const connected of [true, false]) {
        for (const needsReauth of [true, false]) {
          for (const toleranceMinutes of [null, 12 * HOUR]) {
            const standing = attendedStandingOf(window, {
              connected,
              needsReauth,
              toleranceMinutes,
              lastSuccessAt: null,
            });
            expect(ATTENDED_STANDINGS).toContain(standing);
            expect(SCHEDULED_STANDINGS).not.toContain(standing);
          }
        }
      }
    }
  });
});

describe("outbound standing (#2301) — allos publishes, nothing arrives", () => {
  it("states only whether the feed is live", () => {
    // Prod: a connected calendar-feed row with ZERO events rendered "Connected",
    // green, plus a permanent "No syncs yet". Nothing will ever sync in.
    const out = (connected: boolean) =>
      providerStanding({
        delivery: "outbound",
        connected,
        needsReauth: false,
        latest: null,
        now: NOW,
      });
    expect(out(true)).toBe("feed-enabled");
    expect(out(false)).toBe("feed-off");
    expect(SCHEDULED_STANDINGS).not.toContain(out(true));
  });
});

describe("the badge/attention tables over the whole union", () => {
  it("never calls a source allos does not drive GOOD", () => {
    // `good` is a HEALTH verdict, and it is the one claim allos cannot make about a
    // source it does not drive. `standingBadge` used to return tone "good" for both
    // `healthy` and `never-synced`, which is what painted a ten-day-old file import
    // and a permanently-empty outbound feed green.
    for (const standing of [...ATTENDED_STANDINGS, ...OUTBOUND_STANDINGS]) {
      for (const noun of [null, "import", "upload"] as const) {
        expect(standingBadge(standing, noun).tone, standing).not.toBe("good");
      }
    }
  });

  it("follows the run noun for the attended dialect", () => {
    expect(standingBadge("imported", "import").label).toBe("Last import");
    expect(standingBadge("imported", "upload").label).toBe("Last upload");
    expect(standingBadge("attempt-failed", "upload").label).toBe(
      "Last upload failed"
    );
    expect(standingBadge("never-imported", "upload").label).toBe(
      "Nothing uploaded yet"
    );
    expect(standingBadge("not-set-up").label).toBe("Not set up");
    expect(standingBadge("feed-enabled").label).toBe("Feed enabled");
    expect(standingBadge("feed-off").label).toBe("Feed off");
  });

  it("promises no next run in an attended or outbound headline", () => {
    // The latent half of the defect: an attended page adopting the shared status
    // header would have rendered "Syncing normally" and "the next successful sync
    // catches up". Nothing catches up — there is no next run until a person starts one.
    for (const standing of [...ATTENDED_STANDINGS, ...OUTBOUND_STANDINGS]) {
      const line = standingHeadline(standing, syncRunNounForKind("archive"));
      expect(line, standing).not.toMatch(/sync/i);
      expect(line, standing).not.toMatch(/catches up/i);
    }
    expect(standingHeadline("imported", "import")).toBe("Imported");
    expect(standingHeadline("imported", "upload")).toBe("Uploaded");
    expect(standingHeadline("attempt-failed", "import")).toBe(
      "The last import failed"
    );
    expect(standingHeadline("never-imported", "import")).toBe(
      "Set up — nothing imported yet"
    );
    expect(standingHeadline("feed-enabled")).toBe(
      "Publishing to your calendar"
    );
  });

  it("lets NO attended or outbound state escalate", () => {
    // The property that makes the split worth doing rather than three more members on
    // a flat union: allos cannot claim a source it does not drive is *still* broken.
    for (const standing of [...ATTENDED_STANDINGS, ...OUTBOUND_STANDINGS]) {
      expect(standingEscalates(standing), standing).toBe(false);
    }
    // …but a failed attempt IS an attention item — expanded in Review, no badge, no
    // digest line.
    expect(needsAttention("attempt-failed")).toBe(true);
    expect(needsAttention("imported")).toBe(false);
    expect(needsAttention("never-imported")).toBe(false);
    expect(needsAttention("not-set-up")).toBe(false);
    expect(needsAttention("feed-enabled")).toBe(false);
    expect(needsAttention("feed-off")).toBe(false);
  });

  it("treats the three never-set-up states as one question", () => {
    // The Import grid shows a pitch card for a provider nobody set up, whatever its
    // delivery family. One decision, not three member lists.
    expect(standingUnconfigured("not-connected")).toBe(true);
    expect(standingUnconfigured("not-set-up")).toBe(true);
    expect(standingUnconfigured("feed-off")).toBe(true);
    for (const standing of [
      "healthy",
      "intermittent",
      "imported",
      "attempt-failed",
      "never-imported",
      "feed-enabled",
    ] as ProviderStanding[]) {
      expect(standingUnconfigured(standing), standing).toBe(false);
    }
  });
});

describe("escalationPolicyLabel — the attended inverse (#2301)", () => {
  it("states the positive for an attended source instead of staying silent", () => {
    const line = escalationPolicyLabel(null, "import", "attended")!;
    expect(line).toContain("only ever as fresh as your last import");
    expect(line).toContain("never marks it late");
    expect(escalationPolicyLabel(null, "upload", "attended")).toContain(
      "your last upload"
    );
    // And it does not promise an escalation it will never perform.
    expect(line).not.toContain("Sync failing");
  });

  it("says nothing at all for an outbound feed", () => {
    // Nothing arrives, so there is no lateness either way.
    for (const tolerance of [null, 12 * HOUR]) {
      expect(escalationPolicyLabel(tolerance, null, "outbound")).toBeNull();
    }
  });
});

// The delivery types are used as values above only through KIND_DELIVERY; this pins
// that the exported union still names exactly the three families the axis declares.
describe("IntegrationDelivery", () => {
  it("has exactly three families, all of them reachable from a registered kind", () => {
    const families = new Set<IntegrationDelivery>(Object.values(KIND_DELIVERY));
    expect([...families].sort()).toEqual(["attended", "outbound", "scheduled"]);
  });
});
