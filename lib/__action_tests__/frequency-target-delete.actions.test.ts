// SERVER-ACTION TIER — issue #1809: deleting a training goal a protocol references.
//
// `protocols.frequency_target_id` is a REFERENCES FK with no ON DELETE action, and the
// two goals-form delete sites ignored it: `deleteFrequencyTarget` deleted the row
// outright, and `createFrequencyTarget`'s dedup DELETE removed a colliding row the same
// way. With a protocol pointing at either, SQLite refused and the Server Action threw a
// bare SQLITE_CONSTRAINT_FOREIGNKEY — the goal was undeletable and the edit unsavable.
//
// Both now route through the shared delete core (lib/frequency-target-delete), which
// nulls the protocol's link — and its `owns_frequency_target` claim — before the delete,
// in one transaction. A protocol whose target is gone degrades to a protocol with no
// adherence intervention: the honest state, and the same degradation the substance-use,
// food-habit, wellness-practice and right-sizing paths already chose.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createFrequencyTarget,
  deleteFrequencyTarget,
} from "@/app/(app)/training/frequency-actions";
import { activateRoutine, createCustomRoutine } from "@/lib/routines";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

function newTarget(
  profileId: number,
  scopeKind: string,
  scopeValue: string,
  perWeek = 3
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(scopeKind, scopeValue, perWeek, profileId).lastInsertRowid
  );
}

function newProtocol(profileId: number, targetId: number, owns = 1): number {
  return Number(
    db
      .prepare(
        `INSERT INTO protocols
           (profile_id, name, start_date, frequency_target_id, owns_frequency_target)
         VALUES (?, 'Strength block', '2020-01-01', ?, ?)`
      )
      .run(profileId, targetId, owns).lastInsertRowid
  );
}

interface ProtocolLink {
  frequency_target_id: number | null;
  owns_frequency_target: number;
}

function protocolLink(id: number): ProtocolLink | undefined {
  return db
    .prepare(
      `SELECT frequency_target_id, owns_frequency_target FROM protocols WHERE id = ?`
    )
    .get(id) as ProtocolLink | undefined;
}

function targetExists(id: number): boolean {
  return (
    db.prepare(`SELECT id FROM frequency_targets WHERE id = ?`).get(id) !==
    undefined
  );
}

describe("deleteFrequencyTarget with a protocol referencing the goal (#1809)", () => {
  it("deletes the goal, and the protocol survives with no intervention linked", async () => {
    const { profile } = seedActor();
    const targetId = newTarget(profile.id, "type", "strength");
    const protocolId = newProtocol(profile.id, targetId);

    await deleteFrequencyTarget(fd({ id: targetId }));

    expect(targetExists(targetId)).toBe(false);
    expect(protocolLink(protocolId)).toEqual({
      frequency_target_id: null,
      owns_frequency_target: 0,
    });
  });

  it("leaves another profile's goal alone (cross-profile refusal still holds)", async () => {
    const other = createProfile("FT-OTHER");
    const otherTarget = newTarget(other.id, "type", "cardio");
    const otherProtocol = newProtocol(other.id, otherTarget);

    // Act as a DIFFERENT profile and submit the other profile's target id.
    const { profile } = seedActor();
    expect(profile.id).not.toBe(other.id);
    await deleteFrequencyTarget(fd({ id: otherTarget }));

    expect(targetExists(otherTarget)).toBe(true);
    expect(protocolLink(otherProtocol)?.frequency_target_id).toBe(otherTarget);
  });

  it("does not touch a protocol that references a DIFFERENT goal", async () => {
    const { profile } = seedActor();
    const doomed = newTarget(profile.id, "type", "strength");
    const kept = newTarget(profile.id, "type", "sport");
    const protocolId = newProtocol(profile.id, kept);

    await deleteFrequencyTarget(fd({ id: doomed }));

    expect(protocolLink(protocolId)).toEqual({
      frequency_target_id: kept,
      owns_frequency_target: 1,
    });
  });
});

describe("the goals-upsert collision delete (#1809)", () => {
  it("re-scoping an edit onto an occupied scope completes, freeing the collided-with goal's protocol", async () => {
    const { profile } = seedActor();
    // The row being edited, and the row already occupying the scope it moves onto.
    const edited = newTarget(profile.id, "type", "cardio", 2);
    const collided = newTarget(profile.id, "type", "strength", 4);
    const protocolId = newProtocol(profile.id, collided);

    await createFrequencyTarget(
      fd({ id: edited, scope_kind: "type", scope_value: "strength", per_week: 5 })
    );

    // The edit merged into ONE row: the edited target now owns the scope, the collided
    // row is gone, and its protocol was freed rather than blocking the whole save.
    expect(targetExists(collided)).toBe(false);
    const survivor = db
      .prepare(
        `SELECT id, per_week FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'type' AND scope_value = 'strength'`
      )
      .all(profile.id) as { id: number; per_week: number }[];
    expect(survivor).toEqual([{ id: edited, per_week: 5 }]);
    expect(protocolLink(protocolId)).toEqual({
      frequency_target_id: null,
      owns_frequency_target: 0,
    });
  });
});

describe("routine activation replacing training-scope goals (#1809, same FK)", () => {
  it("activates, replacing the goals a protocol referenced instead of being refused", () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("FT-ROUTINE");
    actAs(login, profile);
    const targetId = newTarget(profile.id, "type", "strength");
    const protocolId = newProtocol(profile.id, targetId);
    const routineId = createCustomRoutine(profile.id, {
      name: "Upper/lower",
      cycleWeeks: null,
      days: [
        {
          label: "Upper",
          focus: ["Chest"],
          slots: [
            {
              candidates: ["Bench press"],
              sets: 3,
              repMin: 5,
              repMax: 8,
            },
          ],
        },
      ],
    });

    expect(activateRoutine(profile.id, routineId)).toBe(true);

    // The replaced target is gone and the protocol was freed — before, the live FK
    // refused the bulk delete and the whole activation threw.
    expect(targetExists(targetId)).toBe(false);
    expect(protocolLink(protocolId)).toEqual({
      frequency_target_id: null,
      owns_frequency_target: 0,
    });
  });
});
