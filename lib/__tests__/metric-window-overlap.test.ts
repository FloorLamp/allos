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
  anchorImpliedDay,
  anchorRefusesDay,
  compareWindowStarts,
  isDayBucketMetric,
  isDayBucketWindow,
  isSupersedingWindow,
  planSupersede,
  pushOutranks,
  pushStampFor,
  sleepSessionCollapse,
  windowsContain,
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

/**
 * A day-bucket incoming row of a tiling metric, which is the only shape that acts.
 *
 * `date` defaults to the one every `win()` above uses, so a case that is about the
 * OVERLAP is not silently also a case about COVER THE DAY. The cases that are about the
 * date pass it explicitly.
 */
function incoming(
  started_at: string,
  ended_at: string,
  pushedAt: string | null = "2030-01-01T00:00:00Z",
  date = "2026-05-01"
) {
  return { metric: "steps", date, started_at, ended_at, pushedAt };
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
    // MUTATION, MEASURED 2026-08-27: adding `nutrition_kcal` reds this, the registry
    // assertion above, and the granularity case — plus the nested meal below, since
    // #3448 widened its windows past the granularity gate. Adding `hydration_l` reds the
    // same three here and, at the DB tier, both rows of
    // lib/__db_tests__/hydration-day-bucket-3448.test.ts — where the second one deletes a
    // 1.5 L drink a person really logged.
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

  // BOTH WINDOWS ARE LONGER THAN `SUB_DAILY_WINDOW_MAX_MIN`, and that is the whole point
  // of the fixture (#3448). Until 2026-08-27 the meal was 12:00-13:00 and the snack ten
  // minutes: the granularity gate refused both regardless of the metric, so adding
  // `nutrition_kcal` to DAY_BUCKET_METRICS left this case GREEN and only the registry
  // assertions above went red. A case that claims to prove the metric list is
  // load-bearing has to use windows the OTHER gate would let through.
  it("refuses to plan anything for a nested meal and snack", () => {
    const meal = win(
      1,
      "2026-05-01",
      "2026-05-01T12:00:00Z",
      "2026-05-01T14:00:00Z"
    );
    const snack = {
      metric: "nutrition_kcal",
      date: "2026-05-01",
      started_at: "2026-05-01T12:10:00Z",
      ended_at: "2026-05-01T13:30:00Z",
      pushedAt: "2030-01-01T00:00:00Z",
    };
    expect(planSupersede(snack, [meal]).supersede).toEqual([]);
    // And the reverse direction — the later, longer meal must not eat the snack.
    const snackRow = win(
      2,
      "2026-05-01",
      "2026-05-01T12:10:00Z",
      "2026-05-01T13:30:00Z"
    );
    const mealIn = {
      metric: "nutrition_kcal",
      date: "2026-05-01",
      started_at: "2026-05-01T12:00:00Z",
      ended_at: "2026-05-01T14:00:00Z",
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
      date: "2026-05-02",
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
  // 23330 (wrong, but visible, with the right number still stored beside it) to 11609
  // (invisible, and with the row holding the right number gone). Nothing repairs either
  // later — #3439 is closed as not planned — so visible is the whole of what it buys.
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
          "2026-05-01T04:00:00Z",
          "2026-05-01T23:00:00Z",
          "2026-05-01T23:00:00Z"
        ),
        stored
      ).left.map((r) => r.id)
    ).toEqual([1]);
    // No stamp at all: same.
    expect(
      planSupersede(
        incoming("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", null),
        stored
      ).left.map((r) => r.id)
    ).toEqual([1]);
    // The edit lock is a declined overlap too — the day still double counts.
    const locked = [{ ...stored[0], edited: 1 }];
    const plan = planSupersede(
      incoming(
        "2026-05-01T04:00:00Z",
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
          "2026-05-01T04:00:00Z",
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
      date: "2026-05-01",
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
      date: "2026-05-01",
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
      date: "2026-05-01",
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
      "2026-05-01T04:00:00Z",
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
      "2026-05-01T04:00:00Z",
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
      "2026-05-01T04:00:00Z",
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

describe("COVER THE DAY — the `date` term (#3424, the ruling of 2026-08-23T00:58Z)", () => {
  // WHAT IT REPLACED. The rule used to be "the newer row wins over whatever it
  // OVERLAPS", with `date` only a scan bound (a ±2-day radius, deleted with this).
  // Health Connect day buckets CHAIN across days by the zone offset, so the PREVIOUS
  // day's re-anchored bucket overlaps this day's stored row — and could delete it even
  // when nothing replaced that day. Round 10 walked a real profile to an EMPTY day
  // through the shipped Data → Manage flow with exactly that.
  //
  // The unit is the day because the day is what a person reads: `getMetricDailyTotals`
  // sums by `date`, so two rows on different dates never sum into one number.

  /** The zone-offset chain: LA 08-19 [07:00Z, +24h) overlaps NY 08-20 [04:00Z, +24h). */
  const nyAug20 = win(
    1,
    "2026-08-20",
    "2026-08-20T04:00:00Z",
    "2026-08-21T04:00:00Z",
    0,
    "2026-08-20T05:00:00Z"
  );

  it("declines a stamped bucket filed under the PREVIOUS day, though it overlaps", () => {
    // MUTATION: drop the `row.date !== incoming.date` term and this supersedes — which
    // is round 10's headline attack, and the day 08-20 goes to zero.
    const laAug19 = incoming(
      "2026-08-19T07:00:00Z",
      "2026-08-20T07:00:00Z",
      "2026-08-21T12:00:00Z",
      "2026-08-19"
    );
    expect(
      windowsOverlap(
        laAug19.started_at,
        laAug19.ended_at,
        nyAug20.started_at,
        nyAug20.ended_at
      )
    ).toBe(true);
    expect(planSupersede(laAug19, [nyAug20]).supersede).toEqual([]);
  });

  it("does not COUNT that pair either — a chain is not a double count", () => {
    // The two rows are filed under different dates, so no day reads high because of
    // them and there is nothing for Review to say. MUTATION: route the date mismatch to
    // `left` instead of skipping it, and every re-anchored push warns about a day that
    // is correct.
    const laAug19 = incoming(
      "2026-08-19T07:00:00Z",
      "2026-08-20T07:00:00Z",
      "2026-08-21T12:00:00Z",
      "2026-08-19"
    );
    const plan = planSupersede(laAug19, [nyAug20]);
    expect(plan.left).toEqual([]);
    expect(plan.locked).toEqual([]);
  });

  it("collapses the SAME stored row from a bucket filed under ITS date — the control", () => {
    // The prod pair: LA 08-20 [07:00Z, +24h) against NY 08-20 [04:00Z, +24h). Same
    // date, overlapping, newer stamp — this is the delete the PR exists to make, and
    // without it the test above passes for the wrong reason.
    const laAug20 = incoming(
      "2026-08-20T07:00:00Z",
      "2026-08-21T07:00:00Z",
      "2026-08-21T12:00:00Z",
      "2026-08-20"
    );
    expect(
      planSupersede(laAug20, [nyAug20]).supersede.map((r) => r.id)
    ).toEqual([1]);
  });

  it("still requires the OVERLAP — the date alone does not license a delete", () => {
    // Two same-anchoring neighbours filed under one date (a rollover pair, or a day the
    // exporter cut twice) are two readings, not an anomaly. MUTATION: replace the
    // overlap test with the date test and this deletes a disjoint reading.
    const morning = win(
      2,
      "2026-05-01",
      "2026-05-01T00:00:00Z",
      "2026-05-01T06:00:00Z",
      0,
      "2026-05-01T07:00:00Z"
    );
    const evening = incoming(
      "2026-05-01T18:00:00Z",
      "2026-05-02T00:00:00Z",
      "2026-05-02T01:00:00Z"
    );
    expect(planSupersede(evening, [morning]).supersede).toEqual([]);
    expect(planSupersede(evening, [morning]).left).toEqual([]);
  });

  it("leaves the day holding the row that justified the delete", () => {
    // THE INVARIANT, at the level this module can state it: a victim's justifier is
    // itself filed under the victim's date. So whatever this function returns, the date
    // is not emptied — the caller has already excluded this push's own rows from the
    // candidate set, so the justifier can never be in `supersede`.
    const laAug20 = incoming(
      "2026-08-20T07:00:00Z",
      "2026-08-21T07:00:00Z",
      "2026-08-21T12:00:00Z",
      "2026-08-20"
    );
    const plan = planSupersede(laAug20, [nyAug20]);
    for (const row of plan.supersede) expect(row.date).toBe(laAug20.date);
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

const HOUR = 60 * 60 * 1000;
// The four offsets the ambiguity cases lean on, as milliseconds — a profile's own zone
// is the ONLY argument the derivation takes beyond the window.
const HONOLULU = -10 * HOUR;
const KIRITIMATI = 14 * HOUR;
const CHATHAM = 12.75 * HOUR;
const KOLKATA = 5.5 * HOUR;

// A window wide enough to clear the day-bucket granularity gate, from any start.
const wide = (start: string) =>
  new Date(Date.parse(start) + 11 * HOUR).toISOString();

describe("anchorImpliedDay — the day a bucket names, read off its own anchor (#3901)", () => {
  // A day bucket's `started_at` IS a device-local midnight, so the implied offset is the
  // one that makes it midnight: o = -(started_at mod 24h), normalized into [-12h, +14h]
  // at quarter-hour granularity. `profileOffsetMs` is consulted ONLY inside the
  // 10:00Z-12:00Z band, where UTC-10…-12 and UTC+12…+14 are both admissible.
  it.each([
    // The prod sequence of #3901, each bucket naming its own day whatever the profile
    // held at push time — the profile argument below is deliberately the WRONG zone for
    // two of the three, exactly as prod's lagging banner made it.
    ["HST anchor", "2026-08-25T10:00:00Z", HONOLULU, "2026-08-25"],
    [
      "LA anchor, profile still Honolulu",
      "2026-08-26T07:00:00Z",
      HONOLULU,
      "2026-08-26",
    ],
    [
      "NY anchor, profile still LA",
      "2026-08-27T04:00:00Z",
      -7 * HOUR,
      "2026-08-27",
    ],
    // Quarter-hour offsets, which is why the grid is 15 minutes and not an hour.
    ["+05:30 (Kolkata)", "2026-08-25T18:30:00Z", KOLKATA, "2026-08-26"],
    ["+05:45 (Kathmandu)", "2026-08-25T18:15:00Z", KOLKATA, "2026-08-26"],
    ["+12:45 (Chatham)", "2026-08-25T11:15:00Z", CHATHAM, "2026-08-26"],
    // UTC itself, and the far edges of the real-offset range.
    ["UTC", "2026-08-25T00:00:00Z", 0, "2026-08-25"],
    ["-11 (Niue)", "2026-08-25T11:00:00Z", -11 * HOUR, "2026-08-25"],
    ["+13 (Apia)", "2026-08-25T11:00:00Z", 13 * HOUR, "2026-08-26"],
    // THE ONLY AMBIGUOUS BAND, PINNED FROM BOTH SIDES. The same anchor, two profiles,
    // two answers — and each is the one that profile's own calendar keeps.
    [
      "10:00Z, Honolulu profile keeps -10",
      "2026-08-25T10:00:00Z",
      HONOLULU,
      "2026-08-25",
    ],
    [
      "10:00Z, +14 profile keeps +14",
      "2026-08-25T10:00:00Z",
      KIRITIMATI,
      "2026-08-26",
    ],
    // AND SKEWED, WHICH IS THE ONLY WAY THIS BAND CAN BE TESTED AT ALL. Everywhere else
    // the anchor decides and the profile argument is inert; HERE the profile is the sole
    // decider, so a table of matched pairs (each profile agreeing with its own device)
    // cannot fail in the one dimension the whole issue is about. Every row below is a
    // device and a profile in DIFFERENT zones, which is what a travel switch is.
    //
    // The first is #3924's refutation, and it is the prod loss again: a completed
    // Honolulu 08-25 bucket arriving late — phone offline on the transpacific leg,
    // banner already tapped — against a profile already on Tokyo time. Choosing the
    // NEAREST OFFSET picks +14 (5h from +9, against 19h for -10) and files it on
    // 2026-08-26, where the genuine JST bucket then supersedes it and 08-25 holds
    // nothing. Nearest offset is the wrong metric: five hours of offset can be a whole
    // day of date.
    [
      "10:00Z HST bucket, profile already Tokyo",
      "2026-08-25T10:00:00Z",
      9 * HOUR,
      "2026-08-25",
    ],
    [
      "10:00Z HST bucket, profile at +3",
      "2026-08-25T10:00:00Z",
      3 * HOUR,
      "2026-08-25",
    ],
    // The same failure from the +12 side: break-even is `profileOffset > 12h - anchor`,
    // so at a 12:00Z anchor ANY profile east of UTC used to flip the day.
    [
      "12:00Z bucket, profile just east of UTC",
      "2026-08-25T12:00:00Z",
      1 * HOUR,
      "2026-08-25",
    ],
    // Neither candidate day is the profile's: the profile is further west than the
    // anchor's own west representative, so its day is 08-24 and the nearest-offset
    // fallback decides — pointing west with it, which is where the device likely is.
    [
      "10:00Z bucket, profile west of BOTH candidate days",
      "2026-08-25T10:00:00Z",
      -11 * HOUR,
      "2026-08-25",
    ],
    ["12:00Z, -12 profile", "2026-08-25T12:00:00Z", -12 * HOUR, "2026-08-25"],
    ["12:00Z, +12 profile", "2026-08-25T12:00:00Z", 12 * HOUR, "2026-08-26"],
  ])("%s", (_name, start, offset, expected) => {
    expect(anchorImpliedDay("steps", start, wide(start), offset)).toBe(
      expected
    );
  });

  // WHAT IT DECLINES, AND EVERY ONE OF THESE IS A ROW THAT MUST KEEP THE PROFILE-ZONE
  // ATTRIBUTION. A null here is what routes the caller back to today's derivation.
  it.each([
    // Not a tiling metric — nutrition and sleep sit on their records' REAL windows.
    [
      "nutrition",
      "nutrition_kcal",
      "2026-08-25T10:00:00Z",
      "2026-08-25T21:00:00Z",
    ],
    ["sleep", "sleep_min", "2026-08-25T04:00:00Z", "2026-08-25T12:00:00Z"],
    [
      "hydration",
      "hydration_l",
      "2026-08-25T10:00:00Z",
      "2026-08-25T21:00:00Z",
    ],
    // A `15m` exporter setting sends the SAME metrics as minute buckets, and a 15-minute
    // window starting 14:00Z would otherwise "imply" UTC+10 and file a New York
    // afternoon on tomorrow. The granularity gate is what makes that unreachable.
    [
      "a 15-minute bucket",
      "steps",
      "2026-08-25T14:00:00Z",
      "2026-08-25T14:15:00Z",
    ],
    [
      "a point reading",
      "steps",
      "2026-08-25T10:00:00Z",
      "2026-08-25T10:00:00Z",
    ],
    // An instant with no UTC designator is refused by `instantMs` and never compared.
    [
      "a bare local string",
      "steps",
      "2026-08-25T10:00:00",
      "2026-08-25T21:00:00",
    ],
    // Off the quarter-hour grid: no real zone keeps a midnight here, so the window
    // states no anchor and the profile attribution stands.
    [
      "an anchor at 04:07Z",
      "steps",
      "2026-08-25T04:07:00Z",
      "2026-08-25T21:00:00Z",
    ],
  ])("declines %s", (_name, metric, start, end) => {
    expect(anchorImpliedDay(metric, start, end, 0)).toBeNull();
  });
});

describe("anchorRefusesDay — the supersede guard's own reader (#3901)", () => {
  // It takes NO zone: in the ambiguous band a bucket has two admissible days and either
  // one is consistent with the anchor, so a profile that has since moved cannot make a
  // correctly-filed bucket look mislabeled.
  it.each([
    ["the day its anchor names", "2026-08-27T04:00:00Z", "2026-08-27", false],
    [
      "the neighbour prod filed it under",
      "2026-08-27T04:00:00Z",
      "2026-08-26",
      true,
    ],
    [
      "the westward admissible day",
      "2026-08-25T10:00:00Z",
      "2026-08-25",
      false,
    ],
    [
      "the eastward admissible day",
      "2026-08-25T10:00:00Z",
      "2026-08-26",
      false,
    ],
    ["neither admissible day", "2026-08-25T10:00:00Z", "2026-08-24", true],
    // No anchor to contradict: an unreadable instant and an off-grid start both refuse
    // nothing, so the guard cannot make the rule inert on a store it cannot read.
    ["an unreadable instant", "2026-08-25T10:00:00", "2026-08-25", false],
    ["an off-grid anchor", "2026-08-25T04:07:00Z", "2026-08-25", false],
  ])("%s", (_name, start, date, expected) => {
    expect(anchorRefusesDay(start, date)).toBe(expected);
  });
});

describe("THE ANCHOR GUARD inside planSupersede (#3901)", () => {
  const stored: MetricWindow = {
    id: 1,
    date: "2026-08-26",
    started_at: "2026-08-26T07:00:00Z",
    ended_at: "2026-08-27T07:00:00Z",
    edited: null,
    pushed_at: "2026-08-26T23:00:00Z",
  };
  // The prod row, exactly: an NY-anchored bucket filed under the LA-local day because
  // the profile's zone had not flipped yet. It outranks, it overlaps, it covers the
  // date — and every one of those is true of a row whose own anchor says 08-27.
  const mislabeled = {
    metric: "steps",
    date: "2026-08-26",
    started_at: "2026-08-27T04:00:00Z",
    ended_at: "2026-08-27T21:51:56Z",
    pushedAt: "2026-08-27T21:51:56Z",
  };

  it("deletes nothing, and reports the day still reading high", () => {
    const plan = planSupersede(mislabeled, [stored]);
    expect(plan.supersede).toEqual([]);
    expect(plan.left.map((r) => r.id)).toEqual([1]);
  });

  // MUTATION: delete the `anchorContradictsDate` branch in `planSupersede` and this row
  // is superseded — which is the prod deletion, reproduced.
  it("still supersedes when the bucket IS filed under the day its anchor names", () => {
    const consistent = { ...mislabeled, date: "2026-08-27" };
    const neighbour = { ...stored, id: 2, date: "2026-08-27" };
    const plan = planSupersede(consistent, [neighbour]);
    expect(plan.supersede.map((r) => r.id)).toEqual([2]);
  });
});

// #3628 — the re-timed sleep session. Written in this file's mutation-audit style: each
// term of `sleepSessionCollapse` has a row that goes red when that term alone is removed,
// because a `collapse` verdict deletes a night out of a person's record.
describe("sleepSessionCollapse", () => {
  const FITBIT = "com.fitbit.FitbitMobile";
  // The prod pair: 6 h apart, overlapping by 17 minutes, same 377-minute duration.
  const MIS_ZONED = {
    id: 10,
    date: "2026-08-21",
    origin: FITBIT,
    started_at: "2026-08-21T23:58:00Z",
    ended_at: "2026-08-22T06:15:00Z",
    edited: null,
    pushed_at: "2026-08-22T13:40:00Z",
  };
  const CORRECTED = {
    id: 20,
    origin: FITBIT,
    started_at: "2026-08-22T05:58:00Z",
    ended_at: "2026-08-22T12:15:00Z",
  };
  // The watermark: rows below it predate this push, rows at or above it are its own.
  const PUSH = 20;

  it.each([
    // The defect, collapsed.
    ["the prod pair", CORRECTED, MIS_ZONED, PUSH, "collapse"],
    // SAME ORIGIN, AND NAMED. A second device's overlapping night is a different
    // question; a NULL origin is an unknown one, not a shared one, in either role.
    [
      "a different origin",
      CORRECTED,
      { ...MIS_ZONED, origin: "com.oura.oura" },
      PUSH,
      "keep",
    ],
    [
      "a stored row with no origin",
      CORRECTED,
      { ...MIS_ZONED, origin: null },
      PUSH,
      "keep",
    ],
    [
      "an incoming row with no origin",
      { ...CORRECTED, origin: null },
      { ...MIS_ZONED, origin: null },
      PUSH,
      "keep",
    ],
    // OVERLAP, AS INSTANTS. A nap after the night, and #1191's post-gap fragment, are
    // non-overlapping by construction. A naive `${date}T00:00:00` decides nothing.
    [
      "a session that ends before the winner starts",
      CORRECTED,
      {
        ...MIS_ZONED,
        started_at: "2026-08-21T18:00:00Z",
        ended_at: "2026-08-21T19:00:00Z",
      },
      PUSH,
      "keep",
    ],
    [
      "a stored window with no offset",
      CORRECTED,
      { ...MIS_ZONED, started_at: "2026-08-21T23:58:00" },
      PUSH,
      "keep",
    ],
    // LATER BY INSERTION. The loser must predate this push and the winner must belong
    // to it — never "the one whose window starts later", which is the whole trap: here
    // the corrected write starts SIX HOURS after the row it corrects.
    [
      "a stored row this same push inserted",
      CORRECTED,
      { ...MIS_ZONED, id: 21 },
      PUSH,
      "keep",
    ],
    [
      "a winner that predates this push",
      { ...CORRECTED, id: 15 },
      MIS_ZONED,
      PUSH,
      "keep",
    ],
    // THE #133 LOCK: reported, never deleted.
    [
      "a hand-edited night",
      CORRECTED,
      { ...MIS_ZONED, edited: 1 },
      PUSH,
      "locked",
    ],
  ] as const)("%s", (_label, winner, stored, firstId, expected) => {
    expect(sleepSessionCollapse(winner, stored, firstId)).toBe(expected);
  });
});

// The stage sweep's bound. A stage tiles its session exactly, so containment is CLOSED
// on both ends — and an unreadable instant answers false, which leaves the row alone.
describe("windowsContain", () => {
  const OUTER = ["2026-08-21T23:58:00Z", "2026-08-22T06:15:00Z"] as const;
  it.each([
    [
      "a stage flush to the session start",
      "2026-08-21T23:58:00Z",
      "2026-08-22T00:58:00Z",
      true,
    ],
    [
      "a stage flush to the session end",
      "2026-08-22T05:00:00Z",
      "2026-08-22T06:15:00Z",
      true,
    ],
    ["the whole session", ...OUTER, true],
    [
      "a stage starting before it",
      "2026-08-21T23:00:00Z",
      "2026-08-22T00:58:00Z",
      false,
    ],
    [
      "a stage ending after it",
      "2026-08-22T05:00:00Z",
      "2026-08-22T07:00:00Z",
      false,
    ],
    [
      "an offsetless instant",
      "2026-08-21T23:58:00",
      "2026-08-22T00:58:00Z",
      false,
    ],
  ] as const)("%s", (_label, start, end, expected) => {
    expect(windowsContain(OUTER[0], OUTER[1], start, end)).toBe(expected);
  });
});
