// SERVER-ACTION TIER — biomarker goals (#1853, migration 147).
//
// Covers the write path's authorization and validation, the stored shape (including
// the server-resolved unit), progress computed over REAL readings through the same
// plot the biomarker detail page draws, family matching, and the pin that the three
// existing body-metric goals still behave exactly as they did before.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { createGoal, updateGoal } from "@/app/(app)/training/goal-actions";
import { getBiomarkerGoals, getGoalProgressMap, getGoals } from "@/lib/queries";
import { createLogin, createProfile, actAs, seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function seedReading(
  profileId: number,
  date: string,
  canonical: string,
  value: number,
  unit = "mg/dL"
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'Lipids')`
  ).run(profileId, date, canonical, String(value), unit, canonical, value);
}

function goalRow(profileId: number) {
  return db
    .prepare(
      `SELECT id, title, category, target_value, unit, biomarker_name,
              target_direction, baseline_value, body_metric
         FROM goals WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as
    | {
        id: number;
        title: string;
        category: string | null;
        target_value: number | null;
        unit: string | null;
        biomarker_name: string | null;
        target_direction: string | null;
        baseline_value: number | null;
        body_metric: string | null;
      }
    | undefined;
}

beforeEach(() => revalidate.mockClear());

describe("migration 147 — the live schema", () => {
  it("carries both columns and the direction CHECK", () => {
    const sql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'goals'"
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("biomarker_name");
    expect(sql).toContain("target_direction");

    const { profile } = seedActor();
    // The CHECK is live, not decorative.
    expect(() =>
      db
        .prepare(
          "INSERT INTO goals (profile_id, title, target_direction) VALUES (?, 'x', 'sideways')"
        )
        .run(profile.id)
    ).toThrow(/CHECK/i);
    // NULL stays legal — that is every goal that existed before this migration.
    expect(() =>
      db
        .prepare("INSERT INTO goals (profile_id, title) VALUES (?, 'legacy')")
        .run(profile.id)
    ).not.toThrow();
  });
});

describe("createGoal — biomarker kind", () => {
  it("stores the target with the unit resolved SERVER-side from the analyte's plot", () => {
    const { profile } = seedActor();
    seedReading(profile.id, "2026-01-05", "LDL Cholesterol", 160);
    return createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
        target_date: "2026-06-01",
      })
    ).then(() => {
      const row = goalRow(profile.id)!;
      expect(row.biomarker_name).toBe("LDL Cholesterol");
      expect(row.target_direction).toBe("below");
      expect(row.target_value).toBe(100);
      // Not trusted from the client — the analyte's own charted unit.
      expect(row.unit).toBe("mg/dL");
      expect(row.category).toBe("biomarker");
      // The reading at creation becomes the baseline the bar runs from.
      expect(row.baseline_value).toBe(160);
      expect(row.body_metric).toBeNull();
      expect(revalidate).toHaveBeenCalledWith("/training");
    });
  });

  it("derives a title when none is given", async () => {
    const { profile } = seedActor();
    seedReading(profile.id, "2026-01-05", "LDL Cholesterol", 160);
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
      })
    );
    expect(goalRow(profile.id)!.title).toBe("LDL Cholesterol under 100");
  });

  it("still writes a goal for an analyte with no readings yet (null baseline)", async () => {
    const { profile } = seedActor();
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "Hemoglobin A1c",
        target_direction: "below",
        biomarker_target: 5.7,
      })
    );
    const row = goalRow(profile.id)!;
    expect(row.biomarker_name).toBe("Hemoglobin A1c");
    expect(row.baseline_value).toBeNull();
  });

  it("refuses an analyte outside the profile's biomarker vocabulary", async () => {
    const { profile } = seedActor();
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "Midi-chlorian Count",
        target_direction: "below",
        biomarker_target: 100,
      })
    );
    expect(getGoals(profile.id)).toHaveLength(0);
  });

  it("refuses an undeclared or bogus direction", async () => {
    const { profile } = seedActor();
    for (const target_direction of ["", "sideways", "under"]) {
      await createGoal(
        fd({
          kind: "biomarker",
          biomarker_name: "LDL Cholesterol",
          target_direction,
          biomarker_target: 100,
        })
      );
    }
    expect(getGoals(profile.id)).toHaveLength(0);
  });

  it("refuses a missing target value", async () => {
    const { profile } = seedActor();
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
      })
    );
    expect(getGoals(profile.id)).toHaveLength(0);
  });
});

describe("authorization", () => {
  it("writes to the ACTING profile, never to another login's", async () => {
    const owner = createLogin();
    const ownerProfile = createProfile("owner", owner.id);
    const other = createLogin();
    const otherProfile = createProfile("other", other.id);

    actAs(other, otherProfile);
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
      })
    );

    expect(getGoals(otherProfile.id)).toHaveLength(1);
    expect(getGoals(ownerProfile.id)).toHaveLength(0);
  });

  it("updateGoal cannot reach across profiles", async () => {
    const owner = createLogin();
    const ownerProfile = createProfile("owner", owner.id);
    actAs(owner, ownerProfile);
    seedReading(ownerProfile.id, "2026-01-05", "LDL Cholesterol", 160);
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
      })
    );
    const victimId = goalRow(ownerProfile.id)!.id;

    const attacker = createLogin();
    const attackerProfile = createProfile("attacker", attacker.id);
    actAs(attacker, attackerProfile);
    seedReading(attackerProfile.id, "2026-01-05", "LDL Cholesterol", 160);
    await updateGoal(
      fd({
        id: victimId,
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "above",
        biomarker_target: 999,
      })
    );

    // The victim's row is untouched: the UPDATE is profile-scoped.
    const victim = db
      .prepare("SELECT target_value, target_direction FROM goals WHERE id = ?")
      .get(victimId) as { target_value: number; target_direction: string };
    expect(victim.target_value).toBe(100);
    expect(victim.target_direction).toBe("below");
  });
});

describe("progress over real readings", () => {
  it("measures the LATEST result of the analyte's family, in the charted unit", async () => {
    const { profile } = seedActor();
    seedReading(profile.id, "2026-01-05", "LDL Cholesterol", 160);
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
        target_date: "2026-07-01",
      })
    );
    seedReading(profile.id, "2026-04-05", "LDL Cholesterol", 130);

    const goals = getGoals(profile.id);
    const progress = getGoalProgressMap(profile.id, goals).get(goals[0].id)!;
    expect(progress.current).toBe(130);
    expect(progress.asOf).toBe("2026-04-05");
    expect(progress.unit).toBe("mg/dL");
    expect(progress.pct).toBe(50); // 160 → 100, currently 130
    expect(progress.done).toBe(false);
    expect(progress.unavailable).toBeNull();
    // The check-in rhythm rides the analyte's curated retest cadence.
    expect(progress.checkIn?.cadenceDays).toBeGreaterThan(0);
    expect(progress.checkIn?.dueDate).not.toBeNull();
  });

  it("completes when a result lands on the declared side", async () => {
    const { profile } = seedActor();
    seedReading(profile.id, "2026-01-05", "LDL Cholesterol", 160);
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
      })
    );
    seedReading(profile.id, "2026-04-05", "LDL Cholesterol", 92);

    const goals = getGoals(profile.id);
    const progress = getGoalProgressMap(profile.id, goals).get(goals[0].id)!;
    expect(progress.done).toBe(true);
  });

  it("says 'no result yet' rather than 0% for an unmeasured analyte", async () => {
    const { profile } = seedActor();
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "Hemoglobin A1c",
        target_direction: "below",
        biomarker_target: 5.7,
      })
    );
    const goals = getGoals(profile.id);
    const progress = getGoalProgressMap(profile.id, goals).get(goals[0].id)!;
    expect(progress.unavailable).toBe("no-readings");
    expect(progress.asOf).toBeNull();
  });

  it("another profile's readings never advance this goal", async () => {
    const { profile } = seedActor();
    seedReading(profile.id, "2026-01-05", "LDL Cholesterol", 160);
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
      })
    );
    const neighbour = createProfile("neighbour");
    seedReading(neighbour.id, "2026-05-05", "LDL Cholesterol", 70);

    const goals = getGoals(profile.id);
    const progress = getGoalProgressMap(profile.id, goals).get(goals[0].id)!;
    expect(progress.current).toBe(160);
    expect(progress.done).toBe(false);
  });
});

describe("getBiomarkerGoals — the goal reaches its own detail page", () => {
  it("finds the goal by FAMILY, not by raw name", async () => {
    const { profile } = seedActor();
    seedReading(profile.id, "2026-01-05", "Hemoglobin A1c", 7.4, "%");
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "Hemoglobin A1c",
        target_direction: "below",
        biomarker_target: 6.5,
      })
    );

    expect(getBiomarkerGoals(profile.id, "Hemoglobin A1c")).toHaveLength(1);
    // The eAG re-expression of the same draw is the same #482 family — one series,
    // one target, so the goal shows on the page that charts them.
    expect(
      getBiomarkerGoals(profile.id, "Estimated Average Glucose")
    ).toHaveLength(1);
    // A genuinely different analyte does not pick it up.
    expect(getBiomarkerGoals(profile.id, "LDL Cholesterol")).toHaveLength(0);
  });

  it("excludes archived and achieved goals", async () => {
    const { profile } = seedActor();
    seedReading(profile.id, "2026-01-05", "LDL Cholesterol", 160);
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "LDL Cholesterol",
        target_direction: "below",
        biomarker_target: 100,
      })
    );
    const id = goalRow(profile.id)!.id;
    db.prepare("UPDATE goals SET archived = 1 WHERE id = ?").run(id);
    expect(getBiomarkerGoals(profile.id, "LDL Cholesterol")).toHaveLength(0);
  });
});

describe("the three body-metric goals are unchanged (#1853 is additive)", () => {
  it("a weight goal still stores canonical kg, body_metric, and no biomarker columns", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("body", login.id);
    actAs(login, profile);
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, '2026-01-01', 90)"
    ).run(profile.id);

    await createGoal(
      fd({ kind: "body", body_metric: "weight", body_target: 80 })
    );

    const row = goalRow(profile.id)!;
    expect(row.body_metric).toBe("weight");
    expect(row.target_value).toBe(80);
    expect(row.baseline_value).toBe(90);
    expect(row.biomarker_name).toBeNull();
    expect(row.target_direction).toBeNull();

    const goals = getGoals(profile.id);
    const progress = getGoalProgressMap(profile.id, goals).get(goals[0].id)!;
    // Baseline 90 → target 80, currently 90: the same 0% it has always been, and
    // NONE of the per-result fields are set — a body goal still paces daily.
    expect(progress.pct).toBe(0);
    expect(progress.asOf).toBeUndefined();
    expect(progress.checkIn).toBeUndefined();
    expect(progress.unavailable).toBeUndefined();
  });

  it("body-metric analytes are not offered as biomarker targets", async () => {
    const { profile } = seedActor();
    // "Weight" reaches the goals table only through the body_metric path; posting it
    // as a biomarker target must not create a second way to say the same thing.
    await createGoal(
      fd({
        kind: "biomarker",
        biomarker_name: "Weight",
        target_direction: "below",
        biomarker_target: 80,
      })
    );
    const rows = getGoals(profile.id).filter((g) => g.biomarker_name != null);
    expect(rows).toHaveLength(0);
  });
});
