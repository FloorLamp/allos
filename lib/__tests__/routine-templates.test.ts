import { describe, expect, it } from "vitest";
import { ROUTINE_TEMPLATES, getRoutineTemplate } from "@/lib/routine-templates";
import {
  ALL_LIFT_NAMES,
  LIFT_OPTIONS,
  REGION_SCOPES,
  GROUP_SCOPES,
  TYPE_SCOPES,
  liftInfo,
} from "@/lib/lifts";
// Import the PURE helpers from the db-free module (not @/lib/routines, which imports
// lib/db) so this stays a pure-tier test.
import {
  deriveFocusFromCandidates,
  deriveRoutineTargets,
  validateRoutineInput,
} from "@/lib/routine-derive";

// Every concrete + base catalog name, lowercased — the strict set a slot candidate
// must resolve against (a typo'd exercise name is a shipped bug, #738).
const CATALOG = new Set(
  [...ALL_LIFT_NAMES, ...LIFT_OPTIONS].map((n) => n.toLowerCase())
);
const REGIONS = new Set<string>(REGION_SCOPES);
const GROUPS = new Set<string>(GROUP_SCOPES);
const TYPES = new Set<string>(TYPE_SCOPES);

describe("routine template catalog integrity (#738)", () => {
  it("ships the expected templates with unique ids", () => {
    const ids = ROUTINE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "full-body-3x",
        "upper-lower-4x",
        "push-pull-legs-6x",
        "beginner-barbell-5x5",
        "bodyweight-minimal",
      ])
    );
    // At least one beginner and one intermediate template (onboarding shows
    // beginner first, #719).
    expect(ROUTINE_TEMPLATES.some((t) => t.audience === "beginner")).toBe(true);
    expect(ROUTINE_TEMPLATES.some((t) => t.audience === "intermediate")).toBe(
      true
    );
  });

  it("getRoutineTemplate resolves by id and misses cleanly", () => {
    expect(getRoutineTemplate("full-body-3x")?.name).toBeTruthy();
    expect(getRoutineTemplate("nope")).toBeUndefined();
  });

  for (const t of ROUTINE_TEMPLATES) {
    describe(t.id, () => {
      it("declares audience, non-empty days, and a valid cycle", () => {
        expect(["beginner", "intermediate"]).toContain(t.audience);
        expect(t.name.trim().length).toBeGreaterThan(0);
        expect(t.days.length).toBeGreaterThan(0);
        expect(t.cycleWeeks === null || t.cycleWeeks > 0).toBe(true);
      });

      it("every slot candidate resolves to a catalog lift", () => {
        for (const d of t.days) {
          expect(d.slots.length).toBeGreaterThan(0);
          for (const s of d.slots) {
            expect(s.candidates.length).toBeGreaterThan(0);
            expect(s.sets).toBeGreaterThan(0);
            expect(s.repMin).toBeGreaterThan(0);
            expect(s.repMax).toBeGreaterThanOrEqual(s.repMin);
            for (const c of s.candidates) {
              expect(
                CATALOG.has(c.toLowerCase()),
                `${t.id}: candidate "${c}" is not a catalog lift`
              ).toBe(true);
            }
          }
        }
      });

      it("every day focus is a valid region, backed by a slot", () => {
        for (const d of t.days) {
          // Regions actually trained (by the first, primary candidate of each slot).
          const trained = new Set<string>();
          for (const s of d.slots) {
            const info = liftInfo(s.candidates[0]);
            if (info) trained.add(info.region);
          }
          for (const f of d.focus) {
            expect(REGIONS.has(f), `${t.id}: bad focus region ${f}`).toBe(true);
            expect(
              trained.has(f),
              `${t.id}/${d.label}: focus ${f} not trained by any slot`
            ).toBe(true);
          }
        }
      });

      it("declares valid, non-empty training-scope frequency targets", () => {
        expect(t.frequencyTargets.length).toBeGreaterThan(0);
        for (const ft of t.frequencyTargets) {
          expect(ft.perWeek).toBeGreaterThan(0);
          // NEVER food_group — those are nutrition (migration 031) and must never be
          // produced/replaced by routine activation.
          expect(["region", "group", "type"]).toContain(ft.scopeKind);
          if (ft.scopeKind === "region")
            expect(REGIONS.has(ft.scopeValue)).toBe(true);
          if (ft.scopeKind === "group")
            expect(GROUPS.has(ft.scopeValue)).toBe(true);
          if (ft.scopeKind === "type")
            expect(TYPES.has(ft.scopeValue)).toBe(true);
        }
      });
    });
  }
});

describe("deriveRoutineTargets (#738)", () => {
  it("uses a template's DECLARED targets for a template routine", () => {
    const t = getRoutineTemplate("push-pull-legs-6x")!;
    const derived = deriveRoutineTargets({
      source: "template",
      templateId: "push-pull-legs-6x",
      // Days are ignored when a template resolves — declared targets win.
      days: [{ focus: ["Chest"] }],
    });
    expect(derived).toEqual(t.frequencyTargets);
  });

  it("derives region targets from a custom routine's day focus", () => {
    const derived = deriveRoutineTargets({
      source: "custom",
      templateId: null,
      days: [
        { focus: ["Chest", "Back"] },
        { focus: ["Chest", "Legs"] },
        { focus: ["Legs"] },
      ],
    });
    // Chest in 2 days, Back in 1, Legs in 2 — all region scope, ordered by
    // REGION_SCOPES.
    expect(derived).toEqual([
      { scopeKind: "region", scopeValue: "Chest", perWeek: 2 },
      { scopeKind: "region", scopeValue: "Back", perWeek: 1 },
      { scopeKind: "region", scopeValue: "Legs", perWeek: 2 },
    ]);
  });

  it("never emits a food_group target (nutrition stays untouched)", () => {
    for (const t of ROUTINE_TEMPLATES) {
      const derived = deriveRoutineTargets({
        source: "template",
        templateId: t.id,
        days: t.days.map((d) => ({ focus: d.focus })),
      });
      expect(
        derived.every((x) => x.scopeKind !== ("food_group" as string))
      ).toBe(true);
    }
  });

  it("falls back to day-derivation when a template_id is unknown", () => {
    const derived = deriveRoutineTargets({
      source: "template",
      templateId: "was-deleted",
      days: [{ focus: ["Core"] }],
    });
    expect(derived).toEqual([
      { scopeKind: "region", scopeValue: "Core", perWeek: 1 },
    ]);
  });
});

describe("deriveFocusFromCandidates (#739)", () => {
  it("unions each candidate's region, ordered by REGION_SCOPES", () => {
    // Back Squat → Legs, Barbell Bench Press → Chest, Barbell Row → Back.
    const focus = deriveFocusFromCandidates([
      ["Barbell Bench Press", "Dumbbell Bench Press"],
      ["Barbell Row"],
      ["Back Squat"],
    ]);
    // REGION_SCOPES order is Chest, Back, Shoulders, Arms, Legs, Glutes, Core.
    expect(focus).toEqual(["Chest", "Back", "Legs"]);
  });

  it("ignores free-text / custom lift names that don't resolve", () => {
    const focus = deriveFocusFromCandidates([
      ["My Secret Lift", "Totally Made Up"],
    ]);
    expect(focus).toEqual([]);
  });

  it("still credits a resolvable candidate alongside a custom one", () => {
    const focus = deriveFocusFromCandidates([["Back Squat", "Custom Zercher"]]);
    expect(focus).toEqual(["Legs"]);
  });

  it("dedupes a region shared by multiple slots", () => {
    const focus = deriveFocusFromCandidates([["Back Squat"], ["Leg Press"]]);
    expect(focus).toEqual(["Legs"]);
  });
});

describe("validateRoutineInput (#738)", () => {
  const good = {
    name: "  My Split ",
    days: [
      {
        label: " Push ",
        focus: ["Chest", "notARegion"],
        slots: [
          { candidates: [" Bench Press ", ""], sets: 3, repMin: 5, repMax: 8 },
        ],
      },
    ],
  };

  it("normalizes a valid payload (trims, drops bad focus, clamps)", () => {
    const out = validateRoutineInput(good)!;
    expect(out.name).toBe("My Split");
    expect(out.days[0].label).toBe("Push");
    expect(out.days[0].focus).toEqual(["Chest"]); // bogus region dropped
    expect(out.days[0].slots[0].candidates).toEqual(["Bench Press"]); // blank dropped
    expect(out.days[0].slots[0].sets).toBe(3);
  });

  it("keeps repMax ≥ repMin", () => {
    const out = validateRoutineInput({
      name: "x",
      days: [
        {
          label: "d",
          focus: [],
          slots: [
            { candidates: ["Bench Press"], sets: 3, repMin: 10, repMax: 5 },
          ],
        },
      ],
    })!;
    expect(out.days[0].slots[0].repMax).toBe(10);
  });

  it("rejects structurally invalid payloads", () => {
    expect(validateRoutineInput(null)).toBeNull();
    expect(validateRoutineInput({ name: "", days: [] })).toBeNull();
    expect(validateRoutineInput({ name: "x", days: [] })).toBeNull();
    expect(
      validateRoutineInput({ name: "x", days: [{ label: "d", slots: [] }] })
    ).toBeNull();
    expect(
      validateRoutineInput({
        name: "x",
        days: [{ label: "d", slots: [{ candidates: [], sets: 3, repMin: 5 }] }],
      })
    ).toBeNull();
  });
});
