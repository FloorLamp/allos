// DB INTEGRATION TIER — the profile-delete sweep is structurally complete (#2126).
//
// The delete-side sibling of the import-footprint FK scan (#1808): deleteProfile
// runs with `foreign_keys = OFF` (#729), so ON DELETE CASCADE never fires and
// every child table must be deleted explicitly. The sweep's child set is DERIVED
// from PRAGMA foreign_key_list (lib/profile-delete.ts); this scan re-walks the
// same pragma INDEPENDENTLY and fails the build if:
//
//  1. any table reachable from an OWNED_TABLES parent via FK is missing from the
//     generated delete plan (a generator bug — the exact orphaned-PHI drift that
//     left allergy_reactions / medication_courses / intake_item_side_effects
//     behind when the list was hand-maintained), or
//  2. a table OUTSIDE the profile subtree references an owned table — such a row
//     would hold a dangling FK after the sweep, and the day one appears the
//     decision (delete it? null it?) must be made here, not found by a user.
//
// The behavioral proof (seed → delete → zero surviving child rows) lives in
// lib/__action_tests__/delete-profile-children.actions.test.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { ownedChildTables, profileChildDeletePlan } from "@/lib/profile-delete";

interface FkRow {
  table: string;
  from: string;
}

function allTables(): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function fksOf(table: string): FkRow[] {
  return db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as FkRow[];
}

// Independent re-derivation of the profile subtree (owned tables plus everything
// referencing them, to fixpoint) — deliberately NOT reusing lib/profile-delete's
// walk, so a generator bug cannot vouch for itself.
function independentSubtree(): Set<string> {
  const subtree = new Set<string>(OWNED_TABLES);
  const tables = allTables();
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tables) {
      if (subtree.has(t)) continue;
      if (fksOf(t).some((fk) => subtree.has(fk.table))) {
        subtree.add(t);
        changed = true;
      }
    }
  }
  return subtree;
}

describe("profile-delete sweep completeness (#2126)", () => {
  const owned = new Set<string>(OWNED_TABLES);
  const subtree = independentSubtree();
  const planTables = new Set(profileChildDeletePlan(db).map((s) => s.table));

  it("every FK-reachable child of an owned table is in the delete plan", () => {
    const missing = [...subtree]
      .filter((t) => !owned.has(t) && !planTables.has(t))
      .sort();
    expect(
      missing,
      "These tables are FK-reachable from a profile-owned table but absent from " +
        "the derived profile-delete plan — their rows would survive a profile " +
        "delete as orphaned PHI (#2126). Fix lib/profile-delete.ts."
    ).toEqual([]);
  });

  it("the plan deletes only non-owned subtree tables (never an owned table twice, never a global)", () => {
    for (const t of planTables) {
      expect(
        owned.has(t),
        `${t} is owned — deleted by profile_id, not the child plan`
      ).toBe(false);
      expect(subtree.has(t), `${t} is not in the profile subtree`).toBe(true);
    }
  });

  it("regression: the #2126 orphan tables and known grandchildren are swept", () => {
    for (const t of [
      "allergy_reactions",
      "medication_courses",
      "intake_item_side_effects",
      "intake_dose_schedule_versions",
      "routine_slots",
      "medical_record_revisions",
    ]) {
      expect(planTables.has(t), t).toBe(true);
    }
  });

  it("child deletes run deepest-first, so every subquery still finds its parents", () => {
    const children = ownedChildTables(db);
    const plan = profileChildDeletePlan(db);
    const position = new Map(plan.map((s, i) => [s.table, i]));
    for (const child of children.values()) {
      for (const edge of child.edges) {
        if (owned.has(edge.parent)) continue; // owned parents are deleted after all children
        expect(
          position.get(child.table)! < position.get(edge.parent)!,
          `${child.table} must be deleted before its parent ${edge.parent}`
        ).toBe(true);
      }
    }
  });

  // The DECIDE-IN-WRITING checkpoint (the import-footprint scan's posture, one
  // domain over): the derived sweep deletes every child automatically, which is
  // correct exactly when the child's rows are profile-private (profile isolation —
  // no row of one profile's subtree references another's). A NEW table that joins
  // the subtree fails here until someone confirms that property and declares it.
  // If a genuinely SHARED table ever wants an FK into profile-owned data (the
  // providers/shared_supplies class), that confirmation must instead become
  // explicit set-null handling in lib/profile-delete.ts — never a silent delete of
  // another profile's view of shared rows.
  const DECLARED_CHILD_TABLES: { table: string; why: string }[] = [
    { table: "activity_routes", why: "GPS route of one activity (#569)" },
    {
      table: "exercise_sets",
      why: "sets of one activity; equipment link is same-profile",
    },
    {
      table: "allergy_reactions",
      why: "graded manifestations of one allergy (#2126 orphan)",
    },
    {
      table: "fitness_assessment_entries",
      why: "entries of one fitness-check session (#834)",
    },
    {
      table: "intake_item_doses",
      why: "dose schedule of one supplement/medication",
    },
    {
      table: "intake_dose_schedule_versions",
      why: "schedule history of one dose (#1973)",
    },
    { table: "intake_item_logs", why: "adherence log of one item" },
    {
      table: "intake_item_pairs",
      why: "take-together/apart pair of two same-profile items",
    },
    {
      table: "intake_item_side_effects",
      why: "recorded side effects of one item (#2126 orphan)",
    },
    {
      table: "medication_courses",
      why: "start/stop history of one medication (#2126 orphan)",
    },
    {
      table: "integration_sync_rows",
      why: "per-row provenance of one sync event (#1333)",
    },
    {
      table: "medical_record_revisions",
      why: "correction lineage of one record (#1404)",
    },
    { table: "routine_days", why: "days of one routine (#738)" },
    { table: "routine_slots", why: "slots of one routine day (#738)" },
  ];

  it("every subtree child table is declared profile-private (a new one needs the decision made here)", () => {
    const declared = new Set(DECLARED_CHILD_TABLES.map((d) => d.table));
    const undeclared = [...subtree]
      .filter((t) => !owned.has(t) && !declared.has(t))
      .sort();
    expect(
      undeclared,
      "A new table joined the profile-delete subtree (it has an FK path to a " +
        "profile-owned table), and the derived sweep WILL delete its rows with the " +
        "profile. Confirm its rows are profile-private and declare it in " +
        "DECLARED_CHILD_TABLES — or, if it is genuinely shared across profiles, " +
        "give lib/profile-delete.ts explicit set-null handling instead."
    ).toEqual([]);

    // No stale declarations, and every declaration carries a reason.
    for (const d of DECLARED_CHILD_TABLES) {
      expect(
        subtree.has(d.table),
        `${d.table} is no longer in the subtree`
      ).toBe(true);
      expect(
        owned.has(d.table),
        `${d.table} became owned — remove it here`
      ).toBe(false);
      expect(d.why.trim().length).toBeGreaterThan(0);
    }
  });
});
