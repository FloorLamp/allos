// WHAT A CARE OFFER ON A BASIS-LESS BIOMARKER MAY SAY FOR ITSELF (#2347).
//
// THE DEFECT. #2340 established that the biomarker detail page may only COLOUR a
// value when it can SHOW what judged it (`lib/biomarker-value-basis.ts`). A reading
// with no curated band, no source-printed range and no qualitative verdict now
// renders neutral: no colour, no caret, no severity word, not even an `sr-only` one.
// The page has stopped claiming that reading is abnormal.
//
// Two controls on that same page kept reading the STORED flag anyway. `canTrackFollowUp`
// (`isOutOfRange(latest.flag)`) offers a "Recheck" whose entire premise is that the
// reading is out of range, and the retest/staleness notice sits beside it. So the page
// said "we cannot support calling this abnormal" and then offered an affordance that
// exists only because something called it abnormal.
//
// THE RULING (owner, #2347 — option 3 of three). KEEP THE CONTROL, NAME ITS BASIS.
// The stored flag is REAL: with no curated band `reconciledFlag` returns `undefined`
// at `valueNum == null || !cb` (and again on a `ref === "unknown"` range), so it never
// overwrote what the import stored — the flag on a basis-less reading is the SOURCE
// RECORD'S own, not a judgment allos derived. The app being unable to DISPLAY a basis
// is not the same as there being none, and gating the offer would make a reading the
// lab itself flagged un-recheckable on the strength of a display rule. The
// contradiction is resolved by making the control honest, not by deleting either half
// — the same direction #2340 took: the fix is what the surface CLAIMS, never what it
// hides.
//
// REACH IS UNCHANGED, DELIBERATELY. This module adds no offer and removes none:
// `canTrackFollowUp` and `isBiomarkerStale` decide exactly what they decided before,
// and nothing here is consulted by a notification, a finding builder or an Upcoming
// generator. That matters because a recheck offer reaches Upcoming, so it is CARE
// behaviour under `docs/internals/findings.md`'s attention doctrine, whose
// contact-consent rule lets the system reduce contact unilaterally but never increase
// it. Annotating an offer that already renders is the doctrine's "enrich what it was
// already saying" case — the strictest thing a surface may do here — and a note that
// only appears where the page has ALREADY declined to judge cannot widen anything.
//
// THE COPY IS THE DELIVERABLE, so both rules it answers to are stated here:
//
//   • It must not RE-ASSERT the severity the page just declined to claim. Neither
//     sentence names a direction ("high", "low", "abnormal", "out of range"), and the
//     recheck note attributes the flag to the record rather than speaking it in the
//     app's own voice. Saying WHERE a premise came from is not the same as endorsing it.
//   • It must not read as an ERROR. Nothing is broken: a lab flagged a result and
//     allos publishes no band for that analyte, which is an ordinary, explainable
//     state — so the copy explains rather than apologizes, and neither note carries a
//     "cannot" / "missing" / "unavailable".
//
// THE STALENESS SURFACE, HANDLED IN THE SAME CHANGE (the issue's binding scope note).
// It is NOT the same contradiction, and the difference is worth stating because it
// decides the copy:
//
//   `isBiomarkerStale` never DERIVES staleness from the flag. The flag reaches it only
//   through `ImmunityResult`, where every use is an EXEMPTION — a durable-immunity
//   positive, an immutable attribute, a QC metric — i.e. the flag can only ever make a
//   reading LESS stale. Suppressing it there would REMOVE an exemption and nudge a
//   person the app had decided to leave alone, which is precisely the contact INCREASE
//   the contact-consent rule forbids. And the exempting signals are unreachable from a
//   basis-less reading anyway: `immune` is neutral-toned, so #2340's suppression (which
//   fires only on a COLOURING flag) never touches it, and an immutable/QC verdict comes
//   from `classifyQualitativeResult`, which is exactly the `qualitative` basis rather
//   than `none`.
//
// So the retest notice keeps its claim — and its claim was always honest, because it
// prints its own premise inline: the reading's date, its age, and the yearly cadence.
// What it lacked is the one thing #2340 made newly confusing: on a page that has
// deliberately declined to judge the number, an amber "these results are stale" banner
// is easy to read as a verdict on the VALUE. So its note names its premise too —
// the reading's AGE — and only where the page shows no judgment of the value.
//
// PURE: no DB, no React. `lib/__tests__/biomarker-care-basis.test.ts` proves the
// decision across every basis × flag combination.

import type { ValueBasisKind } from "./biomarker-value-basis";
import { isOutOfRange } from "./reference-range";

/** The two care offers the biomarker detail page renders beside a reading. */
export type CareOffer = "recheck" | "retest";

/**
 * Where a care offer's premise comes from — the question "does this offer name a
 * basis" is answered once, here, for every surface that asks it.
 *
 * - `displayed`   — recheck: the judgment behind the offer is on screen (a curated
 *                   band, the source's printed range, or the value's own verdict
 *                   word), so the offer needs no note of its own.
 * - `source-flag` — recheck: the page shows no judgment, so the offer stands on the
 *                   flag the record arrived with. It says so.
 * - `unflagged`   — recheck: the reading carries no out-of-range flag, so there is no
 *                   flag-premised offer to explain. (A follow-up may still be visible
 *                   here; it exists because someone tracked one, which is its own
 *                   premise and needs no explaining.)
 * - `reading-age` — retest: the clock, always. Never the value's basis.
 */
export type CareOfferPremise =
  "displayed" | "source-flag" | "unflagged" | "reading-age";

/**
 * The recheck offer's note. Attributes the flag to the record, states why the value
 * above it is neutral, and names neither a direction nor a fault.
 */
export const RECHECK_BASIS_NOTE =
  "The record this reading came from flagged it. No range on this page judged the " +
  "value, so it renders neutral — this offer follows the record's flag, not a " +
  "judgment of ours.";

/** The heading the recheck note renders under, so the note answers a stated question. */
export const RECHECK_BASIS_HEADING = "Why a recheck is offered.";

/**
 * The retest notice's note, appended to the staleness copy on a reading the page has
 * declined to judge — so an amber banner beside a deliberately neutral number cannot
 * be misread as a verdict on that number.
 */
export const RETEST_BASIS_NOTE =
  "This notice is about the reading's age — it is not a judgment of the value above.";

export interface CareOfferBasisInput {
  /** The basis `biomarkerValueBasis` resolved for the reading the offer is about. */
  basis: ValueBasisKind;
  /** The reading's STORED flag — the one the offer's premise is (or is not) built on. */
  flag: string | null | undefined;
}

export interface CareOfferBasis {
  offer: CareOffer;
  premise: CareOfferPremise;
  /**
   * The sentence the surface must render, or null when the premise is already on
   * screen. A caller renders this and never composes its own: one question, one
   * computation.
   */
  note: string | null;
}

/** Where one care offer's premise comes from, and what it must say about it. */
export function careOfferBasis(
  offer: CareOffer,
  input: CareOfferBasisInput
): CareOfferBasis {
  const bandless = input.basis === "none";
  if (offer === "retest") {
    // The retest clock reads the DATE. Its flag reads can only exempt, never assert,
    // so the basis never gates the notice — it only decides whether the notice has to
    // say which of the two things on screen it is about.
    return {
      offer,
      premise: "reading-age",
      note: bandless ? RETEST_BASIS_NOTE : null,
    };
  }
  if (!isOutOfRange(input.flag))
    return { offer, premise: "unflagged", note: null };
  return bandless
    ? { offer, premise: "source-flag", note: RECHECK_BASIS_NOTE }
    : { offer, premise: "displayed", note: null };
}
