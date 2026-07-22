// DB INTEGRATION TIER — Health Connect chunked write path (issue #1064) + at-ingest
// wrong-granularity diagnostics (issue #1065).
//
// #1064 chunks the ingest into bounded per-transaction batches so the generous caps
// (32 MB / 100k records) are safe — a mid-batch failure leaves the committed chunks in
// place and the next idempotent push of the rolling window re-covers the rest. This
// tier exercises the REAL upserts against a real schema and pins the load-bearing
// facts the pure tier structurally can't see:
//   • a multi-chunk batch imports fully, with correct per-metric row counts;
//   • every chunk's split folds into ONE recordSyncEvent per push (not per chunk) —
//     the #14 accounting contract;
//   • an identical re-push is all `unchanged` (idempotent across chunk boundaries);
//   • a row hand-edited mid-window survives a later chunk (the edit lock is re-read
//     per chunk, never cached across the batch);
//   • a mid-chunk failure commits the prior chunks and the next clean push converges
//     (the chunking safety argument);
//   • an over-cap rejection records the ACTIONABLE Review line (#1064 ask 3);
//   • a mis-granularity payload surfaces its hint in the Review feed read (#1065).
//
// Runs via `npm run test:db`; the `db` singleton points at a per-file temp DB (setup.ts).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { generateHealthConnectToken } from "@/lib/integrations/connections";
import { setTimezone } from "@/lib/settings";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { writeTx } from "@/lib/db";
import { getIntegrationSyncEvents } from "@/lib/queries";
import { parseHealthConnectSyncDetails } from "@/lib/integrations/sync-details";

const TZ = "UTC";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, TZ);
  return id;
}

function rowCount(table: string, profileId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_id = ?`)
      .get(profileId) as { n: number }
  ).n;
}

// Build a heart_rate payload of `count` samples at distinct consecutive minutes from
// `startIso`, one bucket per minute → `count` hr_minutes rows.
function hrSamples(startIso: string, count: number) {
  const t0 = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(t0 + i * 60_000).toISOString(),
    bpm: 60 + (i % 20),
  }));
}

describe("HC chunked ingest — orchestration (#1064)", () => {
  it("imports a 2,500-record batch across 3 chunks with correct row counts + one split", () => {
    const profileId = newProfile("HC-CHUNK-A");
    const parsed = parseHealthConnectPayload(
      { heart_rate: hrSamples("2026-06-01T00:00:00Z", 2500) },
      TZ
    );
    expect(parsed.hrMinutes.length).toBe(2500);

    // Force 3 chunks (1000 + 1000 + 500) with an explicit chunk size.
    const res = ingestHealthConnectPayload(
      profileId,
      parsed,
      "health-connect",
      1000
    );
    expect(rowCount("hr_minutes", profileId)).toBe(2500);
    // The folded split totals the whole batch, regardless of chunk count.
    expect(res.split.inserted).toBe(2500);
    expect(res.split.updated).toBe(0);
    expect(res.split.unchanged).toBe(0);
    expect(res.counts.hrMinutes).toBe(2500);
  });

  it("is idempotent across chunk boundaries: an identical re-push is all unchanged", () => {
    const profileId = newProfile("HC-CHUNK-B");
    const parsed = parseHealthConnectPayload(
      { heart_rate: hrSamples("2026-06-02T00:00:00Z", 2500) },
      TZ
    );
    ingestHealthConnectPayload(profileId, parsed, "health-connect", 1000);
    const again = ingestHealthConnectPayload(
      profileId,
      parsed,
      "health-connect",
      1000
    );
    expect(rowCount("hr_minutes", profileId)).toBe(2500); // no duplication
    expect(again.split.inserted).toBe(0);
    expect(again.split.unchanged).toBe(2500);
  });

  it("skips a row hand-edited mid-window even when it lands in a later chunk", () => {
    // The edit lock lives on body_metrics/activities/medical_records. Use activities:
    // an imported workout the user edits mid-window must survive a re-push whichever
    // chunk it falls in (the lock is re-read per chunk, never cached across the batch).
    const profileId = newProfile("HC-CHUNK-C");
    // Two exercises far enough apart to land in different chunks at size 1.
    const payload = {
      exercise: [
        {
          start_time: "2026-06-03T06:00:00Z",
          end_time: "2026-06-03T07:00:00Z",
          type: "running",
        },
        {
          start_time: "2026-06-03T09:00:00Z",
          end_time: "2026-06-03T10:00:00Z",
          type: "cycling",
        },
      ],
    };
    const parsed = parseHealthConnectPayload(payload, TZ);
    ingestHealthConnectPayload(profileId, parsed, "health-connect", 1);
    expect(rowCount("activities", profileId)).toBe(2);

    // The user hand-edits the SECOND activity (flips the edit lock + changes title).
    db.prepare(
      `UPDATE activities SET title = 'My Ride', edited = 1
        WHERE profile_id = ? AND external_id = 'health-connect:2026-06-03T09:00:00Z'`
    ).run(profileId);

    // Re-push the rolling window with a size-1 chunker (each activity is its own tx).
    const re = ingestHealthConnectPayload(
      profileId,
      parsed,
      "health-connect",
      1
    );
    // The edited row is counted in the `edited` split and left untouched...
    expect(re.split.edited).toBe(1);
    const edited = db
      .prepare(
        `SELECT title FROM activities WHERE profile_id = ? AND external_id = 'health-connect:2026-06-03T09:00:00Z'`
      )
      .get(profileId) as { title: string };
    expect(edited.title).toBe("My Ride"); // survived across the chunk boundary
    // ...the other activity re-sends as unchanged.
    expect(re.split.unchanged).toBe(1);
  });

  it("commits prior chunks on a mid-chunk failure; the next clean push converges", () => {
    const profileId = newProfile("HC-CHUNK-D");
    // Two valid samples (chunk 1) then a chunk whose 2nd row violates a NOT NULL
    // column (metric) — a genuine mid-transaction DB failure, no mocks.
    const good: NormMetricSample[] = [
      {
        metric: "steps",
        date: "2026-06-04",
        start_time: "2026-06-04T01:00:00Z",
        end_time: "2026-06-04T01:10:00Z",
        value: 100,
      },
      {
        metric: "steps",
        date: "2026-06-04",
        start_time: "2026-06-04T02:00:00Z",
        end_time: "2026-06-04T02:10:00Z",
        value: 200,
      },
    ];
    const poison = {
      metric: null as unknown as string, // NOT NULL → INSERT throws
      date: "2026-06-04",
      start_time: "2026-06-04T03:00:00Z",
      end_time: "2026-06-04T03:10:00Z",
      value: 300,
    } as NormMetricSample;
    const validInBadChunk: NormMetricSample = {
      metric: "steps",
      date: "2026-06-04",
      start_time: "2026-06-04T04:00:00Z",
      end_time: "2026-06-04T04:10:00Z",
      value: 400,
    };

    // chunkSize 2: chunk 1 = [good0, good1] commits; chunk 2 = [validInBadChunk,
    // poison] throws and rolls the WHOLE chunk back.
    let threw = false;
    try {
      for (const slice of [
        [good[0], good[1]],
        [validInBadChunk, poison],
      ]) {
        writeTx(() => upsertMetricSamples(profileId, slice, "health-connect"));
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Chunk 1's two rows committed; chunk 2 (incl. its valid row) rolled back.
    expect(rowCount("metric_samples", profileId)).toBe(2);

    // The next clean push (all valid) converges: the two committed rows re-send as
    // unchanged, the previously-rolled-back valid row inserts.
    const clean: NormMetricSample[] = [...good, validInBadChunk];
    const parsedClean = {
      bodyMetrics: [],
      samples: clean,
      hrMinutes: [],
      activities: [],
      vitals: [],
      skipped: 0,
      details: { warnings: [], origins: [] },
    };
    const res = ingestHealthConnectPayload(
      profileId,
      parsedClean,
      "health-connect",
      1000
    );
    expect(rowCount("metric_samples", profileId)).toBe(3);
    expect(res.split.inserted).toBe(1);
    expect(res.split.unchanged).toBe(2);
  });
});

describe("HC chunked ingest — one sync event per push through the route (#1064)", () => {
  let profileId: number;
  let token: string;
  beforeAll(() => {
    profileId = newProfile("HC-CHUNK-ROUTE");
    token = generateHealthConnectToken(profileId, "never");
  });

  function post(body: unknown) {
    return POST(
      new Request("http://x/api/integrations/health-connect/ingest", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );
  }

  it("records exactly ONE event for a multi-chunk push, not one per chunk", async () => {
    const res = await post({
      heart_rate: hrSamples("2026-06-05T00:00:00Z", 2500),
    });
    expect(res.status).toBe(200);

    const events = getIntegrationSyncEvents(profileId, "health-connect");
    // Exactly one event for this single push (the route default chunk size splits the
    // 2,500 rows into 3 transactions, but the accounting is per-push).
    expect(events.length).toBe(1);
    expect(events[0].ok).toBe(1);
    expect(events[0].inserted).toBe(2500);
    expect(events[0].unchanged ?? 0).toBe(0);

    // A second identical push adds exactly one MORE event, all unchanged.
    const res2 = await post({
      heart_rate: hrSamples("2026-06-05T00:00:00Z", 2500),
    });
    expect(res2.status).toBe(200);
    const events2 = getIntegrationSyncEvents(profileId, "health-connect");
    expect(events2.length).toBe(2);
    expect(events2[0].unchanged).toBe(2500);
    expect(events2[0].inserted ?? 0).toBe(0);
    expect(rowCount("hr_minutes", profileId)).toBe(2500); // no duplication
  });
});

describe("HC over-cap rejection records the actionable Review line (#1064)", () => {
  let profileId: number;
  let token: string;
  beforeAll(() => {
    profileId = newProfile("HC-OVERCAP");
    token = generateHealthConnectToken(profileId, "never");
  });

  it("a > record-cap payload → 400 generic body, actionable stored failure", async () => {
    // A payload over the 100k record cap (cheap: empty objects, dropped at parse if it
    // ever reached parsing, but the count guard rejects it first).
    const res = await POST(
      new Request("http://x/api/integrations/health-connect/ingest", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ steps: new Array(100_001).fill({}) }),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    // Generic body (#478) — no internal counts/thresholds leak to the caller.
    expect(body.error).toBe("too many records");

    const events = getIntegrationSyncEvents(profileId, "health-connect");
    const failure = events.find((e) => e.ok === 0);
    expect(failure).toBeTruthy();
    // The STORED Review line is actionable: names the remedy, not just the number.
    expect(String(failure?.error ?? "")).toMatch(/sync window/i);
    expect(String(failure?.error ?? "")).toContain("100001");
  });
});

describe("HC wrong-granularity hint surfaces in Review (#1065)", () => {
  let profileId: number;
  let token: string;
  beforeAll(() => {
    profileId = newProfile("HC-GRANULARITY");
    token = generateHealthConnectToken(profileId, "never");
  });

  it("a fine-grained steps push records a switch-to-daily hint in the sync details", async () => {
    // Steps arriving as 12 sub-daily 15-minute intervals in one day (a `15m` setting).
    const steps = Array.from({ length: 12 }, (_, i) => ({
      start_time: `2026-06-06T${String(i).padStart(2, "0")}:00:00Z`,
      end_time: `2026-06-06T${String(i).padStart(2, "0")}:15:00Z`,
      count: 300,
    }));
    const res = await POST(
      new Request("http://x/api/integrations/health-connect/ingest", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ steps }),
      })
    );
    expect(res.status).toBe(200);

    const events = getIntegrationSyncEvents(profileId, "health-connect");
    const details = parseHealthConnectSyncDetails(events[0].details ?? null);
    expect(details).toBeTruthy();
    expect(
      details!.warnings.some((w) => /Steps/.test(w) && /daily/.test(w))
    ).toBe(true);
  });
});
