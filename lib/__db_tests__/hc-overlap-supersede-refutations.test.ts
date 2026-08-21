// DB INTEGRATION TIER — every shape that REFUTED the first cut of #3424's rule.
//
// The overlap-supersede is the only path in the app where a sync deletes a health
// reading it did not create in the same call. An adversarial review broke the first cut
// four separate ways, and each break ended with a deleted reading. The reproductions
// live here rather than in a scratchpad, because a refutation that is not in the tree is
// a refutation the next rewrite gets to make again.
//
// Each test is named for what it protects and carries the MUTATION that brings the
// defect back. They exercise the REAL ingest entry point, at the SHIPPED chunk size,
// through the REAL parser — the refutations turned on details (`dataOrigin` reading
// only `metadata.data_origin`, `chunk()` slicing at 1000) that a hand-built
// `NormMetricSample` fixture cannot see.
//
// SYNTHETIC ONLY: fictional profiles, invented counts, no PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";

/** A fresh profile per case, so one test's rows can never explain another's survival. */
function freshProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function stored(profile: number, metric: string) {
  return db
    .prepare(
      `SELECT started_at, ended_at, value FROM metric_samples
        WHERE profile_id = ? AND metric = ? ORDER BY started_at`
    )
    .all(profile, metric) as {
    started_at: string;
    ended_at: string;
    value: number;
  }[];
}

function rowCount(profile: number, metric: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = ?"
      )
      .get(profile, metric) as { n: number }
  ).n;
}

function push(profile: number, body: Record<string, unknown>) {
  return ingestHealthConnectPayload(
    profile,
    parseHealthConnectPayload(body, "UTC")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 — the chunk split, at the SHIPPED default chunk size.
// ─────────────────────────────────────────────────────────────────────────────

/** 300 one-minute buckets in the 5 hours between the two anchorings. */
function oneMinuteBuckets(
  key: string,
  valueKey: string
): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  const base = Date.UTC(2026, 4, 1, 10, 1, 0);
  for (let i = 0; i < 300; i++) {
    out.push({
      start_time: new Date(base + i * 60000).toISOString(),
      end_time: new Date(base + (i + 1) * 60000).toISOString(),
      [valueKey]: 3,
      metadata: { data_origin: ORIGIN },
    });
  }
  return { [key]: out };
}

describe("R1 — a push bigger than INGEST_CHUNK_SIZE", () => {
  // THE DEFECT. The first cut resolved a mixed-anchoring pair inside ONE PUSH with a
  // pass scoped to the CHUNK, defended by an arithmetic claim: "a `daily` push carries
  // a handful of interval rows per type against INGEST_CHUNK_SIZE = 1000". That is a
  // claim about payload COMPOSITION and the route does not enforce it —
  // MAX_INGEST_RECORDS is 100_000. With 1200 one-minute buckets sorting BETWEEN the two
  // anchorings, the pair straddled the 1000-row boundary, the pass never saw it, and
  // the per-row rule resolved it by arrival: the STALE 1800 kcal record deleted the
  // CURRENT 2400 one. Before the PR both rows survived — a visible, repairable double
  // count. After it, the correct row was gone.
  it("resolves the mixed-anchoring pair, and keeps the CURRENT row", () => {
    const p = freshProfile("R1-CHUNK");
    const result = push(p, {
      total_calories: [
        {
          start_time: "2026-05-01T15:00:00Z", // stale, pre-switch anchoring
          end_time: "2026-05-01T23:00:00Z",
          calories: 1800,
          metadata: { data_origin: ORIGIN },
        },
        {
          start_time: "2026-05-01T10:00:00Z", // re-anchored, still filling
          end_time: "2026-05-02T01:00:00Z",
          calories: 2400,
          metadata: { data_origin: ORIGIN },
        },
      ],
      ...oneMinuteBuckets("steps", "count"),
      ...oneMinuteBuckets("distance", "meters"),
      ...oneMinuteBuckets("active_calories", "calories"),
      ...oneMinuteBuckets("hydration", "liters"),
    });
    // MUTATION: move `staleBatchOverlaps` back inside `upsertMetricSamples` only, and
    // this stores [1800] — the stale record, and the current one deleted.
    expect(stored(p, "total_kcal")).toEqual([
      {
        started_at: "2026-05-01T10:00:00Z",
        ended_at: "2026-05-02T01:00:00Z",
        value: 2400,
      },
    ]);
    // Nothing in this push may DELETE anything: the pair was settled before the write,
    // and the minute buckets are out of the rule's reach entirely.
    expect(result.split.superseded).toBe(0);
  });

  it("leaves all 1200 sub-daily buckets standing", () => {
    // The granularity gate, at the scale a `1m` exporter actually produces.
    const p = freshProfile("R1-SUBDAILY");
    push(p, {
      ...oneMinuteBuckets("steps", "count"),
      ...oneMinuteBuckets("distance", "meters"),
      ...oneMinuteBuckets("active_calories", "calories"),
      ...oneMinuteBuckets("hydration", "liters"),
    });
    for (const metric of [
      "steps",
      "distance_km",
      "active_kcal",
      "hydration_l",
    ]) {
      expect(rowCount(p, metric)).toBe(300);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — the premise "an overlap is always the mixed-anchoring anomaly" is FALSE
//      for two shipped shapes.
// ─────────────────────────────────────────────────────────────────────────────

describe("R2 — nutrition at a `full` exporter setting", () => {
  // THE DEFECT. `parseHealthConnectPayload` emits one interval row per nutrient per
  // NutritionRecord with the record's REAL start and end, so a snack logged inside a
  // meal window from one origin is two legitimately nested `nutrition_kcal` rows.
  // `recommendedSettingForKey("nutrition")` is `daily`, but nothing enforces it —
  // FINE_GRAINED_CHECK is informational by its own comment and does not cover nutrition
  // at all. The first cut deleted the 800 kcal meal and kept the 150 kcal snack.
  const MEAL = {
    start_time: "2026-05-01T17:00:00Z",
    end_time: "2026-05-01T18:00:00Z",
    calories: 800,
    metadata: { data_origin: "com.myfitnesspal.android" },
  };
  const SNACK = {
    start_time: "2026-05-01T17:20:00Z",
    end_time: "2026-05-01T17:25:00Z",
    calories: 150,
    metadata: { data_origin: "com.myfitnesspal.android" },
  };

  it("stores BOTH when they arrive in one push", () => {
    // MUTATION: add `nutrition_kcal` to DAY_BUCKET_METRICS and the snack is dropped and
    // reported `unchanged`, which is invisible in Review.
    const p = freshProfile("R2-NUTRITION-ONE");
    push(p, { nutrition: [MEAL, SNACK] });
    expect(stored(p, "nutrition_kcal").map((r) => r.value)).toEqual([800, 150]);
  });

  it("does not let a later meal DELETE a stored snack", () => {
    const p = freshProfile("R2-NUTRITION-TWO");
    push(p, { nutrition: [SNACK] });
    const second = push(p, { nutrition: [MEAL] });
    expect(stored(p, "nutrition_kcal").map((r) => r.value)).toEqual([800, 150]);
    expect(second.split.superseded).toBe(0);
  });
});

describe("R2 — sleep", () => {
  // THE DEFECT. `sleep_min` is one row per session on the session's real window. Two
  // overlapping sessions are two readings, not one anomaly — and `dataOrigin` reads only
  // `metadata.data_origin`, so two devices that set none both parse to `origin = null`
  // and land in ONE supersede group.
  it("keeps two overlapping sessions from one origin", () => {
    const p = freshProfile("R2-SLEEP-ONE");
    push(p, {
      sleep: [
        {
          start_time: "2026-05-01T22:00:00Z",
          end_time: "2026-05-02T02:00:00Z",
          metadata: { data_origin: ORIGIN },
        },
        {
          start_time: "2026-05-02T01:55:00Z",
          end_time: "2026-05-02T06:00:00Z",
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    expect(rowCount(p, "sleep_min")).toBe(2);
  });

  it("keeps two DEVICES that both parse to origin = null", () => {
    // MUTATION: add `sleep_min` to DAY_BUCKET_METRICS and one whole night is destroyed.
    const p = freshProfile("R2-SLEEP-NULL-ORIGIN");
    push(p, {
      sleep: [
        {
          start_time: "2026-05-01T22:00:00Z",
          end_time: "2026-05-02T06:00:00Z",
        },
        {
          start_time: "2026-05-01T22:10:00Z",
          end_time: "2026-05-02T05:50:00Z",
        },
      ],
    });
    expect(rowCount(p, "sleep_min")).toBe(2);
  });

  it("keeps a session and every stage nested inside it", () => {
    // The `withings-sync` witness shape, now asserted on the Health Connect path too:
    // a session window with its stages nested inside it is a legitimate nesting, and
    // two `light` stages in one night are two rows of ONE metric.
    const p = freshProfile("R2-SLEEP-STAGES");
    push(p, {
      sleep: [
        {
          start_time: "2026-05-01T22:00:00Z",
          end_time: "2026-05-02T06:00:00Z",
          metadata: { data_origin: ORIGIN },
          stages: [
            {
              stage: "light",
              start_time: "2026-05-01T22:00:00Z",
              end_time: "2026-05-01T23:00:00Z",
            },
            {
              stage: "deep",
              start_time: "2026-05-01T23:00:00Z",
              end_time: "2026-05-02T01:00:00Z",
            },
            {
              stage: "rem",
              start_time: "2026-05-02T01:00:00Z",
              end_time: "2026-05-02T02:00:00Z",
            },
            {
              stage: "light",
              start_time: "2026-05-02T02:00:00Z",
              end_time: "2026-05-02T06:00:00Z",
            },
          ],
        },
      ],
    });
    expect(rowCount(p, "sleep_min")).toBe(1);
    expect(rowCount(p, "sleep_light_min")).toBe(2);
    expect(rowCount(p, "sleep_deep_min")).toBe(1);
    expect(rowCount(p, "sleep_rem_min")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — an ordinary exporter retry.
// ─────────────────────────────────────────────────────────────────────────────

describe("R4 — a byte-identical replay of a pre-switch push", () => {
  // THE DEFECT. The ingest route has no idempotency key, so a 5xx retry or a queued
  // webhook replays a whole payload. After the store had converged, replaying the
  // pre-switch Tokyo payload DELETED the current Honolulu row and re-inserted the stale
  // one — the day rolled back from 3500 to 3000. The old freshness guard could not see
  // it: it compared against the incoming row's natural-key TWIN, and the supersede had
  // already deleted that twin.
  const TOKYO = {
    steps: [
      {
        start_time: "2026-05-01T15:00:00Z",
        end_time: "2026-05-01T23:00:00Z",
        count: 3000,
        metadata: { data_origin: ORIGIN },
      },
    ],
  };
  const HONOLULU = {
    steps: [
      {
        start_time: "2026-05-01T10:00:00Z",
        end_time: "2026-05-02T01:00:00Z",
        count: 3500,
        metadata: { data_origin: ORIGIN },
      },
    ],
  };

  it("deletes nothing and leaves the converged row standing", () => {
    // MUTATION: drop `pushIsNewer` from planSupersede and the replay deletes the 3500
    // row and re-inserts 3000.
    const p = freshProfile("R4-REPLAY");
    push(p, TOKYO);
    push(p, HONOLULU);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);

    const replay = push(p, TOKYO);
    expect(replay.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);
  });

  it("holds even when the exporter stamps the payload itself", () => {
    // The same, with `payload.timestamp` present — the primary stamp rather than the
    // furthest-forward-end fallback. A replay carries the ORIGINAL stamp, so it is
    // never newer than the push it replays.
    const p = freshProfile("R4-REPLAY-STAMPED");
    const stamped = (body: Record<string, unknown>, at: string) => ({
      ...body,
      timestamp: at,
    });
    push(p, stamped(TOKYO, "2026-05-01T23:00:05Z"));
    push(p, stamped(HONOLULU, "2026-05-02T01:00:05Z"));
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);

    const replay = push(p, stamped(TOKYO, "2026-05-01T23:00:05Z"));
    expect(replay.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 — the DELETE's profile scoping, which no behavioural test can observe.
// ─────────────────────────────────────────────────────────────────────────────

describe("R5 — the supersede DELETE names profile_id", () => {
  // THE SECOND HALF OF THIS GUARD IS NOT HERE, and that is the answer rather than a gap.
  // Every id handed to the DELETE came out of the profile-scoped candidate SELECT, so
  // neutralising the DELETE's own `profile_id` clause leaves the entire DB tier green —
  // measured: 763 files, 6504 tests, exit 0. No behavioural test can see it.
  //
  // What CAN see it already ships: lib/__tests__/profile-scoping.test.ts censuses every
  // owned-table `.prepare()` literal in the tree and fails when one does not filter by
  // profile_id. Removing the clause makes THAT go red, by name. Writing a second
  // assertion here would have meant hoisting the SQL to a constant — which is precisely
  // what blinds the census, since it cannot read a non-literal `.prepare()`. Measured:
  // doing so failed the census with "non-literal .prepare(SUPERSEDE_DELETE_SQL) —
  // cannot verify scoping".
  //
  // The behavioural half below pins the candidate SELECT, which is the barrier that
  // does the work.
  it("keeps another profile's overlapping row of the same metric and origin", () => {
    // The behavioural half, which pins the SELECT: another profile's overlapping row of
    // the same metric and origin survives.
    const mine = freshProfile("R5-MINE");
    const theirs = freshProfile("R5-THEIRS");
    const row = (
      started_at: string,
      ended_at: string,
      value: number
    ): NormMetricSample => ({
      metric: "steps",
      date: "2026-05-01",
      started_at,
      ended_at,
      value,
      origin: ORIGIN,
    });
    upsertMetricSamples(
      theirs,
      [row("2026-05-01T00:00:00Z", "2026-05-01T20:00:00Z", 777)],
      HC
    );
    upsertMetricSamples(
      mine,
      [row("2026-05-01T00:00:00Z", "2026-05-01T20:00:00Z", 111)],
      HC
    );
    const counts = upsertMetricSamples(
      mine,
      [row("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", 222)],
      HC
    );
    expect(counts.superseded).toBe(1);
    expect(stored(theirs, "steps").map((r) => r.value)).toEqual([777]);
    expect(stored(mine, "steps").map((r) => r.value)).toEqual([222]);
  });
});

describe("the superseded count equals the rows actually removed", () => {
  it("counts every delete, and only deletes", () => {
    const p = freshProfile("COUNT-EXACT");
    const row = (
      started_at: string,
      ended_at: string,
      value: number
    ): NormMetricSample => ({
      metric: "steps",
      date: "2026-05-01",
      started_at,
      ended_at,
      value,
      origin: ORIGIN,
    });
    upsertMetricSamples(
      p,
      [
        row("2026-05-01T00:00:00Z", "2026-05-01T06:00:00Z", 1),
        row("2026-05-01T06:00:00Z", "2026-05-01T12:00:00Z", 2),
        row("2026-05-01T12:00:00Z", "2026-05-01T18:00:00Z", 3),
      ],
      HC
    );
    const before = rowCount(p, "steps");
    const counts = upsertMetricSamples(
      p,
      [row("2026-05-01T01:00:00Z", "2026-05-01T20:00:00Z", 9)],
      HC
    );
    const after = rowCount(p, "steps");
    // Three removed, one inserted.
    expect(counts.superseded).toBe(3);
    expect(before - after).toBe(2);
  });
});
