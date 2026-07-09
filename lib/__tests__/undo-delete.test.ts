import { describe, it, expect } from "vitest";
import {
  UNDO_KINDS,
  getKindSpec,
  serializePayload,
  parsePayload,
  remapRow,
  type IdMaps,
  type Row,
} from "@/lib/undo-delete";
import { OWNED_TABLES } from "@/lib/owned-tables";

// PURE tests for the undo-delete registry + serialize/restore transforms (issue
// #30). The DB round-trip (real delete → undo) is exercised separately in the
// db-integration tier: lib/__db_tests__/undo-delete.test.ts.

describe("undo-delete registry", () => {
  it("every kind's root table is a profile-owned table", () => {
    for (const spec of Object.values(UNDO_KINDS)) {
      const root = spec.entities[0];
      expect(root.table).toBe(spec.ownedTable);
      expect(OWNED_TABLES as readonly string[]).toContain(spec.ownedTable);
    }
  });

  it("entities are in dependency order (every FK ref appears earlier)", () => {
    for (const spec of Object.values(UNDO_KINDS)) {
      const seen = new Set<string>();
      for (const e of spec.entities) {
        for (const fk of e.fks) {
          // A ref must be an entity defined at or before this one (self-ref for the
          // root is fine; children reference an already-inserted parent).
          expect(seen.has(fk.ref) || fk.ref === e.entity).toBe(true);
        }
        seen.add(e.entity);
      }
    }
  });

  it("only the root entity lacks a child capture clause", () => {
    for (const spec of Object.values(UNDO_KINDS)) {
      spec.entities.forEach((e, i) => {
        if (i === 0) {
          expect(e.childWhere).toBeUndefined();
          expect(e.fks).toEqual([]);
        } else {
          expect(typeof e.childWhere).toBe("string");
        }
      });
    }
  });

  it("getKindSpec throws on an unknown kind", () => {
    expect(() => getKindSpec("nope")).toThrow(/unknown undo kind/);
  });
});

describe("serialize / parse round-trip", () => {
  it("preserves kind and rows", () => {
    const rows: Record<string, Row[]> = {
      activity: [{ id: 5, title: "Squats", profile_id: 2 }],
      sets: [
        { id: 9, activity_id: 5, exercise: "Back Squat", set_number: 1 },
        { id: 10, activity_id: 5, exercise: "Back Squat", set_number: 2 },
      ],
    };
    const json = serializePayload("activity", rows);
    const back = parsePayload(json);
    expect(back.kind).toBe("activity");
    expect(back.rows).toEqual(rows);
  });

  it("rejects an invalid payload version / unknown kind", () => {
    expect(() =>
      parsePayload(JSON.stringify({ v: 2, kind: "activity" }))
    ).toThrow();
    expect(() =>
      parsePayload(JSON.stringify({ v: 1, kind: "bogus", rows: {} }))
    ).toThrow();
    expect(() =>
      parsePayload(JSON.stringify({ v: 1, kind: "activity" }))
    ).toThrow(/rows/);
  });
});

describe("remapRow", () => {
  it("drops the id and remaps a captured FK to the new parent id", () => {
    const idMaps: IdMaps = { activity: new Map([[5, 77]]) };
    const out = remapRow(
      { id: 9, activity_id: 5, exercise: "Back Squat" },
      idMaps,
      [{ column: "activity_id", ref: "activity" }]
    );
    expect(out).toEqual({ activity_id: 77, exercise: "Back Squat" });
    expect("id" in out).toBe(false);
  });

  it("leaves a far-endpoint FK (target not in this capture) untouched", () => {
    // A "take together" pair: a_id was the deleted+restored item, b_id points at a
    // still-existing item that was NOT part of the capture.
    const idMaps: IdMaps = { item: new Map([[3, 42]]) };
    const out = remapRow(
      { id: 1, a_id: 3, b_id: 8, relation: "with" },
      idMaps,
      [
        { column: "a_id", ref: "item" },
        { column: "b_id", ref: "item" },
      ]
    );
    expect(out).toEqual({ a_id: 42, b_id: 8, relation: "with" });
  });

  it("keeps a null FK null", () => {
    const idMaps: IdMaps = { courses: new Map([[1, 2]]) };
    const out = remapRow({ id: 4, item_id: 3, course_id: null }, idMaps, [
      { column: "course_id", ref: "courses" },
    ]);
    expect(out.course_id).toBeNull();
  });
});
