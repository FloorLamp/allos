// DB INTEGRATION TIER (issue #840): the mobility_region weekly-habit loop. A recovery
// session whose tapped moves mobilize a region advances a `mobility_region` frequency
// target for that region — deduped once per day (#223) — through the SAME
// getFrequencyTargetProgress read the strength/food targets use, kept a SEPARATE view
// from the `region` scope (#482: trained ≠ mobilized). Proves the pieces compose against
// the real schema (mobility activity + components → move → MuscleId → MuscleRegion).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getFrequencyTargetProgress, getMobilityCoverage } from "@/lib/queries";
import { getCadenceLedger } from "@/lib/queries/cadence-ledger";
import { setWeekMode, setWeekStart } from "@/lib/settings";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Rolling window so the anchor and recent days are always in-week regardless of
  // when the suite runs.
  setWeekMode(profileId, "rolling");
  return { profileId, anchor: today(profileId) };
}

// A mobility session on `date` with the given move slugs (the mobility log's storage
// shape: one activities row, components typed `recovery`).
function logMobility(profileId: number, date: string, moves: string[]) {
  const components = JSON.stringify(
    moves.map((name) => ({
      name,
      type: "mobility",
      distance_km: null,
      duration_min: null,
    }))
  );
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, components)
     VALUES (?, ?, 'mobility', 'Mobility', ?)`
  ).run(profileId, date, components);
}

describe("mobility_region frequency target (#840)", () => {
  it("uses the profile's calendar week for both the strip and ledger (#4536)", () => {
    const { profileId, anchor: currentDay } = makeProfile(
      "mobility-week-window"
    );
    const anchor = shiftDateStr(currentDay, 2);
    const anchorWeekday = new Date(`${anchor}T00:00:00Z`).getUTCDay();
    setWeekMode(profileId, "calendar");
    setWeekStart(
      profileId,
      ((anchorWeekday + 5) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6
    );
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'mobility_region', 'Shoulders', 3)`
    ).run(profileId);

    logMobility(profileId, shiftDateStr(anchor, -5), ["shoulder_cars"]);
    logMobility(profileId, shiftDateStr(anchor, -1), ["shoulder_cars"]);
    logMobility(profileId, anchor, ["shoulder_cars"]);

    const ledger = getCadenceLedger(profileId, {
      weeks: 1,
      includeCurrent: true,
      direction: "floor",
      asOf: anchor,
    })[0].weeks[0];
    const shoulders = getMobilityCoverage(profileId, anchor).find(
      (row) => row.region === "Shoulders"
    );
    expect({ strip: shoulders?.days, ledger: ledger.count }).toEqual({
      strip: 2,
      ledger: 2,
    });

    setWeekMode(profileId, "rolling");
    expect(
      getMobilityCoverage(profileId, anchor).find(
        (row) => row.region === "Shoulders"
      )?.days
    ).toBe(3);
  });

  it("counts distinct days a mobility session mobilized the region, once per day", () => {
    const { profileId, anchor } = makeProfile("mobility-hips");

    // Target: mobilize the Glutes region (hips) 3×/week.
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'mobility_region', 'Glutes', 3)`
        )
        .run(profileId).lastInsertRowid
    );

    // pigeon_pose → glutes/hip-abductors → Glutes. Two sessions on two distinct days,
    // plus a SECOND session same day as the first (must NOT double-count — once/day).
    logMobility(profileId, anchor, ["pigeon_pose", "hamstring_stretch"]);
    logMobility(profileId, anchor, ["figure_four_stretch"]); // same day → still 1
    logMobility(profileId, shiftDateStr(anchor, -1), ["pigeon_pose"]);
    // A session that mobilizes only Legs (hamstrings), not Glutes — must not count.
    logMobility(profileId, shiftDateStr(anchor, -2), ["hamstring_stretch"]);

    const progress = getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === targetId
    );
    expect(progress).toBeTruthy();
    // Distinct Glutes-mobilized days: anchor and anchor-1 → 2 (not 3: the same-day second
    // session is deduped, and the hamstring-only day is a different region).
    expect(progress!.count).toBe(2);
    expect(progress!.met).toBe(false);

    // A third distinct Glutes day meets it.
    logMobility(profileId, shiftDateStr(anchor, -3), [
      "ninety_ninety_hip_switch",
    ]);
    const met = getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === targetId
    );
    expect(met!.count).toBe(3);
    expect(met!.met).toBe(true);
  });

  it("stays SEPARATE from the strength `region` scope (trained ≠ mobilized, #482)", () => {
    const { profileId, anchor } = makeProfile("mobility-apart");

    // A `region` (strength) target and a `mobility_region` target for the SAME region.
    const strengthId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'region', 'Legs', 2)`
        )
        .run(profileId).lastInsertRowid
    );
    const mobilityId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'mobility_region', 'Legs', 2)`
        )
        .run(profileId).lastInsertRowid
    );

    // Only a mobility session (hamstring_stretch → Legs), NO strength sets.
    logMobility(profileId, anchor, ["hamstring_stretch"]);

    const all = getFrequencyTargetProgress(profileId);
    const strength = all.find((p) => p.target.id === strengthId);
    const mobility = all.find((p) => p.target.id === mobilityId);
    // The strength `region` target is UNMOVED by a mobility session; only the
    // mobility_region target advances.
    expect(strength!.count).toBe(0);
    expect(mobility!.count).toBe(1);
  });
});
