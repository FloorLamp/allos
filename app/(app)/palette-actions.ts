"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import { today } from "@/lib/db";
import { getUnitPrefs } from "@/lib/settings";
import { insertBodyMetric } from "@/lib/offline/writes";
import { getTrackedPractices } from "@/lib/queries";
import { practiceLogOutcomeText } from "@/lib/practice";
import { parseQuickLog } from "@/lib/palette-quick-log";
import { logPractice } from "@/app/(app)/wellness/actions";

// Server action behind the command palette's inline quick-log (issue #29, extended to
// wellness practices in #1633). The palette parses the same input client-side (pure
// parseQuickLog) to preview the row; this re-parses AUTHORITATIVELY — including
// re-deriving the tracked-practice set from the database rather than trusting the
// client's copy of it — and writes through the shared cores (insertBodyMetric, the same
// validation as the body-metrics form and the offline replay; logPractice, the same
// action the Wellness card's button and the quick-entry overlay post). Mutating, so it
// gates on requireWriteAccess.
export async function paletteQuickLog(
  input: string
): Promise<{ ok: boolean; message: string }> {
  const { login, profile } = await requireWriteAccess();
  const prefs = getUnitPrefs(login.id);
  // The finite preimage (#394): only a practice this profile actually tracks can be
  // written, so a forged input can never invent one — and the identity folding is the
  // shared practiceIdentity, so a quick log lands in the same family the card counts.
  const practices = getTrackedPractices(profile.id).map((p) => ({
    identity: p.identity,
    name: p.name,
  }));
  const parsed = parseQuickLog(input, prefs.weightUnit, practices);
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

  const wrote = insertBodyMetric(profile.id, {
    date: today(profile.id),
    weight: String(parsed.value),
    weightUnit: parsed.unit,
    bodyFatPct: null,
    restingHr: null,
    notes: null,
  });
  if (!wrote) return { ok: false, message: "Couldn't log that weight." };

  revalidateRoute("/trends");
  revalidateRoute("/");
  return { ok: true, message: `Logged weight ${parsed.value} ${parsed.unit}.` };
}
