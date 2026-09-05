// DB INTEGRATION TIER — the create core's OWN contract, at its boundary (#4669).
//
// lib/__action_tests__/intake-item-create.actions.test.ts asks the three DOORS what
// they leave behind, which is the question that matters most. It cannot ask this one:
// the core's optional fields are optional, and every door today fills them in. The
// rules that hold when a field is OMITTED therefore have no door behind them, and a
// rule nothing exercises is a rule nothing can tell you has broken — the exact reason
// this PR's own mutation table carried a row claiming a red that never happened.
//
// So the omissions are asked here, directly, one tier down. These are the defaults a
// future caller inherits by not passing something — and, for the same reason, the
// fields the core REFUSES for a kind, which every door today nulls before the core
// sees them.

import { describe, it, expect } from "vitest";
import { db, writeTx } from "@/lib/db";
import { createIntakeItemCore } from "@/lib/intake-item-create";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function rowOf(id: number): { kind: string; obligation: string } {
  return db
    .prepare("SELECT kind, obligation FROM intake_items WHERE id = ?")
    .get(id) as { kind: string; obligation: string };
}

function stackOf(id: number): string | null {
  return (
    db.prepare("SELECT stack FROM intake_items WHERE id = ?").get(id) as {
      stack: string | null;
    }
  ).stack;
}

function create(
  profileId: number,
  input: Parameters<typeof createIntakeItemCore>[1]
): number {
  const out = writeTx(() => createIntakeItemCore(profileId, input));
  if (!out.ok) throw new Error(out.error);
  return out.id;
}

describe("an omitted obligation falls to the KIND's default, not the column's (#1505)", () => {
  it("a medication with no stated obligation is `must`", () => {
    const p = newProfile("core-oblig-med");
    const id = create(p, {
      name: "Amoxicillin",
      kind: "medication",
      provenance: { source: "manual" },
      course: { kind: "open", startedOn: null },
    });
    // `must` is the medication default because that is the posture a prescription is
    // prescribed under. The COLUMN's blanket default is `should` — landing there would
    // silently demote every medication a lean caller creates, and the row would look
    // deliberate.
    expect(rowOf(id)).toEqual({ kind: "medication", obligation: "must" });
  });

  it("a supplement with no stated obligation is `should`", () => {
    const p = newProfile("core-oblig-supp");
    const id = create(p, {
      name: "Creatine",
      kind: "supplement",
      provenance: { source: "manual" },
    });
    expect(rowOf(id)).toEqual({ kind: "supplement", obligation: "should" });
  });
});

describe("a kind's columns belong to that kind, at the core's own boundary (#1505)", () => {
  it("a medication handed a stack is stored without one", () => {
    const p = newProfile("core-stack-med");
    const id = create(p, {
      name: "Atorvastatin",
      kind: "medication",
      // HANDED to the core, and refused. Stack is a supplement affordance, and the
      // core reads the same affordance table the EDIT path reads for this column, so
      // a row's shape does not depend on which door touched it last.
      //
      // This has to be asked HERE. The form door nulls `stack` in `fields()` before
      // the core is called, so posting one through the action exercises that gate and
      // never this one — a core that wrote whatever it was handed would keep the whole
      // action tier green. Removing either gate now reds exactly one test.
      stack: "Morning",
      provenance: { source: "manual" },
      course: { kind: "open", startedOn: null },
    });
    expect(stackOf(id)).toBeNull();
  });

  it("a supplement handed the same stack keeps it", () => {
    const p = newProfile("core-stack-supp");
    const id = create(p, {
      name: "Creatine",
      kind: "supplement",
      stack: "Morning",
      provenance: { source: "manual" },
    });
    // The other half of the gate: it refuses by KIND, not by refusing the column.
    expect(stackOf(id)).toBe("Morning");
  });
});
