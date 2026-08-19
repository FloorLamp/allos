// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #3211 part 3 — the live-niggle coaching tier END TO END: a real `niggles` row
// written by `reportNiggle` reaches `gatherCoachingInput` → `recommendCoaching` and
// tempers its region's target with a line naming it. The tier's ordering and its three
// invariants are pinned pure in lib/__tests__/workout-recommendation-niggles.test.ts;
// what is pinned HERE is the wiring the pure tier cannot see:
//
//   • the gather reads the LIVE set, so a niggle gone quiet for the whole spell stops
//     tempering with nothing having to run to expire it;
//   • profile scoping — one profile's niggle never tempers another's recommendation;
//   • the illness HOLD outranks it through the REAL gather, not just a hand-built input.
//
// Runs via `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { createEpisodeRow } from "@/lib/illness-episode-store";
import { setTimezone } from "@/lib/settings";
import { gatherCoachingInput } from "@/lib/queries";
import { recommendCoaching } from "@/lib/coaching";
import { recommendNextWorkout } from "@/lib/workout-recommendation";
import { reportNiggle } from "@/lib/niggle-store";
import { NIGGLE_QUIET_DAYS } from "@/lib/niggle-model";

const DAY_MS = 86_400_000;

let seq = 0;
// A profile with squat history but nothing logged today → a go-train rec with a target.
function squatProfile(): number {
  const p = newProfile();
  const td = today(p);
  seedSquatDay(p, shiftDateStr(td, -3));
  seedSquatDay(p, shiftDateStr(td, -5));
  return p;
}

function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`niggle-coach-${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A squat session so the recommendation has a Legs lift to lead with — the #2948
// scenario's own shape (squat day → "right knee weird"). Seeded in the PAST, because a
// session logged today makes the card an on-track note with no target to temper.
function seedSquatDay(profileId: number, date: string): void {
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

// Report a right-knee niggle `daysAgo` days before now.
function reportKnee(profileId: number, daysAgo: number): void {
  const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 19);
  const out = reportNiggle(
    profileId,
    { region: "Legs", laterality: "right", bodyTerm: "knee" },
    `${at}Z`
  );
  expect(out.ok).toBe(true);
}

const targetKg = (s: string | undefined) =>
  Number((s ?? "").match(/[\d.]+/)?.[0] ?? "0");

describe("a live niggle tempers the real coaching recommendation (#3211)", () => {
  it("eases the region's target off and NAMES the niggle", () => {
    const p = squatProfile();
    const plain = recommendCoaching(gatherCoachingInput(p, "kg", "km"))[0];

    reportKnee(p, 1);
    const [tempered] = recommendCoaching(gatherCoachingInput(p, "kg", "km"));

    expect(targetKg(tempered.target)).toBeLessThan(targetKg(plain.target));
    expect((tempered.notes ?? []).join(" ")).toContain(
      "Easing off Legs — right knee niggle from yesterday"
    );
    // Tempered, NOT excluded: the lift is still what the app suggests.
    expect(tempered.exercises ?? []).toContain("Back Squat");
  });

  it("a niggle gone quiet for the whole spell stops tempering", () => {
    const p = squatProfile();
    const plain = recommendCoaching(gatherCoachingInput(p, "kg", "km"))[0];

    reportKnee(p, NIGGLE_QUIET_DAYS + 1);
    const [after] = recommendCoaching(gatherCoachingInput(p, "kg", "km"));

    expect(targetKg(after.target)).toBe(targetKg(plain.target));
    expect((after.notes ?? []).join(" ")).not.toContain("niggle");
    expect(
      recommendNextWorkout(gatherCoachingInput(p, "kg", "km")).niggleTempers
    ).toEqual([]);
  });

  it("one profile's niggle never tempers another's recommendation", () => {
    const mine = squatProfile();
    const theirs = squatProfile();
    reportKnee(mine, 1);

    expect(
      recommendNextWorkout(gatherCoachingInput(theirs, "kg", "km"))
        .niggleTempers
    ).toEqual([]);
    expect(
      recommendNextWorkout(gatherCoachingInput(mine, "kg", "km")).niggleTempers
    ).toHaveLength(1);
  });

  it("an open illness episode HOLDS the whole recommendation, niggle included", () => {
    const p = squatProfile();
    reportKnee(p, 1);
    createEpisodeRow(p, "Illness", shiftDateStr(today(p), -2), null);

    const recs = recommendCoaching(gatherCoachingInput(p, "kg", "km"));
    expect(recs.some((r) => r.kind === "illness")).toBe(true);
    expect(recs.some((r) => r.kind === "strength")).toBe(false);
    expect(JSON.stringify(recs)).not.toContain("niggle");
  });
});
