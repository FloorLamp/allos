// Pure routine helpers (#738) — NO DB, NO network, so they live outside the
// db-touching write cores (lib/routines.ts) and can be unit-tested in the pure tier
// (lib/__tests__). Holds the builder-input shapes, the input validator, and the ONE
// frequency-target derivation shared by template activation and custom activation
// (so a template's declared targets and a custom routine's day-derived targets can't
// fork — the "one question, one computation" rule at the target layer).

import type { MuscleRegion } from "./lifts";
import { REGION_SCOPES, liftInfo } from "./lifts";
import type { DerivedFrequencyTarget } from "./routine-templates";
import { getRoutineTemplate } from "./routine-templates";
import type { RoutineSource } from "./types";

// ── Input shapes the builder UI (#739) constructs ───────────────────────────────
export interface RoutineSlotInput {
  candidates: string[];
  sets: number;
  repMin: number;
  repMax: number;
}
export interface RoutineDayInput {
  label: string;
  focus: MuscleRegion[];
  slots: RoutineSlotInput[];
}
export interface RoutineInput {
  name: string;
  cycleWeeks?: number | null;
  days: RoutineDayInput[];
}

// The training scope kinds an activation replaces. `food_group` (nutrition, migration
// 031) is deliberately excluded — see lib/routines.ts and issue #738.
export const TRAINING_TARGET_SCOPES = ["region", "group", "type"] as const;

// Derive the weekly frequency targets a routine implies. A template DECLARES its
// targets explicitly; a custom routine (or a template whose id no longer resolves)
// derives region targets from its days' focus — one region target per region,
// per_week = the number of days whose focus includes it.
export function deriveRoutineTargets(routine: {
  source: RoutineSource;
  templateId: string | null;
  days: { focus: MuscleRegion[] }[];
}): DerivedFrequencyTarget[] {
  if (routine.source === "template" && routine.templateId) {
    const t = getRoutineTemplate(routine.templateId);
    if (t) return t.frequencyTargets;
  }
  const counts = new Map<MuscleRegion, number>();
  for (const d of routine.days)
    for (const r of d.focus) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Ordered by REGION_SCOPES for deterministic output.
  return REGION_SCOPES.filter((r) => counts.has(r)).map((r) => ({
    scopeKind: "region" as const,
    scopeValue: r,
    perWeek: counts.get(r)!,
  }));
}

// Derive a routine day's `focus` from its slots' candidate exercises — the union of
// each RESOLVED candidate's `LiftDef.region`, ordered by REGION_SCOPES for a stable
// result. The builder UI (#739) seeds an editable per-day focus with this so the day's
// regions track the exercises the user picked. Free-text / custom lift names that don't
// resolve against the catalog contribute nothing (they degrade gracefully, matching
// custom-lift behavior everywhere else — #739). This is the ONE focus derivation, kept
// pure so the builder and any future surface can't fork it.
export function deriveFocusFromCandidates(
  candidateLists: string[][]
): MuscleRegion[] {
  const present = new Set<MuscleRegion>();
  for (const list of candidateLists) {
    for (const name of list) {
      const region = liftInfo(name)?.region;
      if (region) present.add(region);
    }
  }
  return REGION_SCOPES.filter((r) => present.has(r));
}

// ── Validate/normalize untrusted builder input ──────────────────────────────────
// Parses an untrusted object (the builder form / a JSON payload) into a clean
// RoutineInput, or returns null when it's structurally invalid. Candidate names are
// left as typed (a custom lift name is allowed anywhere a catalog name is, matching
// how custom lifts behave everywhere else); sets/reps are clamped to sane bounds.
const REGION_SET = new Set<string>(REGION_SCOPES);

export function validateRoutineInput(raw: unknown): RoutineInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  if (!Array.isArray(o.days) || o.days.length === 0) return null;

  const days: RoutineDayInput[] = [];
  for (const d of o.days) {
    if (typeof d !== "object" || d === null) return null;
    const dd = d as Record<string, unknown>;
    const label = typeof dd.label === "string" ? dd.label.trim() : "";
    if (!label) return null;
    const focus = Array.isArray(dd.focus)
      ? (dd.focus.filter(
          (f): f is MuscleRegion => typeof f === "string" && REGION_SET.has(f)
        ) as MuscleRegion[])
      : [];
    if (!Array.isArray(dd.slots) || dd.slots.length === 0) return null;

    const slots: RoutineSlotInput[] = [];
    for (const s of dd.slots) {
      if (typeof s !== "object" || s === null) return null;
      const ss = s as Record<string, unknown>;
      const candidates = Array.isArray(ss.candidates)
        ? ss.candidates
            .map((c) => (typeof c === "string" ? c.trim() : ""))
            .filter((c) => c.length > 0)
        : [];
      if (candidates.length === 0) return null;
      const sets = clampInt(ss.sets, 1, 20);
      const repMin = clampInt(ss.repMin, 1, 100);
      if (sets === null || repMin === null) return null;
      const repMax = Math.max(repMin, clampInt(ss.repMax, 1, 100) ?? repMin);
      slots.push({ candidates, sets, repMin, repMax });
    }
    days.push({ label, focus, slots });
  }

  const cycleWeeks =
    o.cycleWeeks == null ? null : clampInt(o.cycleWeeks, 1, 52);
  return { name, cycleWeeks, days };
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
