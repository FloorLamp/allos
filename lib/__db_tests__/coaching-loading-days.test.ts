// DB INTEGRATION TIER — issue #754: the overtraining/load rest triggers key on
// LOADING days (hard sessions), not every logged activity. Per the findings-builder
// discipline (#448), the gather that assembles loadingDates from HR-zone intensity
// gets an end-to-end fixture test: the pure classifier is boundary-pinned in
// lib/__tests__/coaching-intensity.test.ts, but only a real seed proves the DB gather
// (getDayLoadInputs → loadingDates) drops an easy-cardio day while keeping the hard
// lifting days — and that trainingDates still counts the easy day as movement.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { gatherCoachingInput } from "@/lib/queries";
import { setMaxHrOverride } from "@/lib/settings";
import { recommendCoaching } from "@/lib/coaching";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A windowed session on `date` (08:00–09:00) with ~30 min of HR at a constant bpm,
// so the day's easy/hard split is unambiguous. With a max-HR override of 180 the
// percent-max zones put bpm 150 in Zone 4 (hard) and bpm 110 in Zone 2 (easy).
function seedSession(
  profileId: number,
  date: string,
  type: "strength" | "cardio",
  bpm: number
): void {
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, start_time, end_time)
     VALUES (?, ?, ?, ?, 60, '08:00', '09:00')`
  ).run(profileId, date, type, `${type} session`);
  const ins = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (let m = 0; m < 30; m++) {
    const mm = String(m).padStart(2, "0");
    ins.run(profileId, `${date}T08:${mm}`, bpm, bpm - 3, bpm + 3, 10, "oura");
  }
}

// A session with NO HR data but a subjective intensity rating (#1115 Fix A′). `dur`
// lets a caller make it long (would clear the duration floor) or short (would miss it),
// so the rating — not duration — decides.
function seedRated(
  profileId: number,
  date: string,
  type: "strength" | "cardio",
  intensity: "easy" | "moderate" | "hard",
  dur: number
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(profileId, date, type, `${type} session`, dur, intensity);
}

const HARD_BPM = 150; // Zone 4 at maxHr 180 → a loading day
const EASY_BPM = 110; // Zone 2 at maxHr 180 → a recovery day

describe("loading-days gather (#754)", () => {
  it("drops an easy-cardio day from loadingDates but keeps it as movement", () => {
    const p = newProfile("Loading Test A");
    setMaxHrOverride(p, 180); // percent-max zone model, no resting HR needed
    const td = today(p);
    // 3 hard lifting days (older) + an easy Zone 2 cardio day TODAY.
    seedSession(p, shiftDateStr(td, -3), "strength", HARD_BPM);
    seedSession(p, shiftDateStr(td, -2), "strength", HARD_BPM);
    seedSession(p, shiftDateStr(td, -1), "strength", HARD_BPM);
    seedSession(p, td, "cardio", EASY_BPM);

    const input = gatherCoachingInput(p, "kg", "km");
    // Every day is movement…
    expect(new Set(input.trainingDates).size).toBe(4);
    // …but only the 3 hard days are loading (today's easy spin is excluded).
    expect(input.loadingDates).toBeDefined();
    expect(new Set(input.loadingDates)).toEqual(
      new Set([
        shiftDateStr(td, -3),
        shiftDateStr(td, -2),
        shiftDateStr(td, -1),
      ])
    );
    // The 3-day loading streak is below the 4-day overtraining threshold, so the
    // easy day breaks the fatigue nudge — no rest recommendation fires.
    const recs = recommendCoaching(input);
    expect(recs.some((r) => r.kind === "rest")).toBe(false);
  });

  it("still fires overtraining on four consecutive hard days", () => {
    const p = newProfile("Loading Test B");
    setMaxHrOverride(p, 180);
    const td = today(p);
    for (let i = 0; i < 4; i++) {
      seedSession(p, shiftDateStr(td, -i), "strength", HARD_BPM);
    }

    const input = gatherCoachingInput(p, "kg", "km");
    expect(new Set(input.loadingDates).size).toBe(4);
    const recs = recommendCoaching(input);
    expect(recs[0].id).toBe("rest-overtraining");
    expect(recs[0].detail).toContain("4 days in a row");
  });

  // #1115 Fix A′: the subjective session rating populates the plannedIntent seam, so a
  // self-rated easy day drops from loadingDates even when it's long and un-zoned (no HR),
  // and a self-rated hard day counts even under the duration floor.
  it("drops a long un-zoned self-rated EASY day, keeps hard lifting days", () => {
    const p = newProfile("Rated Easy");
    const td = today(p);
    // 3 hard lifting days (HR) + a LONG easy-rated ride TODAY with no HR.
    seedSession(p, shiftDateStr(td, -3), "strength", HARD_BPM);
    seedSession(p, shiftDateStr(td, -2), "strength", HARD_BPM);
    seedSession(p, shiftDateStr(td, -1), "strength", HARD_BPM);
    seedRated(p, td, "cardio", "easy", 120); // long, would clear the duration floor

    const input = gatherCoachingInput(p, "kg", "km");
    expect(new Set(input.trainingDates).size).toBe(4); // all movement
    expect(new Set(input.loadingDates)).toEqual(
      new Set([
        shiftDateStr(td, -3),
        shiftDateStr(td, -2),
        shiftDateStr(td, -1),
      ])
    );
    // 3-day loading streak < 4 → the easy day breaks the fatigue nudge.
    expect(recommendCoaching(input).some((r) => r.kind === "rest")).toBe(false);
  });

  it("counts a SHORT un-zoned self-rated HARD day as loading (below the duration floor)", () => {
    const p = newProfile("Rated Hard");
    const td = today(p);
    // 3 hard lifting days + a SHORT hard-rated session today (12 min < 30-min floor).
    seedSession(p, shiftDateStr(td, -3), "strength", HARD_BPM);
    seedSession(p, shiftDateStr(td, -2), "strength", HARD_BPM);
    seedSession(p, shiftDateStr(td, -1), "strength", HARD_BPM);
    seedRated(p, td, "strength", "hard", 12);

    const input = gatherCoachingInput(p, "kg", "km");
    // Today's short hard session still loads → 4 consecutive loading days → overtraining.
    expect(new Set(input.loadingDates).size).toBe(4);
    expect(recommendCoaching(input)[0].id).toBe("rest-overtraining");
  });
});
