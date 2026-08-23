// SERVER-ACTION TIER — purpose links for intake items (issue #2857).
//
// The model only means anything if a stated reason survives the round trip: the write
// boundary, the replace-on-save reconcile, the profile scoping the id-carrying kinds
// need, the cascade when the item goes, the detach when the CONDITION goes, and the
// restore when a delete is undone.
//
// SYNTHETIC ONLY: invented products and ordinary supplement vocabulary, no PHI.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  addIntakeItem,
  updateIntakeItem,
  deleteIntakeItem,
} from "@/app/(app)/nutrition/intake-actions";
import { deleteCondition } from "@/app/(app)/records/problems/conditions/actions";
import { undoDelete } from "@/app/(app)/undo-actions";
import { getIntakePurposesByItem } from "@/lib/queries";
import type { IntakeItemPurpose } from "@/lib/intake-purposes";
import { seedActor, createProfile, fd } from "./harness";

function purposesField(rows: unknown[]): string {
  return JSON.stringify(rows);
}

function lastItemId(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT id FROM intake_items WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profileId) as { id: number }
  ).id;
}

function storedFor(profileId: number, itemId: number): IntakeItemPurpose[] {
  return getIntakePurposesByItem(profileId).get(itemId) ?? [];
}

function makeCondition(profileId: number, name: string): number {
  const info = db
    .prepare("INSERT INTO conditions (profile_id, name) VALUES (?,?)")
    .run(profileId, name);
  return Number(info.lastInsertRowid);
}

async function addWithPurposes(rows: unknown[], name = "Eye Health+") {
  await addIntakeItem(
    fd({
      name,
      condition: "daily",
      doses: JSON.stringify([{ amount: "1 cap", food_timing: "any" }]),
      purposes: purposesField(rows),
    })
  );
}

describe("the write boundary", () => {
  it("stores each stated reason as its own row, in order", async () => {
    const { profile } = seedActor();
    const conditionId = makeCondition(profile.id, "Macular degeneration");
    await addWithPurposes([
      { kind: "goal", goalKey: "eyes" },
      { kind: "condition", conditionId },
      {
        kind: "biomarker",
        biomarkerKey: "Vitamin D, 25-Hydroxy",
        direction: "low",
      },
    ]);
    const rows = storedFor(profile.id, lastItemId(profile.id));
    expect(
      rows.map((r) => [
        r.kind,
        r.goal_key,
        r.condition_id,
        r.biomarker_key,
        r.direction,
        r.sort,
      ])
    ).toEqual([
      ["goal", "eyes", null, null, null, 0],
      ["condition", null, conditionId, null, null, 1],
      ["biomarker", null, null, "Vitamin D, 25-Hydroxy", "low", 2],
    ]);
  });

  it("drops a condition belonging to ANOTHER profile rather than linking it", async () => {
    // The ownership check the pure normalizer cannot make — the
    // resolveIndicationConditionId posture (#1052): an untrusted id is dropped, never
    // stored and never an error.
    const { profile } = seedActor();
    const other = createProfile("Second Person");
    const foreign = makeCondition(other.id, "Someone else's condition");
    await addWithPurposes([
      { kind: "condition", conditionId: foreign },
      { kind: "goal", goalKey: "sleep" },
    ]);
    const rows = storedFor(profile.id, lastItemId(profile.id));
    expect(rows.map((r) => r.kind)).toEqual(["goal"]);
  });

  it("replaces the whole set on save, and an empty post clears it", async () => {
    const { profile } = seedActor();
    await addWithPurposes([
      { kind: "goal", goalKey: "eyes" },
      { kind: "goal", goalKey: "sleep" },
    ]);
    const id = lastItemId(profile.id);
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Eye Health+",
        condition: "daily",
        doses: JSON.stringify([{ amount: "1 cap", food_timing: "any" }]),
        purposes: purposesField([{ kind: "goal", goalKey: "heart" }]),
      })
    );
    expect(storedFor(profile.id, id).map((r) => r.goal_key)).toEqual(["heart"]);
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Eye Health+",
        condition: "daily",
        doses: JSON.stringify([{ amount: "1 cap", food_timing: "any" }]),
        purposes: purposesField([]),
      })
    );
    expect(storedFor(profile.id, id)).toEqual([]);
  });

  it("leaves stored purposes alone when a form posts no purposes field at all", async () => {
    // ABSENT MEANS UNCHANGED. Two forms share updateIntakeItem and only one renders
    // the control; without this a medication edit would silently delete somebody's
    // stated reason.
    const { profile } = seedActor();
    await addWithPurposes([{ kind: "goal", goalKey: "eyes" }]);
    const id = lastItemId(profile.id);
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Eye Health+",
        condition: "daily",
        doses: JSON.stringify([{ amount: "1 cap", food_timing: "any" }]),
      })
    );
    expect(storedFor(profile.id, id).map((r) => r.goal_key)).toEqual(["eyes"]);
  });

  it("never refuses a save over an unrenderable purpose", async () => {
    const { profile } = seedActor();
    const result = await addIntakeItem(
      fd({
        name: "Magnesium Glycinate",
        condition: "daily",
        doses: JSON.stringify([{ amount: "200 mg", food_timing: "any" }]),
        purposes: purposesField([
          { kind: "goal", goalKey: "vibes" },
          { kind: "nonsense" },
        ]),
      })
    );
    expect(result.error).toBeFalsy();
    const id = lastItemId(profile.id);
    expect(storedFor(profile.id, id)).toEqual([]);
    expect(
      db.prepare("SELECT name FROM intake_items WHERE id = ?").get(id)
    ).toEqual({ name: "Magnesium Glycinate" });
  });
});

describe("what happens when the things a purpose points at go away", () => {
  it("takes the purposes with the item", async () => {
    const { profile } = seedActor();
    await addWithPurposes([{ kind: "goal", goalKey: "eyes" }]);
    const id = lastItemId(profile.id);
    await deleteIntakeItem(fd({ id: String(id) }));
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM intake_item_purposes WHERE item_id = ?"
        )
        .get(id)
    ).toEqual({ n: 0 });
  });

  it("brings them back when the item delete is undone", async () => {
    const { profile } = seedActor();
    await addWithPurposes([
      { kind: "goal", goalKey: "eyes" },
      { kind: "biomarker", biomarkerKey: "Lutein Level", direction: "low" },
    ]);
    const id = lastItemId(profile.id);
    const { undoId } = await deleteIntakeItem(fd({ id: String(id) }));
    expect(undoId).not.toBeNull();
    expect(await undoDelete(undoId!)).toEqual({ ok: true });
    const restored = lastItemId(profile.id);
    expect(
      storedFor(profile.id, restored).map((r) => [
        r.kind,
        r.goal_key ?? r.biomarker_key,
      ])
    ).toEqual([
      ["goal", "eyes"],
      ["biomarker", "Lutein Level"],
    ]);
  });

  it("removes a condition purpose when the condition is deleted, and does not resurrect it on undo", async () => {
    // The `intake_items.indication_condition_id` null-out one table over (#1052): the
    // detach is a side effect undo deliberately does NOT invert. A purpose row with no
    // condition is not a purpose — the schema CHECK refuses one — so row removal is
    // this link's null-out.
    const { profile } = seedActor();
    const conditionId = makeCondition(profile.id, "Macular degeneration");
    await addWithPurposes([
      { kind: "condition", conditionId },
      { kind: "goal", goalKey: "eyes" },
    ]);
    const id = lastItemId(profile.id);
    expect(storedFor(profile.id, id)).toHaveLength(2);

    const { undoId } = await deleteCondition(fd({ id: String(conditionId) }));
    expect(undoId).not.toBeNull();
    // The delete went through (before the detach it would have tripped the FK), the
    // condition purpose is gone, and the item's other reason is untouched.
    expect(storedFor(profile.id, id).map((r) => r.kind)).toEqual(["goal"]);

    expect(await undoDelete(undoId!)).toEqual({ ok: true });
    expect(storedFor(profile.id, id).map((r) => r.kind)).toEqual(["goal"]);
  });

  it("does not reach into another profile's purposes when a condition is deleted", async () => {
    const { profile } = seedActor();
    const mine = makeCondition(profile.id, "Macular degeneration");
    await addWithPurposes([{ kind: "condition", conditionId: mine }]);
    const myItem = lastItemId(profile.id);
    // A second profile with its OWN condition of the same name and its own purpose.
    const other = createProfile("Second Person");
    const theirs = makeCondition(other.id, "Macular degeneration");
    const theirItem = Number(
      db
        .prepare(
          "INSERT INTO intake_items (profile_id, name, kind, condition) VALUES (?,?,?,?)"
        )
        .run(other.id, "Eye Health+", "supplement", "daily").lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_purposes (item_id, kind, condition_id, sort)
       VALUES (?, 'condition', ?, 0)`
    ).run(theirItem, theirs);

    await deleteCondition(fd({ id: String(mine) }));
    expect(storedFor(profile.id, myItem)).toEqual([]);
    expect(storedFor(other.id, theirItem)).toHaveLength(1);
  });
});
