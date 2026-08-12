// DB INTEGRATION TIER — #2393: a cardio record is a claim about ALL of an activity's
// history, and the app may only make it when the data supports it.
//
// The reported case: a short evening stroll was announced as a personal record beside
// a barbell deadlift PR. It was a DISTANCE record over four measured walks out of
// fourteen — ten sessions, including the longest one by time, carried no distance at
// all and were invisible to the comparison. Two of the measured walks sat three
// metres apart, and both "set a record" at the time.
//
// This proves the end-to-end path — getCardioByActivity's evidence → the verdicts →
// recentCardioPRs — over real rows, not hand-built summaries.

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { cardioRecordVerdicts, recentCardioPRs } from "@/lib/coaching";
import { getCardioByActivity } from "@/lib/queries";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addCardio(
  profile: number,
  date: string,
  activity: string,
  distanceKm: number | null,
  durationMin: number
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, distance_km, duration_min)
     VALUES (?, ?, 'cardio', ?, ?, ?)`
  ).run(profile, date, activity, distanceKm, durationMin);
}

describe("cardio records are judged against their own measurement (#2393)", () => {
  let sparse: number;
  let tracked: number;
  let t: string;

  beforeAll(() => {
    sparse = newProfile("Sparse Stroller");
    t = today(sparse);
    // Fourteen walks. Ten carry no distance — including the LONGEST by time, which may
    // well have covered further than any of the measured four.
    for (let i = 0; i < 10; i++) {
      addCardio(sparse, shiftDateStr(t, -60 + i * 3), "Evening Walk", null, 55);
    }
    addCardio(sparse, shiftDateStr(t, -25), "Evening Walk", 4.2, 40);
    addCardio(sparse, shiftDateStr(t, -20), "Evening Walk", 4.6, 44);
    // The two walks three metres apart, the later one "setting" the record.
    addCardio(sparse, shiftDateStr(t, -10), "Evening Walk", 4.997, 47);
    addCardio(sparse, shiftDateStr(t, -2), "Evening Walk", 5.0, 48);

    tracked = newProfile("Complete Rower");
    // A short history, but measured from the very first session: coverage is complete.
    addCardio(tracked, shiftDateStr(t, -9), "Rowing", 4, 25);
    addCardio(tracked, shiftDateStr(t, -1), "Rowing", 7, 40);
  });

  it("counts the sessions carrying the measurement, not the activity's sessions", () => {
    const walk = getCardioByActivity(sparse, "km").find(
      (c) => c.activity === "Evening Walk"
    )!;
    expect(walk.sessions).toBe(14);
    expect(walk.evidence.distance.measured).toBe(4);
    expect(walk.evidence.duration.measured).toBe(14);
    // The number the record has to beat — the best of the OTHER measured walks.
    expect(walk.evidence.distance.priorBest).toBeCloseTo(4.997, 6);
  });

  it("claims no distance record when most of the history never measured one", () => {
    const stats = getCardioByActivity(sparse, "km");
    expect(recentCardioPRs(stats, t, 30).map((p) => p.kind)).not.toContain(
      "distance"
    );
    const distance = cardioRecordVerdicts(stats, t, 30).find(
      (v) => v.kind === "distance"
    );
    // Withheld with a stated reason, not silently absent.
    expect(distance).toMatchObject({
      state: "withheld",
      reason: "sparse-measurement",
    });
  });

  it("would still withhold it on the noise floor alone, once coverage is complete", () => {
    const p = newProfile("Three Metre Stroller");
    addCardio(p, shiftDateStr(t, -20), "Evening Walk", 4.6, 44);
    addCardio(p, shiftDateStr(t, -10), "Evening Walk", 4.997, 47);
    addCardio(p, shiftDateStr(t, -2), "Evening Walk", 5.0, 48);
    const stats = getCardioByActivity(p, "km");
    expect(
      cardioRecordVerdicts(stats, t, 30).find((v) => v.kind === "distance")
    ).toMatchObject({ state: "withheld", reason: "within-noise" });
  });

  it("still awards a record on a short, completely measured history", () => {
    const kinds = recentCardioPRs(
      getCardioByActivity(tracked, "km"),
      t,
      30
    ).map((p) => p.kind);
    expect(kinds).toContain("distance");
    expect(kinds).toContain("duration");
  });
});
