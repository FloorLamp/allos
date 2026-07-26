"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { getUnitPrefs } from "@/lib/settings";
import { toKg } from "@/lib/units";
import {
  deleteMetricReading as deleteReadingCore,
  updateMetricReading as updateReadingCore,
} from "@/lib/metric-readings";
import {
  isBodyMetricSlug,
  type BodyMetricSlug,
} from "@/lib/trends-body-metrics";

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

export interface ReadingActionResult {
  ok: boolean;
  error?: string;
}

// Resolve the slug + reading id a submission names. A malformed pair is a rejected
// no-op — never a write against a guessed metric.
function parseTarget(
  formData: FormData
): { slug: BodyMetricSlug; id: number } | null {
  const raw = String(formData.get("kind") ?? "").trim();
  const id = Number(formData.get("id"));
  if (!isBodyMetricSlug(raw) || !Number.isInteger(id) || id <= 0) return null;
  return { slug: raw, id };
}

/** Correct one reading's value from the detail page's readings table. */
export async function updateMetricReading(
  formData: FormData
): Promise<ReadingActionResult> {
  const { login, profile } = await requireWriteAccess();
  const target = parseTarget(formData);
  if (!target) return { ok: false, error: "Couldn't find that reading." };

  const raw = String(formData.get("value") ?? "").trim();
  const entered = Number(raw);
  if (raw === "" || !Number.isFinite(entered))
    return { ok: false, error: "Enter a number." };

  // The ONE unit boundary (see the header): weight arrives in the login's display
  // unit; everything else is already stored in the unit it is charted in.
  const value =
    target.slug === "weight"
      ? toKg(entered, getUnitPrefs(login.id).weightUnit)
      : entered;
  if (value == null || !Number.isFinite(value))
    return { ok: false, error: "Enter a number." };

  const outcome = updateReadingCore(profile.id, target.slug, target.id, value);
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
  const { profile } = await requireWriteAccess();
  const target = parseTarget(formData);
  if (!target) return { undoId: null };
  const outcome = deleteReadingCore(profile.id, target.slug, target.id);
  if (!outcome.ok) return { undoId: null };
  revalidateReading(target.slug);
  return { undoId: outcome.undoId };
}

// The chart sits directly above the table on the same page, so an edit or delete has
// to redraw it — the pairing is the point (#1488). The hub and the dashboard read the
// same series, so they refresh too.
function revalidateReading(slug: BodyMetricSlug): void {
  revalidatePath(`/trends/metric/${slug}`);
  revalidatePath("/trends");
  revalidatePath("/");
}
