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
function endMessage(outcome: EndFastOutcome): FastActionResult {
  switch (outcome.kind) {
    case "ended":
      return { ok: true, message: "Fast ended.", undoFastId: outcome.id };
    // The prompt's race, answered honestly (#2756): accepting after the fast was ended
    // on another device re-derives, finds nothing active, and REPORTS that.
    case "none-active":
      return { ok: false, error: "No fast is running." };
    case "invalid":
      return { ok: false, error: "That end time doesn't work — check the date." };
  }
}

// End the active fast — now, or at an explicit backdated instant. NO life-stage gate,
// by the registered exemption in lib/adult-only-writes.ts: a profile that became
// restricted mid-fast must still be able to close the row out.
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
  const result = endMessage(endFast(profile.id, endedAt ?? undefined));
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
  if (outcome.kind === "not-found") return fail("Unknown fast.");
  revalidateRoute("/nutrition");
  revalidateRoute("/");
  return { ok: true, message: "Discarded." };
}
