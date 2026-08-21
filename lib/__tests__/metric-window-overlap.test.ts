// PURE TIER — the overlap-supersede rule itself (#3424), with no database in sight.
//
// This path DELETES stored health rows, so the tests below are written as a MUTATION
// audit rather than a happy-path sweep: each guard in lib/metric-window-overlap.ts has
// at least one case that goes red when that guard alone is removed, and the comment on
// each names which. A suite where three of four guards could be deleted green is the
// failure mode this file exists to avoid.
//
// SYNTHETIC ONLY: invented instants, invented ids, no PHI.

import { describe, expect, it } from "vitest";
import {
  SUPERSEDE_DAY_RADIUS,
  compareWindowStarts,
  isSupersedingInterval,
  overlapGroupKey,
  planOverlapSupersede,
  planSupersede,
  staleBatchOverlaps,
  supersedeDateRange,
  windowsOverlap,
  type MetricWindow,
} from "@/lib/metric-window-overlap";

function win(
  id: number,
  date: string,
  started_at: string,
  ended_at: string,
  edited: number | null = 0
): MetricWindow {
  return { id, date, started_at, ended_at, edited };
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
        "2026-05-01T06:00:00Z",
        "2026-05-01T12:00:00Z"
      )
    ).toBe(false);
  });

  it("treats a shared boundary as ADJACENT, not overlapping", () => {
    // THE DISJOINT-BUCKET GUARANTEE. A fine-grained exporter emits back-to-back
    // windows that meet exactly; if this answered true, every one of them would
    // delete its neighbour and sub-daily data would vanish silently.
    for (let hour = 0; hour < 23; hour++) {
      const a = `2026-05-01T${String(hour).padStart(2, "0")}:00:00Z`;
      const b = `2026-05-01T${String(hour + 1).padStart(2, "0")}:00:00Z`;
      const c = `2026-05-01T${String(hour + 2).padStart(2, "0")}:00:00Z`;
      expect(windowsOverlap(a, b, b, c)).toBe(false);
    }
  });

  it("never touches a POINT reading, in either role", () => {
    // MUTATION: drop the `ae <= as || be <= bs` line and this goes red. The textbook
    // half-open test says TRUE for a zero-length window inside a real one — which is
    // how a daily steps bucket would come to delete an HRV reading.
    const point = "2026-05-01T12:00:00Z";
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00Z",
        "2026-05-02T00:00:00Z",
        point,
        point
      )
    ).toBe(false);
    expect(
      windowsOverlap(
        point,
        point,
        "2026-05-01T00:00:00Z",
        "2026-05-02T00:00:00Z"
      )
    ).toBe(false);
    expect(windowsOverlap(point, point, point, point)).toBe(false);
    expect(isSupersedingInterval(point, point)).toBe(false);
  });

  it("compares instants, not strings — millisecond and offset spellings agree", () => {
    // MUTATION: compare the raw strings instead of Date.parse and both of these flip.
    // `.` sorts before `Z`, and an offset spelling does not sort at all.
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00.000Z",
        "2026-05-02T00:00:00.000Z",
        "2026-05-02T00:00:00Z",
        "2026-05-03T00:00:00Z"
      )
    ).toBe(false);
    // Tokyo midnight written as an offset IS 2026-05-01T15:00:00Z.
    expect(
      windowsOverlap(
        "2026-05-01T10:00:00Z",
        "2026-05-01T20:00:00Z",
        "2026-05-02T00:00:00+09:00",
        "2026-05-02T08:00:00+09:00"
      )
    ).toBe(true);
  });

  it("refuses an instant with no zone rather than guessing the host's", () => {
    // `metric_samples.started_at` is a documented `mixed` column: a reading whose
    // author stated only a day is stored as a bare `${date}T00:00:00`. Parsing that
    // would make a DELETE depend on the server's timezone, so the rule declines.
    expect(
      windowsOverlap(
        "2026-05-01T00:00:00",
        "2026-05-02T00:00:00",
        "2026-05-01T10:00:00Z",
        "2026-05-01T20:00:00Z"
      )
    ).toBe(false);
    expect(windowsOverlap("nonsense", "also-nonsense", "x", "y")).toBe(false);
  });
});

describe("planSupersede — what an incoming window does to the store", () => {
  const westwardIncoming = {
    // Honolulu midnight: EARLIER than the Tokyo midnight it replaces.
    started_at: "2026-05-01T10:00:00Z",
    ended_at: "2026-05-02T01:00:00Z",
  };
  const tokyoStored = win(
    7,
    "2026-05-01",
    "2026-05-01T15:00:00Z",
    "2026-05-01T23:00:00Z"
  );

  it("supersedes every non-locked row it overlaps", () => {
    const plan = planSupersede(westwardIncoming, [tokyoStored]);
    expect(plan.supersede.map((r) => r.id)).toEqual([7]);
    expect(plan.locked).toEqual([]);
  });

  it("supersedes a stored row that ends LATER than it does", () => {
    // A completed re-anchored bucket for a past day legitimately ends earlier than the
    // old-anchoring "today so far" row it overlaps. Blocking it there was measured to
    // leave the profile half-converged, with an 11-hour gap between the two anchorings.
    const stillFilling = win(
      4,
      "2026-08-20",
      "2026-08-20T04:00:00Z",
      "2026-08-20T18:00:00Z"
    );
    const completedReanchored = {
      started_at: "2026-08-19T15:00:00Z",
      ended_at: "2026-08-20T15:00:00Z",
    };
    expect(
      planSupersede(completedReanchored, [stillFilling]).supersede.map((r) => r.id)
    ).toEqual([4]);
  });

  it("holds an EDIT-LOCKED overlap out of the delete set", () => {
    // MUTATION: drop the `row.edited` branch and the locked row lands in `supersede`,
    // which is a hand-corrected reading being deleted by a sync.
    const plan = planSupersede(westwardIncoming, [
      { ...tokyoStored, edited: 1 },
    ]);
    expect(plan.supersede).toEqual([]);
    expect(plan.locked.map((r) => r.id)).toEqual([7]);
  });

  it("reads a NULL lock as unlocked, exactly as the #608 sweep does", () => {
    const plan = planSupersede(westwardIncoming, [
      { ...tokyoStored, edited: null },
    ]);
    expect(plan.supersede.map((r) => r.id)).toEqual([7]);
  });

  it("leaves disjoint neighbours alone", () => {
    const plan = planSupersede(westwardIncoming, [
      win(1, "2026-04-30", "2026-04-30T10:00:00Z", "2026-05-01T10:00:00Z"),
      win(2, "2026-05-02", "2026-05-02T01:00:00Z", "2026-05-03T01:00:00Z"),
    ]);
    expect(plan.supersede).toEqual([]);
    expect(plan.locked).toEqual([]);
  });

  it("does nothing at all when the INCOMING window is a point reading", () => {
    const plan = planSupersede(
      { started_at: "2026-05-01T18:00:00Z", ended_at: "2026-05-01T18:00:00Z" },
      [tokyoStored]
    );
    expect(plan.supersede).toEqual([]);
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
    // MUTATION: rank by started_at instead of freshness and the reversed order keeps
    // the 3000-step Tokyo record. This is the exact defect the ascending-order
    // instruction alone could not fix.
    expect([...staleBatchOverlaps([honolulu, tokyo])]).toEqual([tokyo]);
  });

  it("keeps every row of an ordinary single-anchoring push", () => {
    const disjoint = Array.from({ length: 24 }, (_, h) => ({
      metric: "steps",
      origin: null,
      started_at: `2026-05-01T${String(h).padStart(2, "0")}:00:00Z`,
      ended_at: `2026-05-01T${String(h + 1).padStart(2, "0")}:00:00Z`,
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
    expect(staleBatchOverlaps([point, { ...point, started_at: "2026-05-01T19:00:00Z", ended_at: "2026-05-01T19:00:00Z" }]).size).toBe(0);
  });
});

describe("supersedeDateRange — the scan bound, in profile-local days", () => {
  it("spans SUPERSEDE_DAY_RADIUS days either side, inclusive", () => {
    expect(SUPERSEDE_DAY_RADIUS).toBe(2);
    expect(supersedeDateRange("2026-05-01")).toEqual({
      from: "2026-04-29",
      to: "2026-05-03",
    });
  });

  it("crosses a month boundary correctly", () => {
    expect(supersedeDateRange("2026-03-01")).toEqual({
      from: "2026-02-27",
      to: "2026-03-03",
    });
  });
});

describe("compareWindowStarts", () => {
  it("orders by instant, not by spelling", () => {
    const rows = [
      "2026-05-02T00:00:00+09:00", // 2026-05-01T15:00Z
      "2026-05-01T10:00:00Z",
      "2026-05-01T23:30:00.000Z",
    ];
    expect([...rows].sort(compareWindowStarts)).toEqual([
      "2026-05-01T10:00:00Z",
      "2026-05-02T00:00:00+09:00",
      "2026-05-01T23:30:00.000Z",
    ]);
  });

  it("returns 0 for equal starts so the sort stays stable", () => {
    expect(compareWindowStarts("2026-05-01T10:00:00Z", "2026-05-01T10:00:00Z")).toBe(
      0
    );
  });
});

describe("planOverlapSupersede — the migration's replay", () => {
  // The prod shape (#3424's table): a New-York-anchored bucket and the
  // Los-Angeles-anchored one that re-cut the same day, both summing into 08-20.
  const NY = win(1, "2026-08-20", "2026-08-20T04:00:00Z", "2026-08-21T02:11:00Z");
  const LA = win(2, "2026-08-20", "2026-08-20T07:00:00Z", "2026-08-21T03:05:00Z");

  it("collapses a mixed-anchoring pileup to the current anchoring", () => {
    expect(planOverlapSupersede([NY, LA])).toEqual([1]);
  });

  it("is IDEMPOTENT — a replay over the survivors deletes nothing", () => {
    const doomed = new Set(planOverlapSupersede([NY, LA]));
    const survivors = [NY, LA].filter((r) => !doomed.has(r.id));
    expect(planOverlapSupersede(survivors)).toEqual([]);
  });

  it("is a strict NO-OP on a profile whose buckets never overlapped", () => {
    const clean = [
      win(1, "2026-08-18", "2026-08-18T04:00:00Z", "2026-08-19T04:00:00Z"),
      win(2, "2026-08-19", "2026-08-19T04:00:00Z", "2026-08-20T04:00:00Z"),
      win(3, "2026-08-20", "2026-08-20T04:00:00Z", "2026-08-21T04:00:00Z"),
    ];
    expect(planOverlapSupersede(clean)).toEqual([]);
  });

  it("is a no-op over a day of DISJOINT sub-daily buckets", () => {
    const hourly = Array.from({ length: 24 }, (_, h) =>
      win(
        h + 1,
        "2026-08-20",
        `2026-08-20T${String(h).padStart(2, "0")}:00:00Z`,
        `2026-08-20T${String(h + 1).padStart(2, "0")}:00:00Z`
      )
    );
    expect(planOverlapSupersede(hourly)).toEqual([]);
  });

  it("never deletes an edit-locked row", () => {
    // MUTATION: drop the lock branch in planSupersede and id 1 is deleted here — a
    // hand-corrected reading removed by a boot-time migration with no undo.
    const lockedOld = { ...NY, edited: 1 };
    expect(planOverlapSupersede([lockedOld, LA])).toEqual([]);
  });

  it("lets an edit-locked row supersede an earlier one — the lock is not a shield for neighbours", () => {
    const lockedLater = { ...LA, edited: 1 };
    expect(planOverlapSupersede([NY, lockedLater])).toEqual([1]);
  });

  it("follows INGEST ORDER, which is anchoring order for a stored pileup", () => {
    // The old zone's rows were inserted BEFORE the switch and the re-anchored ones
    // after, so the higher id is always the newer anchoring. Reverse the ids and the
    // replay reverses with them — stated as a test because it is the assumption the
    // whole replay rests on.
    const laFirst = { ...LA, id: 1 };
    const nyLater = { ...NY, id: 2 };
    expect(planOverlapSupersede([laFirst, nyLater])).toEqual([1]);
  });

  it("leaves POINT readings entirely alone, whatever they sit inside", () => {
    const hrv = win(2, "2026-08-20", "2026-08-20T09:00:00Z", "2026-08-20T09:00:00Z");
    const bucket = win(3, "2026-08-20", "2026-08-20T07:00:00Z", "2026-08-21T03:05:00Z");
    expect(planOverlapSupersede([NY, hrv, bucket])).toEqual([1]);
  });

  it("does not compare rows further apart than the day radius", () => {
    // A week-long window overlapping a bucket seven days away is outside the scan
    // bound, so nothing is deleted. Stated as a test because it is the rule's
    // deliberate blind spot, not an accident — it fails toward KEEPING rows.
    const long = win(1, "2026-08-13", "2026-08-13T00:00:00Z", "2026-08-21T00:00:00Z");
    const far = win(2, "2026-08-20", "2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z");
    expect(planOverlapSupersede([long, far])).toEqual([]);
  });
});

describe("overlapGroupKey", () => {
  it("separates metrics and origins, and treats a null origin as one identity", () => {
    const base = { profile_id: 1, metric: "steps", origin: null };
    expect(overlapGroupKey(base)).toBe(overlapGroupKey({ ...base, origin: null }));
    expect(overlapGroupKey(base)).not.toBe(
      overlapGroupKey({ ...base, metric: "distance_km" })
    );
    expect(overlapGroupKey(base)).not.toBe(
      overlapGroupKey({ ...base, origin: "com.fitbit.FitbitMobile" })
    );
    expect(overlapGroupKey(base)).not.toBe(
      overlapGroupKey({ ...base, profile_id: 2 })
    );
  });
});
