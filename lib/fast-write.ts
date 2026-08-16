// Auth-blind write cores for the fasting lifecycle (issue #2756). profileId-first,
// never imports lib/auth — the Server Action owns the gate + revalidation (#319). The
// table's DML lives one module over in lib/fast-store.ts; this file owns the
// TRANSITIONS, the life-stage gate, and the typed outcomes.
//
// Every refusal is a REPORT, never a repair (#1681): a core that cannot do the obvious
// thing says which thing it could not do and writes nothing. The offer conditions the
// Nutrition control renders from are the SAME pure predicates enforced here
// (lib/fasting.ts `fastControlState`), so a stale page cannot produce a write the
// surface would never have offered.
//
// Each core is ONE writeTx (BEGIN IMMEDIATE, #468): the state read and the write commit
// together, so two quick taps — or two devices — cannot mint a second active fast. The
// partial unique index on `fasts(profile_id) WHERE ended_at IS NULL` is the schema-level
// backstop behind that.
//
// ── THE ADULT-ONLY RULING, AND ITS ONE ASYMMETRY (registered in
//    ADULT_ONLY_WRITE_CORES, lib/adult-only-writes.ts) ────────────────────────────────
//
// An eating-restriction tracker on a known-minor profile is eating-disorder-adjacent, so
// it is gated on the #1174/#2107 pattern: the CORE refuses, because hiding the surface
// is theater when a Server Action is independently POST-callable. A refused start
// answers exactly as an unknown row does. Unknown age PASSES, per lib/life-stage's
// documented positive-match-only policy — we restrict only on a positive under-age
// match, never on missing data.
//
// STARTS REFUSE; ENDING AN EXISTING ACTIVE FAST ALWAYS SUCCEEDS. This closes a
// stranded-row trap rather than relaxing the gate: a birthdate edit that makes a profile
// restricted MID-FAST must not leave an active row nobody can close, which would leave
// the profile permanently mid-fast with the food nudges stood down (#2757) and no
// affordance anywhere to fix it. Closing out is harm-reduction, not tracking — it
// removes the fast, it does not record one. `endFast` and `discardFast` carry that
// exemption in the registry, in writing; `startFast` does not.

import { now as clockNow } from "./clock";
import { utcInstant, parseUtcSql } from "./date";
import { writeTx } from "./db";
import {
  FAST_MAX_HOURS,
  overlappingFasts,
  type Fast,
} from "./fasting";
import { isMinor } from "./life-stage";
import {
  createFastRow,
  deleteFastRow,
  getActiveFast,
  getFast,
  listFasts,
  updateFastRow,
} from "./fast-store";
import { getProfileAge } from "./settings/profile-attrs";

// THE GATE. True when this profile may not have fasting content STARTED for it. Named
// and matched by ADULT_ONLY_WRITE_CORES' scan, so renaming it without updating the
// registry fails CI rather than silently disabling the check.
//
// `isMinor` is lib/life-stage's own legal-minor line (age < 18, unknown → false). This
// deliberately does NOT invent an age constant: #2807 extended that model precisely so
// a new surface picks a NAMED member instead of a fresh magic number, and fasting is
// the `isMinor` line — the substance-use one — rather than the adolescent-inclusive
// mental-health screening line, because an eating-restriction tracker has no
// adolescent-validated form the way the PHQ-A does.
export function fastAdultOnlyRefusal(profileId: number): boolean {
  return isMinor(getProfileAge(profileId));
}

/** Read-side twin of the gate: whether a profile sees any fasting surface at all. */
export function fastingAvailable(profileId: number): boolean {
  return !fastAdultOnlyRefusal(profileId);
}

export type StartFastOutcome =
  | { kind: "started"; id: number }
  // A fast is already running — a second start, including the cross-device double-tap.
  | { kind: "already-active"; id: number }
  // A backdated start whose interval collides with a fast already on record. Backdating
  // can never manufacture an overlap, which is what makes backdating safe to offer.
  | { kind: "overlap"; id: number }
  // The proposed start is in the future, or further back than FAST_MAX_HOURS.
  | { kind: "invalid" }
  // The life-stage gate refused. Reported as its own kind rather than folded into
  // `invalid` so the ACTION can answer without a message that would itself be content.
  | { kind: "refused" };

// Start a fast. `startedAt` is an explicit backdated instant for the forgot-to-tap case
// — the common failure — and defaults to now. The whole decision runs inside one
// writeTx against freshly-read rows, so a stale page's backdated instant is judged
// against the state that actually exists at commit time.
export function startFast(
  profileId: number,
  startedAt?: Date,
  note: string | null = null
): StartFastOutcome {
  if (fastAdultOnlyRefusal(profileId)) return { kind: "refused" };
  return writeTx(() => {
    const at = clockNow();
    const start = startedAt ?? at;
    const startMs = start.getTime();
    if (startMs > at.getTime()) return { kind: "invalid" };
    if (at.getTime() - startMs > FAST_MAX_HOURS * 3_600_000)
      return { kind: "invalid" };
    const active = getActiveFast(profileId);
    if (active) return { kind: "already-active", id: active.id };
    // The new fast is OPEN, so it extends to +infinity: any recorded fast that has not
    // finished before `start` collides with it.
    const clash = overlappingFasts(listFasts(profileId), startMs, null);
    if (clash.length > 0) return { kind: "overlap", id: clash[0].id };
    return {
      kind: "started",
      id: createFastRow(profileId, utcInstant(start), null, note),
    };
  });
}

export type EndFastOutcome =
  | { kind: "ended"; id: number; startedAt: string; endedAt: string }
  // Nothing is running — a stale page, or the fast was ended on another device. This is
  // also the answer the food-log prompt's race resolves to: accepting after the fast was
  // ended elsewhere re-derives, finds nothing active, and REPORTS that rather than
  // confirming unconditionally.
  | { kind: "none-active" }
  // The proposed end is at or before the start, or in the future.
  | { kind: "invalid" };

// End the active fast at `endedAt` (default now). NO life-stage gate, by the registered
// exemption above: a profile that became restricted mid-fast must still be able to close
// the row out. See this module's header for the full reasoning.
export function endFast(profileId: number, endedAt?: Date): EndFastOutcome {
  return writeTx(() => {
    const at = clockNow();
    const end = endedAt ?? at;
    const active = getActiveFast(profileId);
    if (!active) return { kind: "none-active" };
    const start = parseUtcSql(active.started_at);
    if (!start) return { kind: "invalid" };
    if (end.getTime() <= start.getTime()) return { kind: "invalid" };
    if (end.getTime() > at.getTime()) return { kind: "invalid" };
    const endInstant = utcInstant(end);
    updateFastRow(
      profileId,
      active.id,
      active.started_at,
      endInstant,
      active.note
    );
    return {
      kind: "ended",
      id: active.id,
      startedAt: active.started_at,
      endedAt: endInstant,
    };
  });
}

export type ReopenFastOutcome =
  | { kind: "reopened"; id: number }
  | { kind: "not-found" }
  // Something else was started in the meantime, so there is no room to reopen into.
  | { kind: "already-active"; id: number };

// UNDO an end (#2756): clear `ended_at` on a fast that was just closed, putting the
// state back exactly where it was. The inverse of `endFast` is complete and local — one
// column, one row, no side state — which is what makes an Undo affordance honest here
// rather than an approximation of one.
//
// Deliberately targets a NAMED id (the one the end just returned) rather than "the most
// recently ended fast": this is the inverse of a specific write, not a general reopen,
// and resolving it by recency could resurrect last week's fast from a stale page. It
// carries no life-stage gate for the same reason `endFast` carries none — it restores
// the state the exempt path produced, and refusing it would strand the user one step
// further along than refusing the end would have.
export function reopenFast(profileId: number, id: number): ReopenFastOutcome {
  return writeTx(() => {
    const active = getActiveFast(profileId);
    if (active) return { kind: "already-active", id: active.id };
    const row = getFast(profileId, id);
    if (!row || row.ended_at === null) return { kind: "not-found" };
    updateFastRow(profileId, id, row.started_at, null, row.note);
    return { kind: "reopened", id };
  });
}

export type DiscardFastOutcome =
  | { kind: "discarded"; id: number }
  | { kind: "not-found" };

// DISCARD a fast — "I never actually fasted". The stale suggest's second resolution,
// beside "end it at a backdated instant"; the two are different truths and the app is
// not entitled to pick between them, which is why detection SUGGESTS and the tap writes.
// Exempt from the life-stage gate on the same harm-reduction reasoning as `endFast`:
// this removes fasting data, it never records any.
export function discardFast(
  profileId: number,
  id: number
): DiscardFastOutcome {
  return writeTx(() => {
    const row = getFast(profileId, id);
    if (!row) return { kind: "not-found" };
    return deleteFastRow(profileId, id) > 0
      ? { kind: "discarded", id }
      : { kind: "not-found" };
  });
}

export type EditFastOutcome =
  | { kind: "saved"; id: number }
  | { kind: "not-found" }
  | { kind: "overlap"; id: number }
  | { kind: "invalid" }
  | { kind: "refused" };

// Correct a COMPLETED fast's instants — the "food log deleted after it triggered an
// accepted end" recovery beyond the Undo window, and the ordinary typo fix. Gated:
// editing a completed fast's interval is recording fasting content, not closing out,
// so it is on the `startFast` side of the asymmetry rather than the `endFast` side.
export function editFast(
  profileId: number,
  id: number,
  startedAt: Date,
  endedAt: Date,
  note: string | null = null
): EditFastOutcome {
  if (fastAdultOnlyRefusal(profileId)) return { kind: "refused" };
  return writeTx(() => {
    const row = getFast(profileId, id);
    if (!row) return { kind: "not-found" };
    const at = clockNow();
    if (endedAt.getTime() <= startedAt.getTime()) return { kind: "invalid" };
    if (endedAt.getTime() > at.getTime()) return { kind: "invalid" };
    if (endedAt.getTime() - startedAt.getTime() > FAST_MAX_HOURS * 3_600_000)
      return { kind: "invalid" };
    const clash = overlappingFasts(
      listFasts(profileId),
      startedAt.getTime(),
      endedAt.getTime(),
      id
    );
    if (clash.length > 0) return { kind: "overlap", id: clash[0].id };
    updateFastRow(
      profileId,
      id,
      utcInstant(startedAt),
      utcInstant(endedAt),
      note
    );
    return { kind: "saved", id };
  });
}

// The active fast, or null — the ONE read every derivation asks (#2757's stand-down
// included). Re-exported here so a caller needs the write module OR the store, never
// both, and so the stand-down predicate has a single import to name.
export function activeFast(profileId: number): Fast | null {
  return getActiveFast(profileId);
}
