import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
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
    db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, distance_km,
          components, source, external_id)
       VALUES (?, '2024-06-01', 'cardio', 'Legacy ride', 60, 24,
          ?, 'strava', 'strava:901')`
    ).run(profileId, JSON.stringify([{ name: "Cycling", type: "cardio" }]));
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

  it("stops automatic retries after a non-quota item failure", async () => {
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

  it("pauses only crash-stranded jobs for automatic recovery", () => {
    const insert = db.prepare(
      `INSERT INTO integration_backfill_jobs
         (profile_id, provider, kind, label, item_noun, status, total_items,
          updated_at)
       VALUES (?, 'strava', ?, 'Test backfill', 'ride', 'running', 2,
          datetime('now', ?))`
    );
    insert.run(profileId, "fresh", "-1 minute");
    insert.run(profileId, "stranded", "-60 minutes");

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
