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
// THE LINE THE GATE ACTUALLY DRAWS. The property protected is not "no row is INSERTed";
// it is "NO ACTIVE FAST COMES TO EXIST for a restricted profile". Those are different,
// and reading the gate as the first one is how a hole opens: `ended_at IS NULL` is this
// module's own definition of active, so CLEARING that column is a way of causing an
// active fast to exist, with no INSERT anywhere in sight. The rule, stated so it can be
// applied to a core that does not exist yet:
//
//   GATED   — every core that can leave a profile with an active fast it did not have.
//             `startFast` (creates one) and `reopenFast` (restores one by clearing
//             `ended_at`) are both on this side.
//   EXEMPT  — cores that STRICTLY REDUCE fasting state and can never enlarge it.
//             `endFast` (an active fast becomes a completed one) and `discardFast` (the
//             row goes away) are both on this side, and neither has any input that could
//             make it land on the other.
//
// THE EXEMPTIONS CLOSE A STRANDED-ROW TRAP. A birthdate edit that makes a profile
// restricted MID-FAST must not leave an active row nobody can close, which would leave
// the profile permanently mid-fast with its food nudges stood down (#2757) and no
// affordance anywhere to fix it. Closing out is harm-reduction, not tracking. That
// promise is only kept if the SURFACE also renders the close-out control for a
// restricted profile with an active fast — `FoodTab` does, and
// e2e/fasting-lifecycle.spec.ts pins it; a gate whose escape hatch is never rendered is
// the same stranded row with extra steps.
//
// ── THE SAME LINE BOUNDS DURATION — BUT ONLY WHERE A CLAIM IS ACTUALLY MINTED ───────
//
// FAST_MAX_HOURS is a ceiling on what the app accepts as a CLAIM about an interval,
// because past 14 days a claim is far likelier to be a mis-set date than a fast. It is
// NOT a ceiling on how long a fast the app WATCHED run may be, and it cannot be: an
// active row grows with the clock, on no input at all, and refusing to close it does not
// shorten it. Core by core:
//
//   `startFast` CARRIES the ceiling. A backdated start takes its interval FROM INPUT, so
//   it can honestly answer "that's too far back — pick a shorter one".
//   `endFast` carries NONE. The end it writes is at most `now`, so the interval it stores
//   is at most the one the row ALREADY has. A duration refusal there prevents no long
//   interval; it only prevents a long interval from being CLOSED, which is the stranded
//   row above wearing a new excuse.
//   `reopenFast` carries NONE either, which is not an exception to the rule but the rule
//   applied honestly. Its duration check sat immediately after `too-old`, so it was
//   reachable ONLY inside FAST_REOPEN_MAX_MINUTES — on a row the app itself wrote seconds
//   ago and had already accepted. An Undo tapped half a minute after an accepted end is
//   not a user claiming an interval; it is the restoration of a state the app was in half
//   a minute ago. `too-old` is what separates an Undo from an arbitrary reopen, and it
//   does the whole of that job.
//
// BOTH of those refusals shipped here, one revision each, and both did real harm — worth
// recording, because neither guard looked wrong from inside the function it lived in:
//
//   A ceiling in `endFast` stranded a restricted profile past 14 days: `too-long` on
//   every tap of the ONE control its surface draws, no backdate field and no discard
//   beside it. Locally it read as "`startFast` and `endFast` cannot disagree about which
//   intervals are storable" — true of the pair, false of the system, since only one of
//   the two ever takes an interval from a user.
//
//   A ceiling in `reopenFast` then made the Undo drawn beside every long end a dead
//   button. Deleting the first ceiling made "you have just ended a 15-day fast" an
//   ordinary outcome of the forgotten fast — the exact case the stale suggest exists to
//   surface — and the app answered its own Undo with "That fast would be too long to
//   reopen." Nothing recovered from there: reopen refused, discard refuses a completed
//   row, and the permanent long row then answered `overlap` to every backdated start
//   inside the fortnight the field can reach. The Undo is now the way back, and it lands
//   in the state the stale suggest handles: an active over-long fast, with an honest
//   backdated end and Discard both on screen.
//
// `reopenFast` remains GATED on LIFE STAGE, and that is a deliberate cost: a restricted
// profile's Undo-after-end is refused. Restoring an active fast for that profile is
// exactly what the gate forbids, and the user loses one undo of a write they had just
// chosen to make — a far smaller harm than the app re-creating the restricted state on
// tap. The SURFACE does not draw that Undo (the action withholds the id it needs), so
// the refusal guards a stale tab rather than answering a button anyone can see.

import { now as clockNow } from "./clock";
import { utcInstant, parseUtcSql } from "./date";
import { writeTx } from "./db";
import {
  FAST_MAX_HOURS,
  FAST_REOPEN_MAX_MINUTES,
  instantSeconds,
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
  // The proposed end is at or before the start (AT THE STORED SECOND — see
  // `instantSeconds`), or in the future. These are the ONLY two refusals a caller can
  // provoke, and both are about the instant it supplied rather than about the interval
  // that already exists — see below.
  | { kind: "invalid" };

// End the active fast at `endedAt` (default now).
//
// NO life-stage gate, by the registered exemption above: a profile that became
// restricted mid-fast must still be able to close the row out.
//
// AND NO DURATION CEILING, which is the other half of the same promise and was missing
// for one revision. `end` is bounded above by `now` and the start is already stored, so
// the longest interval this core can write is exactly the one the clock has already
// produced — no input enlarges it. Refusing a 15-day interval here would therefore
// refuse to close a fast the system itself allowed to grow, which is the stranded row
// the exemption exists to prevent. The claim-side ceiling lives in `startFast` and
// `reopenFast`, where an interval actually arrives from a user. See this module's header.
//
// A plain end (no `endedAt` — the only write the restricted surface draws) is therefore
// refused only while the stored start second is still the current one, i.e. for under a
// second after a start. Nothing else about an active row can refuse it.
export function endFast(profileId: number, endedAt?: Date): EndFastOutcome {
  return writeTx(() => {
    const at = clockNow();
    const end = endedAt ?? at;
    const active = getActiveFast(profileId);
    if (!active) return { kind: "none-active" };
    const start = parseUtcSql(active.started_at);
    if (!start) return { kind: "invalid" };
    // Compared at the STORED second, not in milliseconds: `utcInstant` truncates, so an
    // end 400 ms after its start passes a millisecond test and then serializes to the
    // same string, storing a zero-length fast.
    if (instantSeconds(end) <= instantSeconds(start))
      return { kind: "invalid" };
    if (instantSeconds(end) > instantSeconds(at)) return { kind: "invalid" };
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
  | { kind: "already-active"; id: number }
  // The end is older than FAST_REOPEN_MAX_MINUTES. Past that this is no longer an Undo
  // of a write the user just made, it is the resurrection of finished history.
  | { kind: "too-old" }
  // Reopening would make this fast OPEN again — extending to +infinity — across a fast
  // recorded after it. That is the state the one-active invariant and every reader rule
  // out, and the id comes from a form, so it has to be checked rather than assumed.
  | { kind: "overlap"; id: number }
  // The life-stage gate refused — see below; this core is GATED, not exempt.
  | { kind: "refused" };

// UNDO an end (#2756): clear `ended_at` on a fast that was just closed, putting the
// state back exactly where it was.
//
// GATED, not exempt. Clearing `ended_at` is precisely how an ACTIVE fast comes to exist
// under this module's own definition of active, so for a restricted profile this is the
// thing the adult-only ruling forbids — reached, without the gate, through a button the
// app itself renders on the exempt end's confirmation. "It only clears a column" is a
// fact about the STATEMENT, not about the state it produces. See the module header.
//
// BOUNDED TWO WAYS, because `id` arrives from a form and each check below is the
// difference between an Undo and an arbitrary reopen:
//
//   • AGE — only an end inside FAST_REOPEN_MAX_MINUTES. Naming an id rather than
//     resolving by recency was never sufficient on its own: an id IS an arbitrary
//     handle, so without an age bound this core resurrects last week's fast exactly as
//     the recency version would have, which is the failure the id was chosen to avoid.
//   • OVERLAP — a reopened fast is open, so it runs to +infinity and must clear
//     everything recorded after it. Re-checked here against fresh rows.
//
// AND DELIBERATELY NOT BY DURATION. A third check held the restored interval to
// FAST_MAX_HOURS, and it could only ever fire AFTER the age bound had already passed —
// i.e. on a row this app wrote and accepted within the last quarter hour. That is not a
// claim arriving from a user, so the claim ceiling has nothing to say about it; what it
// actually did was make the Undo beside every long end a button whose every tap was
// refused, with no way back. See the module header. `startFast` still refuses a backdated
// interval past the ceiling, which is the one path where a user really does name one.
export function reopenFast(profileId: number, id: number): ReopenFastOutcome {
  if (fastAdultOnlyRefusal(profileId)) return { kind: "refused" };
  return writeTx(() => {
    const at = clockNow();
    const active = getActiveFast(profileId);
    if (active) return { kind: "already-active", id: active.id };
    const row = getFast(profileId, id);
    if (!row || row.ended_at === null) return { kind: "not-found" };
    const ended = parseUtcSql(row.ended_at);
    const started = parseUtcSql(row.started_at);
    if (!ended || !started) return { kind: "not-found" };
    if (at.getTime() - ended.getTime() > FAST_REOPEN_MAX_MINUTES * 60_000)
      return { kind: "too-old" };
    const clash = overlappingFasts(
      listFasts(profileId),
      started.getTime(),
      null,
      id
    );
    if (clash.length > 0) return { kind: "overlap", id: clash[0].id };
    updateFastRow(profileId, id, row.started_at, null, row.note);
    return { kind: "reopened", id };
  });
}

export type DiscardFastOutcome =
  | { kind: "discarded"; id: number }
  | { kind: "not-found" }
  // The named row is no longer RUNNING — it was closed in the meantime, on another
  // device or in another tab. The `none-active` of this core, and the reason it exists is
  // not a crafted id: the Discard button is drawn on the stale suggest for the ACTIVE
  // fast and carries that row's id, so a tab left open across an end elsewhere posts an
  // id that now names finished history. Deleting it would destroy a COMPLETED fast with
  // no confirmation and no undo while answering "Discarded." — the unconditional
  // confirmation the stateful-write registry exists to end. Every sibling transition here
  // re-derives under the write lock and answers with a typed refusal; this one now does
  // too, which is what made `already-active` catch the same stale tab's start.
  | { kind: "already-ended"; id: number };

// DISCARD a fast — "I never actually fasted". The stale suggest's second resolution,
// beside "end it at a backdated instant"; the two are different truths and the app is
// not entitled to pick between them, which is why detection SUGGESTS and the tap writes.
// Exempt from the life-stage gate on the same harm-reduction reasoning as `endFast`:
// this removes fasting data, it never records any.
//
// It discards the RUNNING fast only. That is not a narrowing of what the surface offers
// — discard is offered nowhere else, and no control anywhere deletes a completed fast —
// it is the staleness re-derivation that makes the id the form carries mean now what it
// meant at render.
export function discardFast(profileId: number, id: number): DiscardFastOutcome {
  return writeTx(() => {
    const row = getFast(profileId, id);
    if (!row) return { kind: "not-found" };
    if (row.ended_at !== null) return { kind: "already-ended", id };
    return deleteFastRow(profileId, id) > 0
      ? { kind: "discarded", id }
      : { kind: "not-found" };
  });
}

// The active fast, or null — the ONE read every derivation asks (#2757's stand-down
// included). Re-exported here so a caller needs the write module OR the store, never
// both, and so the stand-down predicate has a single import to name.
export function activeFast(profileId: number): Fast | null {
  return getActiveFast(profileId);
}
