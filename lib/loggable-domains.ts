// THE LOGGABLE-DOMAIN CENSUS AXIS + the argued-exclusion vocabulary (issue #2130).
//
// Four affordance registries described themselves as complete and none was
// enforced: `ONE_TAP_AFFORDANCES`, the offline queue's flow list, the quick-log
// sheet/palette menus, and the Telegram command vocabulary were each a membership
// list with no membership scan — the pre-#2036 state the send-marker registry
// escaped. The owner-directed mechanism (#2130 comment):
//
//   • membership BETWEEN two const-asserted registries → a type-level `satisfies`
//     over a shared axis, so ABSENCE IS A COMPILE ERROR. Each surface declares
//     `Record<Axis, Entry | ArguedExclusion>`: every axis member is either a real
//     entry or an explicit, reasoned exclusion — never a missing row nobody argued.
//   • membership between CODE and a registry → a source scan (types can't see a
//     call-site fact); see lib/__tests__/one-tap.test.ts.
//
// This module owns the two shared pieces: the domain axis the quick-log sheet,
// the palette, and Telegram all census against, and the branded exclusion values
// every census (including the offline queue's, whose axis is `OneTapAffordance`)
// uses. Pure and dependency-free — client-safe, importable from the offline
// queue's pure core and from the Telegram vocabulary alike.

// ── The axis ─────────────────────────────────────────────────────────────────
//
// Every domain a person LOGS a dated fact into from a quick surface. The grain is
// the finest any census distinguishes: weight / vitals / temperature are separate
// because Telegram covers exactly one of them (`/temp`) while the sheet's one
// measurements form covers all three — a coarser "measurements" domain would have
// hidden the weight gap #2130 found. Adding a domain here forces every census to
// answer for it, which is the point.
export const LOGGABLE_DOMAINS = [
  "activity",
  "food",
  "dose",
  "weight",
  "vitals",
  "temperature",
  "practice",
  "period",
  "mood",
  "symptom",
  "substance",
  "document",
] as const;

export type LoggableDomain = (typeof LOGGABLE_DOMAINS)[number];

// ── Argued exclusion ─────────────────────────────────────────────────────────
//
// "Decided against, and here is why" as a VALUE, so a census row can never be
// silently absent and never emptily excluded. Branded: the only way to construct
// one is `arguedExclusion(reason)`, so the reason is structurally required — the
// registry family's evidence-per-class rule, applied to non-membership.
declare const ArguedExclusionBrand: unique symbol;

export interface ArguedExclusion {
  readonly excluded: true;
  readonly reason: string;
  readonly [ArguedExclusionBrand]: "argued-exclusion";
}

export function arguedExclusion(reason: string): ArguedExclusion {
  if (!reason.trim()) {
    throw new Error("An argued exclusion must state its reason.");
  }
  return { excluded: true, reason } as ArguedExclusion;
}

export function isArguedExclusion(value: unknown): value is ArguedExclusion {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { excluded?: unknown }).excluded === true &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

// ── Planned verb (Telegram only) ─────────────────────────────────────────────
//
// #2130 decides WHICH domains get a Telegram verb; #1895 builds the vocabulary
// surface (registration, /help, handlers) and is explicitly out of #2130's scope.
// So a "decided IN, not yet built" membership is its own branded value: the
// decision is recorded in the census (absence stays impossible) without
// pretending a handler exists. When #1895 lands the verb, the census row flips
// from `plannedVerb(...)` to the real command name and the types keep it honest.
declare const PlannedVerbBrand: unique symbol;

export interface PlannedVerb {
  readonly planned: true;
  readonly verb: string;
  readonly reason: string;
  readonly [PlannedVerbBrand]: "planned-verb";
}

export function plannedVerb(verb: string, reason: string): PlannedVerb {
  if (!verb.trim() || !reason.trim()) {
    throw new Error("A planned verb names the verb and states its reason.");
  }
  return { planned: true, verb, reason } as PlannedVerb;
}

export function isPlannedVerb(value: unknown): value is PlannedVerb {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { planned?: unknown }).planned === true &&
    typeof (value as { verb?: unknown }).verb === "string" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}
