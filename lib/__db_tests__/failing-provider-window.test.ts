// DB INTEGRATION TIER — failing-provider detection is per-provider, not window-capped
// (issue #304).
//
// The badge / hero / Review-issues path used to answer "is any provider currently
// failing?" from the 100 NEWEST events across ALL providers. With one chatty provider
// (e.g. Health Connect checking in hourly) a second provider's last event — a FAILURE
// — could fall past that global window, so the badge under-reported a genuinely broken
// integration while its own grid card (an uncapped per-provider read) still showed the
// error. This proves the fix: getLatestSyncEventPerProvider is uncapped per provider,
// so getImportIssues / getImportReviewCount catch a broken provider buried behind a
// flood of newer successes — including one flipped to needs_reauth (#326).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  recordSyncEvent,
  markConnectionNeedsReauth,
  getConnection,
} from "@/lib/integrations/connections";
import {
  getImportIssues,
  getImportReviewCount,
  getLatestSyncEventPerProvider,
} from "@/lib/queries";

let profileId: number;
const CHATTY_EVENTS = 120; // comfortably past the old 100-newest global window

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('WINDOW-304')").run()
      .lastInsertRowid
  );

  // Strava's LAST event is a failure (a dead refresh token → needs_reauth). It's
  // written FIRST, so it carries the lowest id and — with the later floods tying or
  // beating it on `at` — sorts LAST in a global newest-first ordering.
  recordSyncEvent(profileId, "strava", {
    ok: false,
    error: "Strava token refresh failed (400): invalid_grant",
  });
  markConnectionNeedsReauth(profileId, "strava");

  // Now bury it: a chatty push provider checks in successfully many times, more than
  // the old 100-row global cap.
  for (let i = 0; i < CHATTY_EVENTS; i++) {
    recordSyncEvent(profileId, "health-connect", {
      ok: true,
      received: 1,
      written: 1,
      inserted: 1,
    });
  }
});

describe("failing-provider detection is per-provider (issue #304)", () => {
  it("the buried strava failure IS outside a naive 100-newest global window", () => {
    // Reproduce the OLD detector's feed to show the failure genuinely fell off it.
    const naiveWindow = db
      .prepare(
        `SELECT provider, ok FROM integration_sync_events
          WHERE profile_id = ?
          ORDER BY at DESC, id DESC
          LIMIT 100`
      )
      .all(profileId) as { provider: string; ok: number }[];
    expect(naiveWindow.length).toBe(100);
    // The strava failure is NOT in the window — the old badge/hero would miss it.
    expect(naiveWindow.some((e) => e.provider === "strava")).toBe(false);
  });

  it("getLatestSyncEventPerProvider returns one row per provider, uncapped", () => {
    const latest = getLatestSyncEventPerProvider(profileId);
    const byProvider = new Map(latest.map((e) => [e.provider, e]));
    // Exactly one row per provider that has history.
    expect(latest.length).toBe(byProvider.size);
    expect(new Set(latest.map((e) => e.provider))).toEqual(
      new Set(["strava", "health-connect"])
    );
    // Each is that provider's true latest event, matching what the grid card shows.
    expect(byProvider.get("strava")!.ok).toBe(0);
    expect(byProvider.get("health-connect")!.ok).toBe(1);
  });

  it("getImportIssues detects the buried broken provider", () => {
    const issues = getImportIssues(profileId);
    expect(issues.map((e) => e.provider)).toEqual(["strava"]);
    expect(issues[0].ok).toBe(0);
    // Sanity: the connection really is in the needs_reauth terminal state (#326).
    expect(getConnection(profileId, "strava")?.status).toBe("needs_reauth");
  });

  it("getImportReviewCount counts the buried failing provider", () => {
    // No duplicate/conflict pairs for this fresh profile, so the count is purely the
    // one currently-failing provider.
    expect(getImportReviewCount(profileId)).toBe(1);
  });

  it("a later successful strava sync self-clears the failure", () => {
    recordSyncEvent(profileId, "strava", { ok: true, received: 0, written: 0 });
    expect(getImportIssues(profileId).map((e) => e.provider)).toEqual([]);
    expect(getImportReviewCount(profileId)).toBe(0);
  });
});
