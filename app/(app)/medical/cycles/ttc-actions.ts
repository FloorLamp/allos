"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { setTtcStart } from "@/lib/settings";
import { toCanonicalTempF } from "@/lib/vitals-input";
import { isLhResult, isMucusQuality } from "@/lib/ttc";
import { logBbtCore, logLhTestCore, logMucusCore } from "@/lib/ttc-store";

// Server Actions for the trying-to-conceive observations (issue #1680). Standard
// per-profile: every action operates on the session's ACTIVE profile behind
// requireWriteAccess() (the gate is inlined so the write-access scanner sees a literal
// call in each body), then delegates to the auth-blind write cores (#319) and revalidates.
//
// Each core returns a TYPED outcome and each handler maps EVERY one of them — a locked row
// writes nothing and says so. Nothing here confirms a write that did not happen.

export type TtcActionResult = { ok: true } | { ok: false; error: string };

function revalidateTtc() {
  revalidateRoute("/medical/cycles");
  revalidateRoute("/timeline");
  revalidateRoute("/");
}

const LOCKED_ERROR =
  "That day's reading was corrected by hand, so it wasn't overwritten.";

// Declare (or clear) the date someone started trying to conceive — the ONLY thing that
// turns the TTC surfaces on. Declared-only, forever: no observation and no pattern ever
// writes this, and clearing it stops the surfaces while leaving the recorded observations
// exactly where they are.
export async function setTtcStartAction(
  formData: FormData
): Promise<TtcActionResult> {
  const { profile } = await requireWriteAccess();
  const raw = String(formData.get("start") ?? "").trim();
  if (raw === "") {
    setTtcStart(profile.id, null);
    revalidateTtc();
    return { ok: true };
  }
  if (!isRealIsoDate(raw)) {
    return { ok: false, error: "Enter a valid date (YYYY-MM-DD)." };
  }
  if (raw > today(profile.id)) {
    return { ok: false, error: "That date is in the future." };
  }
  setTtcStart(profile.id, raw);
  revalidateTtc();
  return { ok: true };
}

// One-tap LH test result for today.
export async function logLhTestAction(
  formData: FormData
): Promise<TtcActionResult> {
  const { profile } = await requireWriteAccess();
  const result = formData.get("result");
  if (!isLhResult(result)) {
    return { ok: false, error: "Record the test as positive or negative." };
  }
  const outcome = logLhTestCore(profile.id, today(profile.id), result);
  if (outcome.kind === "locked") return { ok: false, error: LOCKED_ERROR };
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  revalidateTtc();
  return { ok: true };
}

// Today's waking temperature. Converted to the app's canonical °F at the boundary through
// the SAME toCanonicalTempF every other temperature entry uses (the units rule: convert at
// the edges, store canonical, never fork the conversion).
export async function logBbtAction(
  formData: FormData
): Promise<TtcActionResult> {
  const { profile } = await requireWriteAccess();
  const raw = Number(String(formData.get("value") ?? "").trim());
  if (!Number.isFinite(raw)) {
    return { ok: false, error: "Enter a valid temperature." };
  }
  const unit = String(formData.get("unit") ?? "F") === "C" ? "C" : "F";
  const outcome = logBbtCore(
    profile.id,
    today(profile.id),
    toCanonicalTempF(raw, unit)
  );
  if (outcome.kind === "locked") return { ok: false, error: LOCKED_ERROR };
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  revalidateTtc();
  return { ok: true };
}

// One-tap cervical-mucus observation for today.
export async function logMucusAction(
  formData: FormData
): Promise<TtcActionResult> {
  const { profile } = await requireWriteAccess();
  const quality = formData.get("quality");
  if (!isMucusQuality(quality)) {
    return { ok: false, error: "Pick a cervical-mucus observation." };
  }
  const outcome = logMucusCore(profile.id, today(profile.id), quality);
  if (outcome.kind === "locked") return { ok: false, error: LOCKED_ERROR };
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  revalidateTtc();
  return { ok: true };
}
