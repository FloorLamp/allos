"use server";

import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import { revalidateRoute } from "@/lib/revalidate";
import { logBristolStool } from "@/lib/offline/writes";
import { getBristolReadings } from "@/lib/queries/bristol-stool";
import { BRISTOL_STOOL_METRIC, parseBristolType } from "@/lib/bristol-stool";
import { deleteMetricRow, updateMetricRow } from "@/lib/metric-readings";
import { isRealIsoDate } from "@/lib/date";
import type { StatedTimeRefusal } from "@/lib/stated-time";
import { gateItemProfile } from "./gate-item";

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
// It answers with the COUNT ON THE DAY IT WROTE TO, never an average: several movements
// a day is ordinary, and the count is what the picker shows beside the buttons so a
// second tap is informed rather than accidental. On a backfill that day is not today,
// which is why the field is not called one.

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
      dayCount: number;
      statedTimeRefused?: StatedTimeRefusal;
    }
  | { ok: false; error: string };

export async function logStoolForm(
  formData: FormData
): Promise<LogStoolFormOutcome> {
  const { profile } = await requireWriteAccess();
  const type = parseBristolType(formData.get("type"));
  if (type === null) return { ok: false, error: "Pick a type from 1 to 7." };

  // THE DAY THE MOUNT IS STANDING ON (#4424's date context), not a re-derived today.
  // Absent — the quick sheet's tap, and the overwhelming majority — is this profile's
  // today, so the fast path posts exactly the body it always posted. The bound is the
  // write core's shared invariant (`isPastWriteAccepted`): any real past day, never the
  // future. Nothing is re-checked here, because the core refuses what it refuses.
  const posted = String(formData.get("date") ?? "").trim();
  const date = posted && isRealIsoDate(posted) ? posted : today(profile.id);
  // The optional STATED wall time (#3273's "Happened earlier?"), profile-local
  // "HH:MM". Absent — the one-tap path, and the overwhelming majority — is `null`,
  // which the write core reads as "the moment IS now" exactly as it did when the
  // form had no time affordance at all. The shape is re-asked in the core, and since
  // #4425 the core also JUDGES it, so a crafted or mistyped stamp cannot smuggle a
  // future instant onto a row whose natural key IS that instant.
  const at = String(formData.get("at") ?? "").trim() || null;
  const written = logBristolStool(profile.id, date, type, at);
  // The type parsed and the date is a real day, so the core's only remaining refusal is
  // the shared never-the-future bound — said in those words rather than as a retry.
  if (!written.wrote) {
    return { ok: false, error: "That day hasn't happened yet." };
  }

  revalidateStool();
  return {
    ok: true,
    type,
    dayCount: getBristolReadings(profile.id, date, date).length,
    ...(written.statedTimeRefused
      ? { statedTimeRefused: written.statedTimeRefused }
      : {}),
  };
}

// THE RECORD'S TWO ROW WRITES (#4433). A logged movement is a `metric_samples` row, so
// its correction and its delete are the SHARED reading contract's — `updateMetricRow`
// and `deleteMetricRow` over a `{ store, id, metric }` target, which is where the #133
// edit lock and the #507/#508 tombstone already live, and where `captureDelete` makes
// the delete undoable under the #2642 contract. No stool-shaped write core is added.
//
// THE TARGET NAMES THE METRIC, so a crafted token carrying another row's id cannot
// reach it: `deleteReadingAt` probes (id, profile_id, metric) before it captures, and
// `updateReadingAt` carries the metric in its WHERE clause.
//
// NOT `deleteMetricReading` in trends/reading-actions.ts, whose `kind` field is a
// `TrendMetricSlug`: Bristol deliberately is not one (lib/bristol-stool.ts argues why —
// no canonical identity, no knowledge entry, and never a mean), and inventing a slug so
// a shared action would accept it would put stool on the metric registry to buy a
// revalidate list.
function stoolTarget(formData: FormData) {
  const id = Number(String(formData.get("id") ?? "").trim());
  return Number.isInteger(id) && id > 0
    ? ({ store: "metric_samples", id, metric: BRISTOL_STOOL_METRIC } as const)
    : null;
}

/** Correct one logged movement's TYPE — the mis-tap #4433 names ("type 3, meant 4"). */
export async function correctStoolReading(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): the record's
  // `?view=everyone` posts the row's own `profile_id` and `gateItemProfile` gates it,
  // falling back to the acting-profile gate when no subject is posted.
  const profileId = await gateItemProfile(formData);
  const target = stoolTarget(formData);
  const type = parseBristolType(formData.get("type"));
  if (!target) return { ok: false, error: "Couldn't find that reading." };
  if (type === null) return { ok: false, error: "Pick a type from 1 to 7." };
  const outcome = updateMetricRow(profileId, target, type);
  if (!outcome.ok) return { ok: false, error: "Couldn't find that reading." };
  revalidateStool();
  return { ok: true };
}

/** Remove one logged movement, in the shape `useUndoableDelete` reads (#2642). */
export async function deleteStoolReading(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const profileId = await gateItemProfile(formData);
  const target = stoolTarget(formData);
  if (!target) return { undoId: null };
  const outcome = deleteMetricRow(profileId, target);
  if (!outcome.ok) return { undoId: null };
  revalidateStool();
  return { undoId: outcome.undoId };
}

// Every surface a movement shows on: the record, the Trends panel that charts it, and
// the dashboard the sheet is opened from.
function revalidateStool(): void {
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/");
}
