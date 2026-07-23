"use server";

import { revalidatePath } from "next/cache";
import {
  requireWriteAccess,
  requireProfileWriteAccess,
  type CurrentSession,
} from "@/lib/auth";
import { expiresAtFor } from "@/lib/share-links";
import { createEpisodeShareLink } from "@/lib/share-links-db";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { isRealIsoDate, zonedWallTimeToUtc } from "@/lib/date";
import { db, today } from "@/lib/db";
import { getTimezone, deleteProfileSetting } from "@/lib/settings";
import { refillMarkerKey } from "@/lib/refill-nudge";
import { updateTemperatureCore } from "@/lib/temperature-log";
import {
  deleteAdministrationLog,
  updateAdministrationLog,
} from "@/lib/queries";
import { captureDelete } from "@/lib/undo-delete-db";
import {
  resolveTemperatureUnit,
  VITAL_CANONICAL,
  toCanonicalTempF,
} from "@/lib/vitals-input";
import {
  getEpisodeRow,
  createEpisodeRow,
  mergeEpisodeRows,
} from "@/lib/illness-episode-store";
import {
  promoteEpisodeToConditionCore,
  unpromoteEpisodeConditionCore,
  endEpisodeCore,
  reopenEpisodeCore,
  endEpisodeAsOfCore,
  endEpisodeWithMedReconciliation,
  editEpisodeCore,
} from "@/lib/illness-episode-write";
import { getEpisodeMedReconciliation } from "@/lib/queries";
import { ackStaleNudge } from "@/lib/stale-episode-data";
import {
  attachSymptomPhotoCore,
  deleteSymptomPhotoCore,
  updateSymptomPhotoCaptionCore,
} from "@/lib/symptom-photo-write";
import {
  attachSymptomVideoCore,
  deleteSymptomVideoCore,
  updateSymptomVideoCaptionCore,
} from "@/lib/symptom-video-write";
import { ingestVideo } from "@/lib/video/ingest";
import { posterBytesFrom } from "@/lib/video/poster";
import { resolveVideoDate } from "@/lib/video/policy";
import { setSymptomSeverityCore } from "@/lib/symptom-log-write";

// Illness-episode Server Actions (issues #801/#856/#879). An action either operates on the
// session's ACTIVE profile (requireWriteAccess) or, when the cross-profile episode page /
// hero posts an explicit `profileId`, on that TARGET profile (requireProfileWriteAccess,
// the #31 gate that asserts the target is reachable AND write). The gate is INLINED in each
// action — never a shared helper — so the write-access scanner
// (lib/__tests__/actions-write-access.test.ts) sees a literal requireWriteAccess() in every
// body; the write cores stay auth-blind profileId-first (#319). Every episode is addressed
// by its STABLE ROW id (#856) and re-fetched scoped to the RESOLVED profile, so a forged id
// from another profile is dropped even past the gate.

export type EpisodeShareResult =
  { ok: true; path: string } | { ok: false; error: string };

export type EpisodeActionResult = { ok: true } | { ok: false; error: string };

function parseEpisodeId(formData: FormData): number | null {
  const n = Number(formData.get("episodeId"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function eventDateInEpisode(
  date: string,
  row: { started_at: string | null; ended_at: string | null }
): boolean {
  return (
    isRealIsoDate(date) &&
    (row.started_at == null || date >= row.started_at) &&
    (row.ended_at == null || date < row.ended_at)
  );
}

function revalidateEpisodeEvents() {
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/medications");
  revalidatePath("/results");
  revalidatePath("/timeline");
  revalidatePath("/");
}

export async function updateEpisodeTemperatureAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = parseEpisodeId(formData);
  const row = episodeId ? getEpisodeRow(profileId, episodeId) : null;
  const id = Number(formData.get("eventId"));
  const date = String(formData.get("date") ?? "");
  if (!row || !id)
    return { ok: false, error: "That reading is no longer available." };
  if (!eventDateInEpisode(date, row))
    return { ok: false, error: "Keep the reading within this episode." };
  const existing = db
    .prepare(
      `SELECT date FROM medical_records
        WHERE id = ? AND profile_id = ? AND canonical_name = ?`
    )
    .get(id, profileId, VITAL_CANONICAL.temperature.canonical) as
    { date: string } | undefined;
  if (!existing || !eventDateInEpisode(existing.date, row))
    return { ok: false, error: "That reading is no longer available." };
  const value = Number(formData.get("value"));
  const canonicalValue = Number.isFinite(value)
    ? toCanonicalTempF(
        value,
        resolveTemperatureUnit(value, String(formData.get("unit") ?? "F"))
      )
    : null;
  const outcome = updateTemperatureCore(
    profileId,
    id,
    canonicalValue,
    date,
    String(formData.get("time") ?? "")
  );
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  if (outcome.kind === "missing")
    return { ok: false, error: "That reading is no longer available." };
  revalidateEpisodeEvents();
  return { ok: true };
}

export async function updateEpisodeSymptomAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = parseEpisodeId(formData);
  const row = episodeId ? getEpisodeRow(profileId, episodeId) : null;
  const date = String(formData.get("date") ?? "");
  const symptom = String(formData.get("symptom") ?? "");
  if (!row || !eventDateInEpisode(date, row))
    return { ok: false, error: "That symptom is no longer available." };
  const existing = db
    .prepare(
      `SELECT 1 FROM symptom_logs
        WHERE profile_id = ? AND date = ? AND symptom = ?`
    )
    .get(profileId, date, symptom);
  if (!existing)
    return { ok: false, error: "That symptom is no longer available." };
  const outcome = setSymptomSeverityCore(
    profileId,
    symptom,
    Math.round(Number(formData.get("severity"))),
    date,
    String(formData.get("note") ?? "")
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Choose a severity from 1 to 4." };
  revalidateEpisodeEvents();
  return { ok: true };
}

export async function updateEpisodeDoseAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = parseEpisodeId(formData);
  const row = episodeId ? getEpisodeRow(profileId, episodeId) : null;
  const id = Number(formData.get("eventId"));
  const date = String(formData.get("date") ?? "");
  const time = String(formData.get("time") ?? "");
  if (!row || !id)
    return { ok: false, error: "That dose is no longer available." };
  if (!eventDateInEpisode(date, row) || !/^\d{2}:\d{2}$/.test(time))
    return { ok: false, error: "Enter a date and time within this episode." };
  const existing = db
    .prepare(
      `SELECT l.date FROM intake_item_logs l
         JOIN intake_items i ON i.id = l.item_id
        WHERE l.id = ? AND i.profile_id = ? AND i.as_needed = 1
          AND l.status = 'taken'`
    )
    .get(id, profileId) as { date: string } | undefined;
  if (!existing || !eventDateInEpisode(existing.date, row))
    return { ok: false, error: "That dose is no longer available." };
  const amount =
    String(formData.get("amount") ?? "")
      .trim()
      .slice(0, 120) || null;
  const updated = updateAdministrationLog(
    profileId,
    id,
    date,
    zonedWallTimeToUtc(getTimezone(profileId), date, time),
    amount
  );
  if (!updated)
    return { ok: false, error: "That dose is no longer available." };
  revalidateEpisodeEvents();
  return { ok: true };
}

export async function deleteEpisodeTemperatureAction(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = parseEpisodeId(formData);
  const row = episodeId ? getEpisodeRow(profileId, episodeId) : null;
  const id = Number(formData.get("eventId"));
  const owned =
    id && row
      ? (db
          .prepare(
            `SELECT id, date FROM medical_records
            WHERE id = ? AND profile_id = ? AND canonical_name = ?`
          )
          .get(id, profileId, VITAL_CANONICAL.temperature.canonical) as
          { id: number; date: string } | undefined)
      : null;
  const undoId =
    owned && eventDateInEpisode(owned.date, row!)
      ? captureDelete("biomarker-record", profileId, id)
      : null;
  revalidateEpisodeEvents();
  return { undoId };
}

export async function deleteEpisodeDoseAction(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = parseEpisodeId(formData);
  const row = episodeId ? getEpisodeRow(profileId, episodeId) : null;
  const id = Number(formData.get("eventId"));
  const owned =
    id && row
      ? (db
          .prepare(
            `SELECT l.date FROM intake_item_logs l
             JOIN intake_items i ON i.id = l.item_id
            WHERE l.id = ? AND i.profile_id = ? AND i.as_needed = 1
              AND l.status = 'taken'`
          )
          .get(id, profileId) as { date: string } | undefined)
      : null;
  const undoId =
    owned && eventDateInEpisode(owned.date, row!)
      ? deleteAdministrationLog(profileId, id)
      : null;
  revalidateEpisodeEvents();
  return { undoId };
}

// Mint a revocable share link for the episode, re-anchored to its stable id (#856). The
// link also stores the situation + start anchor so a pre-#856 resolver path (and a
// merged-away id) still resolves it; the range re-derives at view time.
//
// Cross-profile (issue #879): CREATING a share link for a household member's episode gates
// on WRITE for that profile — the conservative default, since a share token exposes the
// summary to anyone with the link. READING the printable summary is read-tier (the page
// renders for a view-only grant); minting the outbound link is not.
export async function createEpisodeShareLinkAction(
  formData: FormData
): Promise<EpisodeShareResult> {
  const target = Number(formData.get("profileId"));
  let session: CurrentSession;
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    session = await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    session = await requireWriteAccess();
    profileId = session.profile.id;
  }
  const { login } = session;
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profileId, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  const ttl = String(formData.get("ttl") ?? "");
  const expiresAt = expiresAtFor(ttl, new Date());
  const { id: linkId, token } = createEpisodeShareLink(
    profileId,
    login.id,
    row.situation,
    row.started_at,
    expiresAt,
    row.id
  );
  recordAudit({
    loginId: login.id,
    profileId,
    action: AUDIT_ACTIONS.shareLinkCreate,
    target: String(linkId),
  });
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true, path: `/share/${token}` };
}

// Promote the episode to a durable Condition (onset/resolved from the range). Idempotent.
// Cross-profile gated (issue #879): an explicit `profileId` acts on that member's episode.
export async function promoteEpisodeToConditionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profileId, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  const outcome = promoteEpisodeToConditionCore(profileId, row.id);
  if (outcome.kind === "invalid")
    return { ok: false, error: "Couldn't create the condition." };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/records");
  return { ok: true };
}

// Undo the promotion (delete only the episode-sourced condition). Cross-profile gated.
export async function unpromoteEpisodeConditionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profileId, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  unpromoteEpisodeConditionCore(profileId, row.id);
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/records");
  return { ok: true };
}

function parseDateOrNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s && isRealIsoDate(s) ? s : null;
}

// Edit an episode's boundaries + annotations (item 1 + item 8/9) as a plain row edit —
// derived membership follows the new [start, end) automatically. Coherence guard: an
// OPEN episode's end is owned by the situation toggle ("Feeling better"), so a submitted
// end on a still-open row is ignored here — the two are never allowed to disagree.
export async function editEpisodeAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profileId, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  const startedAt = parseDateOrNull(formData.get("startedAt"));
  const wasOpen = row.ended_at == null;
  // A closed episode may edit both ends; an open episode keeps its null end (the toggle
  // owns closing it). The submitted end must fall strictly after the start (exclusive).
  const submittedEnd = parseDateOrNull(formData.get("endedAt"));
  const endedAt = wasOpen ? null : submittedEnd;
  if (endedAt != null && startedAt != null && endedAt <= startedAt)
    return { ok: false, error: "The end date must be after the start date." };

  const updated = editEpisodeCore(
    profileId,
    id!,
    startedAt,
    endedAt,
    String(formData.get("note") ?? ""),
    String(formData.get("outcome") ?? "")
  );
  if (!updated)
    return { ok: false, error: "That episode is no longer available." };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/medical/episodes");
  return { ok: true };
}

// Retro-create a CLOSED historical episode ("was sick last week, never toggled", item 1).
// Both dates required (an OPEN episode is created by flagging the situation, not here).
export type EpisodeCreateResult =
  { ok: true; id: number } | { ok: false; error: string };

export async function createEpisodeAction(
  formData: FormData
): Promise<EpisodeCreateResult> {
  const { profile } = await requireWriteAccess();
  const situation = String(formData.get("situation") ?? "").trim() || "Illness";
  const startedAt = parseDateOrNull(formData.get("startedAt"));
  const endedAt = parseDateOrNull(formData.get("endedAt"));
  if (!startedAt || !endedAt)
    return { ok: false, error: "Enter both a start and an end date." };
  if (endedAt <= startedAt)
    return { ok: false, error: "The end date must be after the start date." };
  const newId = createEpisodeRow(profile.id, situation, startedAt, endedAt);
  revalidatePath("/medical/episodes");
  return { ok: true, id: newId };
}

// Merge a flap-split episode into a keeper (item 1) — widen the keeper to the union of
// both ranges and delete the loser. Both ids belong to the acting profile.
export async function mergeEpisodesAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const { profile } = await requireWriteAccess();
  const keepId = Number(formData.get("keepId"));
  const dropId = Number(formData.get("dropId"));
  if (!Number.isInteger(keepId) || !Number.isInteger(dropId))
    return { ok: false, error: "Pick two episodes to merge." };
  const merged = mergeEpisodeRows(profile.id, keepId, dropId);
  if (merged == null)
    return {
      ok: false,
      error: "One of those episodes is no longer available.",
    };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/medical/episodes");
  return { ok: true };
}

// End the open episode ("Feeling better", #856 item 2) — deactivates the situation and
// stamps the end through the ONE toggle write core.
export async function endEpisodeAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  // Cross-profile gating (issue #858): a caregiver ends a household member's episode
  // ("feeling better") from the hero cockpit without switching. An explicit `profileId`
  // gates on the TARGET (requireProfileWriteAccess, the #31 gate); absent, the active
  // profile is used (requireWriteAccess). endEpisodeCore is profile-scoped by episode id,
  // so a forged id from another profile is dropped even past the gate.
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  if (!id) return { ok: false, error: "That episode is no longer available." };
  const outcome = endEpisodeCore(profileId, id);
  if (outcome.kind === "missing")
    return { ok: false, error: "That episode is no longer available." };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/");
  revalidatePath("/nutrition");
  return { ok: true };
}

// Reopen a recently resolved episode when symptoms return. The core owns the short
// relapse window and reactivates the matching illness situation atomically, preserving
// the stable episode row and any promoted Condition. #1140 Part B: an OPTIONAL
// `medItemIds` selection restarts the meds this episode's end stopped — SUGGEST-ONLY,
// intersected in the core with the still-eligible persisted set, so an empty selection
// (the dashboard one-tap reopen, Part A) reopens the illness and restarts nothing.
export async function reopenEpisodeAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  if (!id) return { ok: false, error: "That episode is no longer available." };
  const restartItemIds = parseMedItemIds(formData.get("medItemIds"));
  const outcome = reopenEpisodeCore(profileId, id, restartItemIds);
  // A restarted med re-enters the refill-nudge tracked set (#325): drop any lingering
  // low-supply marker so a still-low med re-fires a fresh nudge (the same clear the
  // single-med Restart does).
  for (const itemId of outcome.restartedItemIds) {
    deleteProfileSetting(profileId, refillMarkerKey(itemId));
  }
  if (outcome.kind === "missing") {
    return { ok: false, error: "That episode is no longer available." };
  }
  if (outcome.kind === "expired") {
    return {
      ok: false,
      error:
        "This illness ended too long ago to reopen. Start a new episode instead.",
    };
  }
  if (outcome.kind === "conflict") {
    return { ok: false, error: "A current episode is already active." };
  }
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/medical/episodes");
  revalidatePath("/");
  revalidatePath("/nutrition");
  return { ok: true };
}

// End a STALE open episode BACKDATED to its last active day (issue #859 item 1, the
// stale-nudge's one-tap close). SUGGEST-ONLY: the caregiver initiated it; nothing ever
// auto-closes (#560). Cross-profile gated like endEpisodeAction; the last active day is
// the nudge's computed date (validated). The episode is profile-scoped by id in the
// core, so a forged id from another profile is dropped even past the gate.
export async function endStaleEpisodeAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  const lastActiveDay = parseDateOrNull(formData.get("lastActiveDay"));
  if (!id || !lastActiveDay)
    return { ok: false, error: "That episode is no longer available." };
  const outcome = endEpisodeAsOfCore(profileId, id, lastActiveDay);
  if (outcome.kind === "missing")
    return { ok: false, error: "That episode is no longer available." };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/");
  revalidatePath("/nutrition");
  return { ok: true };
}

// Parse the selected medication ids the end-episode reconciliation checklist posts (a
// comma-separated list). Non-numeric/empty entries are dropped.
function parseMedItemIds(v: FormDataEntryValue | null): number[] {
  return String(v ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// End an episode AND, in the SAME writeTx, close the courses of the selected episode-
// associated meds (issue #880) — the reconciliation checklist's confirm. SUGGEST-ONLY
// (#560): the checklist only lists DERIVED-associated meds, and this re-derives that set
// server-side (getEpisodeMedReconciliation) and INTERSECTS the posted ids with it, so a
// tampered id can never close an unrelated chronic med. `lastActiveDay` (present on the
// stale-nudge #859 path) routes the backdated end; absent → the "feeling better" end.
// Cross-profile gated like endEpisodeAction. Selected courses close with the new
// `illness_resolved` reason. An empty selection just ends the episode.
export async function endEpisodeWithMedsAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  if (!id) return { ok: false, error: "That episode is no longer available." };
  const lastActiveDay = parseDateOrNull(formData.get("lastActiveDay"));
  // Intersect the posted selection with the DERIVED associated set — the suggest-only
  // safety line: only meds the reconciliation actually proposes can be closed here.
  const allowed = new Set(
    getEpisodeMedReconciliation(profileId, id).map((s) => s.itemId)
  );
  const toStop = parseMedItemIds(formData.get("medItemIds")).filter((x) =>
    allowed.has(x)
  );
  const outcome = endEpisodeWithMedReconciliation(
    profileId,
    id,
    toStop,
    lastActiveDay
  );
  if (outcome.kind === "missing")
    return { ok: false, error: "That episode is no longer available." };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/");
  revalidatePath("/nutrition");
  revalidatePath("/medications");
  return { ok: true };
}

// Attach a symptom photo to a day (issue #859 item 4). Rides the existing upload posture
// (per-profile dirs, sha256 dedup, image sniff). Cross-profile gated (issue #879): an
// explicit `profileId` attaches to that member's episode. Answers from the core's typed
// outcome; never leaks internals.
export async function uploadSymptomPhotoAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0)
    return { ok: false, error: "Choose a photo to attach." };
  const date = parseDateOrNull(formData.get("date"));
  if (!date) return { ok: false, error: "Enter a valid date." };
  const symptom = String(formData.get("symptom") ?? "").trim() || null;
  const caption = String(formData.get("caption") ?? "").trim() || null;
  const buffer = Buffer.from(await file.arrayBuffer());
  const outcome = attachSymptomPhotoCore(
    profileId,
    date,
    buffer,
    file.name,
    symptom,
    caption
  );
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true };
}

// Edit the caption without replacing the image. Cross-profile gated; the core scopes
// the photo id to the resolved profile so a forged household photo id cannot be edited.
export async function updateSymptomPhotoCaptionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = Number(formData.get("photoId"));
  if (!Number.isInteger(id) || id <= 0)
    return { ok: false, error: "That photo is no longer available." };
  const caption = String(formData.get("caption") ?? "");
  if (!updateSymptomPhotoCaptionCore(profileId, id, caption))
    return { ok: false, error: "That photo is no longer available." };
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true };
}

// Delete a symptom photo (row + on-disk file). Cross-profile gated (issue #879); the core
// is profile-scoped by id, so a forged photo id from another profile is dropped.
export async function deleteSymptomPhotoAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = Number(formData.get("photoId"));
  if (!Number.isInteger(id) || id <= 0)
    return { ok: false, error: "That photo is no longer available." };
  deleteSymptomPhotoCore(profileId, id);
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true };
}

// Attach a symptom VIDEO/AUDIO clip to a day (#1224 phase 1). The bytes are
// container-sniffed + capped by ingestVideo (never the client type; 60s/100MB),
// stored AS-IS; a client-extracted poster frame (`poster`) is run through the
// #1119 photo ingest to strip its EXIF before storage. Cross-profile gated (#879).
// Answers from the core's typed outcome; never leaks internals.
export async function uploadSymptomVideoAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const file = formData.get("video");
  if (!(file instanceof File) || file.size === 0)
    return { ok: false, error: "Choose a clip to attach." };
  const explicitDate = parseDateOrNull(formData.get("date"));
  const symptom = String(formData.get("symptom") ?? "").trim() || null;
  const caption = String(formData.get("caption") ?? "").trim() || null;

  const ingested = ingestVideo(Buffer.from(await file.arrayBuffer()));
  if (ingested.kind === "invalid") return { ok: false, error: ingested.error };

  // A poster frame is optional — an audio clip, or a browser that couldn't decode
  // the frame, simply has none. When present, strip its metadata via the photo
  // pipeline before storing.
  const poster = await posterBytesFrom(formData.get("poster"));

  const date = resolveVideoDate(
    explicitDate,
    ingested.video.creationDate,
    today(profileId)
  );
  const outcome = attachSymptomVideoCore(
    profileId,
    { date, symptom, caption },
    ingested.video,
    poster
  );
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true };
}

// Edit a symptom clip's caption without replacing the file. Cross-profile gated;
// the core scopes the id to the resolved profile.
export async function updateSymptomVideoCaptionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = Number(formData.get("videoId"));
  if (!Number.isInteger(id) || id <= 0)
    return { ok: false, error: "That clip is no longer available." };
  const caption = String(formData.get("caption") ?? "");
  if (!updateSymptomVideoCaptionCore(profileId, id, caption))
    return { ok: false, error: "That clip is no longer available." };
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true };
}

// Delete a symptom clip (row + on-disk files). Cross-profile gated (#879); the
// core is profile-scoped by id, so a forged household clip id is dropped.
export async function deleteSymptomVideoAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = Number(formData.get("videoId"));
  if (!Number.isInteger(id) || id <= 0)
    return { ok: false, error: "That clip is no longer available." };
  deleteSymptomVideoCore(profileId, id);
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true };
}

// Dismiss the stale-episode nudge for THIS open episode ("keep it open") — remembers
// the episode id so the suggest-only nudge doesn't nag daily (issue #859 item 1).
// Cross-profile gated. Never changes the episode; only the per-episode ack marker.
export async function dismissStaleNudgeAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = parseEpisodeId(formData);
  if (!id) return { ok: false, error: "That episode is no longer available." };
  ackStaleNudge(profileId, id);
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/");
  return { ok: true };
}
