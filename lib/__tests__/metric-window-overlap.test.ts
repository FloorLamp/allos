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
  MAX_PUSH_CLOCK_SKEW_MS,
  SUPERSEDE_DAY_RADIUS,
  compareWindowStarts,
  isDayBucketMetric,
  isDayBucketWindow,
  isSupersedingWindow,
  planSupersede,
  pushOutranks,
  pushStampFor,
  supersedeDateRange,
  windowsOverlap,
  type MetricWindow,
} from "@/lib/metric-window-overlap";
import { SUB_DAILY_WINDOW_MAX_MIN } from "@/lib/integrations/health-connect";
import { utcInstant } from "@/lib/date";

/** A fixed "now" so the clock-skew bound is asserted against a stated instant. */
const NOW = new Date("2026-05-03T12:00:00Z");

// A STORED ROW IS STAMPED BY DEFAULT, because that is what every row written since the
// migration is. A NULL stamp is a state of its own — see `pushOutranks` — so the cases
// that mean it say it, rather than inheriting it from a helper's default.
const STORED_STAMP = "2026-05-01T00:00:00Z";

function win(
  id: number,
  date: string,
  started_at: string,
  ended_at: string,
  edited: number | null = 0,
  pushed_at: string | null = STORED_STAMP
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

describe("pushOutranks — freshness as the PAYLOAD states it, in THREE states", () => {
  // WHY IT EXISTS. The first cut decided freshness from arrival, which was refuted
  // twice: a byte-identical REPLAY of a pre-switch payload deleted the row that had
  // superseded it, and a mixed-anchoring pair split across two 1000-row chunks was
  // resolved by which chunk ran last — the stale bucket deleting the current one.
  const stamped = (pushed_at: string | null, id = 1) => ({ id, pushed_at });
  // A store migrated at 2026-06-01 that held 100 rows at that moment.
  const ERA = { startedAt: "2026-06-01T00:00:00Z", lastUnstampedId: 100 };

  it("is true only when the incoming push is STRICTLY newer", () => {
    expect(
      pushOutranks("2026-05-02T01:00:00Z", stamped("2026-05-01T23:00:00Z"), ERA)
    ).toBe(true);
    expect(
      pushOutranks("2026-05-01T23:00:00Z", stamped("2026-05-02T01:00:00Z"), ERA)
    ).toBe(false);
  });

  it("is FALSE on an equal stamp — a replay, or a second chunk of the same push", () => {
    // MUTATION: relax this to `>=` and both refutations come straight back.
    expect(
      pushOutranks("2026-05-01T23:00:00Z", stamped("2026-05-01T23:00:00Z"), ERA)
    ).toBe(false);
  });

  // ── THE THIRD STATE. A NULL stamp means UNKNOWN, not "older than everything". ──
  //
  // Reading it as old is the defect that survived four adversarial rounds: on deploy
  // day EVERY row is NULL, the correct ones included, so a byte-identical replay of a
  // pre-switch push deleted the CORRECT re-anchored row and the day went from reading
  // 23330 (visible, repairable by #3439) to 11609 (invisible, and unrepairable, because
  // the row holding the right number was gone).
  it("supersedes a NULL row ONLY when both era facts are proven", () => {
    // The row was in the table when the column landed, and the push happened after.
    expect(pushOutranks("2026-06-02T00:00:00Z", stamped(null, 100), ERA)).toBe(
      true
    );
  });

  it("refuses a NULL row the migration never saw — a stampless push wrote it AFTER", () => {
    // MUTATION: drop the `id <= lastUnstampedId` clause. A stampless Health Connect
    // push writes the CURRENT anchoring with a NULL stamp; a stale stamped push then
    // deletes it and the day reads LOW. Verified red as zzr6-attack A2b.
    expect(pushOutranks("2026-06-02T00:00:00Z", stamped(null, 101), ERA)).toBe(
      false
    );
  });

  it("refuses a push made BEFORE the column landed — the delayed stale retry", () => {
    // MUTATION: drop the `incoming > startedAt` clause. A push queued on a phone that
    // went offline before the deploy and drained after it carries a stamp from before
    // the era, and every row it would delete is one it cannot possibly know about.
    // Verified red as zzr6-staleretry E2/E3 and zzr6-replay B1.
    expect(pushOutranks("2026-05-31T23:59:59Z", stamped(null, 100), ERA)).toBe(
      false
    );
  });

  it("refuses every NULL row when there is no era at all", () => {
    // No marker, or an unreadable one: nothing is known, so nothing is deleted.
    expect(pushOutranks("2026-06-02T00:00:00Z", stamped(null, 1), null)).toBe(
      false
    );
    expect(
      pushOutranks("2026-06-02T00:00:00Z", stamped(null, 1), {
        startedAt: "2026-06-01T00:00:00",
        lastUnstampedId: 100,
      })
    ).toBe(false);
  });

  it("leaves a STAMPED row's comparison alone, era or no era", () => {
    // The era licenses nothing extra: a stamped row is decided by its own stamp, so an
    // era cannot widen what a stale push may delete.
    expect(
      pushOutranks("2026-05-01T00:00:00Z", stamped("2026-05-02T00:00:00Z"), ERA)
    ).toBe(false);
    expect(
      pushOutranks(
        "2026-07-01T00:00:00Z",
        stamped("2026-05-02T00:00:00Z"),
        null
      )
    ).toBe(true);
  });

  it("refuses a push that cannot say when it happened", () => {
    expect(pushOutranks(null, stamped(null), ERA)).toBe(false);
    expect(pushOutranks(undefined, stamped("2026-05-01T00:00:00Z"), ERA)).toBe(
      false
    );
    // Zone-less: unreadable, so it deletes nothing.
    expect(pushOutranks("2026-05-02T00:00:00", stamped(null), ERA)).toBe(false);
  });
});

describe("pushStampFor — the push's OWN time, and nothing that looks like it", () => {
  it("takes what the exporter stated, canonicalised", () => {
    expect(pushStampFor("2026-05-03T00:00:00.123Z", NOW)).toBe(
      "2026-05-03T00:00:00Z"
    );
    expect(pushStampFor("2026-05-03T09:00:00+09:00", NOW)).toBe(
      "2026-05-03T00:00:00Z"
    );
  });

  it("gives a byte-identical replay the SAME stamp", () => {
    // The property the whole replay defence rests on: a retry is never newer than the
    // push it replays.
    expect(pushStampFor("2026-05-03T00:00:00Z", NOW)).toBe(
      pushStampFor("2026-05-03T00:00:00Z", NOW)
    );
  });

  it("returns NULL when the push states nothing readable — no window fallback", () => {
    // MUTATION: reintroduce "else use the furthest-forward ended_at in the push" and a
    // re-anchored COMPLETED day, which ends earlier than the still-filling row it
    // corrects, reads as the OLDER push. Measured: the correcting 3500 was never
    // written and the day stood at 3000 for 3500 walked, with nothing to converge it.
    // An end is a property of the READING; only the push may say when the push was.
    expect(pushStampFor(null, NOW)).toBe(null);
    expect(pushStampFor(undefined, NOW)).toBe(null);
    // Zone-less: unreadable as an instant, so it is not a stamp either.
    expect(pushStampFor("2026-05-03T00:00:00", NOW)).toBe(null);
  });

  it("states the bound in hours, so widening it is a visible edit", () => {
    // MUTATION: 12 h -> 12 days. The boundary test below builds its fixture FROM the
    // constant, so it pins the comparison and not the magnitude — this pins the
    // magnitude. A bound nobody has written down is a bound that drifts.
    expect(MAX_PUSH_CLOCK_SKEW_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("refuses a stamp further ahead of this clock than MAX_PUSH_CLOCK_SKEW_MS", () => {
    // A phone with a fast clock writes its stamp onto the rows it stores, and every
    // later honest push then reads as older than them — so nothing could supersede
    // those rows again, ever. MUTATION: drop the bound and that becomes permanent.
    const ahead = new Date(NOW.getTime() + MAX_PUSH_CLOCK_SKEW_MS + 60_000);
    expect(pushStampFor(ahead.toISOString(), NOW)).toBe(null);
    // Inside the bound is still believed — this is a "that cannot be a push" check,
    // not a clock-sync check.
    const nearly = new Date(NOW.getTime() + MAX_PUSH_CLOCK_SKEW_MS - 60_000);
    expect(pushStampFor(nearly.toISOString(), NOW)).toBe(utcInstant(nearly));
  });
});

describe("a stamp in the PAST is believed, and reported instead", () => {
  it("accepts an arbitrarily old stamp — the bound is deliberately one-sided", () => {
    // A phone whose clock went BACKWARDS stamps every later push in the past, so
    // `pushOutranks` is false forever and the day keeps reading high. Refusing an old
    // stamp would not help: it would yield no stamp, which declines the supersede in
    // exactly the same way. The bound exists only for the FUTURE direction, where a
    // believed stamp is written onto rows and poisons them against every later push.
    // What covers the backwards clock is the other half of this design — the count of
    // overlaps LEFT STANDING, which is emitted from what happened rather than from why.
    expect(pushStampFor("2019-01-01T00:00:00Z", NOW)).toBe(
      "2019-01-01T00:00:00Z"
    );
  });

  it("counts an overlap it declined, whatever the reason", () => {
    const stored = [
      win(
        1,
        "2026-05-01",
        "2026-05-01T10:00:00Z",
        "2026-05-02T01:00:00Z",
        0,
        "2026-05-02T01:00:00Z"
      ),
    ];
    // Older stamp: declined, and COUNTED.
    expect(
      planSupersede(
        incoming(
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          "2026-05-01T23:00:00Z"
        ),
        stored
      ).left.map((r) => r.id)
    ).toEqual([1]);
    // No stamp at all: same.
    expect(
      planSupersede(
        incoming("2026-05-01T15:00:00Z", "2026-05-01T23:00:00Z", null),
        stored
      ).left.map((r) => r.id)
    ).toEqual([1]);
    // The edit lock is a declined overlap too — the day still double counts.
    const locked = [{ ...stored[0], edited: 1 }];
    const plan = planSupersede(
      incoming(
        "2026-05-01T15:00:00Z",
        "2026-05-01T23:00:00Z",
        "2026-05-03T00:00:00Z"
      ),
      locked
    );
    expect(plan.supersede).toEqual([]);
    expect(plan.left.map((r) => r.id)).toEqual([1]);
    // And a supersede that DID happen leaves nothing standing.
    expect(
      planSupersede(
        incoming(
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          "2026-05-03T00:00:00Z"
        ),
        stored
      ).left
    ).toEqual([]);
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

  // ── WHAT `left` COUNTS. It promised "every overlap this row DECLINED to collapse,
  // whatever the reason" and did not deliver two of them, including the ONLY one no
  // later push repairs. And it counted PAIRS, so two incoming buckets over one stored
  // row reported "2 daily totals" for one day that reads wrong.
  it("counts the stored SUB-DAILY bucket it may never collapse — the permanent one", () => {
    // MUTATION: `continue` before pushing this row and a day reads 9200 for 9000 walked,
    // forever, with `warnings: []`. Verified red as zzr6-attack A3a and zzr6-count D2.
    const shortBucket = win(
      1,
      "2026-05-01",
      "2026-05-01T04:00:00Z",
      "2026-05-01T04:20:00Z",
      0,
      "2026-05-01T04:20:05Z"
    );
    const plan = planSupersede(
      incoming(
        "2026-04-30T15:00:00Z",
        "2026-05-01T13:00:00Z",
        "2026-05-01T13:00:05Z"
      ),
      [shortBucket]
    );
    expect(plan.supersede).toEqual([]);
    expect(plan.left.map((r) => r.id)).toEqual([1]);
  });

  it("counts a FINE-GRAINED incoming row landing on a stored day bucket", () => {
    // Verified red as zzr6-count D3. Not reachable from `upsertMetricSamples`, which
    // only looks up day-bucket windows — one indexed query per minute bucket is not a
    // cost this path may take. Said at the call site rather than promised here.
    const dayBucket = win(
      1,
      "2026-05-01",
      "2026-05-01T04:00:00Z",
      "2026-05-02T00:00:00Z",
      0,
      null
    );
    const minute = {
      metric: "steps",
      started_at: "2026-05-01T07:00:00Z",
      ended_at: "2026-05-01T07:30:00Z",
      pushedAt: "2026-05-01T07:30:05Z",
    };
    expect(planSupersede(minute, [dayBucket]).left.map((r) => r.id)).toEqual([
      1,
    ]);
  });

  it("says NOTHING about two overlapping MINUTE buckets — that is two devices summing", () => {
    // MUTATION: count an overlap when NEITHER side is a day bucket, and two origin-less
    // devices at `1m` produce a Review line on every push of every day.
    const deviceA = win(
      1,
      "2026-05-01",
      "2026-05-01T10:00:00Z",
      "2026-05-01T10:01:00Z"
    );
    const deviceB = {
      metric: "steps",
      started_at: "2026-05-01T10:00:30Z",
      ended_at: "2026-05-01T10:01:30Z",
      pushedAt: "2030-01-01T00:00:00Z",
    };
    const plan = planSupersede(deviceB, [deviceA]);
    expect(plan.supersede).toEqual([]);
    expect(plan.left).toEqual([]);
  });

  it("says nothing about a nested meal and snack either", () => {
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
    expect(planSupersede(snack, [meal]).left).toEqual([]);
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

  it("reports only what it deletes and what a lock held — never a write to withhold", () => {
    // MUTATION: bring back a `blocked` list and have the caller drop the incoming row.
    // That version could LOSE a reading and say "nothing new" about it; the most a
    // stale row may do now is sit beside the fresh one as a visible double count.
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
    expect(Object.keys(planSupersede(replay, converged)).sort()).toEqual([
      "left",
      "locked",
      "supersede",
    ]);
    // And a genuinely newer push still supersedes — otherwise nothing converges.
    const newer = incoming(
      "2026-05-01T15:00:00Z",
      "2026-05-01T23:00:00Z",
      "2026-05-03T00:00:00Z"
    );
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
