// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1300 — today's reported-burden gather + the coaching rest tilt end-to-end (#448).
// The threshold + copy are pinned pure in lib/__tests__/reported-burden.test.ts; this seeds
// real symptom_logs + a mood row + a training activity and asserts the gather's verdict AND
// that the real coaching builder (gatherCoachingInput → recommendCoaching) leads with the
// tilt naming the symptom — a severe day tilts, a mild single symptom does not. Runs via
// `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { upsertMoodLog } from "@/lib/offline/writes";
import { getReportedBurden, gatherCoachingInput } from "@/lib/queries";
import { recommendCoaching } from "@/lib/coaching";

let seq = 0;
function newProfile(): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`burden-${seq++}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function logSymptomRow(
  profileId: number,
  date: string,
  symptom: string,
  severity: number
): void {
  db.prepare(
    "INSERT INTO symptom_logs (profile_id, date, symptom, severity) VALUES (?,?,?,?)"
  ).run(profileId, date, symptom, severity);
}

// A little training context so recommendCoaching isn't the empty state.
function seedTraining(profileId: number, date: string): void {
  const id = Number(
    db
      .prepare(
        "INSERT INTO activities (profile_id, date, type, title, duration_min) VALUES (?,?,'strength','Squat Day',45)"
      )
      .run(profileId, date).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps) VALUES (?, 'Back Squat', 1, 100, 5)"
  ).run(id);
}

describe("getReportedBurden (#1300) — the gather over real self-reports", () => {
  it("a severe symptom today yields a tilt naming the symptom", () => {
    const p = newProfile();
    const on = today(p);
    logSymptomRow(p, on, "cramps", 3);
    const b = getReportedBurden(p, on);
    expect(b.tilts).toBe(true);
    expect(b.basis).toBe("symptom");
    expect(b.leadSymptom).toEqual({ symptom: "cramps", severity: 3 });
  });

  it("a mild single symptom does not tilt", () => {
    const p = newProfile();
    const on = today(p);
    logSymptomRow(p, on, "headache", 1);
    expect(getReportedBurden(p, on).tilts).toBe(false);
  });

  it("low energy alone tilts on the energy basis", () => {
    const p = newProfile();
    const on = today(p);
    upsertMoodLog(p, on, { valence: 2, energy: 1 });
    const b = getReportedBurden(p, on);
    expect(b.tilts).toBe(true);
    expect(b.basis).toBe("energy");
  });
});

describe("coaching engine consumes the burden (#1300)", () => {
  it("a severe-symptom day makes the coaching card lead with the rest tilt", () => {
    const p = newProfile();
    const on = today(p);
    seedTraining(p, on);
    logSymptomRow(p, on, "cramps", 3);
    const recs = recommendCoaching(gatherCoachingInput(p, "kg", "km"));
    expect(recs[0].kind).toBe("rest");
    expect(recs[0].detail).toContain("severe cramps");
  });

  it("a mild-symptom day does NOT tilt (no rest card from the burden)", () => {
    const p = newProfile();
    const on = today(p);
    seedTraining(p, on);
    logSymptomRow(p, on, "headache", 1);
    const recs = recommendCoaching(gatherCoachingInput(p, "kg", "km"));
    expect(recs.find((r) => r.id === "rest-symptom")).toBeUndefined();
  });
});
