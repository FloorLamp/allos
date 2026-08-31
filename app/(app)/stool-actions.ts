"use server";

import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { revalidateRoute } from "@/lib/revalidate";
import { logBristolStool } from "@/lib/offline/writes";
import { getBristolReadings } from "@/lib/queries/bristol-stool";
import { parseBristolType } from "@/lib/bristol-stool";
import type { StatedTimeRefusal } from "@/lib/stated-time";

// The Bristol stool-form tap (issue #2785). Authorization at the request boundary, the
// write core auth-blind and profileId-first — the house rule, and the same shape every
// other quick-log action here takes.
//
// The action decides NOTHING about the scale: `parseBristolType` is the one guard, and
// it is the same call the write core makes, so a crafted post cannot store an 8 by
// going around the form. Checking here as well is not the redundant assertion the
// repo's rules forbid — it is what lets the surface answer "that isn't a type" instead
// of the core's silent `false`.
//
// It answers with the day's COUNT, never an average: several movements a day is
// ordinary, and the count is what the picker shows beside the buttons so a second tap
// is informed rather than accidental.

// A REFUSED STATED TIME IS A NOTICE, NOT A FAILURE (#4425, the body-metric contract):
// the observation lands and `statedTimeRefused` says the minute did not, so the picker
// can finish the sentence itself. It has to: `STATED_TIME_REFUSAL_NOTE` is deliberately
// the vocabulary for a surface that TIMESTAMPED the statement off a device clock, and
// here the user TYPED it — telling them their clock is ahead would diagnose the wrong
// machine (lib/stated-time.ts says so in those words).
export type LogStoolFormOutcome =
  | {
      ok: true;
      type: number;
      todayCount: number;
      statedTimeRefused?: StatedTimeRefusal;
    }
  | { ok: false; error: string };

export async function logStoolForm(
  formData: FormData
): Promise<LogStoolFormOutcome> {
  const { profile } = await requireWriteAccess();
  const type = parseBristolType(formData.get("type"));
  if (type === null) return { ok: false, error: "Pick a type from 1 to 7." };

  const date = today(profile.id);
  // The optional STATED wall time (#3273's "Happened earlier?"), profile-local
  // "HH:MM". Absent — the one-tap path, and the overwhelming majority — is `null`,
  // which the write core reads as "the moment IS now" exactly as it did when the
  // form had no time affordance at all. The shape is re-asked in the core, and since
  // #4425 the core also JUDGES it, so a crafted or mistyped stamp cannot smuggle a
  // future instant onto a row whose natural key IS that instant.
  const at = String(formData.get("at") ?? "").trim() || null;
  const written = logBristolStool(profile.id, date, type, at);
  if (!written.wrote) {
    return { ok: false, error: "Couldn't log that. Try again." };
  }

  revalidateRoute("/trends");
  revalidateRoute("/");
  return {
    ok: true,
    type,
    todayCount: getBristolReadings(profile.id, date, date).length,
    ...(written.statedTimeRefused
      ? { statedTimeRefused: written.statedTimeRefused }
      : {}),
  };
}
