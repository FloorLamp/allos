// The UNCONFIRMED IMPORTED MEDICATION escape hatch (issue #2574). Pure and
// client-safe — no DB, no network.
//
// THE PROBLEM. A medication imported from a clinical document nudges every morning at
// `must`, has never once been logged — neither taken nor skipped — and nothing in the
// app ever asks whether it is still current. The import is faithful: the source states
// the med Active with no end date and a scheduled sig, so `must` + active is the right
// read of the document. The DOCUMENT is stale, because an EHR routinely never marks a
// course prescribed during an acute illness discontinued. Nothing downstream revisits
// it, so the reminder outlives the prescription indefinitely.
//
// WHY THE EXISTING DETECTOR CANNOT HELP, and must not be changed to. The demotion engine
// (lib/supplement-demotion.ts) exempts MEDICATIONS entirely: poor med adherence is a
// missed-dose escalation concern, never an obligation question, and you do not want the
// app suggesting someone downgrade a real antihypertensive because their logging is
// sloppy. That exemption is correct and is untouched here. Its consequence is that a
// medication genuinely STOPPED is indistinguishable from one badly adhered to, and the
// app resolves every such case as the second, forever.
//
// THE SIGNAL IS NOT ADHERENCE, which is what makes this predicate disjoint from that one
// rather than a hole in it:
//
//   kind = medication  AND  import-provenanced  AND  ZERO lifetime logs
//                      AND  enough scheduled occurrences to have noticed.
//
// Zero is the whole claim. Not a low rate — no engagement of any kind, ever, on an item
// no user tap created. One skip IS engagement, and one skip removes the offer: a person
// who has told the app "not today" about this medication is a person for whom this is a
// live medication being managed, and the adherence machinery owns them from there.
//
// WHAT IT PRODUCES AND WHAT IT MAY NEVER DO. It produces a per-item FLAG that puts one
// more button on a dose reminder that was already being sent. It is not a Finding: no
// dedupeKey, no suppression bus, no registry entry, no send of its own. It adds no
// contact — the nudge is happening anyway and the offer rides it, which is the
// ride-the-nag corollary of the contact-consent rule, and it puts the exit on the very
// message doing the interrupting rather than on a screen the user has to go find.
//
// DETECTION SUGGESTS; THE TAP WRITES. There is no auto-apply here or downstream. The
// button reduces nudging on a MEDICATION, so a mis-tap silences a real reminder — and
// the gate is what makes that acceptable. The offer can only appear on an item nobody
// has ever taken or skipped, and it disappears the moment anyone does either. It must
// never appear on a medication with any engagement history.
//
// ── The #2385 declaration ────────────────────────────────────────────────────
// This feature claims to change behaviour, so it declares its own falsification. Local
// queries over data the instance already holds; no telemetry, no score, no pipeline.
//
// WHAT WOULD SHOW IT WORKING. `medication_courses` gains stops whose items have zero
// rows in `intake_item_logs` — the population this detector names — and the profile's
// count of active, import-provenanced, never-logged medications falls and stays down.
// Paired with the negative that makes it meaningful: `restartMedicationCourse` on those
// same items stays at zero, so nobody is having to undo a stop they did not mean.
//
// WHAT WOULD SHOW IT WRONG. A stopped item is RESTARTED, or — worse and quieter — the
// same drug reappears as a new `intake_items` row shortly after, because the person
// stopped the reminder and then had to re-add the medication they were actually taking.
// Either says the gate read "never logged" as "not in use" for someone who simply does
// not log, and the answer is to raise the occurrence floor or retire the button, not to
// soften the copy.
//
// THE DECEPTIVE SUCCESS. **Total dose sends fell.** It is guaranteed to improve, it
// improves monotonically with how much the button is tapped, and it improves FASTEST
// exactly when the feature is wrong — a button that over-silences removes the most
// reminders. "Fewer interruptions" and "we stopped reminding someone about a medication
// they take" are the same number. The paired measure is the adherence ledger on the
// items that were NOT stopped: sends falling while logging on surviving medications
// holds is the feature working; sends falling while logging falls with them is the harm
// wearing the same number.
//
// The safety-signal exception in §9 of the doctrine cuts the other way here and is worth
// stating: the dose reminder itself carries no such declaration and can never be retired
// because a measure looked flat. This is a declaration about the BUTTON, not about the
// reminder it rides.

import { isPushedIntake } from "./intake-schedule";
import type { AdherenceDot } from "./intake-adherence";
import type { IntakeItemKind, IntakeObligation } from "./types";

// ---- Provenance ------------------------------------------------------------

// The `intake_items.source` value a document import writes. A row carrying it was
// created by an extraction, never by a user tap — which is the half of the evidence
// that distinguishes "the app was told about this" from "somebody entered this".
export const IMPORTED_SOURCE = "extracted";

// Whether this row came from a document import rather than a person. Deliberately
// keyed on `source` alone and not on `document_id`: reassignment and reprocessing move
// the document link, and the question here is who CREATED the row, which never changes.
export function isImportProvenanced(item: { source: string | null }): boolean {
  return item.source === IMPORTED_SOURCE;
}

// ---- Window + threshold ----------------------------------------------------

// How many trailing days the occurrence count reads. Thirty, the same span the sibling
// demotion detector uses, and for the same reason: long enough that a quiet fortnight
// cannot alone carry a claim, short enough that a course abandoned in real life is
// noticed this month rather than next quarter.
export const UNCONFIRMED_WINDOW_DAYS = 30;

// The scheduled occurrences inside that window before the offer appears at all — the
// cold-start guard. Below this the item has simply not been due often enough for
// "nobody has ever engaged with it" to mean anything; an item imported yesterday has
// had one morning, and offering to stop it then would be the app second-guessing a
// prescription it just read.
//
// A SPARSE SCHEDULE IS OUT OF SCOPE BY CONSTRUCTION, and that is the conservative
// direction. A weekly medication accrues about four occurrences in the window and never
// reaches this floor, so it never gets the button. That is the same shape the demotion
// detector's floor gives a weekly supplement, and it errs toward leaving a reminder
// standing — which is the only direction a safety-adjacent offer may err in.
export const UNCONFIRMED_MIN_OCCURRENCES = 10;

// ---- Types -----------------------------------------------------------------

// One item's slice of the evidence. `strip` is the ITEM-LEVEL adherence strip the
// Supplements page renders and the demotion detector reads — the same per-day
// aggregation, so the offer can never disagree with the strip the user is looking at.
export interface UnconfirmedMedInput {
  itemId: number;
  name: string;
  // Clinical identity. Read ONLY to require a medication — the mirror image of the
  // demotion detector, which reads it only to refuse one.
  kind: IntakeItemKind;
  // Provenance: `extracted` for a document import, `manual` (or null, on legacy rows)
  // for a row a person created.
  source: string | null;
  obligation: IntakeObligation;
  active: boolean;
  strip: AdherenceDot[];
  // Lifetime logs of EITHER status for this item, across every dose it has ever had.
  // Not a windowed count: the claim is that nothing has ever happened here.
  lifetimeLogs: number;
}

export interface UnconfirmedMedication {
  itemId: number;
  name: string;
  // The evidence, kept as DATA so each surface writes its own phrasing.
  occurrences: number;
}

// ---- Detection -------------------------------------------------------------

// A day counts as an occasion only when the item was actually DUE and the day was not a
// deliberate skip — the same definition of "an occurrence" the adherence percentage and
// the demotion detector use, so a cadence-gated off-day (#1602 scores it "na") is not an
// occasion and a sparse schedule cannot read as abandonment.
function isOccurrence(dot: AdherenceDot): boolean {
  return dot.state !== "na" && dot.state !== "skipped";
}

// The offer for one item, or null. Null is the overwhelmingly common answer, and it is
// also how the offer CLEARS: the moment any dose is taken or skipped the lifetime count
// leaves zero and this returns null on the next gather. Nothing stored, nothing to
// expire, no stale button that outlives its own evidence.
export function detectUnconfirmedMedication(
  input: UnconfirmedMedInput
): UnconfirmedMedication | null {
  // MEDICATIONS ONLY — the exact complement of the demotion detector's refusal, which
  // is what makes the two flags disjoint by construction rather than by coordination.
  // A supplement nobody logs is a priority question and already has an answer.
  if (input.kind !== "medication") return null;
  // IMPORT-PROVENANCED ONLY. A medication somebody typed in is a medication somebody
  // decided to track; the absence of logs says something about their logging, not about
  // the prescription. The whole argument for this offer is that no user action ever
  // asserted this item.
  if (!isImportProvenanced(input)) return null;
  // Only an item that is actually nudging has anything to stop. A `may` item is never
  // scheduled-due, so it interrupts nobody and there is no complaint to answer.
  if (!isPushedIntake(input)) return null;
  // A paused or already-stopped item is not reminding either.
  if (!input.active) return null;
  // ANY ENGAGEMENT, EVER, ENDS IT. One skip is a decision on the record (#232) and one
  // dose taken is plainly a live medication. This is the line the whole offer rests on
  // and it is checked before the window is even looked at.
  if (input.lifetimeLogs > 0) return null;

  const occurrences = input.strip.filter(isOccurrence).length;
  if (occurrences < UNCONFIRMED_MIN_OCCURRENCES) return null;

  return { itemId: input.itemId, name: input.name, occurrences };
}

// Every offer across a profile's items, deterministic (by name, then item id).
export function detectUnconfirmedMedications(
  inputs: readonly UnconfirmedMedInput[]
): UnconfirmedMedication[] {
  return inputs
    .map(detectUnconfirmedMedication)
    .filter((c): c is UnconfirmedMedication => c != null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.itemId - b.itemId);
}

// ---- The tap's outcome -----------------------------------------------------

// The stop reason a tap records. The button collects no reason — it exists to make the
// exit one tap from the interruption — and `normalizeStopReason` folds anything
// unrecognised to `other`, so a stop always carries some reason and never a dangling
// null. The reply points at where to name a real one; the record is completable later.
export const UNCONFIRMED_STOP_REASON = "other";

// What a tap did. The four `stopMedicationCourses` outcomes, plus the one refusal this
// offer owns:
//
//   `withdrawn` — the button is stale and the OFFER is gone. A message sits in a chat
//   indefinitely, and in the meantime the person may have taken or skipped a dose, or
//   stopped the med from the web. Any of those ends the claim the button was making, so
//   the handler re-derives candidacy from the live detector before it writes anything
//   and refuses here. This is the same discipline the right-size tap uses — never read
//   an assertion off a button — and here it is the load-bearing safety property: it is
//   what makes "this can only appear on a medication with no engagement history" true
//   of the TAP and not merely of the render.
export type UnconfirmedStopOutcome =
  "stopped" | "already-stopped" | "synced" | "not-found" | "withdrawn";

// One line of copy per outcome, shared by every surface that runs this tap so two
// callers cannot describe one result differently. The refusals are not decoration: a
// stale message tapped twice, or an item stopped from the web in between, must SAY so
// rather than claim it did something (the inline-action contract).
//
// `synced` is the repair case — no open course but the live flag still set — and it is
// reported as a stop because that is what the person asked for and what they now have.
//
// The success line NAMES WHERE TO FINISH THE RECORD in words rather than as a link. A
// callback answer is a plain-text toast: Telegram renders no link inside one, so a URL
// here would be a string the reader cannot tap. The stop carries `other` as its reason
// and the Medications page completes it — which is the point of saying so, and is the
// #1718 rule applied to a channel that strips something other than buttons.
export const UNCONFIRMED_STOP_TEXT: Record<UnconfirmedStopOutcome, string> = {
  stopped:
    "Stopped — no more reminders. Add a reason, or restart it, on Medications.",
  "already-stopped": "Already stopped — nothing to change.",
  synced:
    "Stopped — no more reminders. Add a reason, or restart it, on Medications.",
  "not-found": "That medication is no longer available.",
  withdrawn:
    "This medication has been logged or changed since — its reminders are unchanged.",
};
