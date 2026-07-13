// DB INTEGRATION TIER — Health Connect token failures surface instead of stopping
// ingest silently (#607).
//
// A push provider's only real failure mode is "the phone's bearer token no longer
// matches" (rotated or expired). Before the fix that produced NO sync event (the
// profile is unknown, so the 401 has nothing to attribute) and never consulted the
// stored expiry, so the badge/Issues/card stayed green while data silently stopped.
// This tier proves: an expired token appears in the Issues/failing read; an
// unmatched-token push records a rate-limited failure event (+ needs_reauth); and a
// fresh successful ingest self-clears both.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  generateHealthConnectToken,
  getConnection,
  upsertConnection,
  resolveHealthConnectProfile,
  recordUnmatchedHealthConnectPush,
  recordSyncEvent,
} from "@/lib/integrations/connections";
import { getImportIssues } from "@/lib/queries/integrations";

let profileId: number;

function hcIssue() {
  return getImportIssues(profileId).find(
    (e) => e.provider === "health-connect"
  );
}
function failureEventCount(): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM integration_sync_events WHERE profile_id = ? AND provider = 'health-connect' AND ok = 0"
      )
      .get(profileId) as { n: number }
  ).n;
}

beforeEach(() => {
  // Fresh profile AND a clean integration-table slate so recordUnmatchedHealthConnect
  // Push's "exactly one HC connection" attribution is deterministic across tests.
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM integration_connections");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-TOKEN')").run()
      .lastInsertRowid
  );
});

describe("expired Health Connect token surfaces in the Issues read (#607)", () => {
  it("appears as a failing provider, then clears when a fresh token is minted", () => {
    generateHealthConnectToken(profileId, "90d");
    // Force the stored expiry into the past (as if the 90d token lapsed).
    const cfg = JSON.parse(getConnection(profileId, "health-connect")!.config!);
    cfg.tokenExpiresAt = new Date(Date.now() - 3600_000).toISOString();
    upsertConnection(profileId, "health-connect", { config: cfg });

    const issue = hcIssue();
    expect(issue).toBeTruthy();
    expect(issue!.ok).toBe(0);
    expect(issue!.error).toMatch(/expired/i);

    // Minting a fresh (non-expiring) token clears the synthetic issue.
    generateHealthConnectToken(profileId, "never");
    expect(hcIssue()).toBeUndefined();
  });
});

describe("unmatched-token push records a rate-limited failure (#607)", () => {
  it("records once per window, flips needs_reauth, and self-clears on a good ingest", () => {
    const realToken = generateHealthConnectToken(profileId, "never");
    expect(getConnection(profileId, "health-connect")!.status).toBe(
      "connected"
    );

    // The phone pushes with a stale/rotated token → unmatched.
    recordUnmatchedHealthConnectPush("rotated-stale-token");
    expect(failureEventCount()).toBe(1);
    expect(getConnection(profileId, "health-connect")!.status).toBe(
      "needs_reauth"
    );
    const issue = hcIssue();
    expect(issue?.ok).toBe(0);
    expect(issue?.error).toMatch(/token no longer matches/i);

    // A flood of further stale pushes within the hour is rate-limited to one event.
    recordUnmatchedHealthConnectPush("rotated-stale-token");
    recordUnmatchedHealthConnectPush("another-wrong-token");
    expect(failureEventCount()).toBe(1);

    // The user updates the phone with the real token → a successful ingest resolves,
    // clearing needs_reauth; its ok:1 event drops HC from the failing read.
    expect(resolveHealthConnectProfile(realToken)).toBe(profileId);
    expect(getConnection(profileId, "health-connect")!.status).toBe(
      "connected"
    );
    recordSyncEvent(profileId, "health-connect", { ok: true, written: 0 });
    expect(hcIssue()).toBeUndefined();
  });

  it("does not attribute a failure when several HC connections exist", () => {
    generateHealthConnectToken(profileId, "never");
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('HC-OTHER')").run()
        .lastInsertRowid
    );
    generateHealthConnectToken(other, "never");
    // Two HC connections → can't tell which phone is misconfigured → skip (no event).
    recordUnmatchedHealthConnectPush("mystery-token");
    expect(failureEventCount()).toBe(0);
  });
});
