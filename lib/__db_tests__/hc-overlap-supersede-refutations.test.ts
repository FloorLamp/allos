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
  overlapsLeftWarning,
  parseHealthConnectPayload,
} from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import {
  applyMetricSampleSupersede,
  planMetricSampleSupersede,
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { pushMetricSamples } from "./hc-metric-sample-push";
import { pushStampFor } from "@/lib/metric-window-overlap";
import { writeImportTombstone } from "@/lib/integrations/tombstones";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";

/** A fresh profile per case, so one test's rows can never explain another's survival. */
function freshProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function warningsOf(_result: unknown): string[] {
  return lastParsedDetails?.warnings ?? [];
}

/** The details object of the most recent push, which the ingest appends its line to. */
let lastParsedDetails: { warnings: string[] } | null = null;

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
//
// AND STATE ONE IN THE PAST (#3438). `pushStampFor` nulls a stated instant more than
// MAX_PUSH_CLOCK_SKEW_MS ahead of the server clock. This file used to date its pushes
// 2026-09-01, ten days after the day it was written, so every `push()` here — which goes
// through the REAL ingest — was running with `pushedAt: null` and superseding nothing:
// the "the rule declined" assertions below were passing for the wrong reason, and their
// stated MUTATIONS could not have gone red. The case at the end of this file pins it.
const PUSH_BASE = Date.parse("2026-08-21T18:00:00Z");
let pushSeq = 0;
const stampFor = (seq: number) =>
  new Date(PUSH_BASE + seq * 60_000).toISOString().slice(0, 19) + "Z";

/** A direct upsert whose batch is a LATER push than the one before it. */
function upsert(
  profile: number,
  rows: NormMetricSample[],
  source: string,
  sink?: Parameters<typeof upsertMetricSamples>[3],
  options: Parameters<typeof upsertMetricSamples>[4] = {}
) {
  pushSeq += 1;
  // The three passes the ingest runs, not `upsertMetricSamples` alone — the supersede
  // does not live in the upsert loop any more (#3424, owner ruling option 2).
  return pushMetricSamples(profile, rows, source, sink, {
    pushedAt: stampFor(pushSeq),
    ...options,
  });
}
function push(
  profile: number,
  body: Record<string, unknown>,
  timestamp?: string
) {
  pushSeq += 1;
  const stamp = timestamp ?? stampFor(pushSeq);
  const parsed = parseHealthConnectPayload(
    { ...body, timestamp: stamp },
    "UTC"
  );
  lastParsedDetails = parsed.details;
  return ingestHealthConnectPayload(profile, parsed);
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
  it("stores both anchorings and deletes nothing, at the shipped chunk size", () => {
    // THE ORIGINAL DEFECT: the pair straddled the 1000-row boundary, the batch-scoped
    // pass never saw it, and the per-row rule resolved it by ARRIVAL — the stale 1800
    // record deleting the current 2400 one. Both halves of that are now impossible: the
    // rows of one push share a stamp so neither can supersede the other, and there is no
    // within-push ranking left to depend on which chunk a row landed in.
    // MUTATION: let a row supersede another of the same push (relax `pushIsNewer` to
    // `>=`) and which of these two survives becomes a function of the chunk split.
    const p = freshProfile("R1-CHUNK");
    const result = push(
      p,
      {
        total_calories: [
          {
            start_time: "2026-05-01T15:00:00Z", // pre-switch anchoring
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
      },
      "2026-05-02T01:00:05Z"
    );
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "total_kcal").map((r) => r.value)).toEqual([2400, 1800]);
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

/** One Health Connect steps record, origin-tagged the way `dataOrigin` actually reads. */
function steps(start: string, end: string, count: number) {
  return {
    start_time: start,
    end_time: end,
    count,
    metadata: { data_origin: ORIGIN },
  };
}

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

describe("a push carrying BOTH anchorings leaves a double count, and converges", () => {
  // THERE IS NO WITHIN-PUSH RULE, and this is what that costs. #3424 says the rolling
  // window re-sends the pre-switch record ALONGSIDE the re-anchored one, so two earlier
  // versions had a first phase that picked a winner between two overlapping rows of ONE
  // push. Ask what evidence such a phase could use and there is none: the stamp is
  // per-PUSH so both rows carry the same one, and the ENDS are a window quantity that
  // lib/metric-window-overlap.ts's header spends a page explaining is invalid on exactly
  // this pair. The phase that ranked by ends stored 3000 for 3500 walked, and against an
  // already-converged store its kept stale row then superseded the correct one.
  //
  // Measured over the captured payloads before removing it: 306 pushes, 964 additive
  // records, 394 at day-bucket granularity, TWO distinct anchorings present in the
  // corpus (04:00Z and 00:00Z) — and NOT ONE push carrying two overlapping
  // same-(metric, origin) day buckets. A record carries `start_time`, `end_time`, its
  // value and `metadata.data_origin`: one metadata key, no id, no last-modified time,
  // no client record version, no device.
  //
  // So both rows are stored. The day reads HIGH — visible in every total, said out loud
  // in Review — and the next push whose stamp is newer collapses it.
  const NY = steps("2026-08-20T04:00:00Z", "2026-08-21T04:00:00Z", 9000);
  const TOKYO = steps("2026-08-20T15:00:00Z", "2026-08-21T06:00:00Z", 11000);

  // SEEDED, NOT FRESH — and that is the correction the owner's ruling made explicit.
  // Every earlier version of these three cases pushed into an EMPTY store, where ruling
  // item 3 does no work at all: with nothing stored, "both are written" is what an
  // ordinary insert does, and five review rounds could each read that green as proof the
  // rule held. The configuration item 3 actually governs is a mixed-anchoring push
  // against a store that ALREADY HOLDS ONE OF THE TWO — where the re-sent row is both a
  // row the push will upsert and a row the push's other bucket outranks and overlaps.
  const seedNY = (p: number) =>
    push(p, { steps: [NY] }, "2026-08-21T05:00:05Z");

  it("stores both, says so, and deletes nothing", () => {
    // MUTATION: drop the push-key exclusion from `planMetricSampleSupersede` and the
    // stored NY row is deleted here — by the TOKYO bucket of the very push that is
    // re-sending it. Whether it came back then depended on which of the two the loop
    // reached first, which is rounds 1 and 5 in one fixture.
    const p = freshProfile("BOTH-ANCHORINGS-ONE-PUSH");
    seedNY(p);
    const only = push(p, { steps: [NY, TOKYO] }, "2026-08-21T06:00:05Z");
    expect(only.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000, 11000]);
    expect(warningsOf(only)).toContain(overlapsLeftWarning(1));
  });

  it("says so even when the store held NEITHER of the two", () => {
    // ROUND 6's REFUTATION, AND THE GAP THE SEEDING CORRECTION OPENED. Every case above
    // seeds the store, which is right for pinning the push-key exclusion — but it made
    // the store-holds-NEITHER push the one configuration nothing covered, and that is the
    // configuration where the Review line was silent. `leftStanding` is stored row IDS,
    // so it can only ever name rows that were in the table before the push; two rows of
    // ONE push are never in each other's candidate sets. Both rows are written (right,
    // ruling item 3), the day sums 20000 for 11000 walked — and the push reported
    // `superseded: 0`, `overlapsLeft: 0`, `warnings: []`.
    //
    // MUTATION: drop `inPushDoubleCounts` from the plan (or stop adding it in the ingest)
    // and this goes back to a silent wrong total, with every other spec in this file and
    // in hc-overlap-supersede.test.ts still green.
    const p = freshProfile("BOTH-ANCHORINGS-EMPTY-STORE");
    const only = push(p, { steps: [NY, TOKYO] }, "2026-08-21T06:00:05Z");
    expect(only.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000, 11000]);
    // ONE, not two. The excess is what the day carries beyond the first reading, which is
    // the same number the seeded case above reports for the same symptom — there the
    // stale row is a stored one, here it is the push's own.
    expect(warningsOf(only)).toContain(overlapsLeftWarning(1));
  });

  it("stays quiet when the two buckets of one push do NOT overlap", () => {
    // The other direction, because a count that fires on every multi-day push would be
    // worse than one that never fires. Consecutive day buckets under ONE anchoring tile
    // rather than nest — that is the premise the whole rule rests on — so a push carrying
    // two of them is the ordinary case and says nothing.
    const p = freshProfile("BOTH-ANCHORINGS-DISJOINT");
    const quiet = push(
      p,
      {
        steps: [
          steps("2026-08-19T04:00:00Z", "2026-08-20T04:00:00Z", 8000),
          NY,
        ],
      },
      "2026-08-21T06:00:05Z"
    );
    expect(quiet.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 9000]);
    expect(warningsOf(quiet)).toEqual([]);
  });

  it("collapses on the next push that carries only the new anchoring", () => {
    // The half that makes the trade acceptable: it is transient, and it converges
    // WITHOUT anything having to decide between two rows of one push.
    const p = freshProfile("BOTH-ANCHORINGS-CONVERGE");
    seedNY(p);
    push(p, { steps: [NY, TOKYO] }, "2026-08-21T06:00:05Z");
    const next = push(
      p,
      { steps: [steps("2026-08-20T15:00:00Z", "2026-08-21T12:00:00Z", 11400)] },
      "2026-08-21T12:00:05Z"
    );
    expect(next.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([11400]);
  });

  it("does the same when the pair is SPLIT across chunks", () => {
    // At the shipped chunk size, with 1200 filler rows of other metrics sorting between
    // the two anchorings. Nothing here depends on which chunk a row landed in, which is
    // the property the first refutation was about.
    const p = freshProfile("BOTH-ANCHORINGS-CHUNKED");
    seedNY(p);
    const split = push(
      p,
      {
        steps: [NY, TOKYO],
        ...fillerBuckets("distance", "meters", 2026, 7, 20, 10),
        ...fillerBuckets("active_calories", "calories", 2026, 7, 20, 10),
        ...fillerBuckets("hydration", "liters", 2026, 7, 20, 10),
        ...fillerBuckets("nutrition", "calories", 2026, 7, 20, 10),
      },
      "2026-08-21T06:00:05Z"
    );
    expect(split.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000, 11000]);
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
  const unstamped = (body: Record<string, unknown>) => {
    const parsed = parseHealthConnectPayload(body, "UTC");
    lastParsedDetails = parsed.details;
    return ingestHealthConnectPayload(p0(), parsed);
  };
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

  it("says so in Review, from what HAPPENED rather than from why", () => {
    // MUTATION: gate the line on `parsed.pushedAt === null` again and it is wrong in
    // BOTH directions — it fires for a stampless push whose windows the rule could never
    // have acted on, and stays SILENT when the clock bound rejects a stamp that is
    // present and readable, or when a phone whose clock went backwards stamps every push
    // in the past. All three leave the same double count.
    profile = freshProfile("OVERLAP-LEFT-WARNS");
    unstamped({
      steps: [steps("2026-05-01T15:00:00Z", "2026-05-01T23:00:00Z", 3000)],
    });
    const second = unstamped({
      steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)],
    });
    expect(second.split.superseded).toBe(0);
    expect(warningsOf(second)).toContain(overlapsLeftWarning(1));

    // A stamp the CLOCK BOUND refuses says the same thing, though `pushedAt` is set.
    const far = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    const third = push(
      profile,
      { steps: [steps("2026-05-01T09:00:00Z", "2026-05-02T02:00:00Z", 3600)] },
      far.slice(0, 19) + "Z"
    );
    expect(third.split.superseded).toBe(0);
    expect(warningsOf(third)).toContain(overlapsLeftWarning(2));
  });

  it("stays quiet when there was no overlap to leave standing", () => {
    // MUTATION: emit the line unconditionally, or from a shape test that answers true
    // for everything, and every ordinary push starts announcing a problem it does not
    // have — which is how a real signal gets tuned out.
    profile = freshProfile("OVERLAP-LEFT-QUIET");
    const only = unstamped({
      steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)],
    });
    expect(warningsOf(only).some((w) => w.includes("timezone change"))).toBe(
      false
    );
    // Nor for a payload with nothing the rule could ever act on.
    const points = unstamped({
      heart_rate_variability: [
        { time: "2026-05-01T10:00:00Z", milliseconds: 40 },
      ],
    });
    expect(warningsOf(points).some((w) => w.includes("timezone change"))).toBe(
      false
    );
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

describe("m24i — a Health Connect push meets a FOREIGN source's row", () => {
  // THE MUTANT THAT SURVIVED THE WHOLE SUITE. The source gate exists twice — the
  // `supersedes` flag, and `AND source = ?` in the candidate SELECT — and only the flag
  // was observed. Every "leaves other sources alone" case pushed a NON-HC source at
  // non-HC rows, so an HC push had never been let anywhere near a foreign row. Drop the
  // SELECT's clause and a Health Connect push DELETES A WITHINGS ROW, with both tiers
  // green.
  //
  // The window below is deliberately one a Withings sleep session really can occupy and
  // one the rule really would act on if it could see it: same profile, same metric, same
  // origin (null on both), overlapping, day-bucket granularity, no edit lock, and an
  // older `pushed_at` — every precondition satisfied except the source.
  it("never reaches it, whatever else lines up", () => {
    const p = freshProfile("M24I-FOREIGN-SOURCE");
    const foreign: NormMetricSample = {
      metric: "steps",
      date: "2026-05-01",
      started_at: "2026-05-01T00:00:00Z",
      ended_at: "2026-05-01T20:00:00Z",
      value: 4242,
      origin: null,
    };
    upsert(p, [foreign], "withings");
    // ...and an ordinary Health Connect day bucket that covers the same window.
    const counts = upsert(
      p,
      [{ ...foreign, started_at: "2026-05-01T04:00:00Z", value: 9000 }],
      HC
    );
    expect(counts.superseded).toBe(0);
    const bySource = db
      .prepare(
        `SELECT source, value FROM metric_samples
          WHERE profile_id = ? AND metric = 'steps' ORDER BY source`
      )
      .all(p) as { source: string; value: number }[];
    expect(bySource).toEqual([
      { source: HC, value: 9000 },
      { source: "withings", value: 4242 },
    ]);
  });

  it("and the reverse: a foreign push never reaches a Health Connect row", () => {
    const p = freshProfile("M24I-REVERSE");
    const row: NormMetricSample = {
      metric: "steps",
      date: "2026-05-01",
      started_at: "2026-05-01T04:00:00Z",
      ended_at: "2026-05-02T04:00:00Z",
      value: 9000,
      origin: null,
    };
    upsert(p, [row], HC);
    upsert(
      p,
      [{ ...row, started_at: "2026-05-01T00:00:00Z", value: 4242 }],
      "withings"
    );
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
          )
          .get(p) as { n: number }
      ).n
    ).toBe(2);
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

// ─────────────────────────────────────────────────────────────────────────────
// D1 — WHERE PASS B COMMITS, which is the one thing the owner reversed.
// ─────────────────────────────────────────────────────────────────────────────

describe("D1 — the deletes commit with the LAST chunk", () => {
  // THE DEFECT, AND IT SHIPPED IN THREE ROUNDS OF THIS PR. Pass B ran inside the FIRST
  // chunk's transaction, justified by a sentence that is still true — "a crash between
  // the deletes and the writes must not leave a day reading LOW with nothing in flight
  // to restore it". First-chunk placement satisfies that only when the push is ONE
  // chunk. Split it and the sentence is inverted: the deletes commit with chunk 1,
  // chunk 2 fails, and the day reads NOTHING where `main` still reads the old row —
  // measured at 8000 → nothing. The owner corrected the placement (#3424, the ruling of
  // 2026-08-22) and pinned the invariant instead:
  //
  //     at every commit point the store holds the OLD rows, or OLD + NEW, or NEW —
  //     NEVER NEITHER. A day may read HIGH between commits; it must never read LOWER
  //     than `main` would.
  //
  // MUTATION for both tests below: move `applyMetricSampleSupersede` back to the first
  // chunk (`remaining === orderedSamples.length - slice.length`, or the `pending` flag
  // the earlier rounds used) in `ingestHealthConnectPayload`. The crash test then finds
  // the seeded 8000 gone.

  const LA = "2026-05-01T07:00:00Z";

  /** The pre-push store: one NY-anchored day bucket, stamped by an earlier push. */
  function seedNyDay(p: number): void {
    push(
      p,
      {
        app_version: "1.9.14",
        steps: [
          {
            start_time: "2026-05-01T04:00:00Z",
            end_time: "2026-05-02T04:00:00Z",
            count: 8000,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-02T05:00:00Z"
    );
  }

  /** Three LA-anchored day buckets — one chunk each at chunkSize 1, in start order. */
  const LA_PUSH = {
    app_version: "1.9.14",
    steps: [
      {
        start_time: "2026-04-30T07:00:00Z",
        end_time: "2026-05-01T07:00:00Z",
        count: 7000,
        metadata: { data_origin: ORIGIN },
      },
      {
        start_time: LA,
        end_time: "2026-05-02T07:00:00Z",
        count: 8100,
        metadata: { data_origin: ORIGIN },
      },
      {
        start_time: "2026-05-02T07:00:00Z",
        end_time: "2026-05-03T07:00:00Z",
        count: 900,
        metadata: { data_origin: ORIGIN },
      },
    ],
  };

  /**
   * Make one statement of the real write path fail, the way a disk error or a constraint
   * would: a trigger scoped to ONE profile that ABORTs. It fails INSIDE the chunk's
   * transaction, which is the only way to observe where a transaction boundary actually
   * falls — a spy on the module would test the mock's boundaries instead of SQLite's.
   */
  function abortOn(sql: string): () => void {
    db.exec(`CREATE TEMP TRIGGER d1_abort ${sql}`);
    return () => db.exec("DROP TRIGGER d1_abort");
  }

  function pushChunked(
    p: number,
    body: Record<string, unknown>,
    timestamp: string,
    chunkSize: number
  ) {
    const parsed = parseHealthConnectPayload({ ...body, timestamp }, "UTC");
    lastParsedDetails = parsed.details;
    return ingestHealthConnectPayload(p, parsed, HC, chunkSize);
  }

  /**
   * The concurrent push, as a trigger: it re-stamps one stored row while pass C is
   * inserting, which is exactly the window pass B's `pushed_at IS ?` clause defends.
   * A trigger rather than a spy for the same reason `abortOn` is one — it fires inside
   * the real transaction, so what is observed is SQLite's boundary and not a mock's.
   */
  function restampOn(p: number, startedAt: string, stamp: string): () => void {
    db.exec(
      `CREATE TEMP TRIGGER d1_restamp AFTER INSERT ON metric_samples
         WHEN NEW.profile_id = ${p}
         BEGIN UPDATE metric_samples SET pushed_at = '${stamp}'
                WHERE profile_id = ${p} AND started_at = '${startedAt}'; END`
    );
    return () => db.exec("DROP TRIGGER d1_restamp");
  }

  it("leaves the OLD row plus the committed chunks when chunk 2 of 3 fails", () => {
    const p = freshProfile("D1-CHUNK-2-FAILS");
    seedNyDay(p);
    // THE SEED IS REALLY THERE. Every assertion below is about what SURVIVED, and a
    // survival assertion over an empty table passes for the wrong reason.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);

    const undo = abortOn(
      `BEFORE INSERT ON metric_samples WHEN NEW.profile_id = ${p}
         AND NEW.started_at = '${LA}'
       BEGIN SELECT RAISE(ABORT, 'chunk 2 fails'); END`
    );
    try {
      expect(() =>
        pushChunked(p, LA_PUSH, "2026-05-02T06:00:00Z", 1)
      ).toThrow();
    } finally {
      undo();
    }

    // NOT NOTHING. The seeded 8000 is still there — chunk 3 never committed, so pass B
    // never ran — beside chunk 1's row, which did commit. That is "old + chunks<k": a
    // day reading HIGH, which is visible and repairable, and never a hole.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8000]);

    // AND IT CONVERGES. The exporter re-carries the unacked rows on its next push; pass
    // A re-plans over the store the failure left, and that push collapses the double
    // count. Nothing else has to notice the failed push happened.
    const again = pushChunked(p, LA_PUSH, "2026-05-02T07:30:00Z", 1);
    expect(again.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8100, 900]);
  });

  it("rolls the deletes back with the rows when the push is ONE chunk", () => {
    // THE ONE-CHUNK CASE: the deletes and the rows are in the SAME transaction, so
    // neither can land without the other. Asserted from the rollback direction, because
    // that is the direction that can distinguish it — failing the DELETE (which runs
    // after the chunk's upserts) must take the chunk's INSERTS down with it.
    const p = freshProfile("D1-ONE-CHUNK-ATOMIC");
    seedNyDay(p);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);

    const undo = abortOn(
      `BEFORE DELETE ON metric_samples WHEN OLD.profile_id = ${p}
       BEGIN SELECT RAISE(ABORT, 'the delete fails'); END`
    );
    try {
      expect(() =>
        pushChunked(p, LA_PUSH, "2026-05-02T06:00:00Z", 500)
      ).toThrow();
    } finally {
      undo();
    }
    // EXACTLY the pre-push store: the three rows that were upserted in that transaction
    // went with the failed delete. If they had committed separately, they would be here.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);

    // The same push, unpoisoned, in one chunk: the deletes and the rows land together.
    const ok = pushChunked(p, LA_PUSH, "2026-05-02T07:30:00Z", 500);
    expect(ok.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8100, 900]);
  });

  it("declines a victim another push re-stamped between the plan and the delete", () => {
    // WHAT THE `pushed_at IS ?` CLAUSE DEFENDS AGAINST, and it is not this process.
    // Three processes share one DB file (`lib/db.ts`), so pass A's read and pass B's
    // DELETE can be separated by another push's COMMITTED writes — a window that widens
    // with every extra chunk now that pass B waits for the last one. The clause re-states
    // the stamp pass A actually read, so a row some other push has since claimed as
    // current is not deleted on evidence that has expired.
    //
    // Driven through the passes directly rather than through `ingestHealthConnectPayload`,
    // because the interleaving is BETWEEN two passes and no single-process call can sit
    // there. PASS C IS RUN TOO, in the order the last chunk runs it, and that is not
    // decoration: pass B's second guard asks whether the replacement is standing under
    // its natural key, so a plan applied over a store the push was never written to is a
    // plan every victim of which is correctly declined (the case below it).
    // MUTATION: drop the clause (or write `pushed_at = ?`, which never matches a
    // NULL and so also fails the era tests) and the re-stamped row is deleted.
    const p = freshProfile("D1-GUARD-RESTAMPED");
    seedNyDay(p);
    const stamp = "2026-05-02T06:00:00Z";
    const rows = parseHealthConnectPayload(
      { ...LA_PUSH, timestamp: stamp },
      "UTC"
    ).samples;
    const plan = planMetricSampleSupersede(p, rows, HC, { pushedAt: stamp });
    // It planned something: the seeded NY day is the victim of the LA re-anchoring.
    expect(plan.victims.length).toBe(1);
    expect(plan.victims[0].pushedAt).toBe("2026-05-02T05:00:00Z");
    // PASS C — the LA rows land, so the replacement this delete is licensed by is there.
    upsertMetricSamples(p, rows, HC, undefined, { pushedAt: stamp });

    // The concurrent push, committed between the two passes: it re-stamps the row this
    // plan is about to delete.
    db.prepare("UPDATE metric_samples SET pushed_at = ? WHERE id = ?").run(
      "2026-05-02T06:30:00Z",
      plan.victims[0].id
    );
    expect(applyMetricSampleSupersede(p, plan.victims)).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([
      7000, 8000, 8100, 900,
    ]);

    // AND THE PLAN IS OTHERWISE LIVE — the same call deletes the row when the stamp is
    // still the one it read, so the assertion above is the guard and not a no-op.
    db.prepare("UPDATE metric_samples SET pushed_at = ? WHERE id = ?").run(
      plan.victims[0].pushedAt,
      plan.victims[0].id
    );
    expect(applyMetricSampleSupersede(p, plan.victims)).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8100, 900]);
  });

  it("counts a guard-declined victim as a day still reading high", () => {
    // THE REVIEW LINE REPORTS WHAT HAPPENED, AND THIS IS THE REASON IT COULD NOT SEE
    // (#3438). `overlapsLeft` used to be summed off the PLAN, before `commitChunks` ran,
    // while the emit site described it as covering "every reason a supersede was
    // declined". Pass B's `pushed_at IS ?` guard is a reason the plan structurally cannot
    // know, because it happens after the plan is made: the victim survives, the day reads
    // high, and Review said nothing at all. `counts.superseded` was always honest — it
    // returns real `.changes` — so this is the number that was wrong, not the comment.
    //
    // Driven through the REAL ingest so the number asserted is the one the ingest
    // computes, with the concurrent push staged as a trigger that fires inside pass C.
    //
    // MUTATION: drop the `victims.length - superseded` term in
    // `ingestHealthConnectPayload`, or move the sum back before `commitChunks`, and this
    // reports no overlaps and no warning over a day holding two anchorings.
    const p = freshProfile("D1-GUARD-REPORTED");
    seedNyDay(p);
    const undo = restampOn(p, "2026-05-01T04:00:00Z", "2026-05-02T06:30:00Z");
    let result;
    try {
      result = pushChunked(p, LA_PUSH, "2026-05-02T06:00:00Z", 500);
    } finally {
      undo();
    }
    // The guard refused the delete on evidence that had expired, so the NY row is still
    // there beside the three LA ones — reading high, never low.
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([
      7000, 8000, 8100, 900,
    ]);
    expect(warningsOf(result)).toContain(overlapsLeftWarning(1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R7 — pass A planned a delete for a row pass C was FORBIDDEN to write.
// ─────────────────────────────────────────────────────────────────────────────

describe("R7 — a row pass C will not write plans no delete", () => {
  // THE REFUTATION. `final store = (pre-store − victims) ⊕ upserts` assumed `⊕ upserts`
  // was TOTAL. It is not: pass C holds four unilateral vetoes over what lands, and pass A
  // consulted none of them. It promoted the stored old-anchoring row to `victims` on the
  // strength of an incoming re-anchored row that the #508 tombstone then stopped pass C
  // from writing, and pass B deleted the stored row anyway. The day went to ZERO — the
  // committed FINAL state, not a between-commits transient, and the next push re-plans,
  // finds no victim, re-suppresses the incoming row and leaves it at zero forever.
  // `warnings: []`, and `superseded: 1` told the reader a row had been REPLACED.
  //
  // Nothing recovers it. The supersede delete is sync-internal by design: no re-import
  // tombstone (pinned in hc-overlap-supersede.test.ts) and no undo capture, because it is
  // a raw `dropOverlap.run()` rather than the undo-delete path.
  //
  // REACHABLE FROM THE UI THIS PR EXISTS FOR. `app/(app)/data/manage-actions.ts` writes a
  // `metric_samples` tombstone keyed on the row's exact `started_at` when a user deletes a
  // reading. A user sees today's step count duplicated across two anchorings, deletes the
  // RE-ANCHORED one, and the next rolling-window push destroys the other.
  //
  // MUTATION for every case below: drop the `vetoes.veto(...)` consultation from
  // `planMetricSampleSupersede` — the stored reading is deleted and the day reads lower
  // than `main` would, which is the one thing the ruling's invariant forbids outright.

  /** The Data → Manage delete, through the same key builder that action uses. */
  function tombstone(p: number, startedAt: string): void {
    writeImportTombstone(
      p,
      "metric_samples",
      metricSampleTombstoneKey("steps", HC, ORIGIN, startedAt)
    );
  }

  function pushAt(
    p: number,
    body: Record<string, unknown>,
    timestamp: string,
    chunkSize: number
  ) {
    const parsed = parseHealthConnectPayload(
      { app_version: "1.9.14", ...body, timestamp },
      "UTC"
    );
    lastParsedDetails = parsed.details;
    return ingestHealthConnectPayload(p, parsed, HC, chunkSize);
  }

  it("keeps the stored row when a TOMBSTONE stops the row that would replace it", () => {
    // The lens's configuration, through the real ingest at chunkSize 2.
    const p = freshProfile("R7-TOMBSTONE-VICTIM");
    pushAt(
      p,
      { steps: [steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000)] },
      "2026-05-02T00:00:00Z",
      2
    );
    // THE SEED IS REALLY THERE — a survival assertion over an empty table passes for the
    // wrong reason, and the shipped tombstone case seeds a FRESH profile, which is why
    // the suite could not see this.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);
    tombstone(p, "2026-05-01T15:00:00Z");

    const result = pushAt(
      p,
      { steps: [steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 8500)] },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.suppressed).toBe(1);
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);
    // Nothing to report: one reading stands where one reading stood. The suppressed row
    // put nothing in the store, so there is no day reading high to name.
    expect(warningsOf(result)).toEqual([]);

    // AND IT STAYS THAT WAY. The defect's worst property was that the zero was permanent,
    // so the next push of the same rolling window is driven too.
    const again = pushAt(
      p,
      { steps: [steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 8500)] },
      "2026-05-02T03:00:00Z",
      2
    );
    expect(again.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);
  });

  it("keeps the stored row when the #133 LOCK stops the row that would replace it", () => {
    // The same construction through a different veto, which is the point: guarding the
    // tombstone alone would have left this one live.
    const p = freshProfile("R7-LOCK-VICTIM");
    // Both anchorings in ONE push, so neither is the other's victim (ruling item 3).
    pushAt(
      p,
      {
        steps: [
          steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000),
          steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 8500),
        ],
      },
      "2026-05-02T00:00:00Z",
      2
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    // The user hand-corrects the re-anchored one.
    db.prepare(
      "UPDATE metric_samples SET edited = 1 WHERE profile_id = ? AND started_at = ?"
    ).run(p, "2026-05-01T15:00:00Z");

    const result = pushAt(
      p,
      { steps: [steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 9999)] },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.edited).toBe(1);
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    // AND IT IS SAID OUT LOUD. The locked row stays, so the day really does read high —
    // pass A reports the overlap against the TWIN's stored window rather than pretending
    // a vetoed row touched nothing.
    expect(warningsOf(result)).toContain(overlapsLeftWarning(1));
  });

  it("keeps the stored row when the #1101 STALE RETRY stops the row that would replace it", () => {
    const p = freshProfile("R7-STALE-VICTIM");
    pushAt(
      p,
      {
        steps: [
          steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000),
          steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 8500),
        ],
      },
      "2026-05-02T00:00:00Z",
      2
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    // A queued push drains late: the same natural key, an END that stopped EARLIER, a
    // smaller value. #1101 holds the stored snapshot, so this row lands nowhere.
    const result = pushAt(
      p,
      { steps: [steps("2026-05-01T15:00:00Z", "2026-05-01T20:00:00Z", 6000)] },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    expect(warningsOf(result)).toContain(overlapsLeftWarning(1));
  });

  it("prunes a row a vetoed bucket left standing and a landing bucket collapsed", () => {
    // THE VETO IS A FACT ABOUT THE INCOMING ROW, NOT ABOUT THE STORED ONE, so one stored
    // row can be left standing by a vetoed bucket of a push and collapsed by a bucket of
    // the same push that lands. Every other reason a row lands in `leftStanding` is a
    // fact about the stored row plus the push's one stamp and cannot vary that way — the
    // prune of `leftStanding` by `victims` was a no-op before this, and its comment
    // claimed to be the arbiter of a case that could not arise. Now it can.
    //
    // The collapse is the truth: a row that lands does replace the stored one, so the
    // Review line must not also report it as standing.
    //
    // MUTATION: drop `for (const id of victims.keys()) leftStanding.delete(id)` from
    // `planMetricSampleSupersede` and the line reports 2 days reading high over a store
    // holding exactly one excess reading.
    const p = freshProfile("R7-PRUNE");
    pushAt(
      p,
      {
        steps: [
          steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000),
          steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 8500),
        ],
      },
      "2026-05-02T00:00:00Z",
      2
    );
    // The user hand-corrects the re-anchored row, so the push's re-send of it is vetoed.
    db.prepare(
      "UPDATE metric_samples SET edited = 1 WHERE profile_id = ? AND started_at = ?"
    ).run(p, "2026-05-01T15:00:00Z");
    const result = pushAt(
      p,
      {
        steps: [
          // Vetoed by the #133 lock — its twin stays, and the 8000 row it overlaps is
          // left standing on its account.
          steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 9999),
          // Lands, overlaps the same 8000 row, outranks it: that row is collapsed.
          steps("2026-05-01T07:00:00Z", "2026-05-02T07:00:00Z", 8100),
        ],
      },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.superseded).toBe(1);
    expect(result.split.edited).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8100, 8500]);
    // ONE reading standing over the day, not two: the locked row. The 8000 row is gone.
    expect(warningsOf(result)).toContain(overlapsLeftWarning(1));
  });

  it("still collapses the stored row when a row of the SAME push DOES land", () => {
    // A VETOED ROW DECLINES A DELETE; IT DOES NOT VETO THE PUSH. The re-anchored bucket
    // here is tombstoned and lands nowhere, but a second bucket of the same push does
    // land, does overlap the stored row and does outrank it — so the collapse happens and
    // the day is left reading right. MUTATION: skip the whole PUSH when any row is
    // vetoed, or hoist the veto to a `return emptySupersedePlan()`, and the stored row
    // survives beside the new one with the day reading 16100.
    const p = freshProfile("R7-MIXED");
    pushAt(
      p,
      { steps: [steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000)] },
      "2026-05-02T00:00:00Z",
      2
    );
    tombstone(p, "2026-05-01T15:00:00Z");
    const result = pushAt(
      p,
      {
        steps: [
          // Vetoed: tombstoned, lands nowhere.
          steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 8500),
          // Lands, overlaps the stored row, outranks it.
          steps("2026-05-01T07:00:00Z", "2026-05-02T07:00:00Z", 8100),
        ],
      },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.suppressed).toBe(1);
    expect(result.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8100]);
    expect(warningsOf(result)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8 — the evidence pass A read expired between the passes.
// ─────────────────────────────────────────────────────────────────────────────

describe("R8 — pass B re-states the licensing row, not just the victim", () => {
  // THE REFUTATION. Round 7's outcome, reached through the race the file's own comment
  // already said was open. Pass A consults pass C's vetoes, but it consults them at PASS A
  // TIME, and three processes share one DB file: a user hitting Data → Manage between the
  // passes deletes the re-anchored row and writes the #508 tombstone for it, and pass C
  // then refuses to write the push's re-send of that exact row. Pass B deleted the
  // old-anchoring victim anyway. The day went to ZERO — committed, silent, and LOWER than
  // `main`, which has no production `DELETE FROM metric_samples` on this path at all.
  //
  // The PR modelled a concurrent writer in exactly this window and guarded ONE of the two
  // things pass A read — the victim's provenance (`pushed_at IS ?`) — and not the other,
  // the evidence that licensed the delete. So the DELETE now re-states the natural key of
  // the row that replaces the victim and asks whether anything stands there.
  //
  // MUTATION for every case below: drop the `AND EXISTS (…)` clause from
  // `applyMetricSampleSupersede` and the first case's day reads nothing.
  //
  // Driven through the passes by hand, because the interleaving is BETWEEN pass A and
  // pass C and no single-process call can sit there — the same reason the `pushed_at`
  // guard's own case is driven this way.

  const KEY = "2026-05-01T15:00:00Z";
  const RE_ANCHORED = { started_at: KEY, ended_at: "2026-05-02T01:00:00Z" };

  /** A store holding BOTH anchorings of one day, written by one earlier push. */
  function seedBothAnchorings(p: number): void {
    pushBoth(p);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
  }
  function pushBoth(p: number) {
    const parsed = parseHealthConnectPayload(
      {
        app_version: "1.9.14",
        steps: [
          steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000),
          steps(KEY, RE_ANCHORED.ended_at, 8500),
        ],
        timestamp: "2026-05-02T00:00:00Z",
      },
      "UTC"
    );
    lastParsedDetails = parsed.details;
    return ingestHealthConnectPayload(p, parsed, HC, 2);
  }

  /** The rolling window re-sending the re-anchored row, as pass A/C receive it. */
  const RESEND_STAMP = "2026-05-02T03:00:00Z";
  function resendRows() {
    return parseHealthConnectPayload(
      {
        app_version: "1.9.14",
        steps: [steps(KEY, RE_ANCHORED.ended_at, 8500)],
        timestamp: RESEND_STAMP,
      },
      "UTC"
    ).samples;
  }

  /** Data → Manage: the row goes, and a tombstone on its exact natural key stays. */
  function userDeletes(p: number, startedAt: string): void {
    db.prepare(
      "DELETE FROM metric_samples WHERE profile_id = ? AND started_at = ?"
    ).run(p, startedAt);
    writeImportTombstone(
      p,
      "metric_samples",
      metricSampleTombstoneKey("steps", HC, ORIGIN, startedAt)
    );
  }

  it("keeps the victim when the user deletes the replacing row between the passes", () => {
    const p = freshProfile("R8-DELETED-BETWEEN");
    seedBothAnchorings(p);
    const rows = resendRows();

    // PASS A — over the store as it stands, which still holds the row this push re-sends.
    const plan = planMetricSampleSupersede(p, rows, HC, {
      pushedAt: RESEND_STAMP,
    });
    expect(plan.victims.length).toBe(1);
    expect(plan.victims[0].replacedBy.startedAt).toBe(KEY);

    // ← THE CONCURRENT WRITER. The user is on Data → Manage *because* they saw the
    // duplicated day this PR exists to fix, and deletes the re-anchored one of the pair.
    userDeletes(p, KEY);

    // PASS C — the tombstone refuses the re-send outright, so nothing lands.
    const counts = upsertMetricSamples(p, rows, HC, undefined, {
      pushedAt: RESEND_STAMP,
    });
    expect(counts.suppressed).toBe(1);

    // PASS B — no replacement stands under the licensing key, so the DELETE matches
    // nothing and the 8000 row survives. `main` reads 8000 here; so does this.
    const removed = applyMetricSampleSupersede(p, plan.victims);
    expect(removed).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);

    // AND IT IS SAID OUT LOUD rather than reported as a replacement that happened. This
    // is the term `ingestHealthConnectPayload` adds to the Review line for exactly the
    // reasons the plan could not see, and it counts this one.
    expect(plan.victims.length - removed).toBe(1);
  });

  it("still deletes the victim when nothing raced the plan — the control", () => {
    // THE SAME SETUP AND THE SAME CALL, with the concurrent writer removed. Without this
    // the case above passes for a guard that never matches anything.
    const p = freshProfile("R8-CONTROL");
    seedBothAnchorings(p);
    const rows = resendRows();
    const plan = planMetricSampleSupersede(p, rows, HC, {
      pushedAt: RESEND_STAMP,
    });
    expect(plan.victims.length).toBe(1);
    const counts = upsertMetricSamples(p, rows, HC, undefined, {
      pushedAt: RESEND_STAMP,
    });
    expect(counts.suppressed).toBe(0);
    expect(applyMetricSampleSupersede(p, plan.victims)).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8500]);
  });

  it("deletes the victim when a CONCURRENT row stands under the licensing key", () => {
    // THE GUARD IS NOT A VETO DETECTOR, and this is the case that says so. Two of the four
    // vetoes REQUIRE a stored twin, so when one of them newly fires between the passes a
    // row is standing under the licensing key by definition — the `EXISTS` is true and the
    // delete goes ahead. That is the invariant behaving, not a hole in it: what the day
    // holds afterwards is the hand-corrected reading, never nothing.
    //
    // MUTATION: make the guard test the victim instead of the replacement (e.g. re-state
    // `id`), and this case stops distinguishing itself from the one above.
    const p = freshProfile("R8-LOCKED-TWIN-APPEARS");
    // The store holds ONLY the old anchoring, so pass A finds no twin for the re-send.
    const seed = parseHealthConnectPayload(
      {
        app_version: "1.9.14",
        steps: [steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000)],
        timestamp: "2026-05-02T00:00:00Z",
      },
      "UTC"
    );
    lastParsedDetails = seed.details;
    ingestHealthConnectPayload(p, seed, HC, 2);
    const rows = resendRows();
    const plan = planMetricSampleSupersede(p, rows, HC, {
      pushedAt: RESEND_STAMP,
    });
    expect(plan.victims.length).toBe(1);

    // ← THE CONCURRENT WRITER: a row appears under the licensing key, hand-corrected.
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value, edited,
          pushed_at)
       VALUES (?, ?, ?, 'steps', '2026-05-01', ?, ?, 9100, 1, ?)`
    ).run(p, HC, ORIGIN, KEY, RE_ANCHORED.ended_at, "2026-05-02T02:00:00Z");

    // PASS C — the #133 lock holds, so the push's row lands nowhere.
    const counts = upsertMetricSamples(p, rows, HC, undefined, {
      pushedAt: RESEND_STAMP,
    });
    expect(counts.edited).toBe(1);
    // PASS B — a row IS standing under the licensing key, so the collapse happens.
    expect(applyMetricSampleSupersede(p, plan.victims)).toBe(1);
    // The day holds the hand-corrected reading. OLD, or OLD + NEW, or NEW — never NEITHER.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9100]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8b — one record sent twice is one reading.
// ─────────────────────────────────────────────────────────────────────────────

describe("R8b — a push carrying one natural key twice", () => {
  // THE REFUTATION. `countInPushDoubleCounts` groups by (metric, origin) and counts
  // "overlaps a row of this push that starts earlier". Two copies of ONE record share a
  // `started_at`, so they overlap totally — and the ON CONFLICT merges them into ONE
  // stored row. The store was right every time; the warning was false and scaled with the
  // number of copies: two copies said "1 reading", three said "2 readings", over a store
  // holding one row.
  //
  // The principle was already written one paragraph up in the same docstring, for the
  // stored side only — "the stored row and the incoming row are ONE reading updated in
  // place, not two" — and `scripts/hc-origin-overlap-census.ts` already collapses on
  // (metric, origin, started_at) "so a re-sent moving-end snapshot is not reported as an
  // overlap with itself". The dedupe of `dayBuckets` is that same collapse, applied to the
  // incoming side.
  //
  // MUTATION for the first three cases: drop the `dayBucketKeys` guard in
  // `planMetricSampleSupersede` and each reports a double count over a single stored row.

  function pushSteps(p: number, records: unknown[], timestamp: string) {
    const parsed = parseHealthConnectPayload(
      { app_version: "1.9.14", steps: records, timestamp },
      "UTC"
    );
    lastParsedDetails = parsed.details;
    return ingestHealthConnectPayload(p, parsed, HC, 2);
  }
  const A = steps("2026-05-01T15:00:00Z", "2026-05-02T01:00:00Z", 9000);

  it("says nothing when one record arrives twice", () => {
    const p = freshProfile("R8B-TWICE");
    pushSteps(p, [A, A], "2026-05-02T02:00:00Z");
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000]);
    expect(warningsOf(null)).toEqual([]);
  });

  it("says nothing when it arrives three times", () => {
    // The count SCALED with the copies, which is what made it obviously a phantom rather
    // than a debatable unit.
    const p = freshProfile("R8B-THRICE");
    pushSteps(p, [A, A, A], "2026-05-02T02:00:00Z");
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000]);
    expect(warningsOf(null)).toEqual([]);
  });

  it("says nothing when the second copy is the one pass C vetoes", () => {
    // AND THIS IS THE `dayBuckets` COMMENT'S OWN CLAIM, falsified. It said the list holds
    // "the ones that pass C will actually write … counts nothing that never lands". Pass A
    // reads the PRE-PUSH store for both rows of a duplicated key and sees no veto on
    // either; pass C reads the first row's write when it reaches the second and
    // stale-retry vetoes it. The row never landed and was counted anyway. The dedupe is
    // what makes that harmless — not the veto gate.
    const p = freshProfile("R8B-STALE-COPY");
    pushSteps(
      p,
      [A, steps("2026-05-01T15:00:00Z", "2026-05-01T20:00:00Z", 6000)],
      "2026-05-02T02:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000]);
    expect(warningsOf(null)).toEqual([]);
  });

  it("still counts two genuine anchorings — the control", () => {
    // THE TRUE POSITIVE THE DEDUPE MUST NOT TAKE WITH IT. Two DIFFERENT natural keys
    // overlapping is ruling item 3's "write both", and it really is two readings summing
    // into one day.
    const p = freshProfile("R8B-CONTROL");
    pushSteps(
      p,
      [steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000), A],
      "2026-05-02T02:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 9000]);
    expect(warningsOf(null)).toContain(overlapsLeftWarning(1));
  });
});

describe("the fixtures state a stamp production would accept", () => {
  it("dates its pushes in the PAST", () => {
    // #3438. This file used to state `timestamp: 2026-09-01`, ten days after the day it
    // was written, so `pushStampFor` refused every one of them and every `push()` above
    // ran with `pushedAt: null` — superseding nothing, and passing its "the rule declined"
    // assertions for a reason that had nothing to do with the guard under test.
    expect(PUSH_BASE).toBeLessThan(Date.now());
    expect(pushStampFor(stampFor(1))).toBe(stampFor(1));
    expect(pushStampFor(stampFor(pushSeq))).toBe(stampFor(pushSeq));
  });
});
