"use server";

import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { getUnitPrefs, type WeightUnit } from "@/lib/settings";
import { LOGGED_VIA_FIELD } from "@/lib/logged-via";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { getTrackedPractices } from "@/lib/queries";
import { practiceLogOutcomeText } from "@/lib/practice";
import { parseQuickLog } from "@/lib/palette-quick-log";
import { submittedWeightUnit } from "@/lib/units";
import { logPractice } from "@/app/(app)/wellness/actions";

// Server action behind the command palette's inline quick-log (issue #29, extended to
// wellness practices in #1633). The palette parses the same input client-side (pure
// parseQuickLog) to preview the row; this re-parses AUTHORITATIVELY — including
// re-deriving the tracked-practice set from the database rather than trusting the
// client's copy of it — and writes through each domain's own ACTION: `addMeasurements`,
// the same one the measurements form posts from every surface (#4424 ruling 7 — this
// path used to reach past it into `insertBodyMetric`, so the palette was the one weight
// door with no shared day bound above it and no shared revalidation), and `logPractice`,
// the same action the Wellness card's button and the quick-entry overlay post.
// Mutating, so it gates on requireWriteAccess.
//
// `capturedUnit` is the unit the PREVIEW was parsed against, so an unsuffixed number
// commits as the row the person read ("Log weight · 82.5 kg") rather than against the
// pref re-read here (#630, #3853) — the same carry every weight form makes, validated
// like one because a Server Action argument arrives over the wire.
export async function paletteQuickLog(
  input: string,
  capturedUnit?: WeightUnit
): Promise<{ ok: boolean; message: string }> {
  const { login, profile } = await requireWriteAccess();
  const prefs = getUnitPrefs(login.id);
  const weightUnit = submittedWeightUnit(capturedUnit, prefs.weightUnit);
  // The finite preimage (#394): only a practice this profile actually tracks can be
  // written, so a forged input can never invent one — and the identity folding is the
  // shared practiceIdentity, so a quick log lands in the same family the card counts.
  const practices = getTrackedPractices(profile.id).map((p) => ({
    identity: p.identity,
    name: p.name,
  }));
  const parsed = parseQuickLog(input, weightUnit, practices);
  if (!parsed) return { ok: false, message: "Unrecognized quick log." };
  if (parsed.error) return { ok: false, message: parsed.error };

  if (parsed.type === "practice") {
    // Reach the EXISTING action — its own write gate, its own revalidation of every
    // practice surface — instead of re-implementing the write here.
    const fd = new FormData();
    fd.set("practice", parsed.practice);
    const outcome = await logPractice(fd);
    // Answered from the typed outcome, never an unconditional confirm: a session log is
    // not idempotent, and one that did not happen must not be reported as one that did.
    return {
      ok: outcome.kind === "logged",
      message: practiceLogOutcomeText(outcome),
    };
  }

  // TIME-BLIND, like every quick-log door: the palette states a WEIGHT, never a
  // "when", so it posts no `occurred_at` field at all — which the action reads as "no
  // statement was made" and leaves any stored time alone (#2235's trichotomy), rather
  // than as the explicit clear an empty field means.
  const fd = new FormData();
  fd.set("date", today(profile.id));
  fd.set("weight", String(parsed.value));
  fd.set("weight_unit", parsed.unit);
  // The command palette IS the quick-log surface (#3087).
  fd.set(LOGGED_VIA_FIELD, "quick-log");
  const saved = await addMeasurements(fd);
  // The one refusal this submission can meet: the action judges the day against the
  // profile's own today, and the line above states that very day — so this is the
  // gate answering rather than a case a user can reach. It is asked anyway because
  // an unconditional confirm is what #232 forbids, and because the day this posts is
  // derived rather than constant.
  if (saved.dateRefused)
    return { ok: false, message: "Couldn't log that weight." };
  return { ok: true, message: `Logged weight ${parsed.value} ${parsed.unit}.` };
}
