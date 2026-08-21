// PURE TIER — the overlap-supersede rule itself (#3424), with no database in sight.
//
// This path DELETES stored health rows, so the tests below are written as a MUTATION
// audit rather than a happy-path sweep: each guard in lib/metric-window-overlap.ts has
// at least one case that goes red when that guard alone is removed, and the comment on
// each names which. A suite where three of four guards could be deleted green is the
// failure mode this file exists to avoid.
//
// Four of the guards here exist BECAUSE an adversarial review deleted real readings
// with the first cut of this rule, and each of those carries the refutation it answers:
// the day-bucket METRIC gate (a snack nested in a meal), the day-bucket GRANULARITY
// gate (two devices with no data_origin sharing one minute-bucket group), and the
// PUSH-STAMP freshness pair (an exporter retry, and a mixed-anchoring pair split across
// two chunks).
//
// SYNTHETIC ONLY: invented instants, invented ids, no PHI.

import { describe, expect, it } from "vitest";
import {
  DAY_BUCKET_METRICS,
  SUPERSEDE_DAY_RADIUS,
  compareWindowStarts,
  isDayBucketMetric,
  isDayBucketWindow,
  isSupersedingWindow,
  planSupersede,
  pushIsNewer,
  pushStampFor,
  staleBatchOverlaps,
  supersedeDateRange,
  windowsOverlap,
  type MetricWindow,
} from "@/lib/metric-window-overlap";
import { SUB_DAILY_WINDOW_MAX_MIN } from "@/lib/integrations/health-connect";

function win(
  id: number,
  date: string,
  started_at: string,
  ended_at: string,
  edited: number | null = 0,
  pushed_at: string | null = null
): MetricWindow {
  return { id, date, started_at, ended_at, edited, pushed_at };
}

/** A day-bucket incoming row of a tiling metric, which is the only shape that acts. */
function incoming(
  started_at: string,
  ended_at: string,
  pushedAt: string | null = "2030-01-01T00:00:00Z"
) {
  return { metric: "steps", started_at, ended_at, pushedAt };
}

describe("windowsOverlap — half-open interval overlap on INSTANTS", () => {
  it("is true for genuinely overlapping windows and false for disjoint ones", () => {
    expect(
      windowsOverlap(
        "2026-05-01T10:00:00Z",
        "2026-05-02T01:00:00Z",
        "2026-05-01T15:00:00Z",
        "2026-05-01T23:00:00Z"
      )
    ).toBe(true);
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00Z",
        "2026-05-01T06:00:00Z",
        "2026-05-01T08:00:00Z",
        "2026-05-01T12:00:00Z"
      )
    ).toBe(false);
  });

  it("treats a shared boundary as ADJACENT, not overlapping", () => {
    // MUTATION: make the test inclusive (`<=`) and every back-to-back sub-daily bucket
    // starts deleting its neighbour.
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00Z",
        "2026-05-01T06:00:00Z",
        "2026-05-01T06:00:00Z",
        "2026-05-01T12:00:00Z"
      )
    ).toBe(false);
  });

  it("never touches a POINT reading, in either role", () => {
    // MUTATION: drop the `end <= start` guard and a day bucket deletes every HRV
    // reading that happens to fall inside it.
    const point = ["2026-05-01T18:00:00Z", "2026-05-01T18:00:00Z"] as const;
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00Z",
        "2026-05-02T00:00:00Z",
        point[0],
        point[1]
      )
    ).toBe(false);
    expect(
      windowsOverlap(
        point[0],
        point[1],
        "2026-05-01T00:00:00Z",
        "2026-05-02T00:00:00Z"
      )
    ).toBe(false);
  });

  it("compares instants, not strings — millisecond and offset spellings agree", () => {
    // `.` sorts before `Z`, and an offset spelling does not sort at all.
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00.000Z",
        "2026-05-02T00:00:00.000Z",
        "2026-05-01T09:00:00+09:00",
        "2026-05-01T20:00:00+09:00"
      )
    ).toBe(true);
  });

  it("refuses an instant with no zone rather than guessing the host's", () => {
    // A bare `${date}T00:00:00` is a profile-local day midnight, not an instant. Parsing
    // it would make a DELETE decision depend on where the server runs.
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00",
        "2026-05-02T00:00:00",
        "2026-05-01T10:00:00Z",
        "2026-05-01T20:00:00Z"
      )
    ).toBe(false);
  });
});

describe("the DAY-BUCKET METRIC gate", () => {
  // WHY IT EXISTS (an adversarial refutation of #3424's premise). #3424 says "an
  // overlap is always the mixed-anchoring anomaly". That is false for two shipped
  // shapes: `parseHealthConnectPayload` emits one interval row per nutrient per
  // NutritionRecord on the record's REAL window, so a snack logged inside a meal is two
  // legitimately nested `nutrition_kcal` rows; and `sleep_min` is one row per session.
  // Run against those, the rule deleted an 800 kcal meal and kept a 150 kcal snack.
  it("admits exactly the four metrics Health Connect stores as daily totals", () => {
    expect([...DAY_BUCKET_METRICS].sort()).toEqual([
      "active_kcal",
      "distance_km",
      "steps",
      "total_kcal",
    ]);
  });

  it("keeps NUTRITION, HYDRATION and SLEEP out of reach", () => {
    // MUTATION: add any of these to DAY_BUCKET_METRICS and the nested-interval cases
    // below start deleting real readings.
    for (const metric of [
      "nutrition_kcal",
      "protein_g",
      "carbs_g",
      "hydration_l",
      "sleep_min",
      "sleep_deep_min",
      "hrv_ms",
    ]) {
      expect(isDayBucketMetric(metric)).toBe(false);
    }
  });

  it("refuses to plan anything for a nested meal and snack", () => {
    const meal = win(
      1,
      "2026-05-01",
      "2026-05-01T12:00:00Z",
      "2026-05-01T13:00:00Z"
    );
    const snack = {
      metric: "nutrition_kcal",
      started_at: "2026-05-01T12:10:00Z",
      ended_at: "2026-05-01T12:20:00Z",
      pushedAt: "2030-01-01T00:00:00Z",
    };
    expect(planSupersede(snack, [meal]).supersede).toEqual([]);
    // And the reverse direction — the later, longer meal must not eat the snack.
    const snackRow = win(
      2,
      "2026-05-01",
      "2026-05-01T12:10:00Z",
      "2026-05-01T12:20:00Z"
    );
    const mealIn = {
      metric: "nutrition_kcal",
      started_at: "2026-05-01T12:00:00Z",
      ended_at: "2026-05-01T13:00:00Z",
      pushedAt: "2030-01-01T00:00:00Z",
    };
    expect(planSupersede(mealIn, [snackRow]).supersede).toEqual([]);
  });

  it("refuses two overlapping SLEEP sessions, including the origin=null group", () => {
    // `dataOrigin` reads only `metadata.data_origin`, so two devices that set none both
    // parse to origin = null and land in ONE supersede group.
    const nightA = win(
      1,
      "2026-05-02",
      "2026-05-01T22:00:00Z",
      "2026-05-02T06:00:00Z"
    );
    const nightB = {
      metric: "sleep_min",
      started_at: "2026-05-01T22:30:00Z",
      ended_at: "2026-05-02T06:30:00Z",
      pushedAt: "2030-01-01T00:00:00Z",
    };
    expect(planSupersede(nightB, [nightA]).supersede).toEqual([]);
  });
});

describe("the DAY-BUCKET GRANULARITY gate", () => {
  // WHY IT EXISTS. The metric list alone is not enough: the same four metrics arrive as
  // MINUTE buckets at a `1m`/`15m` exporter setting, and two devices with no
  // `metadata.data_origin` share the origin=null group. Gating on the OBSERVED window
  // rather than the recommended setting is what puts those out of reach.
  it("calls a window longer than SUB_DAILY_WINDOW_MAX_MIN a day bucket", () => {
    const start = "2026-05-01T00:00:00Z";
    const at = (min: number) =>
      new Date(Date.parse(start) + min * 60_000).toISOString();
    expect(isDayBucketWindow(start, at(SUB_DAILY_WINDOW_MAX_MIN))).toBe(false);
    expect(isDayBucketWindow(start, at(SUB_DAILY_WINDOW_MAX_MIN + 1))).toBe(
      true
    );
    expect(isDayBucketWindow(start, at(1))).toBe(false);
  });

  it("leaves two overlapping ONE-MINUTE steps buckets alone", () => {
    // MUTATION: drop the granularity gate and one device's minute bucket deletes the
    // other's, silently, on every push.
    const deviceA = win(
      1,
      "2026-05-01",
      "2026-05-01T10:00:00Z",
      "2026-05-01T10:01:00Z"
    );
    const deviceB = incoming("2026-05-01T10:00:30Z", "2026-05-01T10:01:30Z");
    expect(planSupersede(deviceB, [deviceA]).supersede).toEqual([]);
    expect(planSupersede(deviceB, [deviceA]).locked).toEqual([]);
  });

  it("will not let a DAY bucket delete a stored sub-daily one either", () => {
    // The stored side is gated too: a `daily` push arriving after the user switched the
    // exporter down to `15m` must not sweep the minute buckets away.
    const minute = win(
      1,
      "2026-05-01",
      "2026-05-01T10:00:00Z",
      "2026-05-01T10:15:00Z"
    );
    const day = incoming("2026-05-01T00:00:00Z", "2026-05-01T20:00:00Z");
    expect(planSupersede(day, [minute]).supersede).toEqual([]);
  });
});

describe("pushIsNewer — freshness as the PAYLOAD states it", () => {
  // WHY IT EXISTS. The first cut decided freshness from arrival, which was refuted
  // twice: a byte-identical REPLAY of a pre-switch payload deleted the row that had
  // superseded it, and a mixed-anchoring pair split across two 1000-row chunks was
  // resolved by which chunk ran last — the stale bucket deleting the current one.
  it("is true only when the incoming push is STRICTLY newer", () => {
    expect(pushIsNewer("2026-05-02T01:00:00Z", "2026-05-01T23:00:00Z")).toBe(
      true
    );
    expect(pushIsNewer("2026-05-01T23:00:00Z", "2026-05-02T01:00:00Z")).toBe(
      false
    );
  });

  it("is FALSE on an equal stamp — a replay, or a second chunk of the same push", () => {
    // MUTATION: relax this to `>=` and both refutations come straight back.
    expect(pushIsNewer("2026-05-01T23:00:00Z", "2026-05-01T23:00:00Z")).toBe(
      false
    );
  });

  it("treats a NULL stored stamp as supersedable — that is the corrupted history", () => {
    expect(pushIsNewer("2026-05-01T23:00:00Z", null)).toBe(true);
  });

  it("refuses a push that cannot say when it happened", () => {
    expect(pushIsNewer(null, null)).toBe(false);
    expect(pushIsNewer(undefined, "2026-05-01T00:00:00Z")).toBe(false);
    // Zone-less: unreadable, so it deletes nothing.
    expect(pushIsNewer("2026-05-02T00:00:00", null)).toBe(false);
  });
});

describe("pushStampFor — one stamp per push, stable across a replay", () => {
  const rows = [
    { ended_at: "2026-05-01T23:00:00Z" },
    { ended_at: "2026-05-02T01:00:00Z" },
    { ended_at: "2026-05-01T12:00:00Z" },
  ];

  it("prefers what the exporter stated", () => {
    expect(pushStampFor("2026-05-03T00:00:00Z", rows)).toBe(
      "2026-05-03T00:00:00Z"
    );
  });

  it("falls back to the LATEST end in the push when the payload states none", () => {
    // `payload.timestamp` is documented but nothing validates it, so requiring it would
    // switch the whole fix off for an exporter build that omits it, silently.
    expect(pushStampFor(null, rows)).toBe("2026-05-02T01:00:00Z");
    expect(pushStampFor("2026-05-03T00:00:00", rows)).toBe(
      "2026-05-02T01:00:00Z"
    );
  });

  it("gives a byte-identical replay the SAME stamp", () => {
    // This is the property the whole R4 defence rests on: a retry is never newer than
    // the push it replays. MUTATION: use the wall clock here and the replay wins again.
    expect(pushStampFor(null, rows)).toBe(pushStampFor(null, [...rows]));
  });

  it("returns a CANONICAL instant whatever spelling it was handed", () => {
    // MUTATION: return the raw string and `metric_samples.pushed_at` is born `mixed`,
    // which lib/__tests__/time-columns.test.ts freezes against — a new column has no
    // excuse for holding two shapes. Second resolution is the accepted cost.
    expect(pushStampFor("2026-05-03T00:00:00.123Z", [])).toBe(
      "2026-05-03T00:00:00Z"
    );
    expect(pushStampFor("2026-05-03T09:00:00+09:00", [])).toBe(
      "2026-05-03T00:00:00Z"
    );
    expect(pushStampFor(null, [{ ended_at: "2026-05-02T01:00:00.500Z" }])).toBe(
      "2026-05-02T01:00:00Z"
    );
  });

  it("is null when nothing in the push is readable", () => {
    expect(pushStampFor(null, [])).toBe(null);
    expect(pushStampFor(null, [{ ended_at: "2026-05-01T10:00:00" }])).toBe(
      null
    );
  });
});

describe("planSupersede — what an incoming window does to the store", () => {
  const stored = [
    win(1, "2026-05-01", "2026-05-01T15:00:00Z", "2026-05-01T23:00:00Z"),
    win(2, "2026-05-01", "2026-05-02T04:00:00Z", "2026-05-02T10:00:00Z"),
  ];
  const wide = incoming("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z");

  it("supersedes every non-locked row it overlaps", () => {
    expect(planSupersede(wide, stored).supersede.map((r) => r.id)).toEqual([1]);
  });

  it("supersedes a stored row that ends LATER than it does", () => {
    // A completed re-anchored bucket for a PAST day legitimately ends earlier than the
    // old-anchoring "today so far" row it overlaps. MUTATION: apply a freshness test to
    // the ENDS here and the eastward case is left half-converged with an 11-hour gap.
    const todaySoFar = win(
      9,
      "2026-05-01",
      "2026-05-01T04:00:00Z",
      "2026-05-01T22:00:00Z"
    );
    const completed = incoming("2026-04-30T15:00:00Z", "2026-05-01T15:00:00Z");
    expect(
      planSupersede(completed, [todaySoFar]).supersede.map((r) => r.id)
    ).toEqual([9]);
  });

  it("holds an EDIT-LOCKED overlap out of the delete set", () => {
    const locked = [
      win(1, "2026-05-01", "2026-05-01T15:00:00Z", "2026-05-01T23:00:00Z", 1),
    ];
    const plan = planSupersede(wide, locked);
    expect(plan.supersede).toEqual([]);
    expect(plan.locked.map((r) => r.id)).toEqual([1]);
  });

  it("reads a NULL lock as unlocked, exactly as the #608 sweep does", () => {
    const nullLock = [
      win(
        1,
        "2026-05-01",
        "2026-05-01T15:00:00Z",
        "2026-05-01T23:00:00Z",
        null
      ),
    ];
    expect(planSupersede(wide, nullLock).supersede.map((r) => r.id)).toEqual([
      1,
    ]);
  });

  it("leaves disjoint neighbours alone", () => {
    expect(
      planSupersede(
        incoming("2026-05-01T00:00:00Z", "2026-05-01T14:00:00Z"),
        stored
      ).supersede
    ).toEqual([]);
  });

  it("does nothing at all when the INCOMING window is a point reading", () => {
    expect(
      planSupersede(
        incoming("2026-05-01T18:00:00Z", "2026-05-01T18:00:00Z"),
        stored
      ).supersede
    ).toEqual([]);
  });

  it("does nothing when the incoming push is not newer than the stored row", () => {
    // The R4 shape at rule level: a replay carries the stamp of the push it replays.
    const converged = [
      win(
        1,
        "2026-05-01",
        "2026-05-01T10:00:00Z",
        "2026-05-02T01:00:00Z",
        0,
        "2026-05-02T01:00:00Z"
      ),
    ];
    const replay = incoming(
      "2026-05-01T15:00:00Z",
      "2026-05-01T23:00:00Z",
      "2026-05-01T23:00:00Z"
    );
    expect(planSupersede(replay, converged).supersede).toEqual([]);
  });

  it("BLOCKS a not-newer incoming row from being written at all", () => {
    // Refusing to delete is only half the answer. MUTATION: drop the `blocked` return
    // (or stop acting on it in normalize.ts) and a replayed pre-switch push re-INSERTS
    // its stale row under a key its own supersede had cleared — the day goes back to
    // 6500 without a single delete happening.
    const converged = [
      win(
        1,
        "2026-05-01",
        "2026-05-01T10:00:00Z",
        "2026-05-02T01:00:00Z",
        0,
        "2026-05-02T01:00:00Z"
      ),
    ];
    const replay = incoming(
      "2026-05-01T15:00:00Z",
      "2026-05-01T23:00:00Z",
      "2026-05-01T23:00:00Z"
    );
    expect(planSupersede(replay, converged).blocked.map((r) => r.id)).toEqual([
      1,
    ]);
    // And a genuinely newer push is NOT blocked — otherwise nothing would ever converge.
    const newer = incoming(
      "2026-05-01T15:00:00Z",
      "2026-05-01T23:00:00Z",
      "2026-05-03T00:00:00Z"
    );
    expect(planSupersede(newer, converged).blocked).toEqual([]);
    expect(planSupersede(newer, converged).supersede.map((r) => r.id)).toEqual([
      1,
    ]);
  });
});

describe("isSupersedingWindow — the three preconditions, composed", () => {
  it("is true only for a day-bucket window of a tiling metric", () => {
    expect(
      isSupersedingWindow(
        "steps",
        "2026-05-01T00:00:00Z",
        "2026-05-01T20:00:00Z"
      )
    ).toBe(true);
    expect(
      isSupersedingWindow(
        "nutrition_kcal",
        "2026-05-01T00:00:00Z",
        "2026-05-01T20:00:00Z"
      )
    ).toBe(false);
    expect(
      isSupersedingWindow(
        "steps",
        "2026-05-01T00:00:00Z",
        "2026-05-01T00:30:00Z"
      )
    ).toBe(false);
    expect(
      isSupersedingWindow(
        "steps",
        "2026-05-01T00:00:00Z",
        "2026-05-01T00:00:00Z"
      )
    ).toBe(false);
  });
});

describe("staleBatchOverlaps — the mixed-anchoring pair inside ONE push", () => {
  const tokyo = {
    metric: "steps",
    origin: "com.fitbit.FitbitMobile",
    started_at: "2026-05-01T15:00:00Z",
    ended_at: "2026-05-01T23:00:00Z",
  };
  const honolulu = {
    metric: "steps",
    origin: "com.fitbit.FitbitMobile",
    started_at: "2026-05-01T10:00:00Z",
    ended_at: "2026-05-02T01:00:00Z",
  };

  it("drops the pre-switch record and keeps the re-anchored one", () => {
    // MUTATION: return an empty set and #3424's repro reads 6500 steps for 3500
    // walked — the original bug, back inside a single push.
    expect([...staleBatchOverlaps([tokyo, honolulu])]).toEqual([tokyo]);
  });

  it("gives the same answer from either batch order", () => {
    expect([...staleBatchOverlaps([honolulu, tokyo])]).toEqual([tokyo]);
  });

  // EASTWARD, where freshness and batch order DISAGREE — and the only shape that can
  // tell the two rules apart. Westward the re-anchored bucket starts EARLIER, so
  // "keep the earliest start" happens to keep the right one and a mutation from
  // freshness to start order stays green on the pair above. Flying NY -> Tokyo the
  // re-anchored bucket starts LATER: Tokyo midnight is 15:00Z the day before, and the
  // stale New York bucket it overlaps is a COMPLETED day that ends at NY midnight
  // while the Tokyo one is still filling to the push moment.
  const newYorkCompleted = {
    metric: "steps",
    origin: "com.fitbit.FitbitMobile",
    started_at: "2026-08-20T04:00:00Z",
    ended_at: "2026-08-21T04:00:00Z",
  };
  const tokyoFilling = {
    metric: "steps",
    origin: "com.fitbit.FitbitMobile",
    started_at: "2026-08-20T15:00:00Z",
    ended_at: "2026-08-21T06:00:00Z",
  };

  it("keeps the STILL-FILLING re-anchored bucket when it starts LATER (eastward)", () => {
    // MUTATION: rank by started_at instead of freshness and this keeps the New York
    // row — the old anchoring — while dropping the bucket the exporter is still
    // filling. Both batch orders, because a wrong rule is wrong from either end.
    expect([...staleBatchOverlaps([newYorkCompleted, tokyoFilling])]).toEqual([
      newYorkCompleted,
    ]);
    expect([...staleBatchOverlaps([tokyoFilling, newYorkCompleted])]).toEqual([
      newYorkCompleted,
    ]);
  });

  it("keeps every row of an ordinary single-anchoring push", () => {
    const disjoint = Array.from({ length: 12 }, (_, h) => ({
      metric: "steps",
      origin: null,
      started_at: `2026-05-01T${String(h * 2).padStart(2, "0")}:00:00Z`,
      ended_at: `2026-05-01T${String(h * 2 + 2).padStart(2, "0")}:00:00Z`,
    }));
    expect(staleBatchOverlaps(disjoint).size).toBe(0);
  });

  it("never compares across metric or origin", () => {
    const other = { ...tokyo, metric: "distance_km" };
    const otherOrigin = { ...tokyo, origin: "com.google.android.apps.fitness" };
    expect(staleBatchOverlaps([honolulu, other, otherOrigin]).size).toBe(0);
  });

  it("ignores point readings entirely", () => {
    const point = {
      metric: "hrv_ms",
      origin: null,
      started_at: "2026-05-01T18:00:00Z",
      ended_at: "2026-05-01T18:00:00Z",
    };
    expect(
      staleBatchOverlaps([
        point,
        {
          ...point,
          started_at: "2026-05-01T19:00:00Z",
          ended_at: "2026-05-01T19:00:00Z",
        },
      ]).size
    ).toBe(0);
  });

  it("never drops a nested NUTRITION row from a push", () => {
    // The other half of the nutrition refutation: at ingest the first cut dropped the
    // snack inside one push and reported it `unchanged`, which is invisible in Review.
    const meal = {
      metric: "nutrition_kcal",
      origin: null,
      started_at: "2026-05-01T12:00:00Z",
      ended_at: "2026-05-01T13:00:00Z",
    };
    const snack = {
      metric: "nutrition_kcal",
      origin: null,
      started_at: "2026-05-01T12:10:00Z",
      ended_at: "2026-05-01T12:20:00Z",
    };
    expect(staleBatchOverlaps([meal, snack]).size).toBe(0);
  });

  it("never drops overlapping SUB-DAILY buckets from a push", () => {
    const a = {
      metric: "steps",
      origin: null,
      started_at: "2026-05-01T10:00:00Z",
      ended_at: "2026-05-01T10:01:00Z",
    };
    const b = {
      ...a,
      started_at: "2026-05-01T10:00:30Z",
      ended_at: "2026-05-01T10:01:30Z",
    };
    expect(staleBatchOverlaps([a, b]).size).toBe(0);
  });
});

describe("supersedeDateRange — the scan bound, in profile-local days", () => {
  it("spans SUPERSEDE_DAY_RADIUS days either side, inclusive", () => {
    expect(SUPERSEDE_DAY_RADIUS).toBe(2);
    expect(supersedeDateRange("2026-05-10")).toEqual({
      from: "2026-05-08",
      to: "2026-05-12",
    });
  });

  it("crosses a month boundary correctly", () => {
    expect(supersedeDateRange("2026-05-01")).toEqual({
      from: "2026-04-29",
      to: "2026-05-03",
    });
  });
});

describe("compareWindowStarts", () => {
  it("orders by instant, not by spelling", () => {
    const rows = [
      "2026-05-01T15:00:00Z",
      "2026-05-01T09:00:00+09:00", // = 00:00Z
      "2026-05-01T10:00:00.000Z",
    ];
    expect([...rows].sort(compareWindowStarts)).toEqual([
      "2026-05-01T09:00:00+09:00",
      "2026-05-01T10:00:00.000Z",
      "2026-05-01T15:00:00Z",
    ]);
  });

  it("returns 0 for equal starts so the sort stays stable", () => {
    expect(
      compareWindowStarts("2026-05-01T10:00:00Z", "2026-05-01T10:00:00Z")
    ).toBe(0);
  });
});
