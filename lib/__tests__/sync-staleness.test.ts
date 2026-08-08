// PURE TIER — the silence-tolerance derivation (#1685b, unified in #2263) and the
// per-provider tolerances it reads from the registry.
//
// This is the ONE rule that decides whether a connected provider is broken: no
// successful run inside its tolerance. It replaced two rules at two incompatible
// grains — a consecutive-failed-RUN count that for an hourly provider sat below that
// provider's own p90 gap between successes, and a whole-DAY threshold that could see
// silence only at day resolution. The cases below are the ones that keep the unified
// rule honest: it must fire on a connection that stopped, and must NOT fire on one
// that is merely flapping, exempt, or already reported by the reauth signal.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SILENCE_TOLERANCE_POLLS,
  formatSilence,
  formatTolerance,
  isSyncStale,
  silenceMinutes,
  silenceToleranceMinutes,
  staleSyncs,
  staleSyncDetail,
  staleSyncTitle,
  syncDay,
  type SyncFreshness,
} from "@/lib/integrations/staleness";
import { pullCadenceMinutes } from "@/lib/integrations/pull-cadence";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations/registry";

const NOW = "2026-07-30T12:00:00Z";
const HOUR = 60;
const DAY = 24 * HOUR;

// A connected provider with a 3-day tolerance whose last success was `minutes` ago.
function fresh(
  minutes: number,
  over: Partial<SyncFreshness> = {}
): SyncFreshness {
  const at = new Date(Date.parse(NOW) - minutes * 60_000);
  return {
    provider: "strava",
    lastSuccessAt: `${at.toISOString().slice(0, 19)}Z`,
    toleranceMinutes: 3 * DAY,
    alreadyFailing: false,
    ...over,
  };
}

describe("silenceToleranceMinutes", () => {
  it("reads a provider's explicit override", () => {
    expect(silenceToleranceMinutes(getIntegration("strava"))).toBe(3 * DAY);
    expect(silenceToleranceMinutes(getIntegration("oura"))).toBe(3 * DAY);
    expect(silenceToleranceMinutes(getIntegration("withings"))).toBe(3 * DAY);
  });

  it("derives an UNDECLARED tolerance from the provider's own poll cadence", () => {
    // Weather is the one provider that takes the default, which is why the default
    // is 12 polls: 12 × its declared 60-minute cadence = 12 hours. That clears its
    // measured p90 success→success gap (6 h) with headroom and still reports a real
    // outage inside half a day.
    const weather = getIntegration("weather");
    expect(weather?.silenceToleranceMinutes).toBeUndefined();
    expect(silenceToleranceMinutes(weather)).toBe(
      DEFAULT_SILENCE_TOLERANCE_POLLS * pullCadenceMinutes(weather)
    );
    expect(silenceToleranceMinutes(weather)).toBe(12 * HOUR);
  });

  it("gives a PUSH provider the tolerance it declares — there is no cadence to derive from", () => {
    // Health Connect's exporter pushes; the app polls nothing. 12 h is 7.5× its
    // measured longest non-outage silence (1.6 h), and short enough to name the
    // 16.2-hour outage inside one waking period (#2263 decision 3b).
    expect(silenceToleranceMinutes(getIntegration("health-connect"))).toBe(
      12 * HOUR
    );
  });

  it("treats a manual archive import as EXEMPT — it has no cadence to be late against", () => {
    expect(
      silenceToleranceMinutes(getIntegration("fitbit-takeout"))
    ).toBeNull();
  });

  it("treats a planned provider, an outbound feed, and attended portals as exempt", () => {
    expect(silenceToleranceMinutes(getIntegration("garmin"))).toBeNull();
    expect(silenceToleranceMinutes(getIntegration("calendar-feed"))).toBeNull();
    expect(
      silenceToleranceMinutes(getIntegration("patient-portals"))
    ).toBeNull();
  });

  it("treats an unknown provider as exempt — no cadence can be asserted for it", () => {
    expect(silenceToleranceMinutes(undefined)).toBeNull();
  });

  // COMPLETENESS, in the METRIC_KNOWLEDGE / fitness-freshness idiom: every entry
  // declares its policy, or an explicit exemption, or has a poll cadence the default
  // can be derived from. Silence is not a declaration.
  it("every registered provider RESOLVES a tolerance from a declaration it made", () => {
    const undeclared = INTEGRATIONS.filter(
      (i) => !("silenceToleranceMinutes" in i) && !i.pull
    ).map((i) => i.id);
    expect(undeclared).toEqual([]);
    // And every non-exempt one resolves to a positive number of minutes.
    for (const def of INTEGRATIONS) {
      const tolerance = silenceToleranceMinutes(def);
      if (tolerance != null) expect(tolerance).toBeGreaterThan(0);
    }
  });
});

describe("isSyncStale", () => {
  it("fires once the last success is older than the provider's tolerance", () => {
    expect(isSyncStale(fresh(4 * DAY), NOW)).toBe(true);
    expect(isSyncStale(fresh(30 * DAY), NOW)).toBe(true);
  });

  it("does NOT fire inside the tolerance, or exactly at it", () => {
    expect(isSyncStale(fresh(0), NOW)).toBe(false);
    expect(isSyncStale(fresh(2 * DAY), NOW)).toBe(false);
    // Exactly the tolerance is still within it — stale strictly AFTER the interval,
    // the same convention lib/freshness.ts uses.
    expect(isSyncStale(fresh(3 * DAY), NOW)).toBe(false);
    expect(isSyncStale(fresh(3 * DAY + 1), NOW)).toBe(true);
  });

  // THE #2263 case, at MINUTE grain — the resolution the old day-grained rule could
  // not express, and the reason weather read "Sync failing" for 29% of hours.
  it("resolves a SUB-DAY tolerance, which the day-grained rule could not", () => {
    const weather = { provider: "weather", toleranceMinutes: 12 * HOUR };
    expect(isSyncStale(fresh(2 * HOUR, weather), NOW)).toBe(false);
    expect(isSyncStale(fresh(6 * HOUR, weather), NOW)).toBe(false);
    expect(isSyncStale(fresh(12 * HOUR, weather), NOW)).toBe(false);
    expect(isSyncStale(fresh(13 * HOUR, weather), NOW)).toBe(true);
  });

  it("never fires for an exempt (null-tolerance) provider, however old", () => {
    expect(
      isSyncStale(
        fresh(400 * DAY, {
          provider: "fitbit-takeout",
          toleranceMinutes: null,
        }),
        NOW
      )
    ).toBe(false);
  });

  it("never fires for a provider ALREADY reported as failing — no double-report", () => {
    // The reauth item names the cause; a silence line naming the symptom underneath it
    // would be a second row for one broken connection.
    expect(isSyncStale(fresh(90 * DAY, { alreadyFailing: true }), NOW)).toBe(
      false
    );
  });

  it("never fires for a connection that has NEVER synced successfully", () => {
    // The copy is "no data since <date>", which requires a date. A connection that has
    // never succeeded is a setup problem its own page already shows, and firing here
    // would flag every freshly-created connection before its first tick.
    expect(isSyncStale(fresh(0, { lastSuccessAt: null }), NOW)).toBe(false);
  });

  it("never fires on a stamp in the FUTURE — a clock that stepped back is not silence", () => {
    expect(isSyncStale(fresh(-5 * DAY), NOW)).toBe(false);
  });

  it("uses a per-provider tolerance, so the same gap decides differently", () => {
    // Thirteen hours of silence: fine for a 3-day provider, broken for the 12-hour one.
    expect(isSyncStale(fresh(13 * HOUR), NOW)).toBe(false);
    expect(
      isSyncStale(
        fresh(13 * HOUR, { provider: "weather", toleranceMinutes: 12 * HOUR }),
        NOW
      )
    ).toBe(true);
  });

  it("reads the legacy bare-SQLite stamp shape as UTC, not local time", () => {
    // Pre-#2205 rows may still hold "YYYY-MM-DD HH:MM:SS" with no zone marker. Parsed
    // as local time on a TZ=America/Chicago container that would read five hours late.
    expect(silenceMinutes("2026-07-30 10:00:00", NOW)).toBe(120);
    expect(silenceMinutes("2026-07-30T10:00:00Z", NOW)).toBe(120);
    expect(silenceMinutes("not a stamp", NOW)).toBeNull();
  });
});

describe("staleSyncs", () => {
  it("returns only the quiet providers, each with its since-date, instant and duration", () => {
    const out = staleSyncs(
      [
        fresh(1 * DAY), // healthy
        fresh(10 * DAY, { provider: "oura" }), // quiet
        fresh(99 * DAY, {
          provider: "fitbit-takeout",
          toleranceMinutes: null,
        }), // exempt
        fresh(99 * DAY, { provider: "withings", alreadyFailing: true }), // reauth wins
      ],
      NOW
    );
    expect(out.map((s) => s.provider)).toEqual(["oura"]);
    expect(out[0]).toMatchObject({
      since: "2026-07-20",
      // The INSTANT, not the date: the synthetic issue row stamps `at`/`created_at`
      // with it, and those columns hold instants (#2263).
      sinceAt: "2026-07-20T12:00:00Z",
      minutes: 10 * DAY,
    });
  });

  it("is empty for a healthy set — a working setup produces no signal at all", () => {
    expect(
      staleSyncs([fresh(0), fresh(1 * DAY, { provider: "oura" })], NOW)
    ).toEqual([]);
  });
});

describe("copy", () => {
  it("states the observation and asks the user to CHECK, never to reconnect", () => {
    const detail = staleSyncDetail("Withings", {
      provider: "withings",
      since: "2026-07-12",
      sinceAt: "2026-07-12T04:00:00Z",
      minutes: 18 * DAY,
    });
    expect(detail).toContain("No data since 2026-07-12");
    expect(detail).toContain("18 days");
    // "Reconnect" would assert a cause (a dead grant) that this signal has no evidence
    // for — the connection may be perfectly authorized and simply not delivering.
    expect(detail).not.toContain("Reconnect");
    expect(staleSyncTitle("Withings")).toBe("Withings sync has stopped");
  });

  // The duration is what changed in #2263: a 14-hour silence is now escalatable, so
  // the one sentence has to speak both dialects.
  it("names a sub-day silence in HOURS and a longer one in days", () => {
    const at = (minutes: number) =>
      staleSyncDetail("Weather & UV", {
        provider: "weather",
        since: "2026-07-29",
        sinceAt: "2026-07-29T22:00:00Z",
        minutes,
      });
    expect(at(14 * HOUR)).toContain("hasn't synced successfully in 14 hours");
    expect(at(4 * DAY)).toContain("hasn't synced successfully in 4 days");
  });

  it("floors every unit, so a duration is never overstated", () => {
    expect(formatSilence(1)).toBe("1 minute");
    expect(formatSilence(45)).toBe("45 minutes");
    expect(formatSilence(119)).toBe("119 minutes");
    expect(formatSilence(120)).toBe("2 hours");
    expect(formatSilence(13 * HOUR + 59)).toBe("13 hours");
    expect(formatSilence(47 * HOUR)).toBe("47 hours");
    expect(formatSilence(48 * HOUR)).toBe("2 days");
    // Eleven days and fourteen hours is ELEVEN days, never twelve.
    expect(formatSilence(11 * DAY + 14 * HOUR)).toBe("11 days");
  });

  it("states a DECLARED tolerance exactly, in its own unit", () => {
    expect(formatTolerance(12 * HOUR)).toBe("12 hours");
    expect(formatTolerance(1 * HOUR)).toBe("1 hour");
    expect(formatTolerance(3 * DAY)).toBe("3 days");
    expect(formatTolerance(1 * DAY)).toBe("1 day");
    expect(formatTolerance(90)).toBe("90 minutes");
  });
});

describe("syncDay", () => {
  it("takes the day from either stored timestamp shape", () => {
    // SQLite datetime('now') and an ISO instant both lead with the day.
    expect(syncDay("2026-07-12 04:00:00")).toBe("2026-07-12");
    expect(syncDay("2026-07-12T04:00:00.000Z")).toBe("2026-07-12");
  });
});
