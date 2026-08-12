import { describe, it, expect } from "vitest";
import { DATASET_UNDO_KIND, undoKindForTable } from "@/lib/dataset-undo";
import { UNDO_KINDS } from "@/lib/undo-delete";

// The completeness guard is the TYPE SYSTEM since #2125 (a deletable undo root
// missing from DATASET_UNDO_KIND, or a mapping for a non-deletable root, is a
// compile error — see lib/dataset-undo.ts). This pure suite pins the halves types
// can't see; the DATASETS cross-check (each mapped table is a real, deletable
// dataset table) lives in the db tier (lib/__db_tests__/dataset-undo.test.ts)
// because lib/export imports the SQLite `db`.
describe("dataset table → undo kind mapping", () => {
  it("each mapped kind is rooted at exactly the table it is keyed by", () => {
    for (const [table, kind] of Object.entries(DATASET_UNDO_KIND)) {
      const spec = UNDO_KINDS[kind];
      expect(spec, `kind for ${table}`).toBeDefined();
      expect(spec.ownedTable, `root of ${kind}`).toBe(table);
      // The root entity's table is the owned table the capture ownership-checks.
      expect(spec.entities[0].table).toBe(spec.ownedTable);
    }
  });

  it("each mapped kind is 1:1 — every non-root entity is a child OF THE SELECTED ROW", () => {
    // What disqualifies a kind from a bulk mapping is capturing something that is not
    // the selected row's OWN — routing the bulk delete through it would change what the
    // delete MEANS, not just make it reversible. Two shapes do that, and #2124 sharpened
    // this assertion into naming them rather than proxying for them:
    //
    //  • a COUNTER (food-serving's day-counter decrement) — the row is one tick of a
    //    total that other rows also feed;
    //  • a convention SIBLING — an explicitly-deleted entity with NO fk to the root, so
    //    it is selected by a shared natural key rather than by the root's id
    //    (wellness-practice's whole session name-family, the alcohol day's tap events).
    //
    // `deleteExplicitly` ALONE does not disqualify, and reading it as if it did was a
    // proxy that happened to hold while every explicit child was a sibling. A photo
    // series (`symptom-day`, and `skin-lesion` if it ever becomes a dataset) is deleted
    // explicitly for a purely physical reason — SQLite carries no ON DELETE on that FK,
    // so captureDelete has to remove the rows itself — while being selected by
    // `<fk> = <root id>` and remapped back onto the root on restore. That is a cascade
    // child in all but the declaration, and excluding it would have left the
    // symptom-day bulk delete permanent (and in fact broken: a plain DELETE threw on
    // the photo FK whenever the day carried one).
    for (const [table, kind] of Object.entries(DATASET_UNDO_KIND)) {
      const rootEntity = UNDO_KINDS[kind].entities[0].entity;
      for (const entity of UNDO_KINDS[kind].entities.slice(1)) {
        const where = `${kind} (${table}) child ${entity.entity}`;
        expect(entity.counter, where).toBeUndefined();
        if (!entity.deleteExplicitly) continue;
        expect(
          entity.fks.some((f) => f.ref === rootEntity),
          `${where} is deleted explicitly with no FK to the root — a convention sibling, not this row's own child`
        ).toBe(true);
      }
    }
  });

  it("undoKindForTable answers by physical table and returns null for unmapped ones", () => {
    expect(undoKindForTable("goals")).toBeNull();
    expect(undoKindForTable("nonexistent")).toBeNull();
    // The argued exclusions stay plain bulk deletes.
    expect(undoKindForTable("frequency_targets")).toBeNull();
    expect(undoKindForTable("food_log")).toBeNull();
    expect(undoKindForTable("food_log_events")).toBeNull();
    expect(undoKindForTable("activities")).toBe("activity");
    // The supplements dataset resolves through its physical table.
    expect(undoKindForTable("intake_items")).toBe("intake-item");
    expect(undoKindForTable("supplements")).toBeNull();
    // #2038's kinds, mapped by #2125.
    expect(undoKindForTable("practice_logs")).toBe("practice-session");
    expect(undoKindForTable("substance_log")).toBe("substance-history");
    // #2127: one period row, same single-entity shape.
    expect(undoKindForTable("cycles")).toBe("cycle");
    // #1847: the clinical passport datasets. `immunizations` had a dedicated
    // "returns null" assertion here for its whole life — the bulk delete of a
    // vaccination record was permanent while a weigh-in's was not, which is the
    // inversion that issue ended.
    expect(undoKindForTable("allergies")).toBe("allergy");
    expect(undoKindForTable("conditions")).toBe("condition");
    expect(undoKindForTable("immunizations")).toBe("immunization");
    // #1847's fifth clinical kind, and the first mapping whose value the type guard
    // could not have been satisfied without moving the visit's inbound `encounter_id`
    // detach into captureDelete.
    expect(undoKindForTable("encounters")).toBe("visit");
    // #2123/#2124: the readings table's other two stores and the symptom-day. All three
    // had a dedicated "returns null" life until now — the ⋯ menu offered Undo for a
    // weigh-in and nothing for an HRV sample, a mood check-in or a symptom day.
    expect(undoKindForTable("metric_samples")).toBe("metric-sample");
    expect(undoKindForTable("mood_logs")).toBe("mood-log");
    expect(undoKindForTable("symptom_logs")).toBe("symptom-day");
    // Not a deletable dataset, so its undoable kind is reachable only from the row
    // menu — no mapping, and none required by the type guard.
    expect(undoKindForTable("skin_lesions")).toBeNull();
  });
});
