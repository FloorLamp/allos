// DB INTEGRATION TIER — the integration sync-event debug log (issue: integration
// debugging surface). Seeds TWO profiles, writes events under each, and proves the
// profile-scoped readers never bleed one profile's sync history into the other's —
// the same invariant the source scan asserts statically, verified here against a
// real schema. Also exercises the Health Connect write PATH (upsert → summarize →
// recordSyncEvent) end-to-end so the event a real ingest would store is checked.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  recordSyncEvent,
  recordSyncRows,
  enableWeather,
  getConnection,
  setStravaCredentials,
  setStravaTokens,
} from "@/lib/integrations/connections";
import { runStravaSync } from "@/lib/integrations/strava-sync";
import {
  provenanceCountsByEvent,
  getConnectedSources,
  getIntegrationSyncEvents,
  getLastSuccessfulSyncAt,
  getLatestSyncEvent,
  getSyncEventRawRef,
} from "@/lib/queries";
import { upsertMetricSamples } from "@/lib/integrations/normalize";
import { summarizeSplit, dateWindow } from "@/lib/integrations/sync-log";

let profileA: number;
let profileB: number;

beforeAll(() => {
  profileA = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('SYNC-A')").run()
      .lastInsertRowid
  );
  profileB = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('SYNC-B')").run()
      .lastInsertRowid
  );

  // A: a successful HC sync, then a failed one, then a Strava sync.
  recordSyncEvent(profileA, "health-connect", {
    ok: true,
    windowStart: "2024-01-01",
    windowEnd: "2024-01-02",
    received: 10,
    written: 7,
    skipped: 3,
  });
  recordSyncEvent(profileA, "health-connect", {
    ok: false,
    error: "boom",
  });
  recordSyncEvent(profileA, "strava", {
    ok: true,
    received: 2,
    written: 2,
    skipped: 0,
  });

  // B: its own HC sync, which must never surface in A's reads.
  recordSyncEvent(profileB, "health-connect", {
    ok: true,
    windowStart: "2099-12-30",
    windowEnd: "2099-12-31",
    received: 999,
    written: 999,
    skipped: 0,
  });
});

describe("integration_sync_events: profile + provider scoping", () => {
  it("returns only the querying profile's events for the given provider", () => {
    const hcA = getIntegrationSyncEvents(profileA, "health-connect");
    expect(hcA.length).toBe(2);
    expect(hcA.every((e) => e.profile_id === profileA)).toBe(true);
    expect(hcA.every((e) => e.provider === "health-connect")).toBe(true);
    // B's row (received 999) never leaks in.
    expect(hcA.some((e) => e.received === 999)).toBe(false);
  });

  it("filters by provider — the Strava event is not in the HC list", () => {
    const hcA = getIntegrationSyncEvents(profileA, "health-connect");
    expect(hcA.some((e) => e.provider === "strava")).toBe(false);
    const stravaA = getIntegrationSyncEvents(profileA, "strava");
    expect(stravaA.length).toBe(1);
    expect(stravaA[0].provider).toBe("strava");
  });

  it("returns B's own events and nothing of A's", () => {
    const hcB = getIntegrationSyncEvents(profileB, "health-connect");
    expect(hcB.length).toBe(1);
    expect(hcB[0].received).toBe(999);
    expect(hcB[0].profile_id).toBe(profileB);
  });

  it("orders newest first (most recently inserted event leads)", () => {
    const hcA = getIntegrationSyncEvents(profileA, "health-connect");
    // The failed event was inserted after the successful one → leads on id DESC.
    expect(hcA[0].ok).toBe(0);
    expect(hcA[0].error).toBe("boom");
    expect(hcA[1].ok).toBe(1);
  });

  it("getLastSuccessfulSyncAt ignores failures", () => {
    const at = getLastSuccessfulSyncAt(profileA, "health-connect");
    expect(at).toBeTruthy();
    // It must be the ok=1 event, not the later ok=0 one.
    const success = getIntegrationSyncEvents(profileA, "health-connect").find(
      (e) => e.ok === 1
    );
    expect(at).toBe(success!.at);
    // B never had a successful sync of a provider it doesn't use.
    expect(getLastSuccessfulSyncAt(profileB, "strava")).toBeNull();
  });

  it("getLatestSyncEvent returns the most recent event regardless of outcome", () => {
    const latest = getLatestSyncEvent(profileA, "health-connect");
    expect(latest?.ok).toBe(0); // the failure was newest
    expect(getLatestSyncEvent(profileB, "strava")).toBeNull();
  });
});

describe("integration_sync_events: recording is best-effort", () => {
  it("never throws when the profile_id violates the FK (swallowed)", () => {
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM integration_sync_events")
      .get() as { n: number };
    expect(() =>
      recordSyncEvent(9_999_999, "health-connect", { ok: true })
    ).not.toThrow();
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM integration_sync_events")
      .get() as { n: number };
    // The bad-FK insert was rejected + swallowed, so no row was added.
    expect(after.n).toBe(before.n);
  });
});

describe("integration_sync_events: simulated Health Connect ingest path", () => {
  it("writes an event mirroring the upsert result + data window", () => {
    // Drive the same steps the ingest route does: upsert normalized rows, then
    // summarize + record the event under the token-resolved profile.
    const rows = [
      {
        metric: "steps",
        date: "2024-05-01",
        start_time: "2024-05-01T00:00",
        end_time: "2024-05-01T23:59",
        value: 8000,
      },
      {
        metric: "steps",
        date: "2024-05-02",
        start_time: "2024-05-02T00:00",
        end_time: "2024-05-02T23:59",
        value: 9000,
      },
    ];
    const counts = upsertMetricSamples(profileA, rows, "health-connect");
    // Both rows are brand-new on this first upsert.
    expect(counts).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
    const skipped = 1; // pretend one payload record was malformed
    const tally = summarizeSplit(counts, skipped);
    const win = dateWindow(rows.map((r) => r.date));
    recordSyncEvent(profileA, "health-connect", {
      ok: true,
      windowStart: win.start,
      windowEnd: win.end,
      received: tally.received,
      written: tally.inserted + tally.updated + tally.unchanged,
      inserted: tally.inserted,
      updated: tally.updated,
      unchanged: tally.unchanged,
      skipped: tally.skipped,
    });

    const latest = getLatestSyncEvent(profileA, "health-connect")!;
    expect(latest.ok).toBe(1);
    expect(latest.written).toBe(2);
    expect(latest.inserted).toBe(2);
    expect(latest.unchanged).toBe(0);
    expect(latest.received).toBe(3);
    expect(latest.skipped).toBe(1);
    expect(latest.window_start).toBe("2024-05-01");
    expect(latest.window_end).toBe("2024-05-02");

    // The rows actually landed in metric_samples, scoped to A.
    const persisted = db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
      )
      .get(profileA) as { n: number };
    expect(persisted.n).toBe(2);

    // Idempotency check: re-upserting the same window writes no NEW rows and now
    // classifies both as unchanged (the split accounting).
    const rewritten = upsertMetricSamples(profileA, rows, "health-connect");
    expect(rewritten).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
      suppressed: 0,
      edited: 0,
    });
    const persistedAfter = db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
      )
      .get(profileA) as { n: number };
    expect(persistedAfter.n).toBe(2); // still 2 — no duplication

    // getConnection stays independent of the event log.
    expect(getConnection(profileA, "health-connect")).toBeUndefined();
  });
});

describe("integration_sync_events: Strava network throw is recorded (#476)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a rejected fetch records an ok:false event instead of vanishing unlogged", async () => {
    const p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('STRAVA-NET')").run()
        .lastInsertRowid
    );
    // A live, connected Strava with a still-valid access token, so
    // getStravaAccessToken returns WITHOUT hitting the token endpoint — the throw we
    // want to exercise is the ACTIVITY fetch inside the sync loop, the path that used
    // to escape runStravaSync unlogged.
    setStravaCredentials(p, "client-id", "client-secret");
    setStravaTokens(p, {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // > 5-min margin → no refresh
    });

    // Simulate the DNS/ECONNRESET/TLS/timeout rejection the bug report describes.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    const res = await runStravaSync(p);
    expect(res).toHaveProperty("error");

    const ev = getLatestSyncEvent(p, "strava");
    expect(ev?.ok).toBe(0);
    // The real cause is threaded into the event message, not swallowed as "(0)".
    expect(ev?.error).toContain("ECONNRESET");
  });
});

describe("integration_sync_events: raw_ref capture + profile-scoped read (#9)", () => {
  it("stores raw_ref and reads it back scoped to the owning profile", () => {
    recordSyncEvent(profileA, "strava", {
      ok: true,
      raw_ref: "strava-fixture-ref.json",
    });
    const ev = getLatestSyncEvent(profileA, "strava")!;
    expect(ev.raw_ref).toBe("strava-fixture-ref.json");
    // The profile-scoped reader resolves the ref for the owning profile...
    expect(getSyncEventRawRef(profileA, ev.id)).toBe("strava-fixture-ref.json");
    // ...but NEVER for another profile querying the same event id.
    expect(getSyncEventRawRef(profileB, ev.id)).toBeNull();
  });

  it("returns null for events recorded without a raw_ref", () => {
    recordSyncEvent(profileB, "strava", { ok: true });
    const ev = getLatestSyncEvent(profileB, "strava")!;
    expect(ev.raw_ref).toBeNull();
    expect(getSyncEventRawRef(profileB, ev.id)).toBeNull();
  });

  it("returns null for a non-existent event id", () => {
    expect(getSyncEventRawRef(profileA, 9_999_999)).toBeNull();
  });
});

// ── Weather belongs in Connected sources (issue #1614) ────────────────────────
//
// The Weather setup page has always linked to Data → Review's "Connected sources"
// for its sync history, but getConnectedSources only admitted push/oauth/token
// integrations — so Weather (kind "public") had nowhere to land: its FAILURES showed
// under Needs attention while its successful history was unreachable. It is a
// recurring source (the hourly tick pulls it and records an event per run), so it
// belongs on that surface like every other stream.
describe("getConnectedSources includes the keyless Weather stream", () => {
  let weatherProfile: number;
  let otherProfile: number;

  beforeAll(() => {
    weatherProfile = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('WEATHER-SRC')").run()
        .lastInsertRowid
    );
    otherProfile = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('WEATHER-OTHER')").run()
        .lastInsertRowid
    );
    enableWeather(weatherProfile);
    recordSyncEvent(weatherProfile, "weather", {
      ok: true,
      windowStart: "2026-07-01",
      windowEnd: "2026-07-14",
      received: 336,
      written: 336,
      inserted: 336,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    });
  });

  it("surfaces Weather with its history once it has synced", () => {
    const sources = getConnectedSources(weatherProfile);
    const weather = sources.find((s) => s.id === "weather");
    expect(weather).toBeTruthy();
    expect(weather!.kind).toBe("public");
    expect(weather!.connected).toBe(true);
    // Keyless and tick-driven, but still pullable on demand — #1772 unified the
    // setup page's redirecting sync form and Review's inline button into ONE
    // affordance, so weather joined the on-demand set instead of keeping a private
    // one. Healthy providers collapse in Review, so the button only renders where
    // there is something to act on.
    expect(weather!.canSyncNow).toBe(true);
    // It speaks the cache dialect: its counts are revised forecast cells, not records.
    expect(weather!.vocabulary).toBe("forecast");
    expect(weather!.standing).toBe("healthy");
    expect(weather!.latest?.inserted).toBe(336);
    expect(weather!.history.length).toBe(1);
  });

  it("stays profile-scoped — another profile sees no Weather card", () => {
    const sources = getConnectedSources(otherProfile);
    expect(sources.some((s) => s.id === "weather")).toBe(false);
  });

  it("still excludes the outbound calendar feed and the archive importer", () => {
    const ids = getConnectedSources(weatherProfile).map((s) => s.id);
    expect(ids).not.toContain("calendar-feed");
    expect(ids).not.toContain("fitbit-takeout");
  });

  // #1771: Weather's events carry real inserted/updated counts (hourly UV cells plus
  // the #1726 daily rows), so the old `inserted + updated > 0` gate rendered a
  // "What this wrote" expander on every successful weather sync — which then
  // apologized, permanently, because runWeatherSync records no provenance and is
  // RIGHT not to (it writes cells of a GLOBAL location-keyed cache, per #1212).
  it("reports no provenance for the weather stream, so no drill-in is offered", () => {
    const weather = getConnectedSources(weatherProfile).find(
      (s) => s.id === "weather"
    )!;
    // The split is real …
    expect(
      (weather.latest!.inserted ?? 0) + (weather.latest!.updated ?? 0)
    ).toBeGreaterThan(0);
    // … and yet nothing was recorded to drill into.
    expect(weather.provenanceCounts).toEqual({});
  });
});

// The other half of the #1771 gate: a provider that DOES record provenance still
// resolves it, so the drill-in stays reachable exactly where it can deliver.
describe("provenanceCountsByEvent — the drill-in gate, and its count", () => {
  let p: number;
  let withRows: number;
  let withoutRows: number;

  beforeAll(() => {
    p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('PROV-GATE')").run()
        .lastInsertRowid
    );
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, source)
           VALUES (?, '2026-07-08', 'cardio', 'Provenance run', 'strava')`
        )
        .run(p).lastInsertRowid
    );
    withoutRows = recordSyncEvent(p, "strava", {
      ok: true,
      inserted: 0,
      updated: 0,
      unchanged: 5,
    })!;
    withRows = recordSyncEvent(p, "strava", {
      ok: true,
      inserted: 1,
      updated: 0,
      unchanged: 4,
    })!;
    recordSyncRows(withRows, [
      {
        target_table: "activities",
        target_id: activityId,
        disposition: "inserted",
      },
    ]);
  });

  it("names only the events that recorded rows, and how many each holds", () => {
    const counts = provenanceCountsByEvent(
      p,
      "strava",
      Math.min(withRows, withoutRows)
    );
    // The COUNT is the point (#1991): the drill-in labels itself with what it will
    // LIST, so an event with one recorded row must promise exactly one.
    expect(counts[withRows]).toBe(1);
    expect(counts[withoutRows]).toBeUndefined();
  });

  it("is profile-scoped through the parent event", () => {
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('PROV-GATE-B')").run()
        .lastInsertRowid
    );
    expect(provenanceCountsByEvent(other, "strava", 1)).toEqual({});
  });

  it("threads through to the Connected-sources card", () => {
    const strava = getConnectedSources(p).find((s) => s.id === "strava")!;
    expect(strava.provenanceCounts[withRows]).toBe(1);
    expect(strava.provenanceCounts[withoutRows]).toBeUndefined();
  });
});
