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
// it is "NO FASTING CONTENT COMES TO EXIST for a restricted profile". Those are
// different, and reading the gate as the first one is how a hole opens: `ended_at IS
// NULL` is this module's own definition of active, so CLEARING that column is a way of
// causing an active fast to exist, with no INSERT anywhere in sight. The rule, stated so
// it can be applied to a core that does not exist yet:
//
// THE MEASURE IS THE INTERVAL THE ROW REPRESENTS, and stating it any other way breaks one
// of the four cores. An ACTIVE row represents [start, now] — it is a fast in progress, and
// it GROWS on no input at all. A completed row represents [start, end]. Then:
//
//   GATED   — every core that can leave a profile with MORE recorded fasting than it had.
//             `startFast` (nothing → an interval that starts growing) and `reopenFast`
//             (a fixed [start, end] → [start, now] and growing again) are on this side.
//             `editFast` is on it for the other half of the same property: it takes the
//             instants of a recorded interval from a user, so it can lengthen a fast as
//             easily as shorten one. It opens no row and closes none — which is exactly
//             why an insert-shaped or active-count-shaped reading would wave it through.
//   EXEMPT  — cores that can only SHRINK that interval, whatever their input.
//             `endFast` takes [start, now] to [start, e] with `e` bounded above by now, so
//             the interval it leaves is never longer than the one it found — a backdated
//             end makes it shorter, and no input makes it longer. `discardFast` takes the
//             interval to nothing at all.
//
// THAT CLAUSE IS LOAD-BEARING AND WAS MISSING FOR ONE REVISION. Written as "no input could
// make them enlarge it", the criterion is literally false of `endFast`: it takes `endedAt`
// off a form and can turn an open row into a 36-hour RECORDED fast whose duration the
// caller chose. Measured against the interval the row already represented — [start, now]
// — that write is a reduction, every time. The old active-COUNT reading got the same
// answer here by accident and got `editFast` wrong, which is why the criterion is stated
// over the interval instead.
//
// WHAT THE EDIT'S GATE COSTS A RESTRICTED PROFILE, STATED HONESTLY BECAUSE IT IS NOT
// NOTHING. A revision of this comment claimed it cost nothing, and this module's own test
// fixture is the counterexample: a profile that becomes restricted mid-fast and closes out
// a fast the clock has grown past FAST_MAX_HOURS — the harm-reduction path the exemption
// above MANDATES — is left with a permanent over-long recorded row. `editFast` refuses it
// (this gate), `reopenFast` refuses it (the same gate), `discardFast` refuses it (already
// closed), and `FoodTab` draws that profile no card once nothing is active. It is the
// #2993 artifact, on the population the gate protects, and the only remaining exit is Data
// → Manage's generic row DELETE — which is the remedy #2993's ruling overruled, because
// removing the row asserts the fast never happened.
//
// The residue is BOUNDED and it is not this core's to fix. The row renders nowhere for
// that profile (`lib/queries/fasting.ts` is the only reader of `fasts`, and `FoodTab`
// gates it), and it blocks only backdated starts, which the gate refuses anyway. Ungating
// the edit would hand a restricted profile a fasting-content editor, and drawing history
// on the close-out surface would make it a tracker — #2756 ruled both out. Closing it
// properly is an IA decision about what the close-out surface offers, so it is REPORTED
// rather than decided here, and pinned by a test so it cannot be quietly claimed away.
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
//   `editFast` CARRIES it too, and carries `startFast`'s OTHER bound with it. It is the
//   one core where the instants of a recorded interval arrive from a form, so it mints a
//   claim outright, and a length-only ceiling turned out to bound the wrong quantity:
//   `startFast` also refuses a start further BACK than FAST_MAX_HOURS, so a length-only
//   edit accepted `(3 years ago, 3 years ago + 10 d)` — a row `startFast` refuses,
//   produced by a core, which is this chain's signature defect. Both bounds apply, and
//   they apply to an instant the user NAMES; an instant left alone is not re-judged,
//   which is what keeps the 360-hour row this core exists for correctable. See `editFast`.
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
// tap. The SURFACE does not draw that Undo, because `endFastAction` withholds the id it
// needs for exactly this refusal, so this one guards a stale tab rather than answering a
// button anyone can see.
//
// THE OTHER FOUR REFUSALS ARE NOT COVERED THAT WAY, AND MUST NOT BE READ AS IF THEY
// WERE. Withholding the id is a claim about ONE of them; the sentence above said so for
// a revision in which it was read as a claim about all five, which is how the Undo came
// to be drawn beside a `too-old`. What actually makes the offer exact is that the other
// four are FALSE AT THE MOMENT THE END COMMITS, by construction rather than by being
// asked: `too-old` measures from that very write (`end_written_at`, below), `not-found`
// names the row `endFast` just closed, `already-active` needs a fast running and the end
// just cleared the only one, and `overlap` needs a fast recorded after this one, which
// could not have been started while this one was open. Each can become true AFTERWARDS —
// another device, another tab, a window that elapses — and each is re-derived here under
// the write lock, which is what the typed refusals are for. The offer is exact about the
// state it was made in, and honest about the state it lands in.

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
  updateFastInterval,
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
    // No end, and therefore no end stamp — the two are ONE argument, so an open row
    // cannot carry half of them.
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
    // The claimed end AND the clock reading of this write, together. `end` may be
    // backdated by hours; `at` is when the user actually did this, and it is what the
    // Undo's age bound reads — see `reopenFast`.
    const endInstant = utcInstant(end);
    updateFastRow(
      profileId,
      active.id,
      active.started_at,
      { at: endInstant, writtenAt: utcInstant(at) },
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
  // The end was WRITTEN longer than FAST_REOPEN_MAX_MINUTES ago. Past that this is no
  // longer an Undo of a write the user just made, it is the resurrection of finished
  // history. Measured from the write, never from the instant the end NAMES — see below.
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
//   • AGE — only an end WRITTEN inside FAST_REOPEN_MAX_MINUTES, read from
//     `end_written_at` rather than from `ended_at`. Naming an id rather than resolving
//     by recency was never sufficient on its own: an id IS an arbitrary handle, so
//     without an age bound this core resurrects last week's fast exactly as the recency
//     version would have, which is the failure the id was chosen to avoid.
//
//     WHICH INSTANT THIS MEASURES IS THE WHOLE CHECK, and reading `ended_at` for it was
//     wrong in a way that looked right for one revision. An Undo takes back an ACTION,
//     and the action happened now whatever time it recorded. `ended_at` is a CLAIM about
//     when the fast stopped, and the surface asks for a backdated one out loud — "End it
//     at the time you actually stopped". So a backdated end blew the age bound the
//     microsecond the write landed: an end backdated 16 minutes answered `too-old` on
//     the Undo drawn beside it, deterministically, and behind that refusal was F1's
//     whole damage list again — discard refuses a completed row, there is no edit core,
//     and the permanent long row answers `overlap` to backdated starts. The plain path
//     only ever worked because `ended_at ≈ now` there, which is an accident of that
//     path and not a property of the check. `end_written_at` is the app's own clock at
//     the write, so the bound now measures the thing its name claims.
//   • OVERLAP — a reopened fast is open, so it runs to +infinity and must clear
//     everything recorded after it. Re-checked here against fresh rows.
//
// AND DELIBERATELY NOT BY DURATION. A third check held the restored interval to
// FAST_MAX_HOURS, and it could only ever fire AFTER the age bound had already passed —
// i.e. on a row this app wrote and accepted within the last quarter hour. What it
// actually did was make the Undo beside every long end a button whose every tap was
// refused, with no way back. See the module header.
//
// THE PREMISE THAT SENTENCE ORIGINALLY RESTED ON WAS "the interval is not a claim
// arriving from a user", AND #2993's EDIT CORE MADE THAT FALSE. An edit can rewrite
// `started_at` on a row that is still inside its Undo window, so inside the quarter hour
// the interval became exactly a user's claim — and start / end / edit-three-years-back /
// reopen / end again walked out with a row 78× this ceiling, every step a typed success.
// That is #2981's guard invalidated by a later PR's feature, which is why the fix went
// where the claim is made rather than here.
//
// THE PREMISE THAT REPLACES IT IS A PROPERTY OF THE WHOLE MODULE, and it is what this
// core is now entitled to lean on: every `started_at` that can reach this function was,
// at the moment it was WRITTEN, inside FAST_MAX_HOURS of the clock — or was already on
// the row and merely carried forward while the clock grew it. Only two writers ever set
// one (`createFastRow` from `startFast`, and `editFast`), and both apply that same bound
// to it; `endFast` and this core pass the stored string through untouched. So the longest
// interval any composition of these cores can record is the one the clock itself
// produced, which is precisely what a duration ceiling here could not improve on and what
// `endFast` already documents as its own reason for carrying none.
export function reopenFast(profileId: number, id: number): ReopenFastOutcome {
  if (fastAdultOnlyRefusal(profileId)) return { kind: "refused" };
  return writeTx(() => {
    const at = clockNow();
    const active = getActiveFast(profileId);
    if (active) return { kind: "already-active", id: active.id };
    const row = getFast(profileId, id);
    if (!row || row.ended_at === null) return { kind: "not-found" };
    const started = parseUtcSql(row.started_at);
    if (!started) return { kind: "not-found" };
    // The write stamp is NULL only for a closed row this module did not write — nothing
    // constructs one today, and the pair being one argument keeps it that way — so the
    // answer for "closed, but nobody recorded when" is the same as for an ancient end:
    // this is not an Undo of a write the user just made.
    const written = row.end_written_at ? parseUtcSql(row.end_written_at) : null;
    if (!written) return { kind: "too-old" };
    if (at.getTime() - written.getTime() > FAST_REOPEN_MAX_MINUTES * 60_000)
      return { kind: "too-old" };
    const clash = overlappingFasts(
      listFasts(profileId),
      started.getTime(),
      null,
      id
    );
    if (clash.length > 0) return { kind: "overlap", id: clash[0].id };
    // Both halves of the end go away together: the row is active again, so there is no
    // end for a write stamp to describe.
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

export type EditFastOutcome =
  | { kind: "saved"; id: number }
  | { kind: "not-found" }
  // The named row is RUNNING, not recorded history — it was reopened elsewhere since the
  // control was drawn. `discardFast`'s `already-ended` from the other direction: the id
  // the form carries has to mean at commit what it meant at render.
  | { kind: "still-active"; id: number }
  // The corrected interval collides with another recorded fast. The row being edited is
  // excluded from that scan — a fast always overlaps itself.
  | { kind: "overlap"; id: number }
  // End at or before start (AT THE STORED SECOND), an instant in the future, an interval
  // past FAST_MAX_HOURS, or a NAMED start further back than `startFast` would accept.
  | { kind: "invalid" }
  // Neither instant was named, so there is no correction to make. Its own kind rather
  // than a silent success: "Fast updated." over a write that changed nothing is the
  // unconditional confirmation the stateful-write registry exists to end.
  | { kind: "unchanged"; id: number }
  // The life-stage gate refused — this core is GATED, see the module header.
  | { kind: "refused" };

// CORRECT a recorded fast's instants (#2993, and #2756's "beyond it, a completed fast's
// instants stay editable").
//
// WHY THIS EXISTS AT ALL, since it was deleted once as unreachable and the deletion cost
// five review rounds: a fast recorded as 15 days long is almost always a mis-set date
// rather than a fiction, and past the Undo window the app had nothing to say about it —
// reopen answers `too-old`, discard refuses a completed row, and the permanent row then
// answers `overlap` to every backdated start inside the fortnight it covers. EDITING is
// the honest remedy and DELETING is not: removing the row asserts the fast never
// happened, while correcting its end asserts what actually did. That is the same
// distinction the stale suggest already refuses to pick for the user.
//
// EACH INSTANT IS OPTIONAL, AND AN UNNAMED ONE IS NOT REWRITTEN. This is the `note` rule
// applied to the columns the button is actually about, and it was missing for one
// revision: the form prefills each field with the row's own value at MINUTE grain, so a
// "Save times" that posted both fields rewrote whatever the user did not touch — the
// stored seconds truncated away (`17:03:49Z` → `17:03:00Z`) on every single save, an hour
// lost across a DST fall-back, and a whole offset lost if the profile's zone changed
// between the render and the submit. A field the user did not touch is not a claim they
// are making, so it does not reach the row: the unnamed instant is written back from the
// row's own STRING, not from a re-serialized parse of it, and survives byte-for-byte.
//
// `note` is likewise read off the row and written back — the requirement is that a
// completed fast's INSTANTS stay editable, and a note-shaped parameter with no field
// behind it would blank the column on every save.
//
// A NAMED START CARRIES `startFast`'s BOUNDS, NOT JUST THE LENGTH CEILING. This is the
// hole the length ceiling alone left open, and it was reachable two ways:
//
//   • WITHOUT any reopen — `startFast` refuses a start further back than FAST_MAX_HOURS,
//     while a length-only bound happily accepted `edit(3 years ago, 3 years ago + 10 d)`.
//     Three chained legal edits then fabricated 42 days of contiguous history, each row
//     one `startFast` would have refused outright. A core producing a row its sibling
//     refuses is this PR chain's signature defect, and the ceiling was carried here to
//     prevent exactly that.
//   • THROUGH the Undo — start, end, edit the pair to a legal 10-day interval three years
//     back, reopen (the stamp is untouched, so `too-old` still passes), end again. Every
//     step a typed success, and the row came out at 78× the ceiling, because `endFast`
//     writes `now` against whatever `started_at` the row now carries.
//
// So the rule is stated over the INSTANT rather than over the interval: a start the user
// NAMES is judged exactly as `startFast` judges one — not in the future, not further back
// than FAST_MAX_HOURS. A start the user does NOT name is left alone, which is what keeps
// the 15-day row this core exists for correctable: its start is 360 h old precisely
// because the app let it grow, and re-judging it as a fresh claim would refuse the one
// correction #2993 asked for.
//
// WHAT THAT BUYS THE WHOLE MACHINE, since `reopenFast` leans on it: every `started_at`
// this module can store was, at the moment it was WRITTEN, inside FAST_MAX_HOURS of the
// clock — or was already on the row and merely carried forward. `createFastRow` (from
// `startFast`) and this core are the only two writers that ever set one; `endFast` and
// `reopenFast` pass the stored string through untouched. So no composition of these cores
// can record an interval longer than the clock itself produced.
//
// IT CANNOT MINT AN ACTIVE FAST, which is the invariant the partial unique index and
// every reader downstream assume. It writes through `updateFastInterval`, whose statement
// cannot set `ended_at` to NULL and whose WHERE refuses an already-open row; and the row
// it accepts is re-read as CLOSED under the write lock, so an id reopened since the
// control was drawn gets `still-active` rather than being silently closed again at a time
// the user never chose.
//
// AND IT DOES NOT TOUCH `end_written_at` — the store statement does not name the column.
// The stamp bounds the UNDO OF AN END, and an edit is not an end: it closes nothing, so
// re-closing the Undo's clock would open a fifteen-minute reopen window on a write that
// has no Undo anywhere. Because the column is untouched rather than recomputed, the rule
// holds without a caveat: AN EDIT NEVER LEAVES A ROW MORE REOPENABLE THAN IT FOUND IT —
// including the row this module cannot itself create, a closed one whose stamp is NULL,
// which `reopenFast` reads as `too-old` before and after.
export function editFast(
  profileId: number,
  id: number,
  startedAt?: Date,
  endedAt?: Date
): EditFastOutcome {
  if (fastAdultOnlyRefusal(profileId)) return { kind: "refused" };
  return writeTx(() => {
    const at = clockNow();
    const row = getFast(profileId, id);
    if (!row) return { kind: "not-found" };
    if (row.ended_at === null) return { kind: "still-active", id };
    if (startedAt === undefined && endedAt === undefined)
      return { kind: "unchanged", id };
    if (startedAt) {
      if (instantSeconds(startedAt) > instantSeconds(at))
        return { kind: "invalid" };
      if (at.getTime() - startedAt.getTime() > FAST_MAX_HOURS * 3_600_000)
        return { kind: "invalid" };
    }
    const start = startedAt ?? parseUtcSql(row.started_at);
    const end = endedAt ?? parseUtcSql(row.ended_at);
    if (!start || !end) return { kind: "not-found" };
    // Compared at the STORED second, like `endFast`: `utcInstant` truncates, so a
    // millisecond test would accept a pair that serializes to one zero-length row.
    if (instantSeconds(end) <= instantSeconds(start))
      return { kind: "invalid" };
    if (instantSeconds(end) > instantSeconds(at)) return { kind: "invalid" };
    if (end.getTime() - start.getTime() > FAST_MAX_HOURS * 3_600_000)
      return { kind: "invalid" };
    const clash = overlappingFasts(
      listFasts(profileId),
      start.getTime(),
      end.getTime(),
      id
    );
    if (clash.length > 0) return { kind: "overlap", id: clash[0].id };
    updateFastInterval(
      profileId,
      id,
      startedAt ? utcInstant(startedAt) : row.started_at,
      endedAt ? utcInstant(endedAt) : row.ended_at,
      row.note
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
