// DB INTEGRATION TIER (#448) — the Trends → Fitness windowed builders (#1492).
//
// Windowing is exactly where builder-INPUT bugs live: every confirmed defect in
// the #45 engines was in the gather layer, invisible to a pure tier that receives
// pre-gathered arrays. So the fixture here deliberately STRADDLES the window edge —
// rows just inside it, one exactly ON its first day, one exactly on its last day,
// and rows well outside on both sides — and every assertion is "the windowed read
// returns the inside rows and only the inside rows".
//
// It also pins the thing the whole issue turns on: the windowed reads are the SAME
// computations with a window parameter (#221), so an UNWINDOWED call must still
// return the full record. A builder that silently started windowing /training's
// full-history surfaces would pass a windows-only test and be a regression.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  getCardioIntensityMix,
  getCardioVolumeByWeek,
  getExerciseE1rmSeries,
  getSportByActivity,
  getVolumeByDate,
  getWorkoutTypeDays,
} from "@/lib/queries";
import type { ActivityComponent } from "@/lib/types";

// A fixed window with a fixed edge — no clock, no relative dates, so the
// straddling rows can't drift across the boundary between runs.
const FROM = "2026-04-27";
const TO = "2026-07-25";

// Rows placed relative to that edge.
const BEFORE_FAR = "2026-01-05"; // deep past — outside
const BEFORE_EDGE = "2026-04-26"; // the day BEFORE the window opens — outside
const ON_OPEN = FROM; // the window's first day — INSIDE
const INSIDE = "2026-06-01"; // comfortably inside
const ON_CLOSE = TO; // the window's last day — INSIDE
const AFTER_EDGE = "2026-07-26"; // the day AFTER it closes — outside

let profileId = 0;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertActivity(opts: {
  date: string;
  type: string;
  title: string;
  durationMin?: number | null;
  distanceKm?: number | null;
  intensity?: string | null;
  components?: ActivityComponent[];
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, distance_km, intensity, components)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.date,
        opts.type,
        opts.title,
        opts.durationMin ?? null,
        opts.distanceKm ?? null,
        opts.intensity ?? null,
        opts.components ? JSON.stringify(opts.components) : null
      ).lastInsertRowid
  );
}

// One strength session: a single working set at (weight × reps).
function insertLift(
  date: string,
  exercise: string,
  weightKg: number,
  reps: number
): void {
  const activityId = insertActivity({
    date,
    type: "strength",
    title: `Session ${date}`,
    durationMin: 45,
  });
  db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, ?, 1, ?, ?, 0)`
  ).run(activityId, exercise, weightKg, reps);
}

function insertRun(date: string, minutes: number, intensity: string): void {
  insertActivity({
    date,
    type: "cardio",
    title: `Run ${date}`,
    durationMin: minutes,
    distanceKm: 8,
    intensity,
    components: [
      {
        name: "Running",
        type: "cardio",
        duration_min: minutes,
        distance_km: 8,
      } as ActivityComponent,
    ],
  });
}

function insertMatch(date: string, minutes: number): void {
  insertActivity({
    date,
    type: "sport",
    title: `Match ${date}`,
    durationMin: minutes,
    components: [
      {
        name: "Tennis",
        type: "sport",
        duration_min: minutes,
      } as ActivityComponent,
    ],
  });
}

beforeAll(() => {
  profileId = newProfile("Fitness Window (#1492)");

  // Strength — one lift on every edge position. Loads differ per date so a leaked
  // row is visible in the VALUE, not just the count.
  insertLift(BEFORE_FAR, "Back Squat", 80, 5);
  insertLift(BEFORE_EDGE, "Back Squat", 90, 5);
  insertLift(ON_OPEN, "Back Squat", 100, 5);
  insertLift(INSIDE, "Back Squat", 110, 5);
  insertLift(ON_CLOSE, "Back Squat", 120, 5);
  insertLift(AFTER_EDGE, "Back Squat", 130, 5);

  // Cardio — same straddle, with distinguishable intensities/durations.
  insertRun(BEFORE_FAR, 90, "hard");
  insertRun(BEFORE_EDGE, 80, "hard");
  insertRun(ON_OPEN, 30, "easy");
  insertRun(INSIDE, 40, "easy");
  insertRun(ON_CLOSE, 50, "moderate");
  insertRun(AFTER_EDGE, 70, "hard");

  // Sport — likewise.
  insertMatch(BEFORE_EDGE, 120);
  insertMatch(ON_OPEN, 60);
  insertMatch(ON_CLOSE, 90);
  insertMatch(AFTER_EDGE, 150);
});

describe("windowed training volume (getVolumeByDate)", () => {
  it("returns the window's sessions INCLUSIVE of both edge days, and nothing outside", () => {
    const rows = getVolumeByDate(profileId, FROM, TO);
    expect(rows.map((r) => r.date)).toEqual([ON_OPEN, INSIDE, ON_CLOSE]);
    // Values prove it's the right rows, not just the right count.
    expect(rows.map((r) => r.volume)).toEqual([500, 550, 600]);
  });

  it("excludes the days one step OUTSIDE either edge", () => {
    const dates = getVolumeByDate(profileId, FROM, TO).map((r) => r.date);
    expect(dates).not.toContain(BEFORE_EDGE);
    expect(dates).not.toContain(AFTER_EDGE);
  });

  it("still returns the FULL history when called unwindowed (/training is unchanged)", () => {
    expect(getVolumeByDate(profileId).map((r) => r.date)).toEqual([
      BEFORE_FAR,
      BEFORE_EDGE,
      ON_OPEN,
      INSIDE,
      ON_CLOSE,
      AFTER_EDGE,
    ]);
  });

  it("honors a one-sided window", () => {
    expect(
      getVolumeByDate(profileId, undefined, BEFORE_EDGE).map((r) => r.date)
    ).toEqual([BEFORE_FAR, BEFORE_EDGE]);
    expect(getVolumeByDate(profileId, ON_CLOSE).map((r) => r.date)).toEqual([
      ON_CLOSE,
      AFTER_EDGE,
    ]);
  });
});

describe("windowed est-1RM series (getExerciseE1rmSeries)", () => {
  it("keeps only the window's sessions, both edges inclusive", () => {
    const series = getExerciseE1rmSeries(profileId, FROM, TO);
    expect(series).toHaveLength(1);
    expect(series[0].points.map((p) => p.date)).toEqual([
      ON_OPEN,
      INSIDE,
      ON_CLOSE,
    ]);
    // Ascending loads ⇒ ascending e1RM: the windowed series is a real trend, and
    // its first/last are the window's, not the lifetime's.
    const values = series[0].points.map((p) => p.value);
    expect(values[0]).toBeLessThan(values[2]);
    expect(values[0]).toBeGreaterThan(0);
  });

  it("still returns the lifetime series unwindowed", () => {
    const series = getExerciseE1rmSeries(profileId);
    expect(series[0].points.map((p) => p.date)).toEqual([
      BEFORE_FAR,
      BEFORE_EDGE,
      ON_OPEN,
      INSIDE,
      ON_CLOSE,
      AFTER_EDGE,
    ]);
  });
});

describe("windowed cardio (getCardioVolumeByWeek / getCardioIntensityMix)", () => {
  it("sums only the window's minutes into the weekly stack", () => {
    const weekly = getCardioVolumeByWeek(profileId, 53, FROM, TO);
    const total = weekly.data.reduce(
      (sum, row) => sum + Number(row.Running ?? 0),
      0
    );
    // 30 (on open) + 40 (inside) + 50 (on close) — the 90/80/70-minute rows on the
    // far side of each edge are out.
    expect(total).toBe(120);
  });

  it("mixes intensity over the window only", () => {
    const mix = getCardioIntensityMix(profileId, FROM, TO);
    expect(mix.map((b) => b.intensity)).toEqual(["Easy", "Moderate"]);
    expect(mix.find((b) => b.intensity === "Easy")).toMatchObject({
      minutes: 70,
      sessions: 2,
    });
    expect(mix.find((b) => b.intensity === "Moderate")).toMatchObject({
      minutes: 50,
      sessions: 1,
    });
    // The three HARD runs all sit outside the window — a leak would show up here.
    expect(mix.some((b) => b.intensity === "Hard")).toBe(false);
  });

  it("still mixes the FULL history unwindowed", () => {
    const mix = getCardioIntensityMix(profileId);
    expect(mix.find((b) => b.intensity === "Hard")).toMatchObject({
      sessions: 3,
      minutes: 240,
    });
  });
});

describe("windowed sport (getSportByActivity)", () => {
  it("summarizes only the window's matches", () => {
    const sports = getSportByActivity(profileId, undefined, 10, FROM, TO);
    expect(sports).toHaveLength(1);
    expect(sports[0]).toMatchObject({
      sport: "Tennis",
      sessions: 2,
      totalDurationMin: 150, // 60 + 90
      longestDurationMin: 90,
      longestDurationDate: ON_CLOSE,
    });
  });

  it("still summarizes the FULL history unwindowed", () => {
    const sports = getSportByActivity(profileId);
    expect(sports[0]).toMatchObject({
      sessions: 4,
      totalDurationMin: 420,
      longestDurationMin: 150, // the after-edge match
    });
  });
});

describe("windowed sessions-by-type days (getWorkoutTypeDays)", () => {
  it("returns rows inside [since, until] and only those", () => {
    const rows = getWorkoutTypeDays(profileId, FROM, TO);
    const dates = rows.map((r) => r.date);
    expect(dates).toContain(ON_OPEN);
    expect(dates).toContain(INSIDE);
    expect(dates).toContain(ON_CLOSE);
    expect(dates).not.toContain(BEFORE_FAR);
    expect(dates).not.toContain(BEFORE_EDGE);
    expect(dates).not.toContain(AFTER_EDGE);
  });

  it("a WIDER window over the same end reaches the deep-past rows", () => {
    const dates = getWorkoutTypeDays(profileId, BEFORE_FAR, TO).map(
      (r) => r.date
    );
    expect(dates).toContain(BEFORE_FAR);
    expect(dates).toContain(BEFORE_EDGE);
  });

  it("splits one day's mixed training by type", () => {
    // The fixture logs multiple disciplines across the window; every returned
    // row carries a type, and a (date, type) pair appears at most once.
    const rows = getWorkoutTypeDays(profileId, FROM, TO);
    expect(rows.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const r of rows) {
      expect(r.count).toBeGreaterThan(0);
      const key = `${r.date}|${r.type}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(new Set(rows.map((r) => r.type)).size).toBeGreaterThan(1);
  });
});

describe("profile scoping", () => {
  it("never surfaces another profile's rows in a windowed read", () => {
    const otherId = newProfile("Fitness Window Neighbor");
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'strength', 'Neighbor session', 45)`
        )
        .run(otherId, INSIDE).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
       VALUES (?, 'Neighbor Lift', 1, 999, 5, 0)`
    ).run(activityId);

    const rows = getVolumeByDate(profileId, FROM, TO);
    expect(rows.map((r) => r.volume)).toEqual([500, 550, 600]);
    expect(
      getExerciseE1rmSeries(profileId, FROM, TO).map((s) => s.exercise)
    ).toEqual(["Back Squat"]);
  });
});
