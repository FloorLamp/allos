"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { db, today, writeTx } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import {
  isSubstanceInstrument,
  substanceInstrumentDef,
  isSubstance,
  substanceDef,
  ALCOHOL_FOOD_GROUP,
  MAX_WEEKLY_CAP,
  type SubstanceInstrument,
} from "@/lib/substance-use";
import {
  recordInstrumentScore,
  type InstrumentAnswer,
} from "@/lib/instrument-records";
import { logFoodServingCore, undoFoodServingCore } from "@/lib/food-log-write";
import {
  logSubstanceUnitCore,
  undoSubstanceUnitCore,
} from "@/lib/substance-log-write";
import { getSubstanceWeekState } from "@/lib/queries";
import { formError, formOk, type FormResult } from "@/lib/types";

// Server Actions for the substance-use surface (issues #998, #1078). Standard
// per-profile: every action operates on the session's ACTIVE profile behind
// requireWriteAccess() (the gate is inlined so the write-access scanner sees a
// literal call in each body), then delegates to the auth-blind write cores (#319)
// and revalidates. Substance data never rides a notification or any push channel
// from here.

export type SubstanceInstrumentActionResult =
  { ok: true; id: number } | { ok: false; error: string };

// This week's post-write unit count rides the result so the one-tap log/undo
// reconciles optimistically against the server (the #748 item 2 pattern).
export type SubstanceLogResult =
  { ok: true; weekCount: number } | { ok: false; error: string };

function revalidateSubstanceUse() {
  revalidatePath("/records/specialty/substance-use");
  revalidatePath("/nutrition");
  revalidatePath("/timeline");
  revalidatePath("/upcoming");
  revalidatePath("/");
}

// Record ONE substance-instrument score. Two shapes (the #716 action contract):
//   • in-app administration (AUDIT-C, and DAST-10 since #1085) → `answers` carries
//     every item's answer, validated against the item's OWN option set, and the
//     total is derived server-side from them (the source of truth);
//   • outside total-only entry (AUDIT, and any in-app instrument done elsewhere —
//     an imported/outside total lands in the SAME canonical_name series) →
//     `total` is submitted directly with no answers.
export async function recordSubstanceInstrumentAction(
  formData: FormData
): Promise<SubstanceInstrumentActionResult> {
  const { profile } = await requireWriteAccess();

  const instrumentRaw = String(formData.get("instrument") ?? "");
  if (!isSubstanceInstrument(instrumentRaw))
    return { ok: false, error: "Pick a valid instrument." };
  const instrument: SubstanceInstrument = instrumentRaw;
  const def = substanceInstrumentDef(instrument);

  const dateRaw = String(formData.get("date") ?? "").trim();
  const date = isRealIsoDate(dateRaw) ? dateRaw : today(profile.id);

  const mode = String(formData.get("mode") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  let total: number;
  let answers: InstrumentAnswer[] | undefined;

  if (mode === "administer") {
    // Only an in-app instrument (baked item text — the licensing determination in
    // lib/substance-use.ts) may be administered here.
    if (def.entry !== "in-app" || def.items.length === 0) {
      return { ok: false, error: "Enter this instrument as a total score." };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(formData.get("answers") ?? "[]"));
    } catch {
      return { ok: false, error: "Couldn't read the answers." };
    }
    if (!Array.isArray(parsed) || parsed.length !== def.items.length) {
      return { ok: false, error: "Answer every item." };
    }
    const parsedAnswers: InstrumentAnswer[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const a = Number(parsed[i]);
      // Validate against the item's OWN option values (0..4 for AUDIT-C).
      if (
        !Number.isInteger(a) ||
        !def.items[i].options.some((o) => o.value === a)
      ) {
        return { ok: false, error: "Answer every item." };
      }
      parsedAnswers.push({ itemIndex: i, answer: a });
    }
    answers = parsedAnswers;
    total = parsedAnswers.reduce((sum, a) => sum + a.answer, 0);
  } else {
    // Outside total-only entry.
    const t = Number(formData.get("total"));
    if (!Number.isInteger(t) || t < 0 || t > def.maxTotal) {
      return {
        ok: false,
        error: `Enter a total between 0 and ${def.maxTotal}.`,
      };
    }
    total = t;
  }

  const id = recordInstrumentScore(profile.id, {
    instrument,
    date,
    total,
    answers,
    notes,
  });
  revalidateSubstanceUse();
  return { ok: true, id };
}

// Log ONE unit of a substance for today, dispatched to the substance's ledger
// (#1078 split-ledger, one computation per substance): alcohol goes through the
// SAME auth-blind food-log core the Nutrition one-tap bar and the Telegram button
// use (a standard drink IS one serving of the curated `alcohol` food group,
// #860/#944); nicotine/cannabis go through the substance_log core. Both answer
// from the typed outcome — never unconditionally confirm.
export async function logSubstanceUnitAction(
  formData: FormData
): Promise<SubstanceLogResult> {
  const { profile } = await requireWriteAccess();
  const substance = String(formData.get("substance") ?? "");
  if (!isSubstance(substance))
    return { ok: false, error: "Unknown substance." };
  const outcome =
    substanceDef(substance).ledger === "food-log"
      ? logFoodServingCore(profile.id, ALCOHOL_FOOD_GROUP, today(profile.id))
      : logSubstanceUnitCore(profile.id, substance, today(profile.id));
  if (outcome.kind !== "logged")
    return { ok: false, error: "Couldn't log that." };
  revalidateSubstanceUse();
  return {
    ok: true,
    weekCount: getSubstanceWeekState(profile.id, substance).count,
  };
}

// Undo one unit logged today (idempotent — a no-op at zero), same dispatch.
export async function undoSubstanceUnitAction(
  formData: FormData
): Promise<SubstanceLogResult> {
  const { profile } = await requireWriteAccess();
  const substance = String(formData.get("substance") ?? "");
  if (!isSubstance(substance))
    return { ok: false, error: "Unknown substance." };
  const outcome =
    substanceDef(substance).ledger === "food-log"
      ? undoFoodServingCore(profile.id, ALCOHOL_FOOD_GROUP, today(profile.id))
      : undoSubstanceUnitCore(profile.id, substance, today(profile.id));
  if (outcome.kind !== "undone")
    return { ok: false, error: "Couldn't undo that." };
  revalidateSubstanceUse();
  return {
    ok: true,
    weekCount: getSubstanceWeekState(profile.id, substance).count,
  };
}

// Set (or update) a weekly reduction target: a CAP of units per week (standard
// drinks / uses), 0..MAX_WEEKLY_CAP (0 = a substance-free week target — "Dry
// January", a quit target). One target per (profile, substance) via the
// migration-072 partial unique index; re-setting updates the cap in place.
// User-initiated and reversible — never auto-created.
export async function setSubstanceTargetAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const substance = String(formData.get("substance") ?? "");
  if (!isSubstance(substance)) return formError("Unknown substance.");
  const capRaw = Number(formData.get("cap"));
  if (!Number.isInteger(capRaw) || capRaw < 0 || capRaw > MAX_WEEKLY_CAP) {
    return formError(`Enter a weekly cap between 0 and ${MAX_WEEKLY_CAP}.`);
  }
  writeTx(() => {
    db.prepare(
      `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
       VALUES ('substance', ?, ?, ?)
       ON CONFLICT (profile_id, scope_value) WHERE scope_kind = 'substance'
       DO UPDATE SET per_week = excluded.per_week`
    ).run(substance, capRaw, profile.id);
  });
  revalidateSubstanceUse();
  return formOk();
}

// Remove the reduction target. Nulls any protocol that referenced it FIRST (the
// row-ops side-state rule — a live protocols.frequency_target_id FK would block
// the delete), then removes the target. Scoped to a substance target so it can't
// touch a training/food row.
export async function clearSubstanceTargetAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const substance = String(formData.get("substance") ?? "");
  if (!isSubstance(substance)) return formError("Unknown substance.");
  const target = db
    .prepare(
      `SELECT id FROM frequency_targets
        WHERE profile_id = ? AND scope_kind = 'substance' AND scope_value = ?`
    )
    .get(profile.id, substance) as { id: number } | undefined;
  if (!target) return formOk(); // idempotent — nothing to clear
  writeTx(() => {
    db.prepare(
      `UPDATE protocols SET frequency_target_id = NULL, owns_frequency_target = 0
        WHERE profile_id = ? AND frequency_target_id = ?`
    ).run(profile.id, target.id);
    db.prepare(
      `DELETE FROM frequency_targets WHERE id = ? AND profile_id = ?`
    ).run(target.id, profile.id);
  });
  revalidateSubstanceUse();
  return formOk();
}
