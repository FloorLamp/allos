"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireSession } from "@/lib/auth";
import { gateItemProfile } from "../gate-item";
import { getUnitPrefs } from "@/lib/settings";
import { anxietyStoredValue } from "@/lib/mood";
import { submittedWeightUnit, toKg } from "@/lib/units";
import {
  deleteMetricRow as deleteReadingCore,
  updateMetricRow as updateReadingCore,
} from "@/lib/metric-readings";
import {
  parseReadingTarget,
  type MetricRowTarget,
} from "@/lib/reading-placement";
import { isTrendMetricSlug, type TrendMetricSlug } from "@/lib/trend-metrics";

// The metric detail page's per-READING write paths (issue #1488, absorbing #1397).
//
// The gate shape is the usual one and stays HERE, at the action layer:
// `requireWriteAccess()` → parse/validate → the auth-blind lib core
// (lib/metric-readings.ts) → `revalidatePath`. The core takes `profileId` first and
// never imports lib/auth, so moving the SQL out of the action didn't move the check
// with it (the write-access scanner only sees action modules).
//
// UNITS convert HERE, at the boundary, as everywhere else: weight is submitted in the
// login's display unit and stored in kilograms. Every other metric on the detail page
// is stored in the unit it is charted in, so its submitted value passes straight
// through — the one conversion is named rather than a `switch` of unit math.
//
// AND THE SUBMISSION SAYS WHICH UNIT (#630, #3853). A correction form opens pre-filled
// with the row's value converted for DISPLAY, so the unit the person edits in is the
// one their row printed — which is why both callers post it. Re-reading the pref here
// instead would convert against whatever it says at WRITE time, and a flip in another
// tab or on another device lands a correction 2.2046× out on a number the person was
// already looking at because they thought it was wrong.
//
// TWO FIELDS, TWO DIFFERENT QUESTIONS (#2032). `kind` is the PAGE: it decides the display
// unit to convert back from and the routes to revalidate. `target` is the ROW: it decides
// which physical record is written. They used to be the same field, and that is exactly
// why a clinical observation folded onto a stream metric's page could be charted but not
// corrected — the page said `body_metrics` while the row lived in `medical_records`.

export interface ReadingActionResult {
  ok: boolean;
  error?: string;
}

// Resolve the page and the row a submission names. Either half malformed is a rejected
// no-op — never a write against a guessed row, and never against a guessed store.
function parseTarget(
  formData: FormData
): { slug: TrendMetricSlug; target: MetricRowTarget } | null {
  const raw = String(formData.get("kind") ?? "").trim();
  if (!isTrendMetricSlug(raw)) return null;
  const target = parseReadingTarget(String(formData.get("target") ?? ""));
  return target ? { slug: raw, target } : null;
}

/** Correct one reading's value from the detail page's readings table. */
export async function updateMetricReading(
  formData: FormData
): Promise<ReadingActionResult> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): `/history`'s
  // `?view=everyone` posts the row's own `profile_id`, and `gateItemProfile` gates it
  // through requireProfileWriteAccess — reachable AND write, redirect otherwise —
  // falling back to the acting-profile gate when no subject is posted. The ⋯ menu is
  // the affordance; this is the gate.
  const profileId = await gateItemProfile(formData);
  const { login } = await requireSession();
  const target = parseTarget(formData);
  if (!target) return { ok: false, error: "Couldn't find that reading." };

  const raw = String(formData.get("value") ?? "").trim();
  const entered = Number(raw);
  if (raw === "" || !Number.isFinite(entered))
    return { ok: false, error: "Enter a number." };

  // The ONE unit boundary (see the header): weight arrives in the login's display
  // unit; everything else is already stored in the unit it is charted in. Calm is
  // the one non-unit display map (#1313/#1408) — the table offers the relabelled
  // axis (high = calm), the store keeps `anxiety` semantics — so it converts back
  // here, at the same boundary, rather than letting a display slot reach the store.
  const value =
    target.slug === "weight"
      ? toKg(
          entered,
          submittedWeightUnit(
            formData.get("weight_unit"),
            getUnitPrefs(login.id).weightUnit
          )
        )
      : target.slug === "calm"
        ? anxietyStoredValue(entered)
        : entered;
  if (value == null || !Number.isFinite(value))
    return { ok: false, error: "Enter a number." };

  const outcome = updateReadingCore(profileId, target.target, value);
  if (!outcome.ok) {
    return {
      ok: false,
      error:
        outcome.error === "invalid"
          ? "That value isn't in range for this metric."
          : "Couldn't find that reading.",
    };
  }
  revalidateReading(target.slug);
  return { ok: true };
}

/**
 * Delete one reading. Returns the undo id in the shape `useUndoableDelete` expects —
 * null where the store has no undoable capture (its delete is still tombstoned so a
 * resync can't resurrect it; there is simply nothing to restore FROM).
 */
export async function deleteMetricReading(
  formData: FormData
): Promise<{ undoId: number | null }> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): `/history`'s
  // `?view=everyone` posts the row's own `profile_id`, and `gateItemProfile` gates it
  // through requireProfileWriteAccess — reachable AND write, redirect otherwise —
  // falling back to the acting-profile gate when no subject is posted. The ⋯ menu is
  // the affordance; this is the gate.
  const profileId = await gateItemProfile(formData);
  const target = parseTarget(formData);
  if (!target) return { undoId: null };
  const outcome = deleteReadingCore(profileId, target.target);
  if (!outcome.ok) return { undoId: null };
  revalidateReading(target.slug);
  return { undoId: outcome.undoId };
}

// The chart sits directly above the table on the same page, so an edit or delete has
// to redraw it — the pairing is the point (#1488). The hub and the dashboard read the
// same series, so they refresh too.
function revalidateReading(slug: TrendMetricSlug): void {
  revalidateRoute(`/trends/metric/${slug}`);
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/");
}
