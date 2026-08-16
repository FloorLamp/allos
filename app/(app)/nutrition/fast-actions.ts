"use server";

// Server Actions for the fasting lifecycle (#2756). The auth gate + revalidation live
// here; the transitions, the typed refusals and the life-stage gate all live in the
// auth-blind core (lib/fast-write.ts), which is what makes these actions thin and what
// makes the gate real — a POST straight at one of these is judged by the same core the
// button is.
//
// Every action answers from what ACTUALLY happened. None of them confirms
// unconditionally: `already-active`, `none-active`, `overlap` and `invalid` each get
// their own sentence, because a control that says "done" over a write that did not land
// is the failure the stateful-write registry exists to end.

import { requireWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import { getTimezone } from "@/lib/settings";
import { zonedWallTimeToUtc } from "@/lib/date";
import {
  discardFast,
  endFast,
  fastAdultOnlyRefusal,
  reopenFast,
  startFast,
  type EndFastOutcome,
} from "@/lib/fast-write";
// The actions answer with a MESSAGE rather than the bare `FormResult`, because every
// one of them is a lifecycle transition whose confirmation must name what happened
// ("Fast ended.") rather than just succeeding. An ended fast also answers with the row
// id, so the surface can offer UNDO — the inverse (reopen) is complete and local, one
// column on one named row, which is what makes that affordance honest rather than an
// approximation of one.
export type FastActionResult =
  | { ok: true; message: string; undoFastId?: number }
  | { ok: false; error: string };

function fail(error: string): FastActionResult {
  return { ok: false, error };
}

// A backdated instant from the form. The field carries a profile-LOCAL wall time
// (`YYYY-MM-DDTHH:MM`, what a datetime-local input produces) and the SERVER resolves it
// against the profile's timezone — never a client instant, so a page open across a
// timezone change or a browser with a skewed clock cannot stamp one. Returns null for
// absent (the ordinary "now" case) and undefined for present-but-unusable, which the
// callers refuse rather than silently treating as now.
function parseBackdated(
  raw: FormDataEntryValue | null,
  tz: string
): Date | null | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const at = zonedWallTimeToUtc(tz, m[1], m[2]);
  return at ?? undefined;
}

// Start a fast — now, or at an explicit backdated instant (forgot-to-tap is the common
// failure). A restricted profile's `refused` is answered as "not available", the same
// nothing-here-for-you answer the read side gives; it deliberately does not explain the
// gate, because an explanation of an eating-restriction gate is itself content.
export async function startFastAction(
  formData: FormData
): Promise<FastActionResult> {
  const { profile } = await requireWriteAccess();
  const startedAt = parseBackdated(
    formData.get("started_at"),
    getTimezone(profile.id)
  );
  if (startedAt === undefined) return fail("Enter a valid start time.");
  const outcome = startFast(profile.id, startedAt ?? undefined);
  switch (outcome.kind) {
    case "started":
      revalidateRoute("/nutrition");
      revalidateRoute("/");
      return { ok: true, message: "Fast started." };
    case "already-active":
      return fail("A fast is already running.");
    case "overlap":
      return fail("That overlaps a fast already on record.");
    case "invalid":
      return fail("That start time doesn't work — check the date.");
    case "refused":
      return fail("Fasting isn't available on this profile.");
  }
}

// The one sentence each end outcome earns, shared by the control and by the food-log
// follow-up offer so the two cannot describe the same write differently.
//
// `canUndo` is what decides whether the confirmation carries `undoFastId` — the ONE
// answer to "may this end be taken back right now", resolved on the server, which is the
// only tier that knows. Every surface that ends a fast keys its Undo off the presence of
// that id, so the Nutrition control and the food-log follow-up toast cannot offer
// different affordances for the same write, and no component has to re-derive a gate.
function endMessage(
  outcome: EndFastOutcome,
  canUndo: boolean
): FastActionResult {
  switch (outcome.kind) {
    case "ended":
      return {
        ok: true,
        message: "Fast ended.",
        ...(canUndo ? { undoFastId: outcome.id } : {}),
      };
    // The prompt's race, answered honestly (#2756): accepting after the fast was ended
    // on another device re-derives, finds nothing active, and REPORTS that.
    case "none-active":
      return { ok: false, error: "No fast is running." };
    // The only refusal an end can provoke, and it is about the instant the form
    // supplied. There is deliberately no length refusal here: an end cannot make an
    // interval longer than the clock already made it, so refusing one would refuse to
    // close a fast the app itself let grow (lib/fast-write.ts).
    case "invalid":
      return {
        ok: false,
        error: "That end time doesn't work — check the date.",
      };
  }
}

// End the active fast — now, or at an explicit backdated instant. NO life-stage gate,
// by the registered exemption in lib/adult-only-writes.ts: a profile that became
// restricted mid-fast must still be able to close the row out.
//
// The UNDO it offers is gated, though, because the reopen behind it is. Of `reopenFast`'s
// five refusals, four are false AT THE MOMENT THIS END COMMITS whatever the form said:
// `too-old` is measured from when the end was WRITTEN rather than from the instant it
// names, so it cannot fire on the write that just happened; `not-found` names the row we
// just closed; `already-active` needs a fast running and this end cleared the only one;
// and `overlap` needs a fast recorded after this one, which could not have been started
// while this one was open. The life-stage gate is the one that can be true immediately,
// so it is the one asked here — and asking rather than re-deriving a copy of it is what
// keeps this from drifting.
//
// SO THE OFFER IS EXACT ABOUT THE STATE IT IS MADE IN, not about the state it lands in,
// and the difference is deliberate. A device that starts a fast, or a tab that sits past
// FAST_REOPEN_MAX_MINUTES, can still refuse the tap — the core re-derives under its own
// lock and answers with a typed refusal, which is the whole design. A weaker claim than
// the one this comment made for a revision ("an Undo appears if and only if tapping it
// would land"), and unlike that one it is true: `too-old` read `ended_at` then, so it
// fired instantly and deterministically on any end backdated past the window, beside an
// Undo this action had already offered.
export async function endFastAction(
  formData: FormData
): Promise<FastActionResult> {
  const { profile } = await requireWriteAccess();
  const endedAt = parseBackdated(
    formData.get("ended_at"),
    getTimezone(profile.id)
  );
  if (endedAt === undefined)
    return { ok: false, error: "Enter a valid end time." };
  const result = endMessage(
    endFast(profile.id, endedAt ?? undefined),
    !fastAdultOnlyRefusal(profile.id)
  );
  if (result.ok) {
    revalidateRoute("/nutrition");
    revalidateRoute("/");
  }
  return result;
}

/** UNDO an end: reopen the named fast, putting the state back exactly where it was. */
export async function undoEndFastAction(
  formData: FormData
): Promise<FastActionResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) return fail("Unknown fast.");
  const outcome = reopenFast(profile.id, id);
  switch (outcome.kind) {
    case "reopened":
      revalidateRoute("/nutrition");
      revalidateRoute("/");
      return { ok: true, message: "Fast reopened." };
    case "already-active":
      return fail("A fast is already running.");
    case "not-found":
      return fail("That fast is no longer there to reopen.");
    // An Undo is the inverse of a write the user JUST made. Past the window it would be
    // resurrecting finished history, which is a different act and not one this offers.
    case "too-old":
      return fail("That's too old to undo now.");
    case "overlap":
      return fail("Reopening that would overlap a later fast.");
    // GATED, unlike the end it undoes: restoring an active fast is exactly what the
    // adult-only ruling withholds, so this cannot ride the end's exemption. Not drawn as
    // a button anywhere — `endFastAction` withholds the id for a restricted profile — so
    // this answers a stale tab, which is the case a surface-only rule cannot cover.
    case "refused":
      return fail("Fasting isn't available on this profile.");
  }
}

// DISCARD a fast — "I never actually fasted". The stale suggest's second resolution
// beside ending it at a backdated instant; the app never picks between them, and never
// auto-ends anything.
export async function discardFastAction(
  formData: FormData
): Promise<FastActionResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) return fail("Unknown fast.");
  const outcome = discardFast(profile.id, id);
  switch (outcome.kind) {
    case "discarded":
      revalidateRoute("/nutrition");
      revalidateRoute("/");
      return { ok: true, message: "Discarded." };
    // The tab was open across an end elsewhere, so the id it carries now names a
    // COMPLETED fast. Reported rather than obeyed — deleting finished history is not the
    // write this button was drawn for, and "Discarded." over it would be a confirmation
    // of something the user never asked for.
    case "already-ended":
      return fail("That fast has already ended.");
    case "not-found":
      return fail("Unknown fast.");
  }
}
