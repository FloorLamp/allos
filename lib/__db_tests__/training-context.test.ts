// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issues #666 (condition-aware training considerations) + #838 (injury layer). The
// #448-rule fixture test for the training-context gather: the exclusion / tempering /
// consideration-note all ride the ONE shared recommendation model, gathered from real
// profile-scoped DB reads (gatherCoachingInput → recommendNextWorkout / recommendCoaching,
// and buildMuscleVolumeFindings). The pure tier can't see the gather; this seeds a
// realistic fixture and asserts the end-to-end output.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed at a
// throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { gatherCoachingInput } from "@/lib/queries/coaching";
import { recommendNextWorkout } from "@/lib/workout-recommendation";
import { recommendCoaching } from "@/lib/coaching";
import { buildMuscleVolumeFindings } from "@/lib/rule-findings";
import { muscleVolumeSignalKey } from "@/lib/muscle-volume-bands";
import { logInjuryCore, setInjuryStatusCore } from "@/lib/injuries";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

function logStrengthSets(
  profileId: number,
  anchorDay: string,
  day: number,
  exercise: string,
  n: number
): void {
  const actId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Session', 30)`
      )
      .run(profileId, shiftDateStr(anchorDay, day)).lastInsertRowid
  );
  const insSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, ?, 60, 5)`
  );
  for (let s = 1; s <= n; s++) insSet.run(actId, exercise, s);
}

describe("#838 active injury — recommendation + volume-band exclusion via the real gather", () => {
  it("excludes the injured region from the recommendation and NAMES it; legs unchanged", () => {
    const { profileId, anchor } = makeProfile("injury-active");
    // Chest (Bench Press) + Legs (Leg Extension) history, both within the recent window.
    logStrengthSets(profileId, anchor, -2, "Bench Press", 2);
    logStrengthSets(profileId, anchor, -3, "Leg Extension", 2);

    // Baseline: chest is in the recommendation.
    const before = recommendNextWorkout(
      gatherCoachingInput(profileId, "kg", "km")
    );
    expect(before.focus).toContain("Chest");
    expect(before.exercises).toContain("Bench Press");

    // Log an ACTIVE right-shoulder injury covering Chest + Shoulders.
    logInjuryCore(profileId, {
      label: "right shoulder",
      regions: ["Chest", "Shoulders"],
      status: "active",
      since: anchor,
    });

    const after = recommendNextWorkout(
      gatherCoachingInput(profileId, "kg", "km")
    );
    // No chest recommendation; the leg work is untouched.
    expect(after.focus).not.toContain("Chest");
    expect(after.exercises).not.toContain("Bench Press");
    expect(after.exercises).toContain("Leg Extension");
    // The exclusion is DISCLOSED, never silent.
    expect(after.excludedRegions.map((d) => d.region)).toContain("Chest");
    expect(after.excludedRegions[0].injuryLabels).toContain("right shoulder");
  });

  it("holds the volume-band shortfall nag for the injured region, keeps legs", () => {
    const { profileId, anchor } = makeProfile("injury-volume");
    const month = anchor.slice(0, 7);
    // Under-floor chest (Bench Press) + quads (Leg Extension), two distinct weeks so the
    // cold-start gate is cleared. This week's low volume drives the shortfall findings.
    logStrengthSets(profileId, anchor, 0, "Bench Press", 2);
    logStrengthSets(profileId, anchor, -14, "Bench Press", 2);
    logStrengthSets(profileId, anchor, 0, "Leg Extension", 2);
    logStrengthSets(profileId, anchor, -14, "Leg Extension", 2);

    const beforeKeys = buildMuscleVolumeFindings(profileId, anchor).map(
      (f) => f.dedupeKey
    );
    expect(beforeKeys).toContain(muscleVolumeSignalKey("chest", month));
    expect(beforeKeys).toContain(muscleVolumeSignalKey("quads", month));

    logInjuryCore(profileId, {
      label: "pec strain",
      regions: ["Chest"],
      status: "active",
      since: anchor,
    });

    const afterKeys = buildMuscleVolumeFindings(profileId, anchor).map(
      (f) => f.dedupeKey
    );
    // The chest shortfall is silenced (region out); the quads shortfall stays.
    expect(afterKeys).not.toContain(muscleVolumeSignalKey("chest", month));
    expect(afterKeys).toContain(muscleVolumeSignalKey("quads", month));
  });
});

describe("#838 recovering injury — tempered suggest-next-set via the real gather", () => {
  it("returns the region at a lighter target than an uninjured baseline", () => {
    const { profileId, anchor } = makeProfile("injury-recovering");
    // Bench Press only, with a target-rep session so suggestNextSet produces a load.
    logStrengthSets(profileId, anchor, -2, "Bench Press", 3);

    const plain = recommendCoaching(gatherCoachingInput(profileId, "kg", "km"));
    const plainBench = plain.find((r) => r.title.includes("Bench Press"));

    const injId = logInjuryCore(profileId, {
      label: "chest strain",
      regions: ["Chest"],
      status: "recovering",
      since: anchor,
    });
    expect(injId.kind).toBe("ok");

    const input = gatherCoachingInput(profileId, "kg", "km");
    expect(input.injuries?.some((i) => i.status === "recovering")).toBe(true);

    const tempered = recommendCoaching(input);
    const temperedBench = tempered.find((r) => r.title.includes("Bench Press"));
    // The region still returns (recovering ≠ excluded) but the load is tempered.
    const num = (s: string | undefined) =>
      Number((s ?? "").match(/[\d.]+/)?.[0] ?? "0");
    expect(plainBench?.target).toBeTruthy();
    expect(temperedBench?.target).toBeTruthy();
    expect(num(temperedBench?.target)).toBeLessThan(num(plainBench?.target));
  });

  it("a RESOLVED injury exerts no effect (record kept, normal coaching)", () => {
    const { profileId, anchor } = makeProfile("injury-resolved");
    logStrengthSets(profileId, anchor, -2, "Bench Press", 2);
    const res = logInjuryCore(profileId, {
      label: "old strain",
      regions: ["Chest"],
      status: "active",
      since: anchor,
    });
    const id = res.kind === "ok" ? res.id : 0;
    setInjuryStatusCore(profileId, id, "resolved", anchor);

    const nw = recommendNextWorkout(gatherCoachingInput(profileId, "kg", "km"));
    expect(nw.excludedRegions).toEqual([]);
    expect(nw.focus).toContain("Chest");
  });
});

describe("#666 condition consideration — note present via the real gather", () => {
  it("surfaces the mapped condition's note; the recommendation is unchanged", () => {
    const { profileId, anchor } = makeProfile("condition-note");
    logStrengthSets(profileId, anchor, -2, "Bench Press", 2);

    const before = recommendNextWorkout(
      gatherCoachingInput(profileId, "kg", "km")
    );
    expect(before.considerations).toEqual([]);

    // An ACTIVE osteoporosis condition on the problem list.
    db.prepare(
      `INSERT INTO conditions (profile_id, name, code, code_system, status, onset_date)
       VALUES (?, 'Osteoporosis', 'M81.0', 'ICD-10', 'active', ?)`
    ).run(profileId, anchor);

    const input = gatherCoachingInput(profileId, "kg", "km");
    expect(input.considerations?.map((c) => c.key)).toContain("osteoporosis");

    const after = recommendNextWorkout(input);
    expect(after.considerations.map((c) => c.key)).toContain("osteoporosis");
    // Note-only: the recommendation itself is untouched (never gated / re-ranked).
    expect(after.focus).toEqual(before.focus);
    expect(after.exercises).toEqual(before.exercises);
    expect(after.excludedRegions).toEqual([]);
  });

  it("an UNMAPPED condition carries no note", () => {
    const { profileId, anchor } = makeProfile("condition-unmapped");
    logStrengthSets(profileId, anchor, -2, "Bench Press", 2);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status, onset_date)
       VALUES (?, 'Seasonal allergies', 'active', ?)`
    ).run(profileId, anchor);
    const input = gatherCoachingInput(profileId, "kg", "km");
    expect(input.considerations).toEqual([]);
  });
});
