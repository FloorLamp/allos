// The pure niggle layer (issue #2948, part 1) — types, the expiry clock, and the
// live-set derivation. No DB, no network, no clock: the store (lib/niggle-store.ts), the
// Server Action, and the tests all read the same functions.
//
// ── WHAT A NIGGLE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────
//
// A niggle is the tier BELOW an injury. The prod evidence for it: `injuries` is empty
// while the owner's own `activities.notes` read "right knee weird" and "left hip no
// good" — the injury entity (regions, muscles, movements, exercises, a three-state
// lifecycle, review dates, load factors) is too heavy to reach for after an ordinary
// session, so the signal lands where nothing can read it.
//
// So a niggle carries exactly four facts: WHERE (a `MuscleRegion` from the injury/lifts
// vocabulary), WHICH SIDE (an `InjuryLaterality`, or null when the person did not say),
// WHERE IT CAME FROM (an optional activity id and/or canonical exercise identity), and
// WHEN it was first and most recently reported. There is:
//
//   • NO status machine. An injury has active/recovering/resolved because someone
//     manages it. Nobody manages a niggle — that is the entire point.
//   • NO management UI. The only write is the user's tap on a confirm chip.
//   • NO stored expiry flag. A niggle is LIVE or not purely as a function of
//     `lastReportedAt` and now, so nothing has to run to resolve one and no cron can
//     leave the table in a state a reader disagrees with. "Auto-expiry is the default
//     lifecycle; a niggle needs zero interaction to go away" (#2948 invariants).
//
// The region vocabulary is `lib/injury-model.ts`'s and nothing else — see
// lib/curated/niggle-lexicon.ts for how a typed word reaches it.

import type { InjuryLaterality } from "./injury-model";
import type { MuscleRegion } from "./lifts";

// ── THE QUIET SPELL ──────────────────────────────────────────────────────────
//
// How long a niggle stays live with NO re-report. #2948 asked for a named constant in
// the 10–14 day range; 14 is the pick, for a training-shaped reason: the app's weekly
// frequency model means a lift is typically revisited once or twice a week, so 14 days
// is the smallest window that reliably contains TWO more sessions touching the region.
// A 10-day clock can expire a niggle between a fortnightly squat day and the next one,
// which would silently drop the very re-report that should have advanced it.
//
// A SUGGESTION-strength constant, not a medical claim: nothing is treated, and expiry
// only means the app stops mentioning it.
export const NIGGLE_QUIET_DAYS = 14;

const MS_PER_DAY = 86_400_000;

// A stored niggle row (the read shape).
export interface Niggle {
  id: number;
  // The coarse region — `lib/lifts` REGION_SCOPES, via the injury vocabulary.
  region: MuscleRegion;
  // The side the person named. NULL means they did not say, and is NEVER a guess: a
  // one-sided niggle recorded with no side is strictly less than we know, which is the
  // honest direction to be wrong in.
  laterality: InjuryLaterality | null;
  // The word the person actually used ("knee", "hip"). DISPLAY ONLY — the `Injury.label`
  // precedent. Nothing keys on it, nothing filters by it, and it is not a vocabulary.
  bodyTerm: string | null;
  // Where it came from, when it came from somewhere: the activity whose notes carried it
  // and/or the canonical exercise identity (`exerciseHistoryKey`) it was blamed on.
  sourceActivityId: number | null;
  sourceExercise: string | null;
  // First report, and most recent report. Canonical UTC instants (#2205).
  reportedAt: string;
  lastReportedAt: string;
}

// The IDENTITY of a niggle for re-report purposes: a person does not have two
// simultaneous right-knee niggles, they have one that keeps coming back. Region +
// laterality, with a null side kept DISTINCT from a stated one — "my knee" and "my right
// knee" are different amounts of knowledge and merging them would invent a side.
export function niggleKey(
  region: MuscleRegion,
  laterality: InjuryLaterality | null
): string {
  return `${region}:${laterality ?? "unstated"}`;
}

// The instant a niggle expires if nothing re-reports it. Pure; canonical instant in,
// canonical instant out.
export function niggleExpiresAt(lastReportedAt: string): string {
  const t = Date.parse(lastReportedAt);
  if (!Number.isFinite(t)) return lastReportedAt;
  return new Date(t + NIGGLE_QUIET_DAYS * MS_PER_DAY).toISOString().slice(0, 19) + "Z";
}

// Is this niggle still live at `now`? The boundary is EXCLUSIVE at the far end: a niggle
// last reported exactly NIGGLE_QUIET_DAYS ago has gone quiet for the full spell and is
// expired. An unparseable stamp reads as expired rather than as immortal — a row we
// cannot date must not keep tempering anything forever.
export function isNiggleLive(
  n: Pick<Niggle, "lastReportedAt">,
  now: string
): boolean {
  const last = Date.parse(n.lastReportedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(at)) return false;
  return at - last < NIGGLE_QUIET_DAYS * MS_PER_DAY;
}

// The live subset, input order preserved.
export function liveNiggles<T extends Pick<Niggle, "lastReportedAt">>(
  niggles: readonly T[],
  now: string
): T[] {
  return niggles.filter((n) => isNiggleLive(n, now));
}

// How the app SAYS a niggle, in the person's own word where there is one. "right knee",
// "left hip", "knee" (side unstated), "knee (both sides)". Falls back to the region when
// no surface form was captured — a niggle written by something other than the note
// extractor still has to render.
export function niggleLabel(
  n: Pick<Niggle, "region" | "laterality" | "bodyTerm">
): string {
  const part = n.bodyTerm && n.bodyTerm.trim() ? n.bodyTerm.trim() : n.region;
  if (n.laterality === "bilateral") return `${part} (both sides)`;
  if (n.laterality === "left" || n.laterality === "right")
    return `${n.laterality} ${part}`;
  return part;
}
