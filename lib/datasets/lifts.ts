// The strength LIFT CATALOG, loaded onto the curated-dataset framework (issue #860
// Track B, moved here by #5175). Copies the mobility-moves.ts shape: import the
// envelope JSON, validate it once with loadDataset(), and expose typed accessors the
// public lib/lifts.ts reads. That module keeps every reader (muscleLabel, the pattern
// helpers, the option lookups) so its ~94 importers are untouched; only the DATA moved.
// The registry lists this dataset for the linter. Pure — no DB, no network.
//
// THE SPLIT (the same one the DEXA decomposition uses): the JSON declares the
// stand-alone lifts and the variant GROUPS; the code below declares the variant
// PRODUCT. A (equipment × base) expansion is a generator, not a table — writing the
// twenty composed rows out by hand is how "Cable Row" gets a different muscle list
// from "Barbell Row". `DEFS` and `LIFT_OPTIONS` are built here in exactly the order
// lib/lifts.ts built them, because `liftInfo`'s loose contains-fallback resolves ties
// by DEFS order (the assisted entries must stay last).
//
// The vocabulary TYPES (MuscleId, MuscleRegion, MovementPattern, Equipment, LoadKind,
// LiftDef, VariantGroup) stay in lib/lifts.ts, which documents them; they are imported
// type-only here, so the import is erased and there is no runtime cycle.
//
// ── Catalog curation notes ───────────────────────────────────────────────────
// The rationale that used to sit as comments beside the literals. JSON carries no
// comments, so the reasoning lives here, next to the loader that owns the data.
//
// Region filing — a lift's `region` is the region its region-consistent PRIME MOVER
// rolls up into, which is not always where the display `muscle` label points:
//   - Deadlift              — Back: the erectors (lower-back) are the region-consistent
//                             prime mover; glutes/hamstrings/quads assist (other regions).
//   - Close-Grip Bench Press — Chest: keeps its "Triceps" display label, but the chest
//                             is the region-consistent prime mover (triceps assist).
//   - Farmers Carry         — Back: grip (forearms) is a secondary since it rolls to
//                             Arms; the traps hold the load and are region-consistent.
//   - Power Clean           — Back: a "full body" explosive pull whose traps
//                             (shrug/upper-back pull) are the region-consistent prime
//                             mover; the rest assist.
//   - Dead Hang             — Back: an isometric hang; grip (forearms) rolls to Arms so
//                             it is a secondary, the lats/scapular retractors primary.
//   - Push Up               — Chest: the most common bodyweight push, bodyweight-loaded
//                             like the Dip (a vest/plate is ADDED to bodyweight). The
//                             core braces as an anti-extension stabilizer, so the
//                             issue's "core" maps to the `abs` MuscleId.
//   - Kettlebell Swing      — Glutes: a ballistic hip hinge, the archetypal
//                             glute/posterior-chain power move; the hinge is a "pull"
//                             pattern like the deadlift family. Loaded, NOT bodyweight.
//   - Turkish Get-Up        — Core: a full-body ground-to-standing sequence under a
//                             loaded overhead hold whose defining demand is
//                             core/anti-rotation, so `abs` is primary. Unilateral,
//                             loaded, not bodyweight.
//
// Standalone vs. variant (#836/#482) — Smith-machine and kettlebell-native lifts are
// STANDALONE entries, not VariantGroup variants, precisely so each keeps a history
// SEPARATE from its barbell twin, the same as the pre-existing "Trap Bar Deadlift" /
// "T-Bar Row" / "Hack Squat". They are tagged like every other catalog lift so muscle
// coverage, volume bands and day-type suggestions see them.
//   - Smith machine: the fixed bar path and different stabilizer demand make these
//     genuinely different lifts from the free-barbell base. Only the two most-common
//     Smith lifts ship — Smith overhead press / row are niche and would add picker
//     entries with little use (the #482 over-expansion caution), so they are left to be
//     logged as custom names if wanted.
//   - Kettlebell-native movements have no barbell "base", so they are standalone.
//     Kettlebell's value is these native moves, not KB-flavored barbell lifts (KB row /
//     KB press), which are deliberately omitted (#482 over-expansion + they would be
//     low-signal duplicates of the barbell row/press histories).
//
// Assisted bodyweight movements (#1922) — their OWN catalog entries, not variants of
// Pull Up / Dip: an assisted rep and a full rep are different loads, so merging their
// histories would blend two progressions into one meaningless track (#482/#836's
// distinct-history discipline — `exerciseHistoryKey` keeps them separate because they
// are plain catalog names, not composed variants). `bodyweight: true` because the body
// IS the load; `loadKind: "assisted"` because the logged weight is the machine's
// COUNTERWEIGHT and subtracts from it. They are listed LAST in the entries so
// `liftInfo`'s loose contains-fallback still resolves a bare "pull up" / "dip" to the
// base movement it names (DEFS order decides ties).

import rawLifts from "./data/lifts.json";
import { loadDataset } from "./loader";
import { nameStrategy } from "./matcher";
import type {
  Equipment,
  LiftDef,
  MuscleId,
  MuscleRegion,
  VariantGroup,
} from "@/lib/lifts";

// The best-effort implement each plain (non-variant) lift is normally performed with,
// as name lists in the dataset. Informational only — the actual load is what's logged.
export interface DefaultEquipmentLists {
  barbell: string[];
  machine: string[];
  cable: string[];
  dumbbell: string[];
  bodyweight: string[];
  trapBar: string[];
  smith: string[];
  kettlebell: string[];
}

// Dataset-level tables that are not per-lift entries: the MuscleId rollup and its
// display labels, the variant groups the product below expands, and the
// default-implement lists.
export interface LiftsDatasetMeta {
  muscleRegions: Record<MuscleId, MuscleRegion>;
  muscleLabels: Record<MuscleId, string>;
  variantGroups: VariantGroup[];
  defaultEquipment: DefaultEquipmentLists;
}

// The validated dataset (envelope + guarantees). Throws at module load if the committed
// JSON ever violates the contract — a loud, early failure.
export const liftsDataset = loadDataset<LiftDef, LiftsDatasetMeta>(rawLifts);

// Identity strategy: the canonical lift `name` (case-folded), which is what every
// catalog lookup in lib/lifts.ts keys on.
export const liftNameStrategy = nameStrategy;

/**
 * The coarse region each `MuscleId` rolls up into.
 *
 * The `satisfies` is the COMPILE-TIME TOTALITY check the in-code
 * `Record<MuscleId, MuscleRegion>` literal used to buy: TypeScript infers the imported
 * JSON's exact key set, so a muscle added to the `MuscleId` union but not to the
 * dataset fails to typecheck HERE, at the boundary, rather than resolving to
 * `undefined` at runtime. (The cast that follows only supplies the value type, which
 * the JSON widens to `string`.)
 */
export const MUSCLE_REGION = rawLifts.meta.muscleRegions satisfies Record<
  MuscleId,
  string
> as Record<MuscleId, MuscleRegion>;

/** The human display label for each `MuscleId` — total over the union, as above. */
export const MUSCLE_LABEL: Record<MuscleId, string> =
  rawLifts.meta.muscleLabels;

/** The base lifts that compose with an implement ("Curl" → "Dumbbell Curl"). */
export const VARIANT_GROUPS: VariantGroup[] = (
  liftsDataset.meta as LiftsDatasetMeta
).variantGroups;

/**
 * Stand-alone lifts (no equipment variants), in catalog order. Handed through from the
 * dataset entries untouched — the same objects, the same order — so `DEFS` below is
 * byte-identical to the array the in-code table produced.
 */
export const PLAIN_DEFS: LiftDef[] = liftsDataset.entries;

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

/** Every concrete catalog lift: the stand-alone entries then the variant product. */
export const DEFS: LiftDef[] = [...PLAIN_DEFS, ...VARIANT_DEFS];

// Picker options: stand-alone lifts plus the base name of each variant group
// (the concrete variants are reached via equipment chips, not listed here).
export const LIFT_OPTIONS = [
  ...PLAIN_DEFS.map((d) => d.name),
  ...VARIANT_GROUPS.map((g) => g.name),
];

const lowerSet = (names: string[]) =>
  new Set(names.map((n) => n.toLowerCase()));

/**
 * The default-implement name sets, lowercased for the case-insensitive lookups in
 * `defaultEquipment` / `isBarbellLift`. `barbell` is the plate-loaded set the plate
 * builder applies to; `trapBar` / `smith` / `kettlebell` are the #836 standalone
 * DISPLAY labels (a trap bar is plate-loaded, so "Trap Bar Deadlift" is in both).
 * Rep-based bodyweight lifts (Crunch, Nordic Curl, …) carry `bodyweight: true` on
 * their entry instead, so `bodyweight` here only needs the timed holds, which are
 * flagged `timed` rather than `bodyweight`.
 */
export const DEFAULT_EQUIPMENT_LIFTS = {
  barbell: lowerSet(rawLifts.meta.defaultEquipment.barbell),
  machine: lowerSet(rawLifts.meta.defaultEquipment.machine),
  cable: lowerSet(rawLifts.meta.defaultEquipment.cable),
  dumbbell: lowerSet(rawLifts.meta.defaultEquipment.dumbbell),
  bodyweight: lowerSet(rawLifts.meta.defaultEquipment.bodyweight),
  trapBar: lowerSet(rawLifts.meta.defaultEquipment.trapBar),
  smith: lowerSet(rawLifts.meta.defaultEquipment.smith),
  kettlebell: lowerSet(rawLifts.meta.defaultEquipment.kettlebell),
};
