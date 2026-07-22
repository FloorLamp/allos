import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contextualNextSet,
  deloadAdjust,
  suggestNextSet,
  temperRecoveringNextSet,
  type NextSet,
  type NextSetSeed,
} from "@/lib/coaching";
import {
  RECOVERING_LOAD_FACTOR,
  temperedRegions,
  type InjuryConstraint,
} from "@/lib/injury-model";
import { regionForExercise } from "@/lib/lifts";

// #1115 Fix B — contextualNextSet is the ONE composition of every next-set context
// modifier (deload week #741, recovering injury #838), so a new modifier reaches all
// surfaces or none. These tests pin the composition, then a source-scan guard proves
// every next-set-rendering surface routes through it (the detail-panel class of bug —
// a surface calling suggestNextSet raw and seeding the un-modified load — can't recur).

const seed: NextSetSeed = {
  exercise: "Bench Press",
  bodyweight: false,
  lastSessionBest: {
    weightKg: 100,
    reps: 6,
    targetReps: null,
    toFailure: false,
  },
  lastSessionSets: [
    { weightKg: 100, reps: 6, targetReps: null, toFailure: false },
    { weightKg: 100, reps: 6, targetReps: null, toFailure: false },
    { weightKg: 100, reps: 6, targetReps: null, toFailure: false },
  ],
};

describe("contextualNextSet — composition", () => {
  const base = suggestNextSet(seed, "kg");

  it("no modifiers ⇒ the plain progression (identity)", () => {
    expect(contextualNextSet(base, "Bench Press", {})).toBe(base);
  });

  it("deload only ⇒ equals deloadAdjust's load half", () => {
    expect(
      contextualNextSet(base, "Bench Press", { deloadWeek: true })
    ).toEqual(
      deloadAdjust({ exercise: "Bench Press", sets: 0, nextSet: base }).nextSet
    );
  });

  it("recovering only ⇒ equals temperRecoveringNextSet", () => {
    expect(
      contextualNextSet(base, "Bench Press", {
        recoveringRegion: true,
        recoveringFactor: RECOVERING_LOAD_FACTOR,
      })
    ).toEqual(
      temperRecoveringNextSet(base, "Bench Press", RECOVERING_LOAD_FACTOR)
    );
  });

  it("both ⇒ temper THEN deload (the lighter stacked result, deload rationale)", () => {
    const both = contextualNextSet(base, "Bench Press", {
      deloadWeek: true,
      recoveringRegion: true,
      recoveringFactor: RECOVERING_LOAD_FACTOR,
    })!;
    const manual = deloadAdjust({
      exercise: "Bench Press",
      sets: 0,
      nextSet: temperRecoveringNextSet(
        base,
        "Bench Press",
        RECOVERING_LOAD_FACTOR
      ),
    }).nextSet!;
    expect(both).toEqual(manual);
    // Lighter than either modifier alone.
    expect(both.weightKg).toBeLessThan(base!.weightKg);
    expect(both.rationale).toMatch(/deload/i);
  });

  it("recoveringRegion without a factor is a no-op (fail-safe)", () => {
    expect(
      contextualNextSet(base, "Bench Press", { recoveringRegion: true })
    ).toBe(base);
  });

  it("passes a null suggestion (cold start) straight through", () => {
    expect(
      contextualNextSet(null, "Bench Press", { deloadWeek: true })
    ).toBeNull();
  });
});

// The #221 cross-surface parity guarantee, made structural: EVERY next-set-rendering
// surface (the coaching card + engine routine card, the Training-overview session card,
// the live logger, and the exercise-detail / Analyze panel) builds its next-set as
// contextualNextSet(suggestNextSet(seed), exercise, ctx). Given the SAME seed and the
// SAME resolved context, they therefore render the identical load — the guard below
// proves the routing, this pins the value for a deload+recovering fixture.
describe("contextualNextSet — one fixture, one answer (#221)", () => {
  it("a deload week on a recovering lift yields one shaved+tempered load", () => {
    const base = suggestNextSet(seed, "kg")!;
    const ctx = {
      deloadWeek: true,
      recoveringRegion: true,
      recoveringFactor: RECOVERING_LOAD_FACTOR,
    };
    const result = contextualNextSet(base, "Bench Press", ctx)!;
    // 100 → temper 0.6 = 60 → deload 0.9 = 54 → plate-rounded to the 2.5 kg step = 55.
    expect(result.weightKg).toBe(55);
    // Any surface that passes the same base + ctx gets the same NextSet.
    const again: NextSet = contextualNextSet(base, "Bench Press", ctx)!;
    expect(again).toEqual(result);
  });
});

// #1144 — the live logger (StrengthSets) and the Analyze/detail panel must agree on the
// RECOVERING-INJURY axis too, not just deload. Both resolve the lift's coarse region via
// the SAME regionForExercise and test it against the SAME temperedRegions set (the panel
// with `.has`, the form with `.includes` over the serialized-to-array prop), then feed the
// SAME contextualNextSet. This pins that, OUTSIDE a deload week, both derivations yield the
// identical tempered load — the #221 "same fixture → same answer everywhere" pin on the
// injury axis, which regressed because the form's client tree only received deloadContext.
describe("form ⇄ Analyze-panel agreement on the recovering-injury axis (#1144)", () => {
  const base = suggestNextSet(seed, "kg")!; // Bench Press → Chest region
  // A recovering Chest injury: temperedRegions includes Chest (the same gather
  // getFormRecoveringContext serializes to the form and the Analyze panel reads).
  const constraints: InjuryConstraint[] = [
    {
      id: 1,
      label: "Left pec strain",
      status: "recovering",
      regions: ["Chest"],
    },
  ];
  const tempered = temperedRegions(constraints);

  it("outside a deload week, the form seeds the SAME tempered load as the panel", () => {
    // The form's derivation: region ∈ the serialized temperedRegions array.
    const injuryRegion = regionForExercise("Bench Press");
    const formCtx = {
      deloadWeek: false,
      recoveringRegion:
        injuryRegion != null && [...tempered].includes(injuryRegion),
      recoveringFactor: RECOVERING_LOAD_FACTOR,
    };
    // The Analyze panel's derivation: region ∈ the temperedRegions set.
    const statRegion = regionForExercise("Bench Press");
    const panelCtx = {
      deloadWeek: false,
      recoveringRegion: statRegion != null && tempered.has(statRegion),
      recoveringFactor: RECOVERING_LOAD_FACTOR,
    };
    // Both resolve Chest as recovering, so both temper.
    expect(formCtx.recoveringRegion).toBe(true);
    expect(panelCtx.recoveringRegion).toBe(true);
    const formNext = contextualNextSet(base, "Bench Press", formCtx);
    const panelNext = contextualNextSet(base, "Bench Press", panelCtx);
    // They agree — and both equal the shared temper, NOT the un-tempered progression.
    expect(formNext).toEqual(panelNext);
    expect(formNext).toEqual(
      temperRecoveringNextSet(base, "Bench Press", RECOVERING_LOAD_FACTOR)
    );
    expect(formNext!.weightKg).toBeLessThan(base.weightKg);
  });

  it("a lift OUTSIDE the recovering region is untouched (byte-for-byte prior)", () => {
    // Squat → Legs, not in the tempered set: the form seeds the plain progression.
    const region = regionForExercise("Squat");
    const ctx = {
      deloadWeek: false,
      recoveringRegion: region != null && [...tempered].includes(region),
      recoveringFactor: RECOVERING_LOAD_FACTOR,
    };
    expect(ctx.recoveringRegion).toBe(false);
    expect(contextualNextSet(base, "Squat", ctx)).toBe(base);
  });
});

// Source-scan guard (pure — reads the repo's own source as text): every production
// module that calls suggestNextSet MUST also call contextualNextSet, so a new next-set
// surface can't seed the un-modified load. lib/coaching/strength.ts is the ONLY
// exception — it DEFINES both.
describe("every suggestNextSet surface routes through contextualNextSet (#1115 Fix B)", () => {
  const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const SCAN_DIRS = ["lib", "app", "components", "scripts"];
  const ALLOWLIST = new Set<string>(["lib/coaching/strength.ts"]);

  function isExcluded(rel: string): boolean {
    return (
      rel.includes("__tests__") ||
      rel.includes("__db_tests__") ||
      rel.includes("__action_tests__") ||
      rel.endsWith(".test.ts") ||
      rel.endsWith(".test.tsx")
    );
  }

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("no surface calls suggestNextSet without contextualNextSet", () => {
    const offenders: string[] = [];
    for (const d of SCAN_DIRS) {
      const abs = path.join(REPO, d);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        const rel = path.relative(REPO, file);
        if (isExcluded(rel) || ALLOWLIST.has(rel)) continue;
        const src = fs.readFileSync(file, "utf8");
        if (
          src.includes("suggestNextSet(") &&
          !src.includes("contextualNextSet(")
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
