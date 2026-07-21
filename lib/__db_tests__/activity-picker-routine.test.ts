// DB INTEGRATION TIER — #1115 Fix C: the activity-form exercise picker floats TODAY'S
// resolved routine slots (+ their candidates) to the front of the frequency-ranked lift
// list, so opening the logger on a routine day surfaces the prescribed lifts first. Off
// a routine, the order is byte-for-byte the frequency ranking. The pure reorder is pinned
// in lib/__tests__/rank-by-frequency.test.ts; this proves the DB gather resolves today's
// day and reorders through it.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { createCustomRoutine, activateRoutine } from "@/lib/routines";
import { getActivitySuggestions } from "@/lib/queries";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("activity picker — routine-aware order (#1115 Fix C)", () => {
  it("floats today's prescribed slots to the front, keeps the rest in place", () => {
    const p = newProfile("Picker Routine");
    // Off a routine first: capture the baseline frequency order.
    const baseline = getActivitySuggestions(p).lifts;
    expect(baseline.length).toBeGreaterThan(3);
    // "Deadlift" is not normally the first catalog option — a fresh profile ranks by
    // catalog order — so a routine that prescribes it must move it to the front.
    expect(baseline[0]).not.toBe("Deadlift");

    const rid = createCustomRoutine(p, {
      name: "Pull day",
      days: [
        {
          label: "Pull",
          focus: ["Back"],
          slots: [
            { candidates: ["Deadlift"], sets: 3, repMin: 5, repMax: 8 },
            { candidates: ["Barbell Row"], sets: 3, repMin: 8, repMax: 12 },
          ],
        },
      ],
    });
    activateRoutine(p, rid);

    const lifts = getActivitySuggestions(p).lifts;
    // The prescribed slots lead, in slot order — base-collapsed ("Barbell Row" → "Row").
    expect(lifts.slice(0, 2)).toEqual(["Deadlift", "Row"]);
    // Nothing was dropped and the tail keeps its frequency order (baseline minus the
    // two floated names, same relative order).
    const tail = baseline.filter((n) => n !== "Deadlift" && n !== "Row");
    expect(lifts.slice(2)).toEqual(tail);
  });

  it("off a routine, the order is unchanged", () => {
    const p = newProfile("Picker No Routine");
    const a = getActivitySuggestions(p).lifts;
    // No active routine ⇒ pure frequency ranking; a re-read is identical.
    expect(getActivitySuggestions(p).lifts).toEqual(a);
    expect(a).not.toHaveLength(0);
  });
});
