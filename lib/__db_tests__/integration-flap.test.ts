// DB INTEGRATION TIER — #1880: flapping is not failing. The flap-aware standing
// (`intermittent` vs `failing`) is derived by ONE computation (providerStanding via
// getIntegrationState / resolveProviderFacts), and the escalation surfaces — the
// Review badge (getImportReviewCount), the Needs-attention feed (getImportIssues),
// and the attention/digest gather (getIntegrationAttention) — all read the same
// standingEscalates rule. This tier proves the real reads over real rows: an
// alternating Failed/Refreshed provider stays OFF every escalation surface while
// its state model says `intermittent`; the third consecutive failure (or a #1685
// staleness breach) flips every surface at once.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
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

// A sync event `hoursAgo` hours back from today's noon — recent enough that the
// provider's staleness threshold (days) never fires from these.
function syncEvent(
  profileId: number,
  provider: string,
  hoursAgo: number,
  ok: number,
  error: string | null = null
): void {
  const day = shiftDateStr(today(profileId), -Math.floor(hoursAgo / 24));
  const hour = String(12 - (hoursAgo % 24)).padStart(2, "0");
  db.prepare(
    `INSERT INTO integration_sync_events
       (profile_id, provider, at, ok, inserted, updated, unchanged, error)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
    // The ledger stores UTC with an explicit `Z` since migration 163 (#2205).
  ).run(profileId, provider, `${day}T${hour}:00:00Z`, ok, ok ? 1 : null, error);
}

const ERR = "weather fetch failed (503)";

describe("a flapping provider is intermittent, never escalated (#1880)", () => {
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

    // NO escalation surface carries it: not the issues list, not the badge, not
    // the attention/digest gather.
    expect(getImportIssues(p)).toEqual([]);
    expect(getImportReviewCount(p)).toBe(0);
    expect(getIntegrationAttention(p)).toEqual([]);
  });

  it("keeps 2 consecutive failures calm and escalates on the 3rd — everywhere at once", () => {
    const p = newProfile("FlapBoundary");
    connect(p, "weather");
    syncEvent(p, "weather", 4, 1);
    syncEvent(p, "weather", 3, 1);
    syncEvent(p, "weather", 2, 0, ERR);
    syncEvent(p, "weather", 1, 0, ERR);

    expect(getIntegrationState(p, "weather")!.standing).toBe("intermittent");
    expect(getImportReviewCount(p)).toBe(0);

    // The third consecutive failure crosses the threshold: the ONE standing flips,
    // and every surface that reads it flips with it.
    syncEvent(p, "weather", 0, 0, ERR);
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
    syncEvent(p, "weather", 3, 0, ERR);
    syncEvent(p, "weather", 2, 0, ERR);
    syncEvent(p, "weather", 1, 0, ERR);
    expect(getIntegrationState(p, "weather")!.standing).toBe("failing");

    // One good run breaks the streak — but the window still shows the flap, so the
    // standing is the honest `intermittent`, not a clean green.
    syncEvent(p, "weather", 0, 1);
    expect(getIntegrationState(p, "weather")!.standing).toBe("intermittent");
    expect(getImportIssues(p)).toEqual([]);

    // Ten clean runs push the failures out of the standing window entirely.
    for (let i = 0; i < 10; i++) syncEvent(p, "weather", 0, 1);
    expect(getIntegrationState(p, "weather")!.standing).toBe("healthy");
  });

  it("escalates a flap whose last success breached the #1685 staleness threshold", () => {
    const p = newProfile("FlapStale");
    connect(p, "weather");
    // The only success is 5 days old — past weather's 2-day registry threshold —
    // and the recent runs are a single failure: below the consecutive threshold,
    // but the staleness rule composes into the SAME standing.
    const staleDay = shiftDateStr(today(p), -5);
    db.prepare(
      `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
       VALUES (?, 'weather', ?, 1, 24)`
    ).run(p, `${staleDay} 04:00:00`);
    syncEvent(p, "weather", 1, 0, ERR);

    const state = getIntegrationState(p, "weather")!;
    expect(state.standing).toBe("failing");
    // The issue row is the recorded failure (it names a cause), not the synthetic
    // stale row — one row per provider either way.
    const issues = getImportIssues(p);
    expect(issues.map((e) => e.provider)).toEqual(["weather"]);
    expect(issues[0].error).toBe(ERR);
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
