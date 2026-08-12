"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import {
  isInstrument,
  instrumentDef,
  instrumentItemOptions,
  type Instrument,
} from "@/lib/mental-health";
import {
  recordInstrumentScore,
  updateInstrumentScore,
  deleteInstrumentScore,
  getInstrumentScoreInstrument,
  instrumentMaxTotal,
  type InstrumentAnswer,
} from "@/lib/instrument-records";
import { formError, formOk, type FormResult } from "@/lib/types";

// Server Actions for the mental-health instrument surface (issue #716). Standard
// per-profile: every action operates on the session's ACTIVE profile behind
// requireWriteAccess() (the gate is inlined so the write-access scanner sees a literal
// call in each body), then delegates to the auth-blind write core (#319) and revalidates.

export type InstrumentActionResult =
  { ok: true; id: number } | { ok: false; error: string };

function revalidateInstruments() {
  // Mental-health instruments folded into Health record (#1042 final tail): the
  // surface is now /records#mental-health.
  revalidateRoute("/records");
  revalidateRoute("/timeline");
  revalidateRoute("/upcoming");
  revalidateRoute("/");
}

// Record ONE instrument score. Two shapes:
//   • in-app administration → `answers` carries every item's 0..3 answer (JSON), and the
//     total is derived server-side from them (the source of truth), so a tampered total
//     can't disagree with the answers;
//   • outside total-only entry → `total` is submitted directly with no answers.
export async function recordInstrumentAction(
  formData: FormData
): Promise<InstrumentActionResult> {
  const { profile } = await requireWriteAccess();

  const instrumentRaw = String(formData.get("instrument") ?? "");
  if (!isInstrument(instrumentRaw))
    return { ok: false, error: "Pick a valid instrument." };
  const instrument: Instrument = instrumentRaw;
  const def = instrumentDef(instrument);

  const dateRaw = String(formData.get("date") ?? "").trim();
  const date = isRealIsoDate(dateRaw) ? dateRaw : today(profile.id);

  const mode = String(formData.get("mode") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  let total: number;
  let answers: InstrumentAnswer[] | undefined;

  if (mode === "administer") {
    // Parse the per-item answers JSON: an array of `def.items.length` integers in 0..3.
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
      // Validate against THIS item's own option set, not a hard-coded 0..3 — an
      // instrument may score its items on different scales (#2321: EPDS reverses
      // seven of its ten), so the item is the authority on what an answer may be.
      const options = instrumentItemOptions(instrument, i);
      if (!Number.isInteger(a) || !options.some((o) => o.value === a)) {
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
  revalidateInstruments();
  return { ok: true, id };
}

// ---- Correcting a recorded score (#1396) ------------------------------------
// A screening score used to be create-only, so a mis-typed outside total permanently
// distorted the trend and could permanently trip the NON-DISMISSIBLE crisis line.
// Both actions below re-check write access, validate against the instrument the
// TARGET ROW actually belongs to (never a client-supplied instrument), and delegate
// to the auth-blind core, which recomputes nothing: the crisis gate reads the stored
// rows, so the correction IS the recompute.

// Correct one score's date and/or total. Answers with the core's typed outcome —
// an administered (item-by-item) reading refuses a total change and says so.
export async function updateInstrumentAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that score.");
  const instrument = getInstrumentScoreInstrument(profile.id, id);
  if (!instrument) return formError("Couldn't find that score.");
  const dateRaw = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(dateRaw)) return formError("Enter a valid date.");
  const maxTotal = instrumentMaxTotal(instrument);
  const total = Number(formData.get("total"));
  if (!Number.isInteger(total) || total < 0 || total > maxTotal)
    return formError(`Enter a total between 0 and ${maxTotal}.`);

  const outcome = updateInstrumentScore(profile.id, id, {
    date: dateRaw,
    total,
  });
  if (outcome.kind === "not-found")
    return formError("Couldn't find that score.");
  if (outcome.kind === "answers-derived")
    return formError(
      "This score was answered item by item, so its total comes from those answers. Delete it and answer again to correct it."
    );
  revalidateInstruments();
  return formOk();
}

// Remove one score. Returns the undo token the shared delete toast restores from
// (`{ undoId }`, the #30 contract) — never an unconditional success.
export async function deleteInstrumentAction(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  const outcome = deleteInstrumentScore(profile.id, id);
  if (outcome.kind === "not-found") return { undoId: null };
  revalidateInstruments();
  return { undoId: outcome.undoId };
}
