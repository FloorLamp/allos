// Pure injury-layer model (issue #838). Types + validation + the region-constraint
// shaping the recommendation engine consumes — no DB, no network, so it's unit-testable
// and shared by the DB cores (lib/injuries.ts), the Server Actions, and the pure
// recommendation model (lib/workout-recommendation.ts).
//
// An injury is the USER'S explicit constraint — "this region is off the table" — the
// equipment-availability class of #666's context taxonomy (physical possibility, may
// re-rank), NOT the medical-judgment class (conditions, note-only). So the engine may
// EXCLUDE an active injury's regions from recommendations/nags — but always DISCLOSED on
// the card ("avoiding Chest (right shoulder injury)"), never silent.

import {
  exerciseDisplayName,
  exerciseHistoryKey,
  isUnilateral,
  liftInfo,
  muscleRegion,
  regionForExercise,
  REGION_SCOPES,
  MUSCLE_IDS,
  type MovementPattern,
  type MuscleId,
  type MuscleRegion,
} from "./lifts";

export type InjuryStatus = "active" | "recovering" | "resolved";
export const INJURY_STATUSES: readonly InjuryStatus[] = [
  "active",
  "recovering",
  "resolved",
];

// Which side the user says the constraint is on (#2024). DISPLAY + future side-aware
// consumers: the engine reasons about exercises, not sides, so a declared side changes no
// filtering today — it is DISCLOSED instead (see `lateralityLimitation`). Recording it is
// still the user telling us something true about their own constraint.
export type InjuryLaterality = "left" | "right" | "bilateral";
export const INJURY_LATERALITIES: readonly InjuryLaterality[] = [
  "left",
  "right",
  "bilateral",
];

// The movement-pattern vocabulary a constraint may name (#2024) — the EXISTING
// lib/lifts MovementPattern, never a parallel list.
export const INJURY_MOVEMENT_PATTERNS: readonly MovementPattern[] = [
  "push",
  "pull",
  "legs",
  "core",
];

// A stored injury row (the read shape). `regions` is the coarse MuscleRegion[] the engine
// excludes/tempers on; `muscles` is the optional finer MuscleId[] (#735), for display.
//
// #2024 adds the optional, USER-DECLARED precision below. Every field stays optional and
// every existing row reads back with all of them empty/null, which is exactly a
// region-scoped constraint — the pre-#2024 behavior, unchanged.
export interface Injury {
  id: number;
  label: string;
  regions: MuscleRegion[];
  muscles: MuscleId[];
  status: InjuryStatus;
  since: string | null;
  resolvedDate: string | null;
  notes: string | null;
  createdAt: string;
  // Which side the user says it is on. Display + disclosure only.
  laterality: InjuryLaterality | null;
  // Movement patterns the constraint covers, when the user means a pattern rather than a
  // whole region ("pressing hurts", not "my whole chest is off the table").
  movements: MovementPattern[];
  // CANONICAL exercise identities (exerciseHistoryKey) the constraint covers, when the
  // user means specific lifts. Never raw labels — the #626/#432 identity function.
  exercises: string[];
  // The user's own recovering LOAD preference as a fraction of the ordinary next-set
  // target. Null ⇒ the app's disclosed 60% fallback applies. Only meaningful while
  // `recovering`.
  loadFactor: number | null;
  // A date the user wants to revisit the constraint on. The app may SUGGEST reviewing it;
  // nothing ever relaxes, transitions or rewrites the constraint on its own (#2024).
  reviewDate: string | null;
}

// What LEVEL a constraint is declared at (#2024). Precedence is exercise → movement →
// region: naming specific lifts means those lifts, naming a pattern means that pattern,
// and a bare region stays the compatibility/fallback scope. A constraint is never applied
// at two levels at once, which is what let "one shoulder movement" delete a whole region.
export type InjuryScope = "exercise" | "movement" | "region";

// The slice of an injury the recommendation model reads. Only NON-resolved injuries become
// constraints; a resolved injury keeps its record but exerts no engine effect.
export interface InjuryConstraint {
  id: number;
  label: string;
  status: "active" | "recovering";
  regions: MuscleRegion[];
  // #2024 — the resolved scope and the user's declared precision.
  scope: InjuryScope;
  movements: MovementPattern[];
  exercises: string[];
  laterality: InjuryLaterality | null;
  loadFactor: number | null;
  reviewDate: string | null;
}

// A single YYYY-MM-DD validator (shared with the actions).
export function isDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const REGION_SET = new Set<string>(REGION_SCOPES);
const MUSCLE_SET = new Set<string>(MUSCLE_IDS);

export function isValidRegion(r: string): r is MuscleRegion {
  return REGION_SET.has(r);
}
export function isValidMuscleId(m: string): m is MuscleId {
  return MUSCLE_SET.has(m);
}

const LATERALITY_SET = new Set<string>(INJURY_LATERALITIES);
const PATTERN_SET = new Set<string>(INJURY_MOVEMENT_PATTERNS);

export function isValidLaterality(s: string): s is InjuryLaterality {
  return LATERALITY_SET.has(s);
}
export function isValidMovementPattern(s: string): s is MovementPattern {
  return PATTERN_SET.has(s);
}

// A submitted/stored load preference, clamped to the fraction range a SUGGESTION can
// sensibly carry. Anything outside it (or non-numeric) is refused rather than clamped
// silently — a "0%" or "300%" preference is a typo, not a declaration.
export const MIN_INJURY_LOAD_FACTOR = 0.1;
export const MAX_INJURY_LOAD_FACTOR = 1;

export function parseLoadFactor(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return null;
  if (n < MIN_INJURY_LOAD_FACTOR || n > MAX_INJURY_LOAD_FACTOR) return null;
  return Math.round(n * 100) / 100;
}

// Parse a stored/submitted `regions` JSON blob into a de-duplicated MuscleRegion[]. Drops
// anything not in the coarse vocabulary rather than throwing (a defensive read); the
// action-layer validation rejects an empty result before a write.
export function parseRegions(raw: string | null | undefined): MuscleRegion[] {
  return dedupe(parseStringArray(raw).filter(isValidRegion));
}

// Parse a stored/submitted `muscles` JSON blob into a de-duplicated MuscleId[]. Also folds
// each fine muscle's coarse region into the region set at shaping time (below), so a user
// who picks only fine muscles still constrains the right coarse regions.
export function parseMuscles(raw: string | null | undefined): MuscleId[] {
  return dedupe(parseStringArray(raw).filter(isValidMuscleId));
}

// Parse a stored/submitted `movements` blob into a de-duplicated MovementPattern[].
export function parseMovements(
  raw: string | null | undefined
): MovementPattern[] {
  return dedupe(parseStringArray(raw).filter(isValidMovementPattern));
}

// Parse a stored/submitted `exercises` blob into de-duplicated CANONICAL exercise
// identities (#2024). Every entry is normalized through `exerciseHistoryKey`, the same
// identity the recommendation engine dedupes lifts by, so a constraint recorded against
// "Curl" and a session logged as "Barbell Curl" are the same lift — and so nothing here is
// ever a raw user label (a #2024 non-goal).
export function parseInjuryExercises(raw: string | null | undefined): string[] {
  return dedupe(
    parseStringArray(raw)
      .map((s) => exerciseHistoryKey(s))
      .filter((k) => k.length > 0)
  );
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// The full constraint region set for an injury: its declared coarse regions PLUS the
// coarse rollup of any finer muscles it names — so picking "biceps" (a MuscleId) also
// constrains the "Arms" region the engine reasons over. Pure; deterministic order
// (REGION_SCOPES order).
export function injuryRegions(
  regions: MuscleRegion[],
  muscles: MuscleId[]
): MuscleRegion[] {
  const set = new Set<MuscleRegion>(regions);
  for (const m of muscles) set.add(muscleRegion(m));
  return REGION_SCOPES.filter((r) => set.has(r));
}

// The FALLBACK recovering-injury load fraction (issue #838, re-framed by #2024): when a
// recovering constraint carries NO user-declared preference, a suggest-next-set target
// backs off to this fraction of the last pre-injury working weight. It is a documented,
// conservative default and a SUGGESTION, never a lockout or a prescription — and it is
// explicitly the FALLBACK: a user who declares their own `loadFactor` wins, and every
// surface that applies the 60% says it is the app's default, not a recovery milestone the
// app decided they had reached.
export const RECOVERING_LOAD_FACTOR = 0.6;

// The level a constraint is declared at, by the #2024 precedence: exercise → movement →
// region. Naming exercises means those exercises; naming only patterns means that pattern;
// naming neither leaves the coarse region as the fallback scope.
export function injuryScope(
  exercises: readonly string[],
  movements: readonly MovementPattern[]
): InjuryScope {
  if (exercises.length > 0) return "exercise";
  if (movements.length > 0) return "movement";
  return "region";
}

// Shape stored injury rows into the constraints the engine reads: NON-resolved only, with
// the full region set (coarse + fine rollup) and the declared #2024 precision. Resolved
// injuries are dropped (record kept, no effect). Deterministic order (input order).
//
// The region set is carried on EVERY constraint even when the scope is finer, because it
// is what an exercise-less surface (a region heat map, a behind-target label) can still
// name. Only a REGION-scoped constraint acts on it.
export function injuryConstraints(injuries: Injury[]): InjuryConstraint[] {
  const out: InjuryConstraint[] = [];
  for (const inj of injuries) {
    if (inj.status === "resolved") continue;
    out.push({
      id: inj.id,
      label: inj.label,
      status: inj.status,
      regions: injuryRegions(inj.regions, inj.muscles),
      scope: injuryScope(inj.exercises, inj.movements),
      movements: inj.movements,
      exercises: inj.exercises,
      laterality: inj.laterality,
      loadFactor: inj.loadFactor,
      reviewDate: inj.reviewDate,
    });
  }
  return out;
}

// The set of regions EXCLUDED by ACTIVE injuries (active only — recovering regions are
// tempered, not excluded).
//
// #2024: REGION-SCOPED constraints only. A constraint that names specific exercises or a
// movement pattern is honored at THAT level (see `exerciseInjuryVerdict`) and must not
// also delete its whole coarse region — losing every chest recommendation because one
// pressing variation hurts was the exact failure this issue names.
export function excludedRegions(
  constraints: readonly InjuryConstraint[]
): Set<MuscleRegion> {
  const s = new Set<MuscleRegion>();
  for (const c of constraints)
    if (c.status === "active" && c.scope === "region")
      for (const r of c.regions) s.add(r);
  return s;
}

// The set of regions TEMPERED by RECOVERING injuries. A region that is ALSO actively
// excluded stays excluded (exclusion wins), so tempering is the recovering-only remainder.
// Region-scoped only, for the same reason as `excludedRegions`.
export function temperedRegions(
  constraints: readonly InjuryConstraint[]
): Set<MuscleRegion> {
  const excluded = excludedRegions(constraints);
  const s = new Set<MuscleRegion>();
  for (const c of constraints)
    if (c.status === "recovering" && c.scope === "region")
      for (const r of c.regions) if (!excluded.has(r)) s.add(r);
  return s;
}

// The constraint an injury with NO declared precision resolves to — a region-scoped one.
// This is what every pre-#2024 row reads back as, and the shape a caller or fixture that
// only knows a region should build, so "region fallback" is written once.
export function regionInjuryConstraint(base: {
  id: number;
  label: string;
  status: "active" | "recovering";
  regions: MuscleRegion[];
}): InjuryConstraint {
  return {
    ...base,
    scope: "region",
    movements: [],
    exercises: [],
    laterality: null,
    loadFactor: null,
    reviewDate: null,
  };
}

// ── Per-exercise resolution (#2024) ──────────────────────────────────────────

// The slice of a constraint that decides COVERAGE — the resolved level plus the
// vocabulary each level reads. `InjuryConstraint` satisfies it structurally; a DRAFT the
// user is still editing resolves into one through `resolveScope` (#2297), so the form's
// preview and the engine's verdict are the same computation rather than two.
export interface ScopeResolution {
  scope: InjuryScope;
  regions: readonly MuscleRegion[];
  movements: readonly MovementPattern[];
  exercises: readonly string[];
}

// Whether ONE constraint covers a given exercise, at the level the constraint was declared
// at. Exercise identity goes through `exerciseHistoryKey` (never a raw label); a movement
// pattern comes from the lifts catalog; a region falls back to `regionForExercise`.
export function constraintCoversExercise(
  c: ScopeResolution,
  exerciseName: string
): boolean {
  if (c.scope === "exercise")
    return c.exercises.includes(exerciseHistoryKey(exerciseName));
  if (c.scope === "movement") {
    const pattern = liftInfo(exerciseName)?.pattern;
    return pattern != null && c.movements.includes(pattern);
  }
  const region = regionForExercise(exerciseName);
  return region != null && c.regions.includes(region);
}

// The laterality LIMITATION disclosure (#2024). The engine picks exercises, not sides, so
// a one-sided constraint on a BILATERAL lift cannot be honored as declared — the honest
// move is to say so rather than to imply the app worked around the side. A constraint on a
// genuinely unilateral lift, or one declared bilateral, has nothing to disclose.
export function lateralityLimitation(
  c: InjuryConstraint,
  exerciseName: string
): string | null {
  if (c.laterality == null || c.laterality === "bilateral") return null;
  if (isUnilateral(exerciseName)) return null;
  return `${exerciseName} works both sides — your ${c.laterality}-side constraint applies to the whole lift.`;
}

// What an exercise's injury constraints say about it. `kind` follows the #2024 precedence:
// an ACTIVE covering constraint EXCLUDES (exclusion wins over tempering), a RECOVERING one
// TEMPERS, and nothing covering it is "clear".
//
// `factor` is the load fraction a tempered suggestion applies: the TIGHTEST user-declared
// preference among the tempering constraints, or — when none declared one — the app's
// RECOVERING_LOAD_FACTOR with `fallback: true`, so every surface can say which it is.
export type InjuryVerdictKind = "clear" | "tempered" | "excluded";

export interface ExerciseInjuryVerdict {
  kind: InjuryVerdictKind;
  // The responsible constraint labels, de-duplicated in input order.
  labels: string[];
  // 1 when not tempered; otherwise the fraction to apply.
  factor: number;
  // Whether `factor` came from the app's documented default rather than the user.
  fallback: boolean;
  // Limitations the engine could not honor (currently: unhonorable laterality).
  limitations: string[];
}

export function exerciseInjuryVerdict(
  constraints: readonly InjuryConstraint[],
  exerciseName: string
): ExerciseInjuryVerdict {
  const covering = constraints.filter((c) =>
    constraintCoversExercise(c, exerciseName)
  );
  const limitations: string[] = [];
  for (const c of covering) {
    const note = lateralityLimitation(c, exerciseName);
    if (note && !limitations.includes(note)) limitations.push(note);
  }
  const labelsOf = (cs: InjuryConstraint[]) => {
    const out: string[] = [];
    for (const c of cs) if (!out.includes(c.label)) out.push(c.label);
    return out;
  };

  const active = covering.filter((c) => c.status === "active");
  if (active.length > 0)
    return {
      kind: "excluded",
      labels: labelsOf(active),
      factor: 1,
      fallback: false,
      limitations,
    };

  const recovering = covering.filter((c) => c.status === "recovering");
  if (recovering.length === 0)
    return {
      kind: "clear",
      labels: [],
      factor: 1,
      fallback: false,
      limitations,
    };

  const declared = recovering
    .map((c) => c.loadFactor)
    .filter((f): f is number => f != null);
  // Overlapping recovering constraints: the most conservative declared preference wins —
  // easing back further can only be a smaller ask.
  const factor = declared.length
    ? Math.min(...declared)
    : RECOVERING_LOAD_FACTOR;
  return {
    kind: "tempered",
    labels: labelsOf(recovering),
    factor,
    fallback: declared.length === 0,
    limitations,
  };
}

// ── The declared scope, as a sentence and as a change (#2024 / #2297) ────────

// The human label for each movement pattern a constraint may name. Lives here, beside the
// vocabulary itself, so the chip that reads a constraint back and the form that writes one
// name the pattern identically.
export const MOVEMENT_PATTERN_LABEL: Record<MovementPattern, string> = {
  push: "Pushing",
  pull: "Pulling",
  legs: "Legs",
  core: "Core",
};

// What a user DECLARED, at whatever level they declared it — the shape both a stored
// `Injury` and a draft the form is still holding satisfy. `muscles` is optional because
// the finer muscle list is a display/rollup input the injury form does not edit.
export interface DeclaredScope {
  regions: readonly MuscleRegion[];
  movements: readonly MovementPattern[];
  exercises: readonly string[];
  laterality: InjuryLaterality | null;
  muscles?: readonly MuscleId[];
}

// The one-line "what does this constraint actually cover?" summary, at the level it was
// declared at (the exercise → movement → region precedence). A constraint that named lifts
// says those lifts; one that named a pattern says the pattern; one that named neither reads
// as its regions. Exercises are stored as canonical identities, so they render back through
// `exerciseDisplayName` in the catalog's own casing — "Bench Press", not "bench press",
// beside "Chest" / "Pushing".
export function scopeSummary(s: DeclaredScope): string {
  const side =
    s.laterality && s.laterality !== "bilateral"
      ? `${s.laterality} side · `
      : "";
  if (s.exercises.length > 0)
    return `${side}${s.exercises.map(exerciseDisplayName).join(", ")}`;
  if (s.movements.length > 0)
    return `${side}${s.movements.map((m) => MOVEMENT_PATTERN_LABEL[m]).join(", ")}`;
  return `${side}${s.regions.join(", ")}`;
}

// Resolve a declaration into the coverage slice the engine reads: the precedence level,
// the full region set (declared regions + the coarse rollup of any finer muscles), and
// canonical exercise identities. A draft holds user-facing lift NAMES, a stored row holds
// keys, and `exerciseHistoryKey` is idempotent — so both resolve to the same thing.
export function resolveScope(s: DeclaredScope): ScopeResolution {
  return {
    scope: injuryScope(s.exercises, s.movements),
    regions: injuryRegions([...s.regions], [...(s.muscles ?? [])]),
    movements: s.movements,
    exercises: s.exercises
      .map((e) => exerciseHistoryKey(e))
      .filter((k) => k.length > 0),
  };
}

// What editing a constraint's scope would CHANGE, over the lifts this profile actually
// trains (#2297). Narrowing a constraint silently re-permits lifts it was excluding — that
// is the point of the edit, but it is a consequence worth SHOWING rather than assuming, the
// same disclosure answer #2199 gave the precedence override. Both sides run through the
// SAME `constraintCoversExercise` the recommendation engine uses, so the preview cannot
// promise something the engine will not do (#221).
export interface ScopeChange {
  // Lifts the saved constraint covered and the edited one does not — back in suggestions.
  released: string[];
  // Lifts the edited constraint newly covers — newly set aside.
  added: string[];
}

export function scopeChange(
  before: DeclaredScope,
  after: DeclaredScope,
  candidates: readonly string[]
): ScopeChange {
  const b = resolveScope(before);
  const a = resolveScope(after);
  const released: string[] = [];
  const added: string[] = [];
  const seen = new Set<string>();
  for (const name of candidates) {
    const key = exerciseHistoryKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const was = constraintCoversExercise(b, name);
    const now = constraintCoversExercise(a, name);
    if (was && !now) released.push(name);
    else if (!was && now) added.push(name);
  }
  return { released, added };
}

// ── Review dates (#2024) ─────────────────────────────────────────────────────

// Whether a constraint has reached the review date the user set. SUGGEST-ONLY: reaching it
// changes nothing about the constraint — no status transition, no relaxed factor, no
// silent expiry. A surface offers "still current?" and the user's tap is the only write.
export function injuryReviewDue(
  c: Pick<InjuryConstraint, "reviewDate">,
  today: string
): boolean {
  return c.reviewDate != null && c.reviewDate <= today;
}

export function constraintsToReview(
  constraints: readonly InjuryConstraint[],
  today: string
): InjuryConstraint[] {
  return constraints.filter((c) => injuryReviewDue(c, today));
}

// One disclosure line entry: a region excluded from the recommendation and the injuries
// responsible for it, so a surface can render "avoiding Chest (right shoulder injury)".
export interface ExcludedRegionDisclosure {
  region: MuscleRegion;
  // The active-injury labels covering this region, de-duplicated in input order.
  injuryLabels: string[];
}

// The disclosure for every ACTIVE-injury-excluded region, so the exclusion is NEVER
// silent (#838 / the #666 never-gate-silently rule satisfied by disclosure). Ordered by
// REGION_SCOPES for a stable read. Empty when no active injury.
export function excludedRegionDisclosures(
  constraints: readonly InjuryConstraint[]
): ExcludedRegionDisclosure[] {
  const byRegion = new Map<MuscleRegion, string[]>();
  for (const c of constraints) {
    // Region-scoped active constraints only (#2024) — a finer constraint's exclusion is
    // disclosed per exercise, not as a whole region the user never took off the table.
    if (c.status !== "active" || c.scope !== "region") continue;
    for (const r of c.regions) {
      const labels = byRegion.get(r) ?? [];
      if (!labels.includes(c.label)) labels.push(c.label);
      byRegion.set(r, labels);
    }
  }
  return REGION_SCOPES.filter((r) => byRegion.has(r)).map((region) => ({
    region,
    injuryLabels: byRegion.get(region)!,
  }));
}

// The one-line human disclosure for an excluded region: "Chest (right shoulder injury)".
// The word "injury" is appended when the label(s) don't already carry it, so a bare label
// ("right shoulder") reads naturally and a self-describing one ("shoulder injury") isn't
// doubled.
export function excludedRegionLabel(d: ExcludedRegionDisclosure): string {
  return `${d.region} (${withInjuryWord(d.injuryLabels)})`;
}

// "right shoulder injury" — the word is appended when the label(s) don't already carry it,
// so a bare label reads naturally and a self-describing one isn't doubled. Shared by the
// region and exercise disclosures so they phrase a constraint identically.
function withInjuryWord(labels: readonly string[]): string {
  const joined = labels.join(", ");
  return /injur/i.test(joined) ? joined : `${joined} injury`;
}

// ── Exercise-level disclosure (#2024) ────────────────────────────────────────
//
// A finer constraint removes or tempers INDIVIDUAL exercises, so its disclosure is
// per-exercise rather than per-region. Same rule as #838's: the engine may act on the
// user's declared constraint, never silently — every surface that renders a recommendation
// renders these lines beside it.

export interface ExcludedExerciseDisclosure {
  exercise: string;
  injuryLabels: string[];
  // Limitations the engine could not honor for this exercise (e.g. an unhonorable side).
  limitations: string[];
}

export interface TemperedExerciseDisclosure {
  exercise: string;
  injuryLabels: string[];
  // The load fraction the suggestion applies, and whether it came from the app's
  // documented default rather than the user's own declaration.
  factor: number;
  fallback: boolean;
  limitations: string[];
}

export function excludedExerciseLabel(d: ExcludedExerciseDisclosure): string {
  return `${d.exercise} (${withInjuryWord(d.injuryLabels)})`;
}

// "Back Squat — easing back to 60% of your usual target (our default)". The fallback is
// NAMED as a default, so a suggested percentage is never mistaken for a prescription or a
// recovery milestone the app decided the user had reached.
export function temperedExerciseLabel(d: TemperedExerciseDisclosure): string {
  const pct = Math.round(d.factor * 100);
  const origin = d.fallback ? " (our default, adjustable)" : " (your setting)";
  return `${d.exercise} — easing back to ${pct}% of your usual target${origin}, from ${withInjuryWord(
    d.injuryLabels
  )}`;
}

// The exclusion / tempering disclosures for a set of CANDIDATE exercises — the lifts a
// recommendation considered. Only exercises an active constraint actually removed appear
// as exclusions, so an unrelated lift is never listed as "avoided".
export function exerciseDisclosures(
  constraints: readonly InjuryConstraint[],
  candidates: readonly string[]
): {
  excluded: ExcludedExerciseDisclosure[];
  tempered: TemperedExerciseDisclosure[];
} {
  const excluded: ExcludedExerciseDisclosure[] = [];
  const tempered: TemperedExerciseDisclosure[] = [];
  const seen = new Set<string>();
  for (const exercise of candidates) {
    const key = exerciseHistoryKey(exercise);
    if (seen.has(key)) continue;
    seen.add(key);
    const v = exerciseInjuryVerdict(constraints, exercise);
    // Region-scoped constraints keep their existing region-level disclosure; listing them
    // again per exercise would double every line on the card.
    const finer = constraints.some(
      (c) => c.scope !== "region" && constraintCoversExercise(c, exercise)
    );
    if (!finer) continue;
    if (v.kind === "excluded")
      excluded.push({
        exercise,
        injuryLabels: v.labels,
        limitations: v.limitations,
      });
    else if (v.kind === "tempered")
      tempered.push({
        exercise,
        injuryLabels: v.labels,
        factor: v.factor,
        fallback: v.fallback,
        limitations: v.limitations,
      });
  }
  return { excluded, tempered };
}
