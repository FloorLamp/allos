"use server";

import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { revalidateRoute } from "@/lib/revalidate";
import { logBristolStool } from "@/lib/offline/writes";
import { getBristolReadings } from "@/lib/queries/bristol-stool";
import { parseBristolType } from "@/lib/bristol-stool";

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

export type LogStoolFormOutcome =
  { ok: true; type: number; todayCount: number } | { ok: false; error: string };

export async function logStoolForm(
  formData: FormData
): Promise<LogStoolFormOutcome> {
  const { profile } = await requireWriteAccess();
  const type = parseBristolType(formData.get("type"));
  if (type === null) return { ok: false, error: "Pick a type from 1 to 7." };

  const date = today(profile.id);
  if (!logBristolStool(profile.id, date, type)) {
    return { ok: false, error: "Couldn't log that. Try again." };
  }

  revalidateRoute("/trends");
  revalidateRoute("/");
  return {
    ok: true,
    type,
    todayCount: getBristolReadings(profile.id, date, date).length,
  };
}
