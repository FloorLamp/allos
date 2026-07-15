// Checked-in routine template catalog (#738, Pillar 3 of the workout-UX epic #732).
//
// A template is a declarative program the user ADOPTS: adoption COPIES it into the
// profile-owned routine tables (routines/routine_days/routine_slots, migration 039),
// after which it is indistinguishable from a hand-authored routine — the engine
// (#740) only ever reads the DB shape (#559: it resolves and fills, it never invents
// a program). So this catalog is authoring input, not a runtime lookup.
//
// Each template DECLARES its derived weekly frequency targets EXPLICITLY (rather than
// the activation code guessing) — activation replaces the profile's training-scope
// `frequency_targets` with these so coaching, Upcoming's `training:<id>` findings, and
// the Telegram nudge light up through existing machinery. The declared targets use
// ONLY training scopes (region/group/type) — NEVER `food_group` (nutrition, migration
// 031), which activation must leave untouched.
//
// Slot `candidates` are ordered exercise names (first the user can actually do wins,
// resolved at recommendation time). Every candidate must resolve against the real lift
// catalog (lib/lifts.ts) — a typo is a shipped bug, enforced by
// lib/__tests__/routine-templates.test.ts.

import type { MuscleRegion } from "./lifts";

// A derived weekly frequency target a template/routine declares. Restricted to the
// TRAINING scopes — `food_group` is deliberately unrepresentable here.
export interface DerivedFrequencyTarget {
  scopeKind: "region" | "group" | "type";
  scopeValue: string;
  perWeek: number;
}

export interface RoutineTemplateSlot {
  // Ordered exercise names; first available wins when the engine fills the slot.
  candidates: string[];
  sets: number;
  repMin: number;
  repMax: number;
}

export interface RoutineTemplateDay {
  label: string;
  focus: MuscleRegion[];
  slots: RoutineTemplateSlot[];
}

export interface RoutineTemplate {
  // Stable catalog id, stored as routines.template_id on adoption.
  id: string;
  name: string;
  // Short description of who/what the template is for (equipment, level).
  description: string;
  audience: "beginner" | "intermediate";
  // Mesocycle length in weeks; null = no cycle. Stored on adoption but inert until
  // #741 adds the behavior.
  cycleWeeks: number | null;
  days: RoutineTemplateDay[];
  // Declared training-scope targets applied on activation.
  frequencyTargets: DerivedFrequencyTarget[];
}

// Helper to keep the day literals terse and readable.
function slot(
  candidates: string[],
  sets: number,
  repMin: number,
  repMax: number
): RoutineTemplateSlot {
  return { candidates, sets, repMin, repMax };
}

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  // ── Full Body 3× — the default beginner recommendation ──────────────────────
  {
    id: "full-body-3x",
    name: "Full Body 3×/week",
    description:
      "Three full-body sessions a week. The simplest effective start — every major region trained most sessions. Barbell/dumbbell gym.",
    audience: "beginner",
    cycleWeeks: null,
    days: [
      {
        label: "Full Body A",
        focus: ["Legs", "Chest", "Back", "Core"],
        slots: [
          slot(["Back Squat", "Front Squat", "Goblet Squat"], 3, 5, 8),
          slot(
            ["Barbell Bench Press", "Bench Press", "Dumbbell Bench Press"],
            3,
            5,
            8
          ),
          slot(["Barbell Row", "Cable Row", "Dumbbell Row"], 3, 6, 10),
          slot(["Cable Crunch", "Crunch", "Hanging Leg Raise"], 3, 10, 15),
        ],
      },
      {
        label: "Full Body B",
        focus: ["Legs", "Shoulders", "Back", "Arms"],
        slots: [
          slot(["Romanian Deadlift", "Deadlift", "Trap Bar Deadlift"], 3, 5, 8),
          slot(
            [
              "Barbell Overhead Press",
              "Overhead Press",
              "Dumbbell Overhead Press",
            ],
            3,
            5,
            8
          ),
          slot(["Lat Pulldown", "Pull Up", "Chin Up"], 3, 6, 10),
          slot(["Barbell Curl", "Dumbbell Curl", "Hammer Curl"], 3, 8, 12),
        ],
      },
      {
        label: "Full Body C",
        focus: ["Legs", "Chest", "Back", "Shoulders"],
        slots: [
          slot(["Leg Press", "Back Squat", "Bulgarian Split Squat"], 3, 8, 12),
          slot(
            ["Incline Bench Press", "Barbell Bench Press", "Cable Fly"],
            3,
            6,
            10
          ),
          slot(["Cable Row", "Barbell Row", "Dumbbell Row"], 3, 8, 12),
          slot(
            ["Lateral Raise", "Dumbbell Lateral Raise", "Cable Lateral Raise"],
            3,
            12,
            15
          ),
        ],
      },
    ],
    frequencyTargets: [
      { scopeKind: "group", scopeValue: "Upper", perWeek: 3 },
      { scopeKind: "group", scopeValue: "Lower", perWeek: 3 },
    ],
  },

  // ── Beginner Barbell 5×5 — linear-progression strength, with a deload cycle ──
  {
    id: "beginner-barbell-5x5",
    name: "Beginner Barbell 5×5",
    description:
      "Two alternating full-body barbell days, 5×5 on the main lifts. Linear progression with an 8-week block plus a deload week. Barbell + rack.",
    audience: "beginner",
    cycleWeeks: 9,
    days: [
      {
        label: "Workout A",
        focus: ["Legs", "Chest", "Back"],
        slots: [
          slot(["Back Squat"], 5, 5, 5),
          slot(["Barbell Bench Press", "Bench Press"], 5, 5, 5),
          slot(["Barbell Row", "Pendlay Row"], 5, 5, 5),
        ],
      },
      {
        label: "Workout B",
        focus: ["Legs", "Shoulders", "Back"],
        slots: [
          slot(["Back Squat"], 5, 5, 5),
          slot(["Barbell Overhead Press", "Overhead Press"], 5, 5, 5),
          slot(["Deadlift", "Trap Bar Deadlift"], 1, 5, 5),
        ],
      },
    ],
    frequencyTargets: [
      { scopeKind: "group", scopeValue: "Upper", perWeek: 3 },
      { scopeKind: "group", scopeValue: "Lower", perWeek: 3 },
    ],
  },

  // ── Upper / Lower 4× — intermediate split ───────────────────────────────────
  {
    id: "upper-lower-4x",
    name: "Upper / Lower 4×/week",
    description:
      "Four days alternating upper- and lower-body sessions. More volume per region than full-body once you can recover from it. Full gym.",
    audience: "intermediate",
    cycleWeeks: null,
    days: [
      {
        label: "Upper A",
        focus: ["Chest", "Back", "Shoulders", "Arms"],
        slots: [
          slot(["Barbell Bench Press", "Bench Press"], 4, 5, 8),
          slot(["Barbell Row", "Cable Row"], 4, 6, 10),
          slot(["Barbell Overhead Press", "Overhead Press"], 3, 8, 12),
          slot(["Lat Pulldown", "Pull Up"], 3, 8, 12),
          slot(["Barbell Curl", "Dumbbell Curl"], 3, 10, 15),
          slot(["Tricep Pushdown", "Skullcrusher"], 3, 10, 15),
        ],
      },
      {
        label: "Lower A",
        focus: ["Legs"],
        slots: [
          slot(["Back Squat", "Front Squat"], 4, 5, 8),
          slot(["Romanian Deadlift", "Deadlift"], 3, 6, 10),
          slot(["Leg Press", "Hack Squat"], 3, 10, 15),
          slot(["Leg Curl", "Nordic Curl"], 3, 10, 15),
          slot(["Calf Raise", "Seated Calf Raise"], 4, 10, 15),
        ],
      },
      {
        label: "Upper B",
        focus: ["Chest", "Back", "Shoulders", "Arms"],
        slots: [
          slot(["Incline Bench Press", "Dumbbell Bench Press"], 4, 6, 10),
          slot(["Pull Up", "Lat Pulldown"], 4, 6, 10),
          slot(["Dumbbell Overhead Press", "Arnold Press"], 3, 8, 12),
          slot(["Cable Row", "T-Bar Row"], 3, 8, 12),
          slot(["Lateral Raise", "Cable Lateral Raise"], 3, 12, 20),
          slot(["Hammer Curl", "Preacher Curl"], 3, 10, 15),
        ],
      },
      {
        label: "Lower B",
        focus: ["Legs", "Glutes", "Core"],
        slots: [
          slot(["Deadlift", "Trap Bar Deadlift"], 3, 4, 6),
          slot(["Front Squat", "Bulgarian Split Squat"], 3, 8, 12),
          slot(["Hip Thrust", "Glute Bridge"], 3, 8, 12),
          slot(["Leg Extension", "Leg Press"], 3, 12, 15),
          slot(["Hanging Leg Raise", "Cable Crunch"], 3, 10, 15),
        ],
      },
    ],
    frequencyTargets: [
      { scopeKind: "group", scopeValue: "Upper", perWeek: 2 },
      { scopeKind: "group", scopeValue: "Lower", perWeek: 2 },
    ],
  },

  // ── Push / Pull / Legs 6× — high-frequency intermediate split ───────────────
  {
    id: "push-pull-legs-6x",
    name: "Push / Pull / Legs 6×/week",
    description:
      "Six days: Push, Pull, Legs, repeated twice. High weekly volume for intermediates who train most days. Full gym.",
    audience: "intermediate",
    cycleWeeks: null,
    days: [
      {
        label: "Push",
        focus: ["Chest", "Shoulders", "Arms"],
        slots: [
          slot(["Barbell Bench Press", "Bench Press"], 4, 5, 8),
          slot(["Barbell Overhead Press", "Dumbbell Overhead Press"], 3, 8, 12),
          slot(["Incline Bench Press", "Dumbbell Bench Press"], 3, 8, 12),
          slot(["Lateral Raise", "Cable Lateral Raise"], 4, 12, 20),
          slot(["Tricep Pushdown", "Skullcrusher"], 3, 10, 15),
        ],
      },
      {
        label: "Pull",
        focus: ["Back", "Shoulders", "Arms"],
        slots: [
          slot(["Deadlift", "Barbell Row"], 3, 5, 8),
          slot(["Pull Up", "Lat Pulldown"], 4, 6, 12),
          slot(["Cable Row", "T-Bar Row"], 3, 8, 12),
          slot(["Face Pull", "Rear Delt Fly"], 3, 12, 20),
          slot(["Barbell Curl", "Hammer Curl"], 3, 10, 15),
        ],
      },
      {
        label: "Legs",
        focus: ["Legs", "Glutes"],
        slots: [
          slot(["Back Squat", "Front Squat"], 4, 5, 8),
          slot(["Romanian Deadlift", "Leg Curl"], 3, 8, 12),
          slot(["Leg Press", "Hack Squat"], 3, 10, 15),
          slot(["Hip Thrust", "Glute Bridge"], 3, 8, 12),
          slot(["Calf Raise", "Seated Calf Raise"], 4, 10, 15),
        ],
      },
    ],
    frequencyTargets: [
      { scopeKind: "region", scopeValue: "Chest", perWeek: 2 },
      { scopeKind: "region", scopeValue: "Back", perWeek: 2 },
      { scopeKind: "region", scopeValue: "Shoulders", perWeek: 2 },
      { scopeKind: "region", scopeValue: "Arms", perWeek: 2 },
      { scopeKind: "region", scopeValue: "Legs", perWeek: 2 },
      { scopeKind: "region", scopeValue: "Glutes", perWeek: 2 },
    ],
  },

  // ── Bodyweight / minimal equipment 3× — no barbell required ──────────────────
  {
    id: "bodyweight-minimal",
    name: "Bodyweight 3×/week",
    description:
      "Three full-body sessions using bodyweight and minimal equipment — no barbell. A pull-up bar and something to dip on cover most of it.",
    audience: "beginner",
    cycleWeeks: null,
    days: [
      {
        label: "Bodyweight A",
        focus: ["Legs", "Chest", "Back", "Core"],
        slots: [
          slot(["Bulgarian Split Squat", "Lunge", "Wall Sit"], 3, 8, 15),
          slot(["Dip"], 3, 6, 12),
          slot(["Pull Up", "Chin Up"], 3, 5, 10),
          slot(["Hanging Leg Raise", "Crunch"], 3, 10, 15),
        ],
      },
      {
        label: "Bodyweight B",
        focus: ["Legs", "Glutes", "Back", "Core"],
        slots: [
          slot(["Lunge", "Step Up", "Wall Sit"], 3, 10, 20),
          slot(["Glute Bridge", "Hip Thrust"], 3, 10, 20),
          slot(["Chin Up", "Pull Up"], 3, 5, 10),
          slot(["Ab Wheel Rollout", "Hanging Leg Raise"], 3, 8, 15),
        ],
      },
      {
        label: "Bodyweight C",
        focus: ["Legs", "Chest", "Back", "Core"],
        slots: [
          slot(["Bulgarian Split Squat", "Step Up"], 3, 10, 15),
          slot(["Dip"], 3, 6, 12),
          slot(["Pull Up", "Chin Up"], 3, 5, 10),
          slot(["Crunch", "Cable Crunch"], 3, 12, 20),
        ],
      },
    ],
    frequencyTargets: [
      { scopeKind: "group", scopeValue: "Upper", perWeek: 3 },
      { scopeKind: "group", scopeValue: "Lower", perWeek: 3 },
    ],
  },
];

// Catalog lookup by id (null when not found — a stored template_id whose template was
// removed simply falls back to the copied DB rows, which remain the source of truth).
export function getRoutineTemplate(id: string): RoutineTemplate | undefined {
  return ROUTINE_TEMPLATES.find((t) => t.id === id);
}
