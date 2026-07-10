"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { today } from "@/lib/db";
import { getUnitPrefs } from "@/lib/settings";
import { insertBodyMetric } from "@/lib/offline/writes";
import { parseQuickLog } from "@/lib/palette-quick-log";

// Server action behind the command palette's inline quick-log (issue #29). The
// palette parses the same input client-side (pure parseQuickLog) to preview the
// row; this re-parses authoritatively, converts using the login's unit pref, and
// writes through the shared insertBodyMetric (same validation as the body-metrics
// form + the offline replay). Mutating, so it gates on requireWriteAccess.
export async function paletteQuickLog(
  input: string
): Promise<{ ok: boolean; message: string }> {
  const { login, profile } = await requireWriteAccess();
  const prefs = getUnitPrefs(login.id);
  const parsed = parseQuickLog(input, prefs.weightUnit);
  if (!parsed) return { ok: false, message: "Unrecognized quick log." };
  if (parsed.error) return { ok: false, message: parsed.error };

  const wrote = insertBodyMetric(profile.id, {
    date: today(profile.id),
    weight: String(parsed.value),
    weightUnit: parsed.unit,
    bodyFatPct: null,
    restingHr: null,
    notes: null,
  });
  if (!wrote) return { ok: false, message: "Couldn't log that weight." };

  revalidatePath("/trends");
  revalidatePath("/");
  return { ok: true, message: `Logged weight ${parsed.value} ${parsed.unit}.` };
}
