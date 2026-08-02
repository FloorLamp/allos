// DB INTEGRATION TIER — #1685b: a connected integration that has silently stopped
// syncing raises the SAME attention item a failing one does, with its own copy, and
// reaches every surface that already reads getImportIssues.
//
// The point of the signal is the case no event-driven detector can see: the connection
// sits at `connected`, nothing has FAILED (so currentlyFailingProviders is empty and
// isAuthRefreshFailure never fired), and nothing has arrived either. This harness builds
// exactly that state from real rows — a connection plus a last successful sync event of a
// chosen age — and asserts it through the real reads the badge, the Data → Review Issues
// list and the dashboard hero use.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getImportIssues,
  getImportReviewCount,
  getIntegrationAttention,
} from "@/lib/queries/integrations";
import { isStaleSyncEvent } from "@/lib/integrations/staleness";
import { collectAttentionModel } from "@/lib/queries/attention";
import { integrationToItem } from "@/lib/attention";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function connect(
  profileId: number,
  provider: string,
  status = "connected"
): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status)
     VALUES (?, ?, ?)
     ON CONFLICT (profile_id, provider) DO UPDATE SET status = excluded.status`
  ).run(profileId, provider, status);
}

// A recorded sync event `daysAgo` days back. ok=1 is a successful (possibly quiet) sync —
// the thing whose absence staleness measures.
function syncEvent(
  profileId: number,
  provider: string,
  daysAgo: number,
  ok = 1,
  error: string | null = null
): void {
  const at = `${shiftDateStr(today(profileId), -daysAgo)} 04:00:00`;
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok, error)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profileId, provider, at, ok, error);
}

// The staleness issues among a profile's import issues.
function staleIssues(profileId: number) {
  return getImportIssues(profileId).filter(isStaleSyncEvent);
}

describe("a connected integration that stopped syncing (#1685)", () => {
  it("raises a stale issue once the last success passes the provider's threshold", () => {
    const p = newProfile("StaleStrava");
    connect(p, "strava");
    syncEvent(p, "strava", 12); // last successful poll, 12 days ago — well past 3

    const stale = staleIssues(p);
    expect(stale).toHaveLength(1);
    expect(stale[0].provider).toBe("strava");
    // The distinct copy: what we observed, and a date — never "Reconnect", which would
    // assert a cause this signal has no evidence for.
    expect(stale[0].error).toContain("No data since");
    expect(stale[0].error).toContain("12 days");
    expect(stale[0].error).not.toContain("Reconnect");
  });

  it("stays quiet for a healthy connection — this is the common case", () => {
    const p = newProfile("HealthyStrava");
    connect(p, "strava");
    syncEvent(p, "strava", 1);
    expect(staleIssues(p)).toEqual([]);
    expect(getImportIssues(p)).toEqual([]);
  });

  it("never fires for a manual archive import, however old (registry exemption)", () => {
    const p = newProfile("OldTakeout");
    connect(p, "fitbit-takeout");
    syncEvent(p, "fitbit-takeout", 400); // a Takeout import from over a year ago
    expect(staleIssues(p)).toEqual([]);
  });

  it("never fires for a connection with no successful sync yet", () => {
    const p = newProfile("NeverSynced");
    connect(p, "oura");
    // Rows exist, but none of them succeeded — a setup problem, not a stopped sync.
    syncEvent(p, "oura", 9, 0, "Oura request failed (500)");
    expect(staleIssues(p)).toEqual([]);
  });

  it("does NOT double-report a provider already flagged as failing", () => {
    const p = newProfile("FailingAndOld");
    connect(p, "withings");
    syncEvent(p, "withings", 20); // last success, long ago …
    syncEvent(p, "withings", 0, 0, "Withings token refresh failed (401)"); // … then a failure

    const issues = getImportIssues(p);
    // Exactly ONE row for the provider: the recorded failure, which names the cause.
    expect(issues.filter((e) => e.provider === "withings")).toHaveLength(1);
    expect(staleIssues(p)).toEqual([]);
    expect(issues[0].error).toContain("401");
  });

  it("ignores a disconnected connection — being off is not being broken", () => {
    const p = newProfile("DisconnectedOld");
    connect(p, "strava", "disconnected");
    syncEvent(p, "strava", 40);
    expect(staleIssues(p)).toEqual([]);
  });

  it("is profile-scoped: one profile's stopped sync is invisible to another", () => {
    const owner = newProfile("StaleOwner");
    const bystander = newProfile("StaleBystander");
    connect(owner, "oura");
    syncEvent(owner, "oura", 15);
    connect(bystander, "oura");
    syncEvent(bystander, "oura", 1);

    expect(staleIssues(owner)).toHaveLength(1);
    expect(staleIssues(bystander)).toEqual([]);
  });
});

describe("the stale signal reaches the surfaces that read import issues", () => {
  it("counts toward the Data → Review badge", () => {
    const p = newProfile("StaleBadge");
    expect(getImportReviewCount(p)).toBe(0);
    connect(p, "weather");
    syncEvent(p, "weather", 9);
    expect(getImportReviewCount(p)).toBe(1);
  });

  it("becomes an attention item with the stale copy, not the reconnect copy", () => {
    const p = newProfile("StaleAttention");
    connect(p, "withings");
    syncEvent(p, "withings", 21);

    const gathered = getIntegrationAttention(p);
    expect(gathered).toHaveLength(1);
    expect(gathered[0].kind).toBe("stale");

    const item = integrationToItem(gathered[0]);
    expect(item.title).toBe("Withings sync has stopped");
    expect(item.actionLabel).toBe("Check connection");
    expect(item.dueText).toBe("No recent data");
    // Same key + href as the failing variant: one row per provider on every surface.
    expect(item.key).toBe("integration:withings");
    expect(item.href).toBe("/integrations/withings");
    // Structural — you fix it, you don't snooze it (#524).
    expect(item.suppressible).toBe(false);
  });

  it("a failing provider still gets the reconnect copy", () => {
    const p = newProfile("FailingAttention");
    connect(p, "strava");
    // Three consecutive failures — the #1880 escalation threshold. A single failed
    // run is `intermittent` now and raises nothing (see integration-flap.test.ts).
    syncEvent(p, "strava", 2, 0, "Strava token refresh failed (401)");
    syncEvent(p, "strava", 1, 0, "Strava token refresh failed (401)");
    syncEvent(p, "strava", 0, 0, "Strava token refresh failed (401)");

    const item = integrationToItem(getIntegrationAttention(p)[0]);
    expect(item.title).toBe("Strava sync needs attention");
    expect(item.actionLabel).toBe("Reconnect");
  });

  it("lands in the shared attention model the hero and Upcoming page render", () => {
    const p = newProfile("StaleModel");
    connect(p, "oura");
    syncEvent(p, "oura", 30);

    const model = collectAttentionModel(p, today(p));
    const item = model.find((i) => i.key === "integration:oura");
    expect(item).toBeDefined();
    expect(item!.title).toBe("Oura Ring sync has stopped");
    expect(item!.signalGroup).toBe("review");
  });
});

describe("self-clearing", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM integration_sync_events").run();
  });

  it("disappears the moment a healthy sync lands — no lifecycle of its own", () => {
    const p = newProfile("StaleClears");
    connect(p, "strava");
    syncEvent(p, "strava", 12);
    expect(staleIssues(p)).toHaveLength(1);

    // One successful poll today, and the derivation stops firing on its own.
    syncEvent(p, "strava", 0);
    expect(staleIssues(p)).toEqual([]);
    expect(getImportReviewCount(p)).toBe(0);
  });
});
