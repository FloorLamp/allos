// Pre-generate the curated mobility-move catalog (lib/datasets/data/mobility-moves.json)
// that the mobility log (issue #840) taps against — the HABIT-tier movement domain.
// ~26 curated moves (hip flexor stretch, pigeon, couch stretch, shoulder CARs, thoracic
// rotations, ankle rocks, …) rather than a rep/load-tracked exercise: mobility is the
// food log of movement — regularity is the signal, load/progression mostly isn't, so a
// move is one TAP, never a set × weight (the false-precision trap /nutrition refuses).
//
// Mirrors the gen-food-groups.ts committed-and-human-reviewable convention: the JSON is
// COMMITTED, the values are curated movement facts, no API key needed —
//
//   npm run gen:mobility-moves
//
// Deliberately OUTSIDE lib/lifts.ts (the strength/cardio catalog) so a mobility move
// never carries 1RM/volume semantics and never pollutes strength stats (#840 point 1).
//
// Each move carries a STABLE slug (the #203 discipline: a rename is display-only, the
// slug never changes — an activity `components` entry and any coverage/target keyed on it
// depend on it), a display name, a `kind` (`hold` — a static stretch held for time;
// `reps` — a dynamic move cycled for reps), the `muscles` it mobilizes (the #735 MuscleId
// vocabulary, so the mobility coverage strip rolls up to MuscleRegion through the SAME
// muscleRegion() machinery strength coverage uses — kept a SEPARATE view, never merged,
// per #482), a serving-text-style `description` (how to perform one round), and an
// optional `guide` hook reserved for the #733 guide content.
//
// Anti-drift: the committed JSON is a FIXED POINT of buildMobilityMoves(), and every
// slug / muscle tag is pinned by lib/__tests__/mobility-moves-dataset.test.ts (every
// slug resolves muscles + kind + description; every muscle is a real MuscleId).

import fs from "node:fs";
import path from "node:path";
import { DATASET_SCHEMA, type DatasetEnvelope } from "../lib/datasets/types";
import type { MuscleId } from "../lib/lifts";

const OUT = path.join(
  process.cwd(),
  "lib",
  "datasets",
  "data",
  "mobility-moves.json"
);

// hold — a static stretch held for time; reps — a dynamic move cycled for reps.
export type MobilityMoveKind = "hold" | "reps";

export interface MobilityMove {
  // Stable slug — an activity `components[].name` for a recovery session. NEVER changes
  // once shipped (renames are display only). Lowercase snake_case.
  slug: string;
  // Display name for the tap button / coverage label.
  name: string;
  kind: MobilityMoveKind;
  // The #735 MuscleId(s) this move mobilizes. At least one. The mobility coverage strip
  // rolls these up to MuscleRegion (muscleRegion) — the reuse the issue calls for,
  // kept a separate view from strength coverage (#482: trained ≠ mobilized).
  muscles: MuscleId[];
  // What one round looks like — the one-tap unit (serving-text style).
  description: string;
  // Reserved hook for the #733 exercise-guide content (a guide slug). Omitted until
  // guide content is authored.
  guide?: string;
}

// Curated mobility-move catalog. Ordered loosely head-to-toe. Public, general-movement
// moves — INFORMATIONAL mobility guidance, not a PT/rehab prescription (#840 non-goal).
const MOVES: MobilityMove[] = [
  // ── Neck / shoulders / upper back ────────────────────────────────────────
  {
    slug: "neck_cars",
    name: "Neck CARs",
    kind: "reps",
    muscles: ["neck"],
    description:
      "5 slow controlled neck circles each direction, chin tracing the widest pain-free path",
  },
  {
    slug: "shoulder_cars",
    name: "Shoulder CARs",
    kind: "reps",
    muscles: ["front-delts", "side-delts", "rear-delts"],
    description:
      "5 slow controlled shoulder circles each side, drawing the biggest circle you own",
  },
  {
    slug: "shoulder_dislocates",
    name: "Shoulder dislocates",
    kind: "reps",
    muscles: ["front-delts", "rear-delts"],
    description:
      "10 passes taking a band or dowel from front to back overhead with straight arms",
  },
  {
    slug: "wall_slides",
    name: "Wall slides",
    kind: "reps",
    muscles: ["front-delts", "mid-back", "traps"],
    description:
      "10 reps sliding arms up and down a wall, keeping wrists and elbows in contact",
  },
  {
    slug: "thread_the_needle",
    name: "Thread the needle",
    kind: "reps",
    muscles: ["mid-back", "rear-delts"],
    description:
      "8 reps per side on all fours, threading one arm under the body and reaching through",
  },
  {
    slug: "thoracic_rotation",
    name: "Thoracic rotation",
    kind: "reps",
    muscles: ["mid-back", "obliques"],
    description:
      "8 open-book rotations per side, following the top hand with your eyes",
  },
  {
    slug: "cat_cow",
    name: "Cat-cow",
    kind: "reps",
    muscles: ["lower-back", "mid-back", "abs"],
    description:
      "10 slow rounds on all fours, arching and rounding the whole spine with the breath",
  },
  {
    slug: "childs_pose",
    name: "Child's pose",
    kind: "hold",
    muscles: ["lats", "lower-back"],
    description:
      "Hold 30–60s sitting hips to heels, arms reaching long, chest sinking toward the floor",
  },
  // ── Wrists ───────────────────────────────────────────────────────────────
  {
    slug: "wrist_cars",
    name: "Wrist CARs",
    kind: "reps",
    muscles: ["forearms"],
    description:
      "8 slow wrist circles each direction, then 5 gentle flexion/extension holds",
  },
  // ── Hips / glutes ────────────────────────────────────────────────────────
  {
    slug: "hip_flexor_stretch",
    name: "Hip flexor stretch",
    kind: "hold",
    muscles: ["quads", "hip-adductors"],
    description:
      "Hold 30–60s per side in a half-kneel, tucking the pelvis and driving the hip forward",
  },
  {
    slug: "couch_stretch",
    name: "Couch stretch",
    kind: "hold",
    muscles: ["quads"],
    description:
      "Hold 30–60s per side, rear shin up a wall in a tall half-kneel, ribs down",
  },
  {
    slug: "pigeon_pose",
    name: "Pigeon pose",
    kind: "hold",
    muscles: ["glutes", "hip-abductors"],
    description:
      "Hold 45–60s per side, front shin across, back leg long, folding over the front hip",
  },
  {
    slug: "figure_four_stretch",
    name: "Figure-four stretch",
    kind: "hold",
    muscles: ["glutes", "hip-abductors"],
    description:
      "Hold 30–45s per side on your back, ankle across the opposite knee, drawing the thigh in",
  },
  {
    slug: "ninety_ninety_hip_switch",
    name: "90/90 hip switch",
    kind: "reps",
    muscles: ["glutes", "hip-adductors", "hip-abductors"],
    description:
      "10 switches rotating both shins between 90/90 positions, staying tall through the spine",
  },
  {
    slug: "adductor_rock_back",
    name: "Adductor rock-back",
    kind: "reps",
    muscles: ["hip-adductors"],
    description:
      "10 rock-backs with one leg out to the side on all fours, sinking into the inner thigh",
  },
  {
    slug: "deep_squat_hold",
    name: "Deep squat hold",
    kind: "hold",
    muscles: ["glutes", "hip-adductors", "quads"],
    description:
      "Hold 45–60s in a flat-foot deep squat, elbows prying the knees out, chest up",
  },
  {
    slug: "glute_bridge",
    name: "Glute bridge",
    kind: "reps",
    muscles: ["glutes", "hamstrings"],
    description:
      "12 reps on your back driving hips to the ceiling, squeezing the glutes at the top",
  },
  // ── Hamstrings / posterior chain ─────────────────────────────────────────
  {
    slug: "hamstring_stretch",
    name: "Hamstring stretch",
    kind: "hold",
    muscles: ["hamstrings"],
    description:
      "Hold 30–45s per side, heel forward and hips hinged, reaching toward the toes",
  },
  {
    slug: "seated_forward_fold",
    name: "Seated forward fold",
    kind: "hold",
    muscles: ["hamstrings", "lower-back"],
    description:
      "Hold 45–60s seated with legs long, hinging from the hips and reaching for the feet",
  },
  {
    slug: "downward_dog",
    name: "Downward dog",
    kind: "hold",
    muscles: ["hamstrings", "calves", "lats"],
    description:
      "Hold 30–45s in an inverted-V, alternately pressing each heel toward the floor",
  },
  {
    slug: "worlds_greatest_stretch",
    name: "World's greatest stretch",
    kind: "reps",
    muscles: ["hamstrings", "quads", "mid-back"],
    description:
      "5 reps per side in a lunge, dropping the elbow inside the front foot then rotating open",
  },
  // ── Quads ────────────────────────────────────────────────────────────────
  {
    slug: "standing_quad_stretch",
    name: "Standing quad stretch",
    kind: "hold",
    muscles: ["quads"],
    description:
      "Hold 30–45s per side, heel to glute and knees together, pelvis gently tucked",
  },
  {
    slug: "cossack_squat",
    name: "Cossack squat",
    kind: "reps",
    muscles: ["hip-adductors", "glutes", "quads"],
    description:
      "8 reps per side shifting side to side, one knee bent deep and the other leg straight",
  },
  // ── Calves / ankles ──────────────────────────────────────────────────────
  {
    slug: "calf_stretch",
    name: "Calf stretch",
    kind: "hold",
    muscles: ["calves"],
    description:
      "Hold 30–45s per side, rear heel down in a split stance driving the knee over the toes",
  },
  {
    slug: "ankle_rocks",
    name: "Ankle rocks",
    kind: "reps",
    muscles: ["calves", "tibialis"],
    description:
      "10 rocks per side in a half-kneel, driving the front knee forward over the toes, heel down",
  },
  {
    slug: "dead_hang",
    name: "Dead hang",
    kind: "hold",
    muscles: ["lats", "forearms", "front-delts"],
    description:
      "Hang 20–45s from a bar with a relaxed grip, letting the shoulders and spine decompress",
  },
];

// The framework envelope shape (issue #860 Track B): the mobility-move catalog ships as
// a curated-dataset envelope under lib/datasets/data/, identity-keyed by slug.
export type MobilityMovesDataset = DatasetEnvelope<MobilityMove>;

// Pure builder: the committed lib/datasets/data/mobility-moves.json is a FIXED POINT of
// this (guarded by lib/__tests__/mobility-moves-dataset.test.ts).
export function buildMobilityMoves(): MobilityMovesDataset {
  return {
    $schema: DATASET_SCHEMA,
    id: "mobility-moves",
    title: "Curated mobility-move catalog for the mobility log",
    description:
      "~26 mobility/flexibility moves at the HABIT tier (one move = one tap) for the " +
      "mobility log (issue #840), each with a stable slug (an activity `components` " +
      "entry), a kind (hold/reps), the #735 MuscleId(s) it mobilizes (rolled up to " +
      "MuscleRegion for the coverage strip — a SEPARATE view from strength coverage, " +
      "#482), and a how-to description. Committed + HUMAN-REVIEWABLE. Regenerate with " +
      "`npm run gen:mobility-moves`. INFORMATIONAL movement guidance, NOT a PT/rehab " +
      "prescription.",
    citation: [
      {
        source:
          "General mobility / flexibility practice (curated, human-reviewable)",
        url: "https://www.acsm.org",
        note: "Move selection and how-to descriptions reflect general mobility guidance; groupings are curated and human-reviewable, not medical advice.",
      },
    ],
    identity: { keys: ["slug"] },
    entries: MOVES,
  };
}

function writeDataset(): void {
  const dataset = buildMobilityMoves();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.entries.length} mobility moves to ${OUT}`);
  console.log("Review the move list + descriptions before committing.");
}

// CLI-only guard (the fixed-point test imports buildMobilityMoves without writing).
if (process.argv[1]?.includes("gen-mobility-moves")) {
  writeDataset();
}
