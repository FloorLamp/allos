import {
  composeVariant,
  DEFAULT_EQUIPMENT_LIFTS,
  DEFS,
  MUSCLE_LABEL,
  MUSCLE_REGION,
  VARIANT_GROUPS,
} from "./datasets/lifts";
import { fmtWeight } from "./units";
import type { WeightUnit } from "./settings";

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
  | "chest" // pecs, all heads — incline work counts here in full (#2891)
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
 * Every `MuscleId`, for exhaustive iteration (e.g. the rollup totality test). The
 * dataset's rollup is keyed by id, and the loader checks its totality over this union
 * at the dataset boundary, so these are exactly the union's members.
 */
export const MUSCLE_IDS = Object.keys(MUSCLE_REGION) as MuscleId[];

/**
 * The coarse `MuscleRegion` a fine-grained `MuscleId` rolls up into (total).
 * `hip-adductors` (inner thigh) → Legs while `hip-abductors` (glute med/min) →
 * Glutes, matching the catalog placement of "Hip Adduction" (Legs) vs "Hip Abduction"
 * (Glutes). `neck` has no dedicated region; it rolls into Back (its posterior
 * placement) — no catalog lift tags it, so that only exists to keep the rollup total.
 */
export function muscleRegion(m: MuscleId): MuscleRegion {
  return MUSCLE_REGION[m];
}

/**
 * The human display label for a `MuscleId` (total over the enum). A pure display
 * formatter over the identity key — every muscle-keyed surface (the coverage list,
 * the SVG hover/text list) renders through here, never inventing its own label, so a
 * rename lands in one place, in the dataset.
 */
export function muscleLabel(m: MuscleId): string {
  return MUSCLE_LABEL[m];
}

// Movement pattern, used to suggest "Push day" / "Pull day" / "Leg day".
export type MovementPattern = "push" | "pull" | "legs" | "core";

/**
 * How a logged weight COMBINES with the movement's own load — the load-semantics
 * vocabulary (#1922), a sibling of `Equipment` on the exercise model.
 *
 *  - `added` (the default, and every lift that existed before #1922): the logged
 *    weight ADDS. A weighted pull-up at +20 kg moves bodyweight + 20.
 *  - `assisted`: the logged weight SUBTRACTS. It is a COUNTERWEIGHT, so more
 *    logged weight means LESS load and an EASIER set. An assisted pull-up at
 *    40 kg of assistance moves bodyweight − 40.
 *
 * The distinction is not cosmetic: `assisted` is the one kind whose load runs
 * BACKWARDS through every ascending-load consumer we have. A raw assistance weight
 * fed to an e1RM, a PR list or a plateau slope is wrong in the DANGEROUS
 * direction — a lifter who needed MORE help would show a personal record. So every
 * load fold goes through `effectiveLoadKg` below (the sign is applied once, at the
 * one place bodyweight is folded in), and the ascending consumers exclude
 * `assisted` lifts outright. lib/__tests__/assisted-load-guard.test.ts is the
 * class guard that pins both halves across the WHOLE catalog, so the next assisted
 * movement added here cannot reintroduce the inversion silently.
 *
 * Machine variants need no kind of their own: `Equipment: "Machine"` already
 * carries their exclusion from free-weight standards (#2326).
 */
export type LoadKind = "added" | "assisted";

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
  // The body itself is the load (pull ups, chin ups, dips). Any logged weight
  // combines with bodyweight according to `loadKind` (ADDED unless the lift says
  // otherwise); with no logged weight the load is just bodyweight. Used to fold
  // the user's bodyweight into volume / strength stats.
  bodyweight?: boolean;
  // How a logged weight combines with the movement (#1922). Absent ⇒ `added`,
  // which is every lift in the catalog except the assisted entries.
  loadKind?: LoadKind;
  // For an `assisted` entry: the canonical movement it is a lighter execution OF
  // ("Assisted Pull Up" → "Pull Up"). It is a SEPARATE history from that base
  // (#482/#836 — distinct equipment, distinct history), so this is never used to
  // merge them; it exists so the standards lookup can score the effective load
  // against the base movement's own bands (#1922 part 2).
  assistedBase?: string;
}

// The canonical implement vocabulary for the lift catalog. It serves two roles:
//
//  1. VariantGroup composition (below) — a base lift (Curl/Row/Bench Press) opts
//     INTO the subset of implements it can be loaded with, composing
//     "<Equipment> <Base>" names ("Dumbbell Curl"). Composed variants SHARE the
//     base's progression history: exerciseHistoryKey collapses them to the base
//     (the deliberate #331 merge — one progression track per base lift).
//
//  2. Standalone-implement labelling — a lift that must keep a SEPARATE history
//     from a same-movement barbell lift (#482: distinct equipment = distinct
//     history) is NOT a merged variant. It ships as its OWN catalog entry named
//     for the implement ("Trap Bar Deadlift", "Smith Bench Press", the
//     kettlebell-native moves), so its e1RM/progression never blends into the
//     barbell base.
//
// That distinction is why "Kettlebell" / "Trap Bar" / "Smith" (added in #836) are
// in the vocabulary but are NOT assigned to any VariantGroup below: as merged
// variants they would collapse into the barbell base history (blending a trap-bar
// deadlift into "Deadlift", a Smith bench into "Bench Press"), violating #482 and
// "existing Deadlift histories untouched". They are standalone catalog entries
// instead — the same treatment T-Bar Row / Hack Squat / Trap Bar Deadlift already
// get. The union member is used as the standalone name's prefix
// and as the defaultEquipment display label.
//
// Deliberately EXCLUDED (tracked as a merged 1RM history they would add noise, not
// signal — the #482 exclusion discipline applied to equipment):
//  - Bands: load varies through the range of motion, so a banded lift has no
//    comparable session-to-session load — noise as a tracked 1RM history.
//  - EZ-bar: a grip variant of a barbell curl/extension; folds into "Barbell".
//  - Rings: an unstable bodyweight surface; folds into the bodyweight movements.
export type Equipment =
  | "Barbell"
  | "Dumbbell"
  | "Cable"
  | "Machine"
  | "Kettlebell"
  | "Trap Bar"
  | "Smith";

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

/**
 * Compose the stored exercise name for a variant, e.g. ("Curl","Dumbbell") ->
 * "Dumbbell Curl". Re-exported from the dataset loader, which owns the variant
 * product it builds.
 */
export { composeVariant } from "./datasets/lifts";

// Picker options: stand-alone lifts plus the base name of each variant group
// (the concrete variants are reached via equipment chips, not listed here).
export { LIFT_OPTIONS } from "./datasets/lifts";

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
 * The DISPLAY name for a stored `exerciseHistoryKey` — the presentation inverse of the
 * key above, for the surfaces that PERSIST the identity and later have to render it
 * (the #2024 injury constraint's `exercises`; anything else that stores a key rather
 * than a logged label). A surface that already holds a logged name renders that name;
 * this is only for a key that has lost its casing.
 *
 * A catalog key renders in the catalog's own casing ("bench press" → "Bench Press"),
 * looked up EXACTLY — deliberately NOT through `liftInfo`, whose loose contains fallback
 * would render a custom "sled push" as whichever catalog lift happens to share a word.
 * A custom key has no canonical casing to recover, so its words are capitalized, the
 * same treatment the activity logger gives a free-text name on the way in.
 */
export function exerciseDisplayName(key: string): string {
  const k = key.trim().toLowerCase();
  if (!k) return "";
  return (
    MAP.get(k)?.name ??
    k.replace(/\b[\w']+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1))
  );
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

/**
 * The LOAD CONTEXT lane of a logged set — the registry equipment instance it was
 * performed on, or the explicit "unassigned/default" lane when the set carries no
 * `exercise_sets.equipment_id` (#1610).
 *
 * Load comparability is a SECOND identity, distinct from the movement identity
 * `exerciseHistoryKey` owns. Two registry machines both serialize as the exact same
 * logged name ("Machine Chest Press"), so no name-derived key can tell a home chest
 * press from a hotel one whose stack geometry makes 50 kg the right load. Every
 * load-sensitive builder therefore appends this lane to whichever NAME identity it
 * already uses, through the two composers below.
 *
 * A NULL equipment id is a lane of its own, never a wildcard: historical rows and
 * built-in-variant work with no custom row stay in the unassigned lane and we never
 * guess which machine produced them.
 */
export function equipmentLoadLane(
  equipmentId: number | null | undefined
): string {
  return equipmentId == null ? "none" : String(equipmentId);
}

/**
 * Load identity for a SEED — the next-set suggestion, the repeat-fill of a prior
 * session, and the "Recent" reference the editor shows (#1610).
 *
 * Name axis: the EXACT logged variant, lowercased/trimmed. #393 established that a
 * per-hand "Dumbbell Curl" load and a "Barbell Curl" total are different
 * progressions even though #331 merges them into one movement history, and that
 * separation survives here for profiles that own no custom equipment at all.
 * Load axis: `equipmentLoadLane`, so two machines logged under one exact name never
 * seed each other.
 *
 * Sibling of `movementLoadKey` below: SAME lane suffix, different name axis, because
 * a seed asks "what did I last do on this exact implement" while a progression series
 * asks "how is this movement trending on this implement".
 */
export function strengthLoadKey(
  exercise: string,
  equipmentId: number | null | undefined
): string {
  return `${exercise.trim().toLowerCase()}@${equipmentLoadLane(equipmentId)}`;
}

/**
 * Load identity for a movement's AGGREGATE progression on one implement — the
 * plateau e1RM series and the plateau finding's dedupe key (#1610 + #1399).
 *
 * Name axis: the canonical `exerciseHistoryKey`, so "Barbell Curl" and "Curl" remain
 * ONE series and ONE dismissal (the #432 series fix and the #1399 dismissal-key twin
 * it left open — the dismissal follows exactly the identity the series groups on).
 * Load axis: `equipmentLoadLane`, so a plateau on the home machine is not the same
 * signal as one on the hotel machine and neither dismissal silences the other.
 */
export function movementLoadKey(
  exercise: string,
  equipmentId: number | null | undefined
): string {
  return `${exerciseHistoryKey(exercise)}@${equipmentLoadLane(equipmentId)}`;
}

/**
 * How a lift is NAMED once its load contexts are rendered side by side (#1610) —
 * the movement plus the registry implement it was performed on, so two machines
 * read as the two distinct progressions they are ("Machine Chest Press (Hotel chest
 * press)"). The bare movement name when the sets carry no implement link.
 *
 * This is the display twin of `equipmentLoadLane`: wherever a surface splits a
 * series, a PR list or a comparison by lane, it must LABEL the lanes with this —
 * #1610 forbids duplicate UNLABELED rows, which is exactly what an unlabeled split
 * would produce. One composer, so the plateau copy (`plateauSubject`), the Trends
 * progression chart, the PR lists and the Analyze context chooser cannot drift into
 * three spellings of the same name.
 *
 * Display only: every catalog lookup (variations, muscles, history key) still runs
 * on the raw `exercise`, which is why the label is composed at the edge rather than
 * folded into the stored name.
 */
export function loadContextLabel(
  exercise: string,
  equipmentLabel: string | null | undefined
): string {
  return equipmentLabel ? `${exercise} (${equipmentLabel})` : exercise;
}

/**
 * The SET a strength record was performed with, as a clause — "at 120 kg × 5",
 * "at bodyweight × 12", "top set at 140 kg" — in the reader's weight unit (#3033).
 *
 * ONE phrasing for every surface that states a record as performed: the PR finding
 * (`prToFinding`) and the recap's PR line render this same clause, so the
 * celebration and the summary can never spell one lift's record two ways. The three
 * cases are the record model's own: an e1RM-kind record is a weight × reps set, a
 * bodyweight lift's load is the body (reps alone), and a top-weight record carries
 * no rep count to claim — rendering it as a set would invent one.
 */
export function prSetClause(
  pr: {
    kind: "1rm" | "weight";
    weightKg: number;
    reps: number;
    bodyweight: boolean;
  },
  weightUnit: WeightUnit
): string {
  if (pr.kind === "weight") {
    return `top set at ${fmtWeight(pr.weightKg, weightUnit)}`;
  }
  return pr.bodyweight
    ? `at bodyweight × ${pr.reps}`
    : `at ${fmtWeight(pr.weightKg, weightUnit)} × ${pr.reps}`;
}

/**
 * Look up a lift by name (case-insensitive, with a loose contains fallback).
 *
 * THE ARGUMENT IS AN EXERCISE NAME. The contains fallback exists to match logged
 * free-text variants ("incline bench" → Incline Bench Press), and it will happily
 * match a string that is not an exercise at all: "Back" is contained in "back squat",
 * so a MUSCLE REGION passed in here returns a confidently wrong lift rather than a
 * visible miss (#2012 — `suggestTitle(rec.focus)` titled a back day "Legs workout").
 */
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

/** Whether a lift is loaded by the body itself (logged weight combines with it). */
export function isBodyweight(name: string): boolean {
  return liftInfo(name)?.bodyweight === true;
}

// "Assisted Pull Up", "Machine Assisted Dip" — the word as a standalone token, so
// a lift merely CONTAINING the letters (none today, but the catalog grows) is not
// swept in.
const ASSISTED_NAME = /(?:^|\s)assisted(?:\s|$)/i;

/**
 * The LOAD KIND of a logged exercise name (#1922) — whether its logged weight adds
 * to the movement or subtracts from it. `added` for everything that is not
 * explicitly assisted, so the catalog's default and every custom lift are
 * unchanged.
 *
 * Resolution is deliberately NOT `liftInfo`'s loose contains-fallback for the
 * catalog half. `liftInfo` matches on substrings, and "Assisted Pull Up" CONTAINS
 * "Pull Up" — which is exactly how a free-typed assisted lift already reads as a
 * WEIGHTED one today, adding the counterweight to bodyweight. So:
 *
 *  1. an EXACT catalog name answers from its own `loadKind`; then
 *  2. a name that carries the word "assisted" AND resolves to a BODYWEIGHT
 *     movement is assisted, whatever its exact spelling ("Machine Assisted Pull
 *     Up", "Assisted Chin Up"). The two conditions together are what keep this
 *     safe: a free-typed "Assisted Bench Press" resolves to a non-bodyweight lift,
 *     where a logged weight is the bar and nothing is being counterweighted, so it
 *     stays `added` and no existing history changes meaning.
 */
export function loadKindOf(name: string): LoadKind {
  const exact = MAP.get(name.trim().toLowerCase());
  if (exact) return exact.loadKind ?? "added";
  const info = liftInfo(name);
  if (info?.bodyweight === true && ASSISTED_NAME.test(name)) return "assisted";
  return "added";
}

/** Whether a logged exercise's weight SUBTRACTS from the load (#1922). */
export function isAssisted(name: string): boolean {
  return loadKindOf(name) === "assisted";
}

/**
 * The canonical movement an assisted lift is a lighter execution of ("Assisted
 * Pull Up" → "Pull Up"), or null for anything not assisted. Used ONLY by the
 * standards lookup, to score the effective load against the base movement's bands;
 * it never merges the two histories.
 */
export function assistedBaseLift(name: string): string | null {
  const exact = MAP.get(name.trim().toLowerCase());
  if (exact?.assistedBase) return exact.assistedBase;
  if (!isAssisted(name)) return null;
  // A non-catalog spelling ("Machine Assisted Pull Up"): the movement liftInfo
  // resolved it to IS the base — that loose match is why loadKindOf had to be
  // stricter than liftInfo, and here it is the right answer.
  return liftInfo(name)?.name ?? null;
}

/**
 * THE load fold (#1922). The effective system load of one set: the movement's own
 * base load (the lifter's bodyweight for a bodyweight movement, 0 otherwise)
 * combined with the logged external weight ACCORDING TO the movement's load kind.
 *
 * This is the single place the SIGN is applied. Every builder that used to write
 * `baseKg + (weight ?? 0)` calls this instead, so an assisted lift's counterweight
 * can never reach a consumer as if it were added load — there is no second fold to
 * forget. Clamped at 0: assistance exceeding bodyweight is not a negative load,
 * it is no measurable load at all, and 0 is precisely the value the standards
 * lookup already declines to place.
 */
export function effectiveLoadKg(
  loadKind: LoadKind,
  baseKg: number,
  weightKg: number | null | undefined
): number {
  const w = weightKg ?? 0;
  return loadKind === "assisted" ? Math.max(0, baseKg - w) : baseKg + w;
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

// The default-implement name sets, from the dataset (lib/datasets/lifts.ts documents
// what each one is for). `barbell` is the plate-loaded set the plate builder applies
// to; variant lifts (Curl/Row/Bench Press/Overhead Press) are detected via their
// "Barbell" chip instead.
const {
  barbell: BARBELL_LIFTS,
  machine: MACHINE_LIFTS,
  cable: CABLE_LIFTS,
  dumbbell: DUMBBELL_LIFTS,
  bodyweight: BODYWEIGHT_LIFTS,
  trapBar: TRAP_BAR_LIFTS,
  smith: SMITH_LIFTS,
  kettlebell: KETTLEBELL_LIFTS,
} = DEFAULT_EQUIPMENT_LIFTS;

/** Whether a lift is loaded on a plate barbell (so the plate builder applies). */
export function isBarbellLift(name: string): boolean {
  if (variantOf(name)?.equipment === "Barbell") return true;
  const info = liftInfo(name);
  return info ? BARBELL_LIFTS.has(info.name.toLowerCase()) : false;
}

/**
 * The implement a lift is normally performed with ("Barbell"/"Dumbbell"/"Cable"/
 * "Machine"/"Bodyweight"), or null when unknown or when the lift already offers a
 * selectable equipment variant. Informational — the actual load is what's logged.
 */
export function defaultEquipment(name: string): string | null {
  if (isBodyweight(name)) return "Bodyweight";
  // Standalone-implement labels first — Trap Bar Deadlift is ALSO a barbell lift
  // (plate math) but should display "Trap Bar", so this precedes the barbell branch.
  const named = liftInfo(name);
  if (named) {
    const nk = named.name.toLowerCase();
    if (TRAP_BAR_LIFTS.has(nk)) return "Trap Bar";
    if (SMITH_LIFTS.has(nk)) return "Smith";
    if (KETTLEBELL_LIFTS.has(nk)) return "Kettlebell";
  }
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
// The activity types a weekly frequency TARGET may be scoped to — deliberately NOT
// the full ActivityType set. `mobility` has its own mobility scope, and `unclassified`
// (#2272) is excluded on purpose: a "Cardio 2×/week" target is rightly unaffected by a
// session nobody said was cardio, and no one sets a target for the unspecified.
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
