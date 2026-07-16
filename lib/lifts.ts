export type MuscleRegion =
  "Chest" | "Back" | "Shoulders" | "Arms" | "Legs" | "Glutes" | "Core";

/**
 * The fine-grained muscle identity (the identity layer, #482 applied to muscles).
 * Every muscle-keyed surface downstream — per-exercise/session/weekly coverage,
 * the SVG anatomy figure, any future finding `dedupeKey` — keys on `MuscleId`,
 * NEVER on the free-string `LiftDef.muscle` display label. This is the ONE
 * grouping; a hand-rolled second one is the identity-layer disease (#432/#482).
 *
 * The coarse 7-value `MuscleRegion` (used by frequency targets, recommendation
 * focus, and goal scopes) is a pure ROLLUP of this enum via `muscleRegion()`, so
 * everything keyed on regions keeps working unchanged.
 */
export type MuscleId =
  | "chest-upper" // clavicular (upper) pec head, split out from the main pecs
  | "chest" // pecs (sternal/lower head)
  | "lats"
  | "traps"
  | "mid-back" // rhomboids / mid-trap / teres
  | "lower-back" // erector spinae
  | "front-delts"
  | "side-delts"
  | "rear-delts"
  | "biceps"
  | "triceps"
  | "forearms" // incl. brachioradialis / grip
  | "abs"
  | "obliques"
  | "glutes"
  | "quads"
  | "hamstrings"
  | "hip-adductors"
  | "hip-abductors" // glute med/min — abduct the hip; roll up to the Glutes region
  | "calves"
  | "tibialis"
  | "neck";

/**
 * The coarse region each `MuscleId` rolls up into. A `Record` so TypeScript
 * enforces totality over the enum at compile time (every id has a region).
 * `hip-adductors` (inner thigh) → Legs while `hip-abductors` (glute med/min) →
 * Glutes, matching the existing catalog placement of "Hip Adduction" (Legs) vs
 * "Hip Abduction" (Glutes). `neck` has no dedicated region; it rolls into Back
 * (its posterior placement) — no catalog lift tags it, so this only exists to
 * keep the rollup total.
 */
const MUSCLE_REGION: Record<MuscleId, MuscleRegion> = {
  "chest-upper": "Chest",
  chest: "Chest",
  lats: "Back",
  traps: "Back",
  "mid-back": "Back",
  "lower-back": "Back",
  neck: "Back",
  "front-delts": "Shoulders",
  "side-delts": "Shoulders",
  "rear-delts": "Shoulders",
  biceps: "Arms",
  triceps: "Arms",
  forearms: "Arms",
  abs: "Core",
  obliques: "Core",
  glutes: "Glutes",
  quads: "Legs",
  hamstrings: "Legs",
  "hip-adductors": "Legs",
  "hip-abductors": "Glutes",
  calves: "Legs",
  tibialis: "Legs",
};

/** Every `MuscleId`, for exhaustive iteration (e.g. the rollup totality test). */
export const MUSCLE_IDS = Object.keys(MUSCLE_REGION) as MuscleId[];

/** The coarse `MuscleRegion` a fine-grained `MuscleId` rolls up into (total). */
export function muscleRegion(m: MuscleId): MuscleRegion {
  return MUSCLE_REGION[m];
}

/**
 * The human display label for a `MuscleId`. A `Record` so TypeScript enforces
 * totality over the enum (every id has a label). This is a pure display formatter
 * over the identity key — every muscle-keyed surface (the coverage list, the
 * future SVG hover/text list) renders through here, never inventing its own
 * label, so a rename lands in one place.
 */
const MUSCLE_LABEL: Record<MuscleId, string> = {
  "chest-upper": "Upper chest",
  chest: "Chest",
  lats: "Lats",
  traps: "Traps",
  "mid-back": "Mid back",
  "lower-back": "Lower back",
  "front-delts": "Front delts",
  "side-delts": "Side delts",
  "rear-delts": "Rear delts",
  biceps: "Biceps",
  triceps: "Triceps",
  forearms: "Forearms",
  abs: "Abs",
  obliques: "Obliques",
  glutes: "Glutes",
  quads: "Quads",
  hamstrings: "Hamstrings",
  "hip-adductors": "Adductors",
  "hip-abductors": "Abductors",
  calves: "Calves",
  tibialis: "Tibialis",
  neck: "Neck",
};

/** The human display label for a `MuscleId` (total over the enum). */
export function muscleLabel(m: MuscleId): string {
  return MUSCLE_LABEL[m];
}

// Movement pattern, used to suggest "Push day" / "Pull day" / "Leg day".
export type MovementPattern = "push" | "pull" | "legs" | "core";

export interface LiftDef {
  name: string;
  muscle: string; // human display label, e.g. "Side delts" (NOT an identity key)
  region: MuscleRegion;
  pattern: MovementPattern;
  // Fine-grained muscle identity (#482). `primaryMuscles` are the prime movers
  // (≥1, and every one rolls up via muscleRegion into `region`); secondary are
  // meaningful assistors. Downstream coverage/anatomy key on these MuscleIds,
  // never on the `muscle` display string.
  primaryMuscles: MuscleId[];
  secondaryMuscles: MuscleId[];
  // Trained one side at a time, so left/right can carry different load/reps.
  // Enables the "Track sides separately" toggle in the activity form.
  unilateral?: boolean;
  // An isometric hold measured by time, not reps (planks, dead hangs). The set
  // input captures a duration instead of reps.
  timed?: boolean;
  // The body itself is the load (pull ups, chin ups, dips). Any logged weight is
  // ADDED to bodyweight; with no logged weight the load is just bodyweight. Used
  // to fold the user's bodyweight into volume / strength stats.
  bodyweight?: boolean;
}

// Equipment a variant lift can be done with. Stored variant names are
// "<Equipment> <Base>", e.g. "Dumbbell Curl".
export type Equipment = "Barbell" | "Dumbbell" | "Cable" | "Machine";

// A base lift that can be performed with different equipment. Each (equipment,
// base) pair expands into a concrete lift named "<Equipment> <Base>" so it is
// tracked as its own exercise (separate 1RM/history) while the picker groups
// them under the base.
export interface VariantGroup {
  name: string; // base lift name, e.g. "Curl"
  muscle: string;
  region: MuscleRegion;
  pattern: MovementPattern;
  // Shared by the base lift and every composed equipment variant (see
  // VARIANT_DEFS). Same identity semantics as LiftDef's fields.
  primaryMuscles: MuscleId[];
  secondaryMuscles: MuscleId[];
  equipment: Equipment[];
  // Equipment for which the variant is trained one side at a time.
  unilateralEquipment?: Equipment[];
}

const VARIANT_GROUPS: VariantGroup[] = [
  {
    name: "Curl",
    muscle: "Biceps",
    region: "Arms",
    pattern: "pull",
    primaryMuscles: ["biceps"],
    secondaryMuscles: ["forearms"],
    equipment: ["Barbell", "Dumbbell", "Cable", "Machine"],
    unilateralEquipment: ["Dumbbell", "Cable"],
  },
  {
    name: "Row",
    muscle: "Mid back",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["mid-back"],
    secondaryMuscles: ["lats", "biceps", "rear-delts"],
    equipment: ["Barbell", "Dumbbell", "Cable", "Machine"],
    unilateralEquipment: ["Dumbbell", "Cable"],
  },
  {
    // Barbell and dumbbell are both pressed with two hands, so no unilateral.
    name: "Bench Press",
    muscle: "Chest",
    region: "Chest",
    pattern: "push",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["front-delts", "triceps"],
    equipment: ["Barbell", "Dumbbell"],
  },
  {
    name: "Overhead Press",
    muscle: "Front delts",
    region: "Shoulders",
    pattern: "push",
    primaryMuscles: ["front-delts"],
    secondaryMuscles: ["side-delts", "triceps"],
    equipment: ["Barbell", "Dumbbell"],
    unilateralEquipment: ["Dumbbell"],
  },
  {
    // No barbell — lateral raises are loaded with dumbbells, a cable, or a
    // machine. Dumbbell and (single-arm) cable can be tracked per side.
    name: "Lateral Raise",
    muscle: "Side delts",
    region: "Shoulders",
    pattern: "push",
    primaryMuscles: ["side-delts"],
    secondaryMuscles: [],
    equipment: ["Dumbbell", "Cable", "Machine"],
    unilateralEquipment: ["Dumbbell", "Cable"],
  },
  {
    name: "Rear Delt Fly",
    muscle: "Rear delts",
    region: "Shoulders",
    pattern: "pull",
    primaryMuscles: ["rear-delts"],
    secondaryMuscles: ["traps", "mid-back"],
    // Bent-over with dumbbells, or one arm at a time on a cable.
    equipment: ["Dumbbell", "Cable"],
    unilateralEquipment: ["Dumbbell", "Cable"],
  },
];

// Stand-alone lifts (no equipment variants). Variant lifts — barbell/dumbbell/
// cable/machine curls and rows — are generated from VARIANT_GROUPS below, so
// "Barbell Row"/"Dumbbell Row" etc. are not listed here.
const PLAIN_DEFS: LiftDef[] = [
  {
    name: "Back Squat",
    muscle: "Quads",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes", "hamstrings", "lower-back"],
  },
  {
    name: "Front Squat",
    muscle: "Quads",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes", "abs"],
  },
  {
    name: "Incline Bench Press",
    muscle: "Upper chest",
    region: "Chest",
    pattern: "push",
    primaryMuscles: ["chest-upper"],
    secondaryMuscles: ["front-delts", "triceps"],
  },
  {
    name: "Push Press",
    muscle: "Front delts",
    region: "Shoulders",
    pattern: "push",
    primaryMuscles: ["front-delts"],
    secondaryMuscles: ["side-delts", "triceps"],
  },
  {
    // Filed under Back region; the erectors (lower-back) are the region-consistent
    // prime mover, glutes/hamstrings/quads assist (they roll to other regions).
    name: "Deadlift",
    muscle: "Posterior chain",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["lower-back"],
    secondaryMuscles: ["glutes", "hamstrings", "traps", "quads", "forearms"],
  },
  {
    name: "Romanian Deadlift",
    muscle: "Hamstrings",
    region: "Legs",
    pattern: "pull",
    primaryMuscles: ["hamstrings"],
    secondaryMuscles: ["glutes", "lower-back"],
  },
  {
    name: "Sumo Deadlift",
    muscle: "Posterior chain",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["lower-back"],
    secondaryMuscles: ["glutes", "quads", "hamstrings", "traps", "forearms"],
  },
  {
    name: "Pendlay Row",
    muscle: "Mid back",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["mid-back"],
    secondaryMuscles: ["lats", "biceps", "rear-delts"],
  },
  {
    name: "Pull Up",
    muscle: "Lats",
    region: "Back",
    pattern: "pull",
    bodyweight: true,
    primaryMuscles: ["lats"],
    secondaryMuscles: ["biceps", "mid-back", "forearms"],
  },
  {
    name: "Chin Up",
    muscle: "Lats & biceps",
    region: "Back",
    pattern: "pull",
    bodyweight: true,
    primaryMuscles: ["lats"],
    secondaryMuscles: ["biceps", "forearms"],
  },
  {
    name: "Lat Pulldown",
    muscle: "Lats",
    region: "Back",
    pattern: "pull",
    unilateral: true,
    primaryMuscles: ["lats"],
    secondaryMuscles: ["biceps", "mid-back"],
  },
  {
    name: "Hammer Curl",
    muscle: "Biceps & brachialis",
    region: "Arms",
    pattern: "pull",
    unilateral: true,
    primaryMuscles: ["biceps", "forearms"],
    secondaryMuscles: [],
  },
  {
    name: "Tricep Extension",
    muscle: "Triceps",
    region: "Arms",
    pattern: "push",
    primaryMuscles: ["triceps"],
    secondaryMuscles: [],
  },
  {
    name: "Tricep Pushdown",
    muscle: "Triceps",
    region: "Arms",
    pattern: "push",
    primaryMuscles: ["triceps"],
    secondaryMuscles: [],
  },
  {
    name: "Leg Press",
    muscle: "Quads",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes", "hamstrings"],
  },
  {
    name: "Leg Curl",
    muscle: "Hamstrings",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["hamstrings"],
    secondaryMuscles: [],
  },
  {
    name: "Leg Extension",
    muscle: "Quads",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["quads"],
    secondaryMuscles: [],
  },
  {
    name: "Calf Raise",
    muscle: "Calves",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["calves"],
    secondaryMuscles: [],
  },
  {
    name: "Hip Thrust",
    muscle: "Glutes",
    region: "Glutes",
    pattern: "legs",
    primaryMuscles: ["glutes"],
    secondaryMuscles: ["hamstrings"],
  },
  {
    name: "Lunge",
    muscle: "Quads & glutes",
    region: "Legs",
    pattern: "legs",
    unilateral: true,
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes", "hamstrings"],
  },
  {
    name: "Bulgarian Split Squat",
    muscle: "Quads & glutes",
    region: "Legs",
    pattern: "legs",
    unilateral: true,
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes", "hamstrings"],
  },
  {
    name: "Dip",
    muscle: "Chest & triceps",
    region: "Chest",
    pattern: "push",
    bodyweight: true,
    primaryMuscles: ["chest"],
    secondaryMuscles: ["triceps", "front-delts"],
  },
  {
    // The most common bodyweight push. Bodyweight-loaded like the Dip (any logged
    // weight — vest/plate — is ADDED to bodyweight). The core (abs) braces as an
    // anti-extension stabilizer; the issue's "core" maps to the `abs` MuscleId.
    name: "Push Up",
    muscle: "Chest & triceps",
    region: "Chest",
    pattern: "push",
    bodyweight: true,
    primaryMuscles: ["chest"],
    secondaryMuscles: ["triceps", "front-delts", "abs"],
  },
  {
    name: "Face Pull",
    muscle: "Rear delts",
    region: "Shoulders",
    pattern: "pull",
    primaryMuscles: ["rear-delts"],
    secondaryMuscles: ["traps", "mid-back"],
  },
  {
    name: "Cable Fly",
    muscle: "Chest",
    region: "Chest",
    pattern: "push",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["front-delts"],
  },
  {
    name: "Shrug",
    muscle: "Traps",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["traps"],
    secondaryMuscles: ["forearms"],
  },
  // Chest
  {
    name: "Decline Bench Press",
    muscle: "Lower chest",
    region: "Chest",
    pattern: "push",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["triceps", "front-delts"],
  },
  {
    // Filed under Chest region; keeps its "Triceps" display label, but the
    // region-consistent prime mover is the chest (triceps assist).
    name: "Close-Grip Bench Press",
    muscle: "Triceps",
    region: "Chest",
    pattern: "push",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["triceps", "front-delts"],
  },
  {
    name: "Pec Deck",
    muscle: "Chest",
    region: "Chest",
    pattern: "push",
    primaryMuscles: ["chest"],
    secondaryMuscles: ["front-delts"],
  },
  // Shoulders
  {
    name: "Arnold Press",
    muscle: "Front delts",
    region: "Shoulders",
    pattern: "push",
    primaryMuscles: ["front-delts"],
    secondaryMuscles: ["side-delts", "triceps"],
  },
  {
    name: "Upright Row",
    muscle: "Side delts",
    region: "Shoulders",
    pattern: "pull",
    primaryMuscles: ["side-delts"],
    secondaryMuscles: ["traps", "front-delts"],
  },
  // Back
  {
    name: "T-Bar Row",
    muscle: "Mid back",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["mid-back"],
    secondaryMuscles: ["lats", "biceps", "rear-delts"],
  },
  {
    name: "Straight-Arm Pulldown",
    muscle: "Lats",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["lats"],
    secondaryMuscles: [],
  },
  {
    name: "Trap Bar Deadlift",
    muscle: "Posterior chain",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["lower-back"],
    secondaryMuscles: ["quads", "glutes", "hamstrings", "traps", "forearms"],
  },
  {
    name: "Back Extension",
    muscle: "Lower back",
    region: "Back",
    pattern: "pull",
    bodyweight: true,
    primaryMuscles: ["lower-back"],
    secondaryMuscles: ["glutes", "hamstrings"],
  },
  {
    // Filed under Back region; grip (forearms) is a secondary since it rolls to
    // the Arms region — the traps hold the load and are region-consistent.
    name: "Farmers Carry",
    muscle: "Grip & traps",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["traps"],
    secondaryMuscles: ["forearms"],
  },
  // Arms
  {
    name: "Preacher Curl",
    muscle: "Biceps",
    region: "Arms",
    pattern: "pull",
    unilateral: true,
    primaryMuscles: ["biceps"],
    secondaryMuscles: ["forearms"],
  },
  {
    name: "Concentration Curl",
    muscle: "Biceps",
    region: "Arms",
    pattern: "pull",
    unilateral: true,
    primaryMuscles: ["biceps"],
    secondaryMuscles: [],
  },
  {
    name: "Skullcrusher",
    muscle: "Triceps",
    region: "Arms",
    pattern: "push",
    primaryMuscles: ["triceps"],
    secondaryMuscles: [],
  },
  {
    name: "Reverse Curl",
    muscle: "Forearms",
    region: "Arms",
    pattern: "pull",
    unilateral: true,
    primaryMuscles: ["forearms"],
    secondaryMuscles: ["biceps"],
  },
  {
    name: "Wrist Curl",
    muscle: "Forearms",
    region: "Arms",
    pattern: "pull",
    primaryMuscles: ["forearms"],
    secondaryMuscles: [],
  },
  // Legs
  {
    name: "Goblet Squat",
    muscle: "Quads",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes"],
  },
  {
    name: "Hack Squat",
    muscle: "Quads",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes"],
  },
  {
    name: "Good Morning",
    muscle: "Hamstrings",
    region: "Legs",
    pattern: "pull",
    primaryMuscles: ["hamstrings"],
    secondaryMuscles: ["glutes", "lower-back"],
  },
  {
    name: "Nordic Curl",
    muscle: "Hamstrings",
    region: "Legs",
    pattern: "legs",
    bodyweight: true,
    primaryMuscles: ["hamstrings"],
    secondaryMuscles: ["glutes"],
  },
  {
    name: "Glute Ham Raise",
    muscle: "Hamstrings & glutes",
    region: "Legs",
    pattern: "legs",
    bodyweight: true,
    primaryMuscles: ["hamstrings"],
    secondaryMuscles: ["glutes"],
  },
  {
    name: "Step Up",
    muscle: "Quads & glutes",
    region: "Legs",
    pattern: "legs",
    unilateral: true,
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes", "hamstrings"],
  },
  {
    name: "Seated Calf Raise",
    muscle: "Calves",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["calves"],
    secondaryMuscles: [],
  },
  {
    name: "Hip Adduction",
    muscle: "Adductors",
    region: "Legs",
    pattern: "legs",
    primaryMuscles: ["hip-adductors"],
    secondaryMuscles: [],
  },
  // Glutes
  {
    name: "Hip Abduction",
    muscle: "Abductors",
    region: "Glutes",
    pattern: "legs",
    primaryMuscles: ["hip-abductors"],
    secondaryMuscles: ["glutes"],
  },
  {
    name: "Glute Bridge",
    muscle: "Glutes",
    region: "Glutes",
    pattern: "legs",
    bodyweight: true,
    primaryMuscles: ["glutes"],
    secondaryMuscles: ["hamstrings"],
  },
  {
    name: "Cable Kickback",
    muscle: "Glutes",
    region: "Glutes",
    pattern: "legs",
    unilateral: true,
    primaryMuscles: ["glutes"],
    secondaryMuscles: ["hamstrings"],
  },
  // Core
  {
    name: "Hanging Leg Raise",
    muscle: "Core",
    region: "Core",
    pattern: "core",
    bodyweight: true,
    primaryMuscles: ["abs"],
    secondaryMuscles: ["obliques"],
  },
  {
    name: "Cable Crunch",
    muscle: "Core",
    region: "Core",
    pattern: "core",
    primaryMuscles: ["abs"],
    secondaryMuscles: [],
  },
  {
    name: "Crunch",
    muscle: "Core",
    region: "Core",
    pattern: "core",
    bodyweight: true,
    primaryMuscles: ["abs"],
    secondaryMuscles: [],
  },
  {
    name: "Russian Twist",
    muscle: "Obliques",
    region: "Core",
    pattern: "core",
    bodyweight: true,
    primaryMuscles: ["obliques"],
    secondaryMuscles: ["abs"],
  },
  {
    name: "Ab Wheel Rollout",
    muscle: "Core",
    region: "Core",
    pattern: "core",
    bodyweight: true,
    primaryMuscles: ["abs"],
    secondaryMuscles: ["obliques"],
  },
  {
    name: "Side Plank",
    muscle: "Obliques",
    region: "Core",
    pattern: "core",
    unilateral: true,
    timed: true,
    primaryMuscles: ["obliques"],
    secondaryMuscles: ["abs"],
  },
  // Olympic
  {
    // "Full body" explosive pull, filed under Back; the traps (shrug/upper-back
    // pull) are the region-consistent prime mover, the rest assist.
    name: "Power Clean",
    muscle: "Full body",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["traps"],
    secondaryMuscles: [
      "lower-back",
      "glutes",
      "hamstrings",
      "quads",
      "front-delts",
    ],
  },
  {
    name: "Hang Clean",
    muscle: "Full body",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["traps"],
    secondaryMuscles: [
      "lower-back",
      "glutes",
      "hamstrings",
      "quads",
      "front-delts",
    ],
  },
  {
    name: "Snatch",
    muscle: "Full body",
    region: "Back",
    pattern: "pull",
    primaryMuscles: ["traps"],
    secondaryMuscles: [
      "lower-back",
      "glutes",
      "hamstrings",
      "quads",
      "side-delts",
      "front-delts",
    ],
  },
  {
    name: "Plank",
    muscle: "Core",
    region: "Core",
    pattern: "core",
    timed: true,
    primaryMuscles: ["abs"],
    secondaryMuscles: ["obliques"],
  },
  {
    name: "Hollow Hold",
    muscle: "Core",
    region: "Core",
    pattern: "core",
    timed: true,
    primaryMuscles: ["abs"],
    secondaryMuscles: [],
  },
  {
    name: "L-Sit",
    muscle: "Core",
    region: "Core",
    pattern: "core",
    timed: true,
    primaryMuscles: ["abs"],
    secondaryMuscles: [],
  },
  {
    name: "Wall Sit",
    muscle: "Quads",
    region: "Legs",
    pattern: "legs",
    timed: true,
    primaryMuscles: ["quads"],
    secondaryMuscles: ["glutes"],
  },
  {
    // Isometric hang, filed under Back; grip (forearms) rolls to Arms so it's a
    // secondary — the lats/scapular retractors are the region-consistent primary.
    name: "Dead Hang",
    muscle: "Grip & forearms",
    region: "Back",
    pattern: "pull",
    timed: true,
    primaryMuscles: ["lats"],
    secondaryMuscles: ["forearms", "traps"],
  },
];

/** Compose the stored exercise name for a variant, e.g. ("Curl","Dumbbell") -> "Dumbbell Curl". */
export function composeVariant(
  group: VariantGroup,
  equipment: Equipment
): string {
  return `${equipment} ${group.name}`;
}

// Expand each variant group into a bare base lift plus one concrete lift per
// equipment, so muscle/region/unilateral resolve for every stored variant name.
const VARIANT_DEFS: LiftDef[] = VARIANT_GROUPS.flatMap((g) => [
  {
    name: g.name,
    muscle: g.muscle,
    region: g.region,
    pattern: g.pattern,
    primaryMuscles: g.primaryMuscles,
    secondaryMuscles: g.secondaryMuscles,
  },
  ...g.equipment.map((eq) => ({
    name: composeVariant(g, eq),
    muscle: g.muscle,
    region: g.region,
    pattern: g.pattern,
    primaryMuscles: g.primaryMuscles,
    secondaryMuscles: g.secondaryMuscles,
    unilateral: g.unilateralEquipment?.includes(eq) || undefined,
  })),
]);

const DEFS: LiftDef[] = [...PLAIN_DEFS, ...VARIANT_DEFS];

// Picker options: stand-alone lifts plus the base name of each variant group
// (the concrete variants are reached via equipment chips, not listed here).
export const LIFT_OPTIONS = [
  ...PLAIN_DEFS.map((d) => d.name),
  ...VARIANT_GROUPS.map((g) => g.name),
];

// Every concrete catalog name, including the composed equipment variants
// ("Dumbbell Curl", "Cable Row", …). Used as extraction vocabulary so an
// importer can map a recognized variant to its exact name.
export const ALL_LIFT_NAMES = DEFS.map((d) => d.name);

const MAP = new Map(DEFS.map((d) => [d.name.toLowerCase(), d]));

// Lookups for variant resolution: composed name -> {group, equipment}, and
// base name -> group.
const COMPOSED = new Map<
  string,
  { group: VariantGroup; equipment: Equipment }
>();
const BASES = new Map<string, VariantGroup>();
for (const g of VARIANT_GROUPS) {
  BASES.set(g.name.toLowerCase(), g);
  for (const eq of g.equipment) {
    COMPOSED.set(composeVariant(g, eq).toLowerCase(), {
      group: g,
      equipment: eq,
    });
  }
}

/**
 * Resolve a lift name to its variant group and chosen equipment:
 *  - a composed name ("Dumbbell Curl") -> { group, equipment: "Dumbbell" }
 *  - a bare base ("Curl")              -> { group, equipment: null }
 *  - anything else                      -> null
 */
export function variantOf(
  name: string
): { group: VariantGroup; equipment: Equipment | null } | null {
  const key = name.trim().toLowerCase();
  const composed = COMPOSED.get(key);
  if (composed) return { group: composed.group, equipment: composed.equipment };
  const base = BASES.get(key);
  if (base) return { group: base, equipment: null };
  return null;
}

/** Collapse a composed variant name to its base ("Dumbbell Curl" -> "Curl"); other names pass through. */
export function baseLiftName(name: string): string {
  return COMPOSED.get(name.trim().toLowerCase())?.group.name ?? name;
}

/**
 * The canonical aggregation key for a logged exercise's history — the key under
 * which its sessions, PRs, session counts, and next-set progression seed
 * accumulate. Collapses a composed equipment variant onto its base
 * ("Barbell Curl"/"Dumbbell Curl"/"Curl" → "curl") then trims/lowercases, so a
 * variant and its bare base are ONE history rather than two: renaming
 * "Barbell Curl" → "Curl" (or logging a lift under two variant spellings) no
 * longer silently splits its progression history into independent tracks that
 * each reset PRs and the seed to whichever exact name was logged last (#331).
 * The names-recycle half of the row-ops convention: `exercise` is a name-keyed
 * join across sets, so it must be re-keyed to a canonical form at aggregation.
 *
 * A truly custom lift (not in the catalog) keeps its own trimmed/lowercased key,
 * so distinct customs stay distinct. EVERY strength history builder keys through
 * this ONE function — getStrengthByExercise (detail panel / coaching / Telegram),
 * getExerciseBodyweightMap (the shared bodyweight-KIND classifier),
 * getRecentExerciseHistory / getRecentByExercise (the editor chip), and
 * getExerciseComparison — so all surfaces see one merged history and can't
 * disagree. Consumers that look a lift up in one of those maps (the detail panel
 * join, the editor's typed-name lookup) must derive their key through this too.
 *
 * Note: because a bare base ("Curl") is equipment-ambiguous, collapsing to the
 * base necessarily also folds the catalog's separate equipment variants
 * ("Barbell Curl" and "Dumbbell Curl") into one history. That is the intended
 * merge here (a single progression track per base lift); goal CREDIT keeps its
 * finer, asymmetric variant matching separately in goalMatchesExercise.
 */
export function exerciseHistoryKey(name: string): string {
  return baseLiftName(name).trim().toLowerCase();
}

/**
 * The finite set of logged names that all collapse to `exerciseHistoryKey(name)`
 * — the canonical key's preimage, lowercased/trimmed. For a catalog variant group
 * this is the bare base plus every composed equipment variant ("Curl",
 * "Barbell Curl", "Dumbbell Curl", "Cable Curl", "Machine Curl" → all key "curl");
 * for a plain catalog lift or a non-catalog custom lift it is just the one name.
 *
 * A scan that needs every set of a merged history can push this into SQL —
 * `WHERE LOWER(TRIM(s.exercise)) IN (...)` — since SQLite can't call baseLiftName,
 * recovering a bounded, index-friendly scan with semantics identical to filtering
 * every profile row by exerciseHistoryKey in JS (#394).
 */
export function exerciseHistoryNames(name: string): string[] {
  const v = variantOf(name);
  if (!v) return [name.trim().toLowerCase()];
  const g = v.group;
  return [g.name, ...g.equipment.map((eq) => composeVariant(g, eq))].map((n) =>
    n.trim().toLowerCase()
  );
}

/** Look up a lift by name (case-insensitive, with a loose contains fallback). */
export function liftInfo(name: string): LiftDef | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  const exact = MAP.get(key);
  if (exact) return exact;
  for (const d of DEFS) {
    const dn = d.name.toLowerCase();
    if (key.includes(dn) || dn.includes(key)) return d;
  }
  return undefined;
}

export function muscleFor(name: string): string | null {
  return liftInfo(name)?.muscle ?? null;
}

/** Whether a lift is trained one side at a time (offers per-side tracking). */
export function isUnilateral(name: string): boolean {
  return liftInfo(name)?.unilateral === true;
}

/** Whether a lift is an isometric hold measured by time instead of reps. */
export function isTimed(name: string): boolean {
  return liftInfo(name)?.timed === true;
}

/** Whether a lift is loaded by the body itself (logged weight is ADDED to it). */
export function isBodyweight(name: string): boolean {
  return liftInfo(name)?.bodyweight === true;
}

/**
 * Resolve whether an exercise's own bodyweight is (part of) the load — the single
 * definition of the suggestion KIND shared by every strength builder
 * (getStrengthByExercise for the detail panel/coaching/Telegram, and the editor's
 * getRecentExerciseHistory seed). True for a catalog bodyweight lift, or for any
 * exercise never logged with an external weight.
 *
 * `sawExternalWeight` MUST be computed over the same window in every caller —
 * resolve it over ALL history, never a recent slice — so one dataset yields one
 * suggestion kind on every surface. An exercise last loaded with external weight
 * >12 months ago and bodyweight-only since (weighted dips → bodyweight dips) must
 * classify identically whether the classifier looks at the last year or all time
 * (#331). One question, one computation.
 */
export function resolveBodyweightKind(
  name: string,
  sawExternalWeight: boolean
): boolean {
  return isBodyweight(name) || !sawExternalWeight;
}

/** One exercise's classification input: its logged name and whether the row (or
 * an already-OR'd group of rows) carried an external weight. */
export interface BodyweightClassifyRow {
  exercise: string;
  hasExternalWeight: boolean;
}

/**
 * Fold a set of (possibly per-row) classification inputs into a
 * canonical-key → resolved-bodyweight-kind map, OR-ing hasExternalWeight across
 * every row that shares a key. The pure core both strength builders route through
 * so their bodyweight KIND agrees by construction over the same all-history rows
 * (#331). Keyed by exerciseHistoryKey — variant-collapsed — exactly like the
 * builders, so a variant and its base classify as ONE lift here too.
 */
export function classifyBodyweightByExercise(
  rows: BodyweightClassifyRow[]
): Map<string, boolean> {
  const saw = new Map<string, { name: string; sawExternalWeight: boolean }>();
  for (const r of rows) {
    const key = exerciseHistoryKey(r.exercise);
    const cur = saw.get(key);
    if (!cur)
      saw.set(key, {
        // Resolve the KIND off the canonical base name so isBodyweight sees the
        // catalog lift, not an arbitrary first-seen variant spelling.
        name: baseLiftName(r.exercise),
        sawExternalWeight: r.hasExternalWeight,
      });
    else if (r.hasExternalWeight) cur.sawExternalWeight = true;
  }
  const out = new Map<string, boolean>();
  for (const [key, v] of saw)
    out.set(key, resolveBodyweightKind(v.name, v.sawExternalWeight));
  return out;
}

// Plain (non-variant) lifts performed on a plate-loaded barbell. Variant lifts
// (Curl/Row/Bench Press/Overhead Press) are detected via their "Barbell" chip.
const BARBELL_LIFTS = new Set(
  [
    "Back Squat",
    "Front Squat",
    "Incline Bench Press",
    "Decline Bench Press",
    "Close-Grip Bench Press",
    "Push Press",
    "Deadlift",
    "Romanian Deadlift",
    "Sumo Deadlift",
    "Trap Bar Deadlift",
    "Pendlay Row",
    "T-Bar Row",
    "Good Morning",
    "Hip Thrust",
    "Shrug",
    "Upright Row",
    "Power Clean",
    "Hang Clean",
    "Snatch",
  ].map((n) => n.toLowerCase())
);

/** Whether a lift is loaded on a plate barbell (so the plate builder applies). */
export function isBarbellLift(name: string): boolean {
  if (variantOf(name)?.equipment === "Barbell") return true;
  const info = liftInfo(name);
  return info ? BARBELL_LIFTS.has(info.name.toLowerCase()) : false;
}

// Default implement for plain (non-variant) lifts that aren't barbell/bodyweight,
// so the UI can show what they're normally performed with. Best-effort defaults.
const set = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()));
const MACHINE_LIFTS = set(
  "Leg Press",
  "Leg Curl",
  "Leg Extension",
  "Calf Raise",
  "Seated Calf Raise",
  "Pec Deck",
  "Hack Squat",
  "Hip Adduction",
  "Hip Abduction"
);
const CABLE_LIFTS = set(
  "Lat Pulldown",
  "Tricep Pushdown",
  "Face Pull",
  "Cable Fly",
  "Straight-Arm Pulldown",
  "Cable Kickback",
  "Cable Crunch",
  "Tricep Extension"
);
const DUMBBELL_LIFTS = set(
  "Hammer Curl",
  "Arnold Press",
  "Concentration Curl",
  "Lunge",
  "Bulgarian Split Squat",
  "Step Up",
  "Goblet Squat",
  "Farmers Carry",
  "Preacher Curl",
  "Reverse Curl",
  "Wrist Curl",
  "Skullcrusher"
);
// Rep-based bodyweight lifts (Crunch, Nordic Curl, …) carry `bodyweight: true`
// on their LiftDef instead, so defaultEquipment resolves them via isBodyweight
// above. This set only needs the timed holds, which are flagged `timed` rather
// than `bodyweight`.
const BODYWEIGHT_LIFTS = set(
  "Plank",
  "Hollow Hold",
  "L-Sit",
  "Wall Sit",
  "Dead Hang",
  "Side Plank"
);

/**
 * The implement a lift is normally performed with ("Barbell"/"Dumbbell"/"Cable"/
 * "Machine"/"Bodyweight"), or null when unknown or when the lift already offers a
 * selectable equipment variant. Informational — the actual load is what's logged.
 */
export function defaultEquipment(name: string): string | null {
  if (isBodyweight(name)) return "Bodyweight";
  if (isBarbellLift(name)) return "Barbell";
  const info = liftInfo(name);
  if (!info) return null;
  const k = info.name.toLowerCase();
  if (MACHINE_LIFTS.has(k)) return "Machine";
  if (CABLE_LIFTS.has(k)) return "Cable";
  if (DUMBBELL_LIFTS.has(k)) return "Dumbbell";
  if (BODYWEIGHT_LIFTS.has(k)) return "Bodyweight";
  return null;
}

/** The muscle region a logged exercise trains, or null if unknown. */
export function regionForExercise(name: string): MuscleRegion | null {
  return liftInfo(name)?.region ?? null;
}

// Coarse body groups for weekly frequency targets.
export type BodyGroup = "Upper" | "Lower" | "Core" | "Full";

const GROUP_REGIONS: Record<BodyGroup, MuscleRegion[]> = {
  Upper: ["Chest", "Back", "Shoulders", "Arms"],
  Lower: ["Legs", "Glutes"],
  Core: ["Core"],
  Full: ["Chest", "Back", "Shoulders", "Arms", "Legs", "Glutes", "Core"],
};

/** The muscle regions covered by a body group. */
export function regionsForGroup(group: BodyGroup): MuscleRegion[] {
  return GROUP_REGIONS[group] ?? [];
}

// Selectable scope values for the frequency-target UI / validation.
export const REGION_SCOPES: MuscleRegion[] = [
  "Chest",
  "Back",
  "Shoulders",
  "Arms",
  "Legs",
  "Glutes",
  "Core",
];
export const GROUP_SCOPES: BodyGroup[] = ["Upper", "Lower", "Core", "Full"];
export const TYPE_SCOPES = ["strength", "cardio", "sport"] as const;

const PATTERN_TITLES: Record<MovementPattern, string> = {
  push: "Push day",
  pull: "Pull day",
  legs: "Leg day",
  core: "Core day",
};

/**
 * Suggest a workout title from the exercises performed:
 * - all one body region  -> "Chest workout"
 * - all one movement      -> "Push day" / "Pull day" / "Leg day"
 * - a region dominates     -> "{Region} workout"
 * - otherwise              -> "Full body workout"
 */
export function suggestTitle(exerciseNames: string[]): string {
  const infos = exerciseNames
    .map((n) => liftInfo(n))
    .filter((i): i is LiftDef => !!i);
  if (infos.length === 0) return "Strength session";

  const regions = new Set(infos.map((i) => i.region));
  if (regions.size === 1) return `${[...regions][0]} workout`;

  const patterns = new Set(infos.map((i) => i.pattern));
  if (patterns.size === 1) return PATTERN_TITLES[[...patterns][0]];

  const counts = new Map<MuscleRegion, number>();
  for (const i of infos) counts.set(i.region, (counts.get(i.region) ?? 0) + 1);
  const [topRegion, topCount] = [...counts.entries()].sort(
    (a, b) => b[1] - a[1]
  )[0];
  if (topCount / infos.length >= 0.6) return `${topRegion} workout`;

  return "Full body workout";
}
