// DB INTEGRATION TIER — #1880: flapping is not failing, and (#2263) what separates
// them is SILENCE, not a failure count. The standing is derived by ONE computation
// (providerStanding via getIntegrationState / resolveProviderFacts), and the
// escalation surfaces — the Review badge (getImportReviewCount), the Needs-attention
// feed (getImportIssues), and the attention/digest gather (getIntegrationAttention) —
// all read the same standingEscalates rule. This tier proves the real reads over real
// rows: a provider whose runs keep failing stays OFF every escalation surface for as
// long as a success keeps landing inside its tolerance, and the moment the successes
// stop for longer than that, every surface flips at once.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { utcInstant } from "@/lib/date";
import {
  getImportIssues,
  getImportReviewCount,
  getIntegrationAttention,
  getIntegrationState,
} from "@/lib/queries/integrations";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function connect(profileId: number, provider: string): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status)
     VALUES (?, ?, 'connected')
     ON CONFLICT (profile_id, provider) DO UPDATE SET status = excluded.status`
  ).run(profileId, provider);
}

// A sync event `hoursAgo` hours back from the app's own now. Measured against the
// CLOCK, not the calendar: the escalation rule is minute-grain silence since #2263, so
// a day-derived fixture would drift with the hour CI happens to run at.
function syncEvent(
  profileId: number,
  provider: string,
  hoursAgo: number,
  ok: number,
  error: string | null = null
): void {
  const at = utcInstant(new Date(clockNow().getTime() - hoursAgo * 3600_000));
  db.prepare(
    `INSERT INTO integration_sync_events
       (profile_id, provider, at, ok, inserted, updated, unchanged, error)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
    // The ledger stores UTC with an explicit `Z` since migration 163 (#2205).
  ).run(profileId, provider, at, ok, ok ? 1 : null, error);
}

const ERR = "weather fetch failed (503)";
// Weather's resolved silence tolerance: 12 polls × its declared hourly cadence.
const WEATHER_TOLERANCE_HOURS = 12;

describe("a flapping provider is intermittent, never escalated (#1880/#2263)", () => {
  it("derives `intermittent` for alternating failures with a recent success", () => {
    const p = newProfile("FlapCalm");
    connect(p, "weather");
    // Newest-first once read back: fail(1h), ok(2h), fail(3h), ok(4h), fail(5h), ok(6h).
    syncEvent(p, "weather", 6, 1);
    syncEvent(p, "weather", 5, 0, ERR);
    syncEvent(p, "weather", 4, 1);
    syncEvent(p, "weather", 3, 0, ERR);
    syncEvent(p, "weather", 2, 1);
    syncEvent(p, "weather", 1, 0, ERR);

    const state = getIntegrationState(p, "weather")!;
    expect(state.standing).toBe("intermittent");
    // The honest tally the amber surfaces render: 3 of the last 6 runs failed.
    expect(state.recentRuns).toEqual({ total: 6, failed: 3 });
    expect(state.lastSuccessAt).toBeTruthy();
    // …and the SIGNAL beside that noise (#2263 item 4): the successes are two hours
    // apart, which is what the failure count never said.
    expect(state.successCadenceMinutes).toBe(120);

    // NO escalation surface carries it: not the issues list, not the badge, not
    // the attention/digest gather.
    expect(getImportIssues(p)).toEqual([]);
    expect(getImportReviewCount(p)).toBe(0);
    expect(getIntegrationAttention(p)).toEqual([]);
  });

  // THE #2263 boundary, and the reason the old one was wrong: a run COUNT is not a
  // measure of whether data is arriving. Six consecutive failures with a success two
  // hours ago are calm; the same six become an outage only once the last success falls
  // outside the provider's tolerance.
  it("keeps a long failure streak calm while a success stays inside the tolerance", () => {
    const p = newProfile("FlapBoundary");
    connect(p, "weather");
    syncEvent(p, "weather", 3, 1);
    syncEvent(p, "weather", 2, 1);
    for (const h of [1.5, 1.2, 1.0, 0.8, 0.5, 0.2])
      syncEvent(p, "weather", h, 0, ERR);

    expect(getIntegrationState(p, "weather")!.standing).toBe("intermittent");
    expect(getImportIssues(p)).toEqual([]);
    expect(getImportReviewCount(p)).toBe(0);
    expect(getIntegrationAttention(p)).toEqual([]);
  });

  it("escalates everywhere at once when no success lands inside the tolerance", () => {
    const p = newProfile("FlapEscalates");
    connect(p, "weather");
    // The last success is exactly at the tolerance — still calm.
    syncEvent(p, "weather", WEATHER_TOLERANCE_HOURS, 1);
    syncEvent(p, "weather", 1, 0, ERR);
    expect(getIntegrationState(p, "weather")!.standing).toBe("intermittent");
    expect(getImportReviewCount(p)).toBe(0);

    // Push that success one hour past it: the ONE standing flips, and every surface
    // that reads it flips with it.
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND ok = 1`
    ).run(p);
    syncEvent(p, "weather", WEATHER_TOLERANCE_HOURS + 1, 1);

    const state = getIntegrationState(p, "weather")!;
    expect(state.standing).toBe("failing");
    const issues = getImportIssues(p);
    expect(issues.map((e) => e.provider)).toEqual(["weather"]);
    // The issue row is the REAL latest failure, naming its cause.
    expect(issues[0].ok).toBe(0);
    expect(issues[0].error).toBe(ERR);
    expect(getImportReviewCount(p)).toBe(1);
    expect(getIntegrationAttention(p)[0].kind).toBe("failing");
  });

  it("a fresh success de-escalates back to intermittent, then to healthy as the flap ages out", () => {
    const p = newProfile("FlapClears");
    connect(p, "weather");
    syncEvent(p, "weather", 20, 1); // the last success, past the tolerance
    syncEvent(p, "weather", 3, 0, ERR);
    syncEvent(p, "weather", 2, 0, ERR);
    syncEvent(p, "weather", 1, 0, ERR);
    expect(getIntegrationState(p, "weather")!.standing).toBe("failing");

    // One good run and the silence is over — but the window still shows the flap, so
    // the standing is the honest `intermittent`, not a clean green.
    syncEvent(p, "weather", 0, 1);
    expect(getIntegrationState(p, "weather")!.standing).toBe("intermittent");
    expect(getImportIssues(p)).toEqual([]);

    // Ten clean runs push the failures out of the standing window entirely.
    for (let i = 0; i < 10; i++) syncEvent(p, "weather", 0, 1);
    expect(getIntegrationState(p, "weather")!.standing).toBe("healthy");
  });

  it("escalates a QUIET stop with no failures recorded at all", () => {
    const p = newProfile("FlapStale");
    connect(p, "weather");
    // Nothing failed, nothing arrived: the shape no event-driven detector can see,
    // and the only one the tolerance catches. Five days is well past weather's 12 h.
    syncEvent(p, "weather", 5 * 24, 1);

    const state = getIntegrationState(p, "weather")!;
    expect(state.standing).toBe("failing");
    // Nothing recorded a cause, so the synthetic quiet-stop row states the
    // observation — one row per provider either way.
    const issues = getImportIssues(p);
    expect(issues.map((e) => e.provider)).toEqual(["weather"]);
    expect(issues[0].error).toContain("No data since");
    expect(issues[0].error).toContain("5 days");
  });

  it("the standing is the same however much display history a surface asked for", () => {
    const p = newProfile("FlapWindow");
    connect(p, "weather");
    syncEvent(p, "weather", 2, 1);
    syncEvent(p, "weather", 1, 0, ERR);

    // The grid asks for 0 rows of display history, the setup page for 25 — the
    // standing window is fixed (STANDING_RUN_WINDOW), so they agree by construction.
    expect(getIntegrationState(p, "weather", 0)!.standing).toBe("intermittent");
    expect(getIntegrationState(p, "weather", 25)!.standing).toBe(
      "intermittent"
    );
    expect(getIntegrationState(p, "weather", 0)!.history).toEqual([]);
  });
});
