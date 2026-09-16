// DB INTEGRATION TIER — the declared food sensitivities table (#5865 slice 1).
//
// Covers the 20260912-food-sensitivities migration against the real schema and the
// store's CRUD over it. The db singleton is redirected at a per-file temp DB by
// lib/__db_tests__/setup.ts before this file is imported (profile 1 exists via
// bootstrapAuth).
//
// WHAT IS WORTH ASSERTING HERE rather than in the pure tier: everything that is a
// property of the SCHEMA (the two CHECKs, the uniqueness of a declaration, the absence
// of a temporal column) and everything that is a property of the STORE's scoping (a
// leaked id must not reach another profile's row through any of the four writes).

import { describe, it, expect, beforeEach } from "vitest";
import { rawDb as db } from "@/lib/db";
import {
  createFoodSensitivity,
  deleteFoodSensitivity,
  foodSensitivityExists,
  getActiveFoodSensitivities,
  getFoodSensitivities,
  getFoodSensitivity,
  setFoodSensitivityStatus,
  updateFoodSensitivity,
} from "@/lib/food-sensitivity-store";

const P1 = 1;
let P2 = 0;

function tableSql(): string {
  return (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'food_sensitivities'"
      )
      .get() as { sql: string }
  ).sql;
}

beforeEach(() => {
  db.prepare("DELETE FROM food_sensitivities").run();
  P2 = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('other')").run()
      .lastInsertRowid
  );
});

describe("the schema", () => {
  it("is profile-owned and born NOT NULL on the owner", () => {
    expect(tableSql()).toMatch(
      /profile_id\s+INTEGER NOT NULL REFERENCES profiles\(id\)/
    );
  });

  it("refuses a trigger kind outside the two vocabularies", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO food_sensitivities (profile_id, trigger_kind, trigger_slug, effect)
           VALUES (?, 'vibe', 'spicy', 'loose_stools')`
        )
        .run(P1)
    ).toThrow(/CHECK/);
  });

  it("refuses a status outside active/stopped, and defaults to active", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO food_sensitivities (profile_id, trigger_kind, trigger_slug, effect, status)
           VALUES (?, 'property', 'spicy', 'loose_stools', 'paused')`
        )
        .run(P1)
    ).toThrow(/CHECK/);
    const row = createFoodSensitivity(P1, {
      trigger_kind: "property",
      trigger_slug: "spicy",
      effect: "loose_stools",
      note: null,
    });
    expect(row.status).toBe("active");
  });

  it("lets the same trigger carry two different effects, and refuses the same pair twice", () => {
    const base = {
      trigger_kind: "property" as const,
      trigger_slug: "spicy",
      note: null,
    };
    createFoodSensitivity(P1, { ...base, effect: "loose_stools" });
    createFoodSensitivity(P1, { ...base, effect: "abdominal_pain" });
    expect(getFoodSensitivities(P1)).toHaveLength(2);
    expect(() =>
      createFoodSensitivity(P1, { ...base, effect: "loose_stools" })
    ).toThrow(/UNIQUE/);
  });

  it("carries no temporal column — a declaration is a standing statement, not an event", () => {
    const cols = db.prepare("PRAGMA table_info(food_sensitivities)").all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).toEqual([
      "id",
      "profile_id",
      "trigger_kind",
      "trigger_slug",
      "effect",
      "note",
      "status",
    ]);
  });
});

describe("the store, scoped to one profile", () => {
  function declare(profileId: number, slug: string) {
    return createFoodSensitivity(profileId, {
      trigger_kind: "property",
      trigger_slug: slug,
      effect: "loose_stools",
      note: null,
    });
  }

  it("reads back only the acting profile's declarations", () => {
    declare(P1, "spicy");
    declare(P2, "caffeine");
    expect(getFoodSensitivities(P1).map((s) => s.trigger_slug)).toEqual([
      "spicy",
    ]);
    expect(getFoodSensitivities(P2).map((s) => s.trigger_slug)).toEqual([
      "caffeine",
    ]);
  });

  it("refuses to read, edit, stop or delete another profile's row through its id", () => {
    const theirs = declare(P2, "caffeine");
    expect(getFoodSensitivity(P1, theirs.id)).toBeUndefined();
    expect(
      updateFoodSensitivity(P1, theirs.id, {
        trigger_kind: "property",
        trigger_slug: "spicy",
        effect: "bloating",
        note: null,
      })
    ).toBe(false);
    expect(setFoodSensitivityStatus(P1, theirs.id, "stopped")).toBe(false);
    expect(deleteFoodSensitivity(P1, theirs.id)).toBe(false);
    // And the row is untouched by all four.
    expect(getFoodSensitivity(P2, theirs.id)).toMatchObject({
      trigger_slug: "caffeine",
      effect: "loose_stools",
      status: "active",
    });
  });

  it("sees a duplicate only within the profile, and never against the row itself", () => {
    const mine = declare(P1, "spicy");
    declare(P2, "spicy");
    const same = {
      trigger_kind: "property" as const,
      trigger_slug: "spicy",
      effect: "loose_stools",
      note: null,
    };
    expect(foodSensitivityExists(P1, same)).toBe(true);
    expect(foodSensitivityExists(P1, same, mine.id)).toBe(false);
    expect(foodSensitivityExists(P2, { ...same, effect: "bloating" })).toBe(
      false
    );
  });

  it("stops and resumes, keeping the row and dropping it from the active set", () => {
    const mine = declare(P1, "spicy");
    expect(getActiveFoodSensitivities(P1)).toHaveLength(1);

    expect(setFoodSensitivityStatus(P1, mine.id, "stopped")).toBe(true);
    expect(getActiveFoodSensitivities(P1)).toHaveLength(0);
    // The declaration is still there — stopping is not deleting.
    expect(getFoodSensitivities(P1)).toHaveLength(1);
    // A second stop changes nothing and says so, rather than reporting success over a
    // swap that did not land (#2138).
    expect(setFoodSensitivityStatus(P1, mine.id, "stopped")).toBe(false);

    expect(setFoodSensitivityStatus(P1, mine.id, "active")).toBe(true);
    expect(getActiveFoodSensitivities(P1)).toHaveLength(1);
  });

  it("edits every stated field in place", () => {
    const mine = declare(P1, "spicy");
    expect(
      updateFoodSensitivity(P1, mine.id, {
        trigger_kind: "group",
        trigger_slug: "dairy",
        effect: "bloating",
        note: "only whole milk",
      })
    ).toBe(true);
    expect(getFoodSensitivity(P1, mine.id)).toMatchObject({
      trigger_kind: "group",
      trigger_slug: "dairy",
      effect: "bloating",
      note: "only whole milk",
    });
  });

  it("deletes one row and leaves the rest of the profile's declarations standing", () => {
    const spicy = declare(P1, "spicy");
    declare(P1, "caffeine");
    expect(deleteFoodSensitivity(P1, spicy.id)).toBe(true);
    expect(getFoodSensitivities(P1).map((s) => s.trigger_slug)).toEqual([
      "caffeine",
    ]);
    // A second delete finds nothing rather than reporting a second success.
    expect(deleteFoodSensitivity(P1, spicy.id)).toBe(false);
  });
});
