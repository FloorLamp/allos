import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { utcInstant } from "@/lib/date";
import {
  getIntegrationBackfillJob,
  queueIntegrationBackfill,
  resumeDueIntegrationBackfills,
  runIntegrationBackfillJob,
} from "@/lib/integrations/backfill-jobs";
import {
  setStravaCredentials,
  setStravaTokens,
} from "@/lib/integrations/connections";
import { countMissingStravaRideDetails } from "@/lib/integrations/strava-sync";
import { resetStravaRateLimitState } from "@/lib/integrations/strava-rate-limit";
import { resetInterruptedWork } from "@/lib/migrations/boot-tasks";

const ride = {
  id: 901,
  name: "Synthetic legacy ride",
  sport_type: "Ride",
  type: "Ride",
  start_date: "2024-06-01T13:00:00Z",
  moving_time: 3600,
  elapsed_time: 3650,
  distance: 24000,
  laps: [],
  segment_efforts: [],
};

describe("integration backfill jobs", () => {
  afterEach(() => vi.unstubAllGlobals());
  let profileId: number;

  function addRide(stravaId: number): void {
    db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, distance_km,
          components, source, external_id)
       VALUES (?, '2024-06-01', 'cardio', 'Legacy ride', 60, 24,
          ?, 'strava', ?)`
    ).run(
      profileId,
      JSON.stringify([{ name: "Cycling", type: "cardio" }]),
      `strava:${stravaId}`
    );
  }

  beforeEach(() => {
    resetStravaRateLimitState();
    profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('Backfill Job Test')")
        .run().lastInsertRowid
    );
    setStravaCredentials(profileId, "backfill-client", "fake-secret");
    setStravaTokens(profileId, {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    addRide(901);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = String(url);
        if (path.endsWith("/athlete")) return Response.json({ ftp: 250 });
        if (path.endsWith("/athlete/zones")) return Response.json({});
        if (path.includes("/streams")) {
          return Response.json({
            time: { data: [0, 1] },
            watts: { data: [190, 210] },
          });
        }
        if (path.endsWith("/activities/901")) return Response.json(ride);
        throw new Error(`Unexpected URL ${path}`);
      })
    );
  });

  it("persists live progress and completes idempotently", async () => {
    const queued = queueIntegrationBackfill(
      profileId,
      "strava",
      "ride-details"
    );
    expect(queued).not.toHaveProperty("error");
    expect("job" in queued && queued.job).toMatchObject({
      status: "queued",
      total_items: 1,
      completed_items: 0,
    });

    const done = await runIntegrationBackfillJob(
      profileId,
      "strava",
      "ride-details"
    );
    expect(done).toMatchObject({
      status: "completed",
      total_items: 1,
      completed_items: 1,
      request_count: 4,
    });
    expect(
      getIntegrationBackfillJob(profileId, "strava", "ride-details")
    ).toMatchObject({ status: "completed", completed_items: 1 });

    const repeated = queueIntegrationBackfill(
      profileId,
      "strava",
      "ride-details"
    );
    expect("job" in repeated && repeated.job).toMatchObject({
      status: "completed",
      total_items: 0,
    });
  });

  it("lets the scheduled pass claim a queued job", async () => {
    const queued = queueIntegrationBackfill(
      profileId,
      "strava",
      "ride-details"
    );
    expect("job" in queued && queued.job.status).toBe("queued");

    await resumeDueIntegrationBackfills(profileId, new Date());

    expect(
      getIntegrationBackfillJob(profileId, "strava", "ride-details")
    ).toMatchObject({ status: "completed", completed_items: 1 });
  });

  it("stops automatic retries after a transient item failure", async () => {
    // A 500 is "not right now": the ride stays a candidate, so the job ends `failed`
    // and the progress line's "retrying" is a promise that can still be kept.
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith("/athlete")) return Response.json({ ftp: 250 });
      if (path.endsWith("/athlete/zones")) return Response.json({});
      if (path.endsWith("/activities/901")) {
        return new Response(null, { status: 500 });
      }
      throw new Error(`Unexpected URL ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queued = queueIntegrationBackfill(
      profileId,
      "strava",
      "ride-details"
    );
    expect("job" in queued && queued.job.status).toBe("queued");

    const failed = await runIntegrationBackfillJob(
      profileId,
      "strava",
      "ride-details"
    );
    expect(failed).toMatchObject({
      status: "failed",
      failed_items: 1,
      retry_after_at: null,
    });
    expect(failed?.error).toContain("1 ride could not be completed");

    const requests = fetchMock.mock.calls.length;
    await resumeDueIntegrationBackfills(
      profileId,
      new Date(Date.now() + 24 * 60 * 60 * 1000)
    );
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it("finishes the job when Strava refuses a candidate for good (#2196)", async () => {
    // A deleted or now-private activity 404s forever. Before #2196 that row held the
    // job in `failed` permanently — `remaining` never reached 0 because the candidate
    // query has no concept of giving up — and the bar read "1 retrying" about a
    // success that was never coming.
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith("/athlete")) return Response.json({ ftp: 250 });
      if (path.endsWith("/athlete/zones")) return Response.json({});
      if (path.endsWith("/activities/901")) {
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected URL ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    queueIntegrationBackfill(profileId, "strava", "ride-details");

    const done = await runIntegrationBackfillJob(
      profileId,
      "strava",
      "ride-details"
    );
    expect(done).toMatchObject({
      status: "completed",
      completed_items: 1,
      failed_items: 1,
      error: null,
    });

    // No automatic re-attempt: a completed job is not due, so the two requests per
    // unavailable candidate are spent only when a person asks again.
    const requests = fetchMock.mock.calls.length;
    await resumeDueIntegrationBackfills(
      profileId,
      new Date(Date.now() + 24 * 60 * 60 * 1000)
    );
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it("treats a 200 ride with no streams as a final answer, and still re-asks on demand", async () => {
    // The second permanently-stuck class: both calls succeed, the ride simply has no
    // telemetry, and the empty `streams_json` matches the candidate predicate again.
    // No HTTP-status rule would catch it — both responses are 200.
    const emptyStreams = vi.fn(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith("/athlete")) return Response.json({ ftp: 250 });
      if (path.endsWith("/athlete/zones")) return Response.json({});
      if (path.includes("/streams")) return Response.json({});
      if (path.endsWith("/activities/901")) return Response.json(ride);
      throw new Error(`Unexpected URL ${path}`);
    });
    vi.stubGlobal("fetch", emptyStreams);
    queueIntegrationBackfill(profileId, "strava", "ride-details");
    expect(
      await runIntegrationBackfillJob(profileId, "strava", "ride-details")
    ).toMatchObject({ status: "completed", failed_items: 1, error: null });

    // The verdict is NOT persisted, on purpose: the ride is still counted as missing
    // details, and a later run that finds streams — an upload Strava has since
    // processed, a re-authorized token — backfills it normally. That reversibility is
    // what buys the two requests an explicit retry spends.
    expect(countMissingStravaRideDetails(profileId)).toBe(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = String(url);
        if (path.endsWith("/athlete")) return Response.json({ ftp: 250 });
        if (path.endsWith("/athlete/zones")) return Response.json({});
        if (path.includes("/streams")) {
          return Response.json({ time: { data: [0, 1] } });
        }
        if (path.endsWith("/activities/901")) return Response.json(ride);
        throw new Error(`Unexpected URL ${path}`);
      })
    );
    const requeued = queueIntegrationBackfill(
      profileId,
      "strava",
      "ride-details"
    );
    expect("job" in requeued && requeued.job.status).toBe("queued");
    expect(
      await runIntegrationBackfillJob(profileId, "strava", "ride-details")
    ).toMatchObject({ status: "completed", completed_items: 1 });
    expect(countMissingStravaRideDetails(profileId)).toBe(0);
  });

  it("resumes a failed job's counters on a manual re-queue (#2195)", async () => {
    // Ride 901 succeeds, ride 902 hits a transient error mid-run. The imported
    // telemetry for 901 is on disk and stays there, so the retry is a RESUME: it
    // continues "1 of 2", not "0 of 1". Zeroing the counters made a job that was
    // most of the way through look like it had never run, and threw away the
    // throughput the ETA is computed from.
    addRide(902);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = String(url);
        if (path.endsWith("/athlete")) return Response.json({ ftp: 250 });
        if (path.endsWith("/athlete/zones")) return Response.json({});
        if (path.includes("/activities/902")) {
          return new Response(null, { status: 503 });
        }
        if (path.includes("/streams")) {
          return Response.json({
            time: { data: [0, 1] },
            watts: { data: [190, 210] },
          });
        }
        if (path.endsWith("/activities/901")) return Response.json(ride);
        throw new Error(`Unexpected URL ${path}`);
      })
    );

    const first = queueIntegrationBackfill(profileId, "strava", "ride-details");
    expect("job" in first && first.job).toMatchObject({
      total_items: 2,
      completed_items: 0,
    });
    const failed = await runIntegrationBackfillJob(
      profileId,
      "strava",
      "ride-details"
    );
    expect(failed).toMatchObject({
      status: "failed",
      total_items: 2,
      completed_items: 1,
      failed_items: 1,
    });
    const spentRequests = failed!.request_count;
    expect(spentRequests).toBeGreaterThan(0);
    expect(failed!.active_seconds).toBeGreaterThan(0);

    const retried = queueIntegrationBackfill(
      profileId,
      "strava",
      "ride-details"
    );
    expect("job" in retried && retried.job).toMatchObject({
      status: "queued",
      // The candidate query returns only ride 902, so a non-resuming re-queue read
      // "0 of 1" for a job that had already imported half its rides.
      total_items: 2,
      completed_items: 1,
      request_count: spentRequests,
      started_at: failed!.started_at,
    });
    expect("job" in retried && retried.job.active_seconds).toBeGreaterThan(0);
  });

  it("pauses only crash-stranded jobs for automatic recovery", () => {
    // The fixture ages `updated_at` through the SAME writer production uses
    // (utcInstant → 'YYYY-MM-DDTHH:MM:SSZ', #2205). It used to seed SQLite's bare
    // `datetime('now', ?)` shape instead, and the lease comparison is LEXICAL: with a
    // bound `Z` cutoff, ' ' (0x20) sorts before 'T' (0x54), so every same-day bare row
    // read as older than any cutoff and the FRESH job got reaped too. Seeding the
    // column's real shape is what makes this test about the lease and not about which
    // serialization the fixture happened to pick.
    const insert = db.prepare(
      `INSERT INTO integration_backfill_jobs
         (profile_id, provider, kind, label, item_noun, status, total_items,
          updated_at)
       VALUES (?, 'strava', ?, 'Test backfill', 'ride', 'running', 2, ?)`
    );
    const minutesAgo = (m: number) =>
      utcInstant(new Date(Date.now() - m * 60_000));
    insert.run(profileId, "fresh", minutesAgo(1));
    insert.run(profileId, "stranded", minutesAgo(60));

    resetInterruptedWork(db, 30);

    const rows = db
      .prepare(
        `SELECT kind, status FROM integration_backfill_jobs
          WHERE profile_id = ? ORDER BY kind`
      )
      .all(profileId);
    expect(rows).toEqual([
      { kind: "fresh", status: "running" },
      { kind: "stranded", status: "paused" },
    ]);
  });
});
