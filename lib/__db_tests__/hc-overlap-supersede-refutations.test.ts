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
import {
  NO_PUSH_STAMP_WARNING,
  parseHealthConnectPayload,
} from "@/lib/integrations/health-connect";
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

// EVERY REAL EXPORTER PUSH STATES `timestamp`, and the supersede now requires it —
// measured over the captured payloads: of 228 bodies, all 175 carrying an `app_version`
// (i.e. every real push) state a readable one. So these fixtures state one too, and a
// caller that wants to REPLAY a push passes that push's own stamp back.
const PUSH_BASE = Date.parse("2026-09-01T00:00:00Z");
let pushSeq = 0;

/** A direct upsert whose batch is a LATER push than the one before it. */
function upsert(
  profile: number,
  rows: NormMetricSample[],
  source: string,
  sink?: Parameters<typeof upsertMetricSamples>[3],
  options: Parameters<typeof upsertMetricSamples>[4] = {}
) {
  pushSeq += 1;
  return upsertMetricSamples(profile, rows, source, sink, {
    pushedAt:
      new Date(PUSH_BASE + pushSeq * 60_000).toISOString().slice(0, 19) + "Z",
    ...options,
  });
}
function push(
  profile: number,
  body: Record<string, unknown>,
  timestamp?: string
) {
  pushSeq += 1;
  const stamp =
    timestamp ??
    new Date(PUSH_BASE + pushSeq * 60_000).toISOString().slice(0, 19) + "Z";
  return ingestHealthConnectPayload(
    profile,
    parseHealthConnectPayload({ ...body, timestamp: stamp }, "UTC")
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

  it("will not let one device's minute bucket delete another's", () => {
    // The 1200 buckets below are back-to-back and therefore DISJOINT, so they never
    // exercise the granularity gate. This does: two devices that set no
    // `metadata.data_origin` both parse to origin = null and share ONE supersede group,
    // and their minute buckets genuinely overlap.
    // MUTATION: drop `isDayBucketWindow` and the second push deletes the first row.
    const p = freshProfile("R1-NULL-ORIGIN-MINUTES");
    push(p, {
      steps: [
        {
          start_time: "2026-05-01T10:00:00Z",
          end_time: "2026-05-01T10:01:00Z",
          count: 40,
        },
      ],
    });
    const second = push(p, {
      steps: [
        {
          start_time: "2026-05-01T10:00:30Z",
          end_time: "2026-05-01T10:01:30Z",
          count: 55,
        },
      ],
    });
    expect(second.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([40, 55]);
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

/** 300 one-minute buckets from a given UTC hour, for a metric OTHER than the pair's. */
function fillerBuckets(
  key: string,
  valueKey: string,
  year: number,
  monthIndex: number,
  day: number,
  hour: number
): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  const base = Date.UTC(year, monthIndex, day, hour, 1, 0);
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

describe("phase 1 is what settles a mixed-anchoring pair INSIDE one push", () => {
  // WHY THIS TEST EXISTS. The push stamp makes every row of one push equal in freshness,
  // so the per-row rule can neither delete nor be written against a sibling — it falls
  // back on ARRIVAL, and the batch is written in ascending started_at order. Westward the
  // re-anchored bucket starts EARLIER, so arrival happens to keep the right one and
  // disabling `staleBatchOverlaps` stays green on every westward case in the tree.
  //
  // EASTWARD IS THE OPPOSITE. Tokyo midnight is 15:00Z the day before, so the
  // still-filling re-anchored bucket starts LATER than the completed New York day it
  // overlaps. Written in start order, the STALE New York row lands first and the fresh
  // Tokyo bucket is blocked behind it. Only freshness gets this right, and only phase 1
  // applies freshness within a push.
  it("keeps the STILL-FILLING bucket even though it starts LATER", () => {
    const p = freshProfile("PHASE1-EASTWARD");
    push(p, {
      steps: [
        {
          // The pre-switch New York day, COMPLETE: 04:00Z to 04:00Z.
          start_time: "2026-08-20T04:00:00Z",
          end_time: "2026-08-21T04:00:00Z",
          count: 9000,
          metadata: { data_origin: ORIGIN },
        },
        {
          // The re-anchored Tokyo day, still filling to the push moment.
          start_time: "2026-08-20T15:00:00Z",
          end_time: "2026-08-21T06:00:00Z",
          count: 11000,
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    // MUTATION: hand `upsertMetricSamples` an empty batchStale (or move the pass back
    // inside it), and this stores the 9000 New York row instead — the old anchoring,
    // kept because it happened to be written first.
    expect(stored(p, "steps")).toEqual([
      {
        started_at: "2026-08-20T15:00:00Z",
        ended_at: "2026-08-21T06:00:00Z",
        value: 11000,
      },
    ]);
  });

  it("still keeps it when the pair is SPLIT across chunks", () => {
    // The same eastward pair, with 1200 filler rows of OTHER metrics sorting between the
    // two anchorings so the `steps` pair straddles the 1000-row chunk boundary. This is
    // the case that makes the WHOLE-PAYLOAD scope of phase 1 load-bearing rather than
    // defence in depth: a per-chunk pass never sees the pair, the stale New York row
    // lands in chunk 1, and the fresh Tokyo bucket in chunk 2 is then blocked behind it
    // by its own push stamp — silently, with `superseded` reading 0.
    const p = freshProfile("PHASE1-EASTWARD-CHUNKED");
    push(p, {
      steps: [
        {
          start_time: "2026-08-20T04:00:00Z",
          end_time: "2026-08-21T04:00:00Z",
          count: 9000,
          metadata: { data_origin: ORIGIN },
        },
        {
          start_time: "2026-08-20T15:00:00Z",
          end_time: "2026-08-21T06:00:00Z",
          count: 11000,
          metadata: { data_origin: ORIGIN },
        },
      ],
      ...fillerBuckets("distance", "meters", 2026, 7, 20, 10),
      ...fillerBuckets("active_calories", "calories", 2026, 7, 20, 10),
      ...fillerBuckets("hydration", "liters", 2026, 7, 20, 10),
      ...fillerBuckets("nutrition", "calories", 2026, 7, 20, 10),
    });
    // MUTATION: stop passing `batchStale` down from ingestHealthConnectPayload, so the
    // pass is scoped to a chunk again, and this stores the 9000 New York row.
    expect(stored(p, "steps")).toEqual([
      {
        started_at: "2026-08-20T15:00:00Z",
        ended_at: "2026-08-21T06:00:00Z",
        value: 11000,
      },
    ]);
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
// R3 (second pass) — a completed re-anchored day, which ends EARLIER than the
//                    still-filling row it corrects.
// ─────────────────────────────────────────────────────────────────────────────

describe("a re-anchored COMPLETED day still corrects the row it overlaps", () => {
  // THE DEFECT THIS PINS, and it is the worst thing either version of this rule did.
  // Freshness once fell back, for a push stating no `timestamp`, to the furthest-forward
  // `ended_at` in that push. An END is a property of the READING. A re-anchored bucket
  // for a day that has FINISHED ends earlier than the old-anchoring "today so far" row
  // it overlaps — so the fallback read the correcting push as the older one and the
  // correcting reading was never written at all:
  //
  //     stored 3000, for 3500 walked, {"inserted":0,"unchanged":1,"superseded":0}
  //
  // The bug this whole file exists to fix reads a day too HIGH, which is visible in
  // every total and repaired by the next push. That read it too LOW, looked exactly like
  // a day you did not walk, and converged on nothing.
  it("writes the 3500 and supersedes the 3000", () => {
    // MUTATION: reintroduce any window-derived push stamp and this stores 3000.
    const p = freshProfile("COMPLETED-DAY-CORRECTS");
    push(
      p,
      {
        steps: [
          {
            start_time: "2026-05-01T15:00:00Z",
            end_time: "2026-05-01T23:00:00Z",
            count: 3000,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-01T23:00:05Z"
    );
    const second = push(
      p,
      {
        steps: [
          {
            start_time: "2026-05-01T10:00:00Z",
            end_time: "2026-05-01T22:00:00Z",
            count: 3500,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-02T00:00:05Z"
    );
    expect(second.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);
  });

  it("and a push that states NO stamp deletes nothing, rather than dropping a row", () => {
    // The stampless path, which is what the fallback was invented to serve. It now
    // supersedes nothing — so the day reads HIGH, visibly, instead of a reading going
    // missing. MUTATION: let a stampless push supersede (or block) and one of the two
    // rows below disappears.
    const p = freshProfile("NO-STAMP-KEEPS-BOTH");
    const body = (start: string, end: string, count: number) => ({
      steps: [
        {
          start_time: start,
          end_time: end,
          count,
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    ingestHealthConnectPayload(
      p,
      parseHealthConnectPayload(
        body("2026-05-01T15:00:00Z", "2026-05-01T23:00:00Z", 3000),
        "UTC"
      )
    );
    const second = ingestHealthConnectPayload(
      p,
      parseHealthConnectPayload(
        body("2026-05-01T10:00:00Z", "2026-05-01T22:00:00Z", 3500),
        "UTC"
      )
    );
    expect(second.split.superseded).toBe(0);
    expect(
      stored(p, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
  });
});

describe("a STAMPLESS push can never delete, however its rows are bundled", () => {
  // The sharpest form of the window-fallback defect, and the one a merely-harmless case
  // cannot catch. A fallback of "furthest-forward end in the push" is computed over the
  // WHOLE push, so bundling a stale re-sent record with an unrelated row that happens to
  // end later — a hydration row, here — manufactures a stamp newer than the row it would
  // then delete. Nothing about the steps data changed; a glass of water did.
  const steps = (start: string, end: string, count: number) => ({
    start_time: start,
    end_time: end,
    count,
    metadata: { data_origin: ORIGIN },
  });
  const unstamped = (body: Record<string, unknown>) =>
    ingestHealthConnectPayload(p0(), parseHealthConnectPayload(body, "UTC"));
  let profile = 0;
  const p0 = () => profile;

  it("leaves the converged row alone when a stale record rides in beside a later one", () => {
    profile = freshProfile("STAMPLESS-BUNDLED");
    unstamped({
      steps: [steps("2026-05-01T15:00:00Z", "2026-05-01T23:00:00Z", 3000)],
    });
    unstamped({
      steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)],
    });
    // The replay, bundled with a hydration row reaching further forward than anything
    // stored. MUTATION: give `pushStampFor` any window-derived fallback and the 3500
    // row is deleted here, by a push that stated no time at all.
    const third = unstamped({
      steps: [steps("2026-05-01T15:00:00Z", "2026-05-01T23:00:00Z", 3000)],
      hydration: [
        {
          start_time: "2026-05-02T01:00:00Z",
          end_time: "2026-05-02T02:00:00Z",
          liters: 0.3,
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    expect(third.split.superseded).toBe(0);
    expect(
      stored(profile, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
  });

  it("says so in Review rather than going quiet about it", () => {
    // A stampless push leaves the day reading HIGH. That is the deliberate direction,
    // but it needs a cause a person can find. MUTATION: drop the warning and the only
    // symptom is a doubled step count with nothing anywhere to explain it.
    const parsed = parseHealthConnectPayload(
      { steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)] },
      "UTC"
    );
    expect(parsed.pushedAt).toBe(null);
    expect(parsed.details.warnings).toContain(NO_PUSH_STAMP_WARNING);
    // And it stays quiet when there was nothing it could have acted on anyway.
    const pointOnly = parseHealthConnectPayload(
      {
        heart_rate_variability: [
          { time: "2026-05-01T10:00:00Z", milliseconds: 40 },
        ],
      },
      "UTC"
    );
    expect(pointOnly.details.warnings).not.toContain(NO_PUSH_STAMP_WARNING);
  });
});

describe("the stored stamp is canonical", () => {
  it("re-serializes whatever spelling the exporter used", () => {
    // MUTATION: hand `upsertMetricSamples` `parsed.pushedAt` raw instead of routing it
    // through `pushStampFor`, and `metric_samples.pushed_at` starts holding two shapes —
    // which lib/__tests__/time-columns.test.ts freezes against for a new column, and
    // which also skips the clock-skew bound on the way past.
    const p = freshProfile("CANONICAL-STAMP");
    push(
      p,
      {
        steps: [
          {
            start_time: "2026-05-01T10:00:00Z",
            end_time: "2026-05-02T01:00:00Z",
            count: 3500,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-02T01:00:05.250Z"
    );
    const row = db
      .prepare(
        "SELECT pushed_at FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
      )
      .get(p) as { pushed_at: string };
    expect(row.pushed_at).toBe("2026-05-02T01:00:05Z");
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

  const T1 = "2026-05-01T23:00:05Z";
  const T2 = "2026-05-02T01:00:05Z";

  it("DELETES NOTHING — the converged row survives the replay", () => {
    // MUTATION: drop `pushIsNewer` from planSupersede and the replay deletes the 3500
    // row. That is the loss this guard exists for.
    const p = freshProfile("R4-REPLAY");
    push(p, TOKYO, T1);
    push(p, HONOLULU, T2);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);

    const replay = push(p, TOKYO, T1);
    expect(replay.split.superseded).toBe(0);
    // The stale row IS re-inserted, and that is the deliberate trade: the day reads
    // high until the next push, which is VISIBLE in every total. The version that
    // suppressed the write instead could drop a correcting reading and report
    // "nothing new" — a wrong number a person can see beats a missing one they cannot.
    expect(
      stored(p, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
  });

  it("and the NEXT genuine push collapses what the replay left", () => {
    // The other half of that trade, and the reason it is acceptable: the double count
    // is transient. MUTATION: any change that lets the replay's row keep a stamp as new
    // as the push that corrects it, and this stops converging.
    const p = freshProfile("R4-CONVERGES");
    push(p, TOKYO, T1);
    push(p, HONOLULU, T2);
    push(p, TOKYO, T1);
    const next = push(p, HONOLULU, "2026-05-02T02:00:05Z");
    expect(next.split.superseded).toBe(1);
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
    upsert(
      theirs,
      [row("2026-05-01T00:00:00Z", "2026-05-01T20:00:00Z", 777)],
      HC
    );
    upsert(
      mine,
      [row("2026-05-01T00:00:00Z", "2026-05-01T20:00:00Z", 111)],
      HC
    );
    const counts = upsert(
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
    upsert(
      p,
      [
        row("2026-05-01T00:00:00Z", "2026-05-01T06:00:00Z", 1),
        row("2026-05-01T06:00:00Z", "2026-05-01T12:00:00Z", 2),
        row("2026-05-01T12:00:00Z", "2026-05-01T18:00:00Z", 3),
      ],
      HC
    );
    const before = rowCount(p, "steps");
    const counts = upsert(
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
