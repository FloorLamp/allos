"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import {
  isInstrument,
  instrumentDef,
  type Instrument,
} from "@/lib/mental-health";
import {
  recordInstrumentScore,
  type InstrumentAnswer,
} from "@/lib/instrument-records";

// Server Actions for the mental-health instrument surface (issue #716). Standard
// per-profile: every action operates on the session's ACTIVE profile behind
// requireWriteAccess() (the gate is inlined so the write-access scanner sees a literal
// call in each body), then delegates to the auth-blind write core (#319) and revalidates.

export type InstrumentActionResult =
  { ok: true; id: number } | { ok: false; error: string };

function revalidateInstruments() {
  revalidatePath("/medical/instruments");
  revalidatePath("/timeline");
  revalidatePath("/upcoming");
  revalidatePath("/");
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
      if (!Number.isInteger(a) || a < 0 || a > 3) {
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
