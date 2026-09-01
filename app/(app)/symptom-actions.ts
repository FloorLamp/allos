"use server";

import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";
import { LOGGED_VIA_FIELD, parseWebOrigin } from "@/lib/logged-via";
import { revalidateRoute } from "@/lib/revalidate";
import { today } from "@/lib/db";
import { zonedDateParts } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { logTemperatureCore } from "@/lib/temperature-log";
import { inlineTempRedFlagNote } from "@/lib/temp-red-flag";
import { queueTempRedFlagDispatch } from "@/lib/notifications/temp-red-flag";
import { profileAgeMonths } from "@/lib/settings";
import {
  logSymptomCore,
  setSymptomSeverityCore,
  lowerSymptomSeverityCore,
  setSymptomNoteCore,
  removeSymptomCore,
  renameCustomSymptomCore,
  deleteCustomSymptomCore,
  setSymptomEpisodeCore,
} from "@/lib/symptom-log-write";
import {
  getActiveSituations,
  setActiveSituations,
} from "@/lib/settings/profile-attrs";
import { BUILTIN_ILLNESS_SITUATION } from "@/lib/situations";
import { formError, formOk, type FormResult } from "@/lib/types";
import { SYMPTOMS, symptomSlugs } from "@/lib/symptoms";
import { getCustomSymptomNames } from "@/lib/queries";
import {
  mapSymptomText,
  type SymptomTextMapping,
  type SymptomVocabulary,
} from "@/lib/symptom-text-map";

// Server write-path for the symptom log (issue #799). The one-tap dashboard card and the
// record's day view post here; each action owns the auth gate + validation +
// revalidation and delegates the SQL / worst-severity / #203 semantics to the auth-blind
// lib cores. Symptoms surface on the dashboard (illness-gated card) and on `/history`, so
// both are revalidated.

// The bar reconciles its optimistic chip to the server's authoritative severity (the
// FoodLogBar #748-item-2 pattern), so a dropped write can't leave a phantom chip.
// `undoId` is present only on the REMOVE path (#2124) and is null when nothing was
// deleted, so the bar offers Undo exactly when there is a capture to restore.
export type SymptomLogResult =
  | { ok: true; symptom: string; severity: number; undoId?: number | null }
  | { ok: false; error: string };

// The day a post is about: what was STATED, or the profile's today when nothing was.
//
// It used to shape-check `\d{4}-\d{2}-\d{2}` and fall back to today on a miss, which
// is two defects in one line (#4425). The regex is not `isRealIsoDate`, so `2026-13-45`
// passed it and reached the cores as a literal string; and a date that FAILED it was
// laundered into today rather than refused, so a forged post silently wrote a different
// day than it asked for. Both halves are gone: a stated day travels to the core exactly
// as stated, and each core answers for it under its own declared bound
// (`LOG_MANIFEST.symptom`). Absence still means today — that is a real answer, not a
// laundering, and it is what every one-tap mount posts.
function parseDate(formData: FormData, profileId: number): string {
  const raw = String(formData.get("date") ?? "").trim();
  return raw || today(profileId);
}

function parseSeverity(formData: FormData): number {
  return Math.round(Number(formData.get("severity")));
}

type EpisodeTarget =
  | { kind: "absent" }
  | { kind: "valid"; episodeId: number }
  | { kind: "invalid" };

function parseEpisodeTarget(formData: FormData): EpisodeTarget {
  const raw = formData.get("episodeId");
  if (raw == null) return { kind: "absent" };
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { kind: "invalid" };
  const episodeId = Number(text);
  return Number.isSafeInteger(episodeId) && episodeId > 0
    ? { kind: "valid", episodeId }
    : { kind: "invalid" };
}

function revalidateSymptoms(): void {
  revalidateRoute("/");
  // Symptoms are a Logs kind on the record since #3958 phase 2, correctable there.
  revalidateRoute("/history");
}

// Cross-profile write gating for the illness Now group (issue #858). The hero lets a caregiver
// log for a household member WITHOUT switching, so the bar may post an explicit
// `profileId`: when present the write is gated by requireProfileWriteAccess(target) — the
// #31 cross-profile gate that asserts the target is reachable AND write; when absent the
// write hits the session's ACTIVE profile via requireWriteAccess(). The default
// dashboard/record symptom mounts send no profileId and are unaffected. The gate is
// inlined in each of THESE actions (never a shared helper) so the write-access scanner
// (lib/__tests__/actions-write-access.test.ts) sees a literal requireWriteAccess() in
// their bodies; the write cores stay auth-blind profileId-first (#319).
//
// `editSymptom` IS THE ONE EXCEPTION AND IT IS DELIBERATE. It is not a bar action — the
// record's ⋯ is its only caller — so it reads the ROW subject field `profile_id`
// through the shared gateItemProfile(), with an allowlist entry naming that gate. Two
// spellings of one subject is not a shape this lane invented; converging #858's
// `profileId` onto #1328's `profile_id` would have to move every bar action and the
// bar's own `withTarget` with them, which is its own change.

// Log (tap) a symptom at a severity — keeps the day's WORST severity (a tap only raises).
export async function logSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const episodeTarget = parseEpisodeTarget(formData);
  if (episodeTarget.kind === "invalid")
    return { ok: false, error: "That episode is no longer available." };
  // NO WINDOW HERE, and that is the ruling rather than an omission (2026-08-31):
  // windows bind OFFERS, not domains. This one action serves a today-only tap on the
  // dashboard AND `/history`'s day view, which mounts the same bar against the day
  // being read — so a bound here would be a bound on the dated surface too, and the
  // record's older days would go neither loggable nor correctable. `TAP_REACH`
  // declares the symptom tap as `dated` for exactly this reason. The core keeps the
  // half that is always true: a real day, never the future.
  const date = parseDate(formData, profileId);
  const outcome = logSymptomCore(
    profileId,
    symptom,
    parseSeverity(formData),
    date,
    // The symptom bar renders on the dashboard, on its own page and in the quick-log
    // sheet, all posting THIS action — so the surface rides the post.
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
    String(formData.get("note") ?? ""),
    episodeTarget.kind === "valid" ? episodeTarget.episodeId : undefined
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't log that symptom." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Explicit edit: SET the severity exactly (may LOWER) and set the note exactly.
export async function editSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#3958's multiprofile clause / #2106).
  // This action's only caller is the record's ⋯, which posts the row's own
  // `profile_id` the way every other correction on that page does — so it takes the
  // shared gateItemProfile() rather than the #858 `profileId` its neighbours here
  // read. Both resolve to requireProfileWriteAccess(target); they differ only in the
  // field name, and this one is spelled the way a RECORD ROW spells its subject.
  //
  // Before this it gated the session and wrote `profile.id`, and `setSymptomSeverityCore`
  // is keyed on (profile, symptom, date) rather than on a row id — so a ⋯ on another
  // member's symptom row would not have been refused, it would have silently written
  // the ACTING profile's own log for that symptom and day. That is why the record drew
  // no menu there at all until now.
  const profileId = await gateItemProfile(formData);
  const symptom = String(formData.get("symptom") ?? "");
  const outcome = setSymptomSeverityCore(
    profileId,
    symptom,
    parseSeverity(formData),
    parseDate(formData, profileId),
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
    String(formData.get("note") ?? "")
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't update that symptom." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Explicit LOWER (#857): drop a symptom-day's worst severity to a strictly lower value,
// preserving its note. Backs the bar's inline "Lower to mild?" confirm — a narrow action
// so a plain tap can never lower (it raises) and this can never raise.
export async function lowerSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const episodeTarget = parseEpisodeTarget(formData);
  if (episodeTarget.kind === "invalid")
    return { ok: false, error: "That episode is no longer available." };
  const outcome = lowerSymptomSeverityCore(
    profileId,
    symptom,
    parseSeverity(formData),
    parseDate(formData, profileId),
    episodeTarget.kind === "valid" ? episodeTarget.episodeId : undefined
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't lower that symptom." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Set (or clear) a logged symptom-day's note without touching its severity (#857). The
// note affordance on a logged row posts here; a blank note clears it.
export async function setSymptomNote(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const episodeTarget = parseEpisodeTarget(formData);
  if (episodeTarget.kind === "invalid")
    return { ok: false, error: "That episode is no longer available." };
  const outcome = setSymptomNoteCore(
    profileId,
    symptom,
    parseDate(formData, profileId),
    String(formData.get("note") ?? ""),
    episodeTarget.kind === "valid" ? episodeTarget.episodeId : undefined
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't save that note." };
  revalidateSymptoms();
  return { ok: true, symptom: outcome.symptom, severity: outcome.severity };
}

// Remove a symptom-day (the bar's undo).
export async function removeSymptom(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const episodeTarget = parseEpisodeTarget(formData);
  if (episodeTarget.kind === "invalid")
    return { ok: false, error: "That episode is no longer available." };
  const outcome = removeSymptomCore(
    profileId,
    symptom,
    parseDate(formData, profileId),
    episodeTarget.kind === "valid" ? episodeTarget.episodeId : undefined
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't find that symptom." };
  revalidateSymptoms();
  // The undo token (#2124) rides back on the very tap that removed the day, so the ×
  // can offer Undo in place. Null when there was nothing logged to remove.
  return {
    ok: true,
    symptom: outcome.symptom,
    severity: 0,
    undoId: outcome.undoId,
  };
}

// Attach a logged symptom-day to an illness episode, or detach it (#1093). A symptom
// logged while an episode was open auto-associates (logSymptomCore); this is the explicit
// "easy detach" (or re-attach) affordance. `episodeId` <= 0 or absent detaches (null);
// a positive id attaches. Cross-profile gated inline (the #858 pattern) so the write-
// access scanner sees a literal requireWriteAccess; the core re-checks episode ownership
// so a forged cross-profile episode id is rejected at the data layer too.
export async function setSymptomEpisode(
  formData: FormData
): Promise<SymptomLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const symptom = String(formData.get("symptom") ?? "");
  const rawEpisode = Number(formData.get("episodeId"));
  const episodeId =
    Number.isInteger(rawEpisode) && rawEpisode > 0 ? rawEpisode : null;
  const outcome = setSymptomEpisodeCore(
    profileId,
    symptom,
    parseDate(formData, profileId),
    episodeId
  );
  if (outcome.kind === "bad-episode")
    return { ok: false, error: "That episode is no longer available." };
  if (outcome.kind !== "ok")
    return { ok: false, error: "Couldn't update that symptom." };
  revalidateSymptoms();
  revalidateRoute("/medical/episodes/[id]", "page");
  return { ok: true, symptom, severity: 0 };
}

// Rename a custom symptom across all its log rows (#203 hygiene).
export async function renameCustomSymptom(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "");
  const outcome = renameCustomSymptomCore(profile.id, from, to);
  if (outcome.kind === "invalid") return formError("Enter a new name.");
  if (outcome.kind === "not-custom")
    return formError("Only your own custom symptoms can be renamed.");
  revalidateSymptoms();
  return formOk();
}

// Delete a custom symptom entirely (#203 hygiene). Every removed day is captured, so the
// result carries the #202 token BATCH — one Undo restores the whole custom symptom's
// history, its photo rows and their files included.
export async function deleteCustomSymptom(
  formData: FormData
): Promise<FormResult & { undoIds?: number[] }> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("symptom") ?? "");
  const outcome = deleteCustomSymptomCore(profile.id, name);
  if (outcome.kind === "invalid")
    return formError("Couldn't find that symptom.");
  if (outcome.kind === "not-custom")
    return formError("Only your own custom symptoms can be deleted.");
  revalidateSymptoms();
  return { ...formOk(), undoIds: outcome.undoIds ?? [] };
}

// Quick body-temperature log from the illness symptom card (issue #800). The bar posts
// a thermometer reading (°F/°C) that joins the EXISTING vitals series (canonical "Body
// Temperature", degF) via the auth-blind logTemperatureCore — the same table/identity as
// a Health Connect push, so it charts + flags like any other reading. The reading is
// timestamped: the entry is "now", so its profile-local clock time becomes the row's
// own `occurred_at` (#2154) for the fever curve (multiple readings/day), and the
// caller may override with an explicit "HH:MM" for a backfilled reading. Temperature
// surfaces on the dashboard, Timeline, Trends, and the clinical results catalog, so all are
// revalidated.
export type TemperatureLogResult =
  | { ok: true; degF: number; flag: string | null; redFlag?: string | null }
  | { ok: false; error: string };

export async function logTemperature(
  formData: FormData
): Promise<TemperatureLogResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const rawValue = Number(formData.get("temperature"));
  const unit = String(formData.get("temp_unit") ?? "F");
  const date = parseDate(formData, profileId);
  // Prefer an explicit "HH:MM" (a backfilled reading); otherwise stamp the reading with
  // the profile-local clock time of "now" (thermometer-to-phone in one step).
  const providedTime = String(formData.get("time") ?? "").trim();
  const time = /^\d{2}:\d{2}$/.test(providedTime)
    ? providedTime
    : zonedDateParts(getTimezone(profileId), new Date()).hhmm;
  const outcome = logTemperatureCore(
    profileId,
    Number.isFinite(rawValue) ? rawValue : null,
    unit,
    date,
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
    time
  );
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  revalidateRoute("/");
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/results");
  // Event-driven red-flag push (#1025): a reading that crosses a cited line
  // dispatches the co-caregiver nudge NOW (fire-and-forget; quiet-hours exempt like
  // redose) instead of waiting for the tick. The per-finding marker + suppression
  // bus inside the shared orchestrator own dedup, so this never double-sends.
  queueTempRedFlagDispatch(profileId, outcome.degF);
  // Single-reading red flag (#859 item 3): surface the source's cited instruction
  // inline at the moment of logging, age-banded. Null when the reading crosses none.
  const redFlag = inlineTempRedFlagNote(
    outcome.degF,
    profileAgeMonths(profileId, date)
  );
  return { ok: true, degF: outcome.degF, flag: outcome.flag, redFlag };
}

// Free-text symptom intake (issue #877): map a typed sentence onto the vocabulary via
// the Light tier and return SUGGESTIONS — this never writes. The user reviews the
// pre-filled rows in the bar and confirms with one tap, which commits through the
// EXISTING logSymptom / logTemperature actions (no new write path). Gated like the
// write actions (it reads the target profile's custom names and drives a write next),
// so the write-access scanner sees a literal requireWriteAccess in the body.
export type SymptomTextSuggestResult =
  | { ok: true; mapping: SymptomTextMapping }
  | {
      ok: false;
      reason: "not-configured" | "empty" | "failed";
      error?: string;
    };

export async function suggestSymptomsFromText(
  formData: FormData
): Promise<SymptomTextSuggestResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const text = String(formData.get("text") ?? "");
  const vocab: SymptomVocabulary = {
    slugs: symptomSlugs(),
    labels: Object.fromEntries(SYMPTOMS.map((s) => [s.slug, s.label])),
    customNames: getCustomSymptomNames(profileId),
  };
  const outcome = await mapSymptomText(text, vocab);
  if (outcome.status === "ok") return { ok: true, mapping: outcome.mapping };
  if (outcome.status === "not-configured")
    return { ok: false, reason: "not-configured" };
  if (outcome.status === "empty") return { ok: false, reason: "empty" };
  return { ok: false, reason: "failed", error: outcome.error };
}

// Symptom→situation bridge (issue #799, direction A): activate the built-in "Illness"
// situation so the day's symptoms fall inside an episode. Suggest-only from the UI — this
// action only ADDS Illness to the active set (idempotent), never deactivates anything.
export async function activateIllnessForSymptoms(): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const active = new Set(getActiveSituations(profile.id));
  if (!active.has(BUILTIN_ILLNESS_SITUATION)) {
    active.add(BUILTIN_ILLNESS_SITUATION);
    setActiveSituations(profile.id, [...active]);
  }
  revalidateRoute("/");
  revalidateRoute("/nutrition");
  revalidateRoute("/history");
  return formOk();
}
