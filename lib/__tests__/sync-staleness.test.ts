// PURE TIER — the last-successful-sync staleness derivation (#1685b) and the
// per-provider thresholds it reads from the registry.
//
// This is the signal that covers the deliberate blind spot in isAuthRefreshFailure
// (#326): a 429/5xx/timeout stays transient so a cloud hiccup can't tear down a healthy
// connection, which means nothing escalates when "transient" lasts for weeks. The rules
// below are the ones that keep the cover honest — it must fire on a connection that
// stopped, and must NOT fire on a connection that is merely quiet, exempt, or already
// reported by the reauth signal.

import { describe, it, expect } from "vitest";
import {
  isSyncStale,
  staleSyncs,
  staleSyncDetail,
  staleSyncTitle,
  syncDay,
  syncStalenessThreshold,
  type SyncFreshness,
} from "@/lib/integrations/staleness";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations/registry";

const TODAY = "2026-07-30";

// A connected provider with a 3-day threshold and a last success `days` ago.
function fresh(days: number, over: Partial<SyncFreshness> = {}): SyncFreshness {
  const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86400000);
  return {
    provider: "strava",
    lastSuccessAt: `${d.toISOString().slice(0, 10)} 04:00:00`,
    thresholdDays: 3,
    alreadyFailing: false,
    ...over,
  };
}

describe("syncStalenessThreshold", () => {
  it("reads the provider's registry threshold", () => {
    expect(syncStalenessThreshold(getIntegration("strava"))).toBe(3);
    expect(syncStalenessThreshold(getIntegration("weather"))).toBe(2);
  });

  it("treats a manual archive import as EXEMPT — it has no cadence to be late against", () => {
    expect(syncStalenessThreshold(getIntegration("fitbit-takeout"))).toBeNull();
  });

  it("treats a planned provider and an outbound feed as exempt", () => {
    expect(syncStalenessThreshold(getIntegration("garmin"))).toBeNull();
    expect(syncStalenessThreshold(getIntegration("calendar-feed"))).toBeNull();
  });

  it("treats an unknown provider as exempt — no cadence can be asserted for it", () => {
    expect(syncStalenessThreshold(undefined)).toBeNull();
  });

  // The registry is the one place a threshold may be stated, so a new provider must make
  // the decision explicitly rather than inheriting silence. `null` is a valid answer;
  // omitting the field is not.
  it("every registered provider DECLARES a threshold (a number or an explicit null)", () => {
    const undeclared = INTEGRATIONS.filter((i) => !("staleAfterDays" in i)).map(
      (i) => i.id
    );
    expect(undeclared).toEqual([]);
  });
});

describe("isSyncStale", () => {
  it("fires once the last success is older than the provider's threshold", () => {
    expect(isSyncStale(fresh(4), TODAY)).toBe(true);
    expect(isSyncStale(fresh(30), TODAY)).toBe(true);
  });

  it("does NOT fire inside the threshold, or exactly at it", () => {
    expect(isSyncStale(fresh(0), TODAY)).toBe(false);
    expect(isSyncStale(fresh(2), TODAY)).toBe(false);
    // Exactly N days is still within tolerance — the threshold is "more than N".
    expect(isSyncStale(fresh(3), TODAY)).toBe(false);
  });

  it("never fires for an exempt (null-threshold) provider, however old", () => {
    expect(
      isSyncStale(
        fresh(400, { provider: "fitbit-takeout", thresholdDays: null }),
        TODAY
      )
    ).toBe(false);
  });

  it("never fires for a provider ALREADY reported as failing — no double-report", () => {
    // The reauth item names the cause; a staleness line naming the symptom underneath it
    // would be a second row for one broken connection.
    expect(isSyncStale(fresh(90, { alreadyFailing: true }), TODAY)).toBe(false);
  });

  it("never fires for a connection that has NEVER synced successfully", () => {
    // The copy is "no data since <date>", which requires a date. A connection that has
    // never succeeded is a setup problem its own page already shows, and firing here
    // would flag every freshly-created connection before its first tick.
    expect(isSyncStale(fresh(0, { lastSuccessAt: null }), TODAY)).toBe(false);
  });

  it("uses a per-provider threshold, so the same gap decides differently", () => {
    // Three days without a poll: fine for a 3-day provider, stale for the 2-day one.
    expect(isSyncStale(fresh(3, { thresholdDays: 3 }), TODAY)).toBe(false);
    expect(
      isSyncStale(fresh(3, { provider: "weather", thresholdDays: 2 }), TODAY)
    ).toBe(true);
  });
});

describe("staleSyncs", () => {
  it("returns only the quiet providers, each with its since-date and day count", () => {
    const out = staleSyncs(
      [
        fresh(1), // healthy
        fresh(10, { provider: "oura" }), // quiet
        fresh(99, { provider: "fitbit-takeout", thresholdDays: null }), // exempt
        fresh(99, { provider: "withings", alreadyFailing: true }), // reauth wins
      ],
      TODAY
    );
    expect(out.map((s) => s.provider)).toEqual(["oura"]);
    expect(out[0]).toMatchObject({ since: "2026-07-20", days: 10 });
  });

  it("is empty for a healthy set — a working setup produces no signal at all", () => {
    expect(
      staleSyncs([fresh(0), fresh(1, { provider: "oura" })], TODAY)
    ).toEqual([]);
  });
});

describe("copy", () => {
  it("states the observation and asks the user to CHECK, never to reconnect", () => {
    const detail = staleSyncDetail("Withings", {
      provider: "withings",
      since: "2026-07-12",
      days: 18,
    });
    expect(detail).toContain("No data since 2026-07-12");
    expect(detail).toContain("18 days");
    // "Reconnect" would assert a cause (a dead grant) that this signal has no evidence
    // for — the connection may be perfectly authorized and simply not delivering.
    expect(detail).not.toContain("Reconnect");
    expect(staleSyncTitle("Withings")).toBe("Withings sync has stopped");
  });
});

describe("syncDay", () => {
  it("takes the day from either stored timestamp shape", () => {
    // SQLite datetime('now') and an ISO instant both lead with the day.
    expect(syncDay("2026-07-12 04:00:00")).toBe("2026-07-12");
    expect(syncDay("2026-07-12T04:00:00.000Z")).toBe("2026-07-12");
  });
});
