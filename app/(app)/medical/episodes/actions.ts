"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { expiresAtFor } from "@/lib/share-links";
import { createEpisodeShareLink } from "@/lib/share-links-db";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { isRealIsoDate } from "@/lib/date";
import {
  getEpisodeRow,
  updateEpisodeBoundaries,
  setEpisodeNote,
  setEpisodeOutcome,
  createEpisodeRow,
  mergeEpisodeRows,
} from "@/lib/illness-episode-store";
import {
  promoteEpisodeToConditionCore,
  unpromoteEpisodeConditionCore,
  endEpisodeCore,
} from "@/lib/illness-episode-write";

// Illness-episode Server Actions (issues #801/#856). Each is gated by requireWriteAccess()
// and operates ONLY on the session's active profile — the episode is addressed by its
// STABLE ROW id (#856), scoped to the profile in getEpisodeRow, so there is no profile_id
// input to tamper with (the same posture as the passport share actions).

export type EpisodeShareResult =
  { ok: true; path: string } | { ok: false; error: string };

export type EpisodeActionResult = { ok: true } | { ok: false; error: string };

function parseEpisodeId(formData: FormData): number | null {
  const n = Number(formData.get("episodeId"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Mint a revocable share link for the episode, re-anchored to its stable id (#856). The
// link also stores the situation + start anchor so a pre-#856 resolver path (and a
// merged-away id) still resolves it; the range re-derives at view time.
export async function createEpisodeShareLinkAction(
  formData: FormData
): Promise<EpisodeShareResult> {
  const { login, profile } = await requireWriteAccess();
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profile.id, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  const ttl = String(formData.get("ttl") ?? "");
  const expiresAt = expiresAtFor(ttl, new Date());
  const { id: linkId, token } = createEpisodeShareLink(
    profile.id,
    login.id,
    row.situation,
    row.started_at,
    expiresAt,
    row.id
  );
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.shareLinkCreate,
    target: String(linkId),
  });
  revalidatePath("/medical/episodes/[id]", "page");
  return { ok: true, path: `/share/${token}` };
}

// Promote the episode to a durable Condition (onset/resolved from the range). Idempotent.
export async function promoteEpisodeToConditionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const { profile } = await requireWriteAccess();
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profile.id, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  const outcome = promoteEpisodeToConditionCore(
    profile.id,
    row.situation,
    row.started_at,
    row.ended_at
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Could not create the condition." };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/conditions");
  return { ok: true };
}

// Undo the promotion (delete only the episode-sourced condition).
export async function unpromoteEpisodeConditionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const { profile } = await requireWriteAccess();
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profile.id, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  unpromoteEpisodeConditionCore(profile.id, row.situation, row.started_at);
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/conditions");
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
  const { profile } = await requireWriteAccess();
  const id = parseEpisodeId(formData);
  const row = id ? getEpisodeRow(profile.id, id) : null;
  if (!row) return { ok: false, error: "That episode is no longer available." };

  const startedAt = parseDateOrNull(formData.get("startedAt"));
  const wasOpen = row.ended_at == null;
  // A closed episode may edit both ends; an open episode keeps its null end (the toggle
  // owns closing it). The submitted end must fall strictly after the start (exclusive).
  const submittedEnd = parseDateOrNull(formData.get("endedAt"));
  const endedAt = wasOpen ? null : submittedEnd;
  if (endedAt != null && startedAt != null && endedAt <= startedAt)
    return { ok: false, error: "The end date must be after the start date." };

  updateEpisodeBoundaries(profile.id, id!, startedAt, endedAt);
  setEpisodeNote(profile.id, id!, String(formData.get("note") ?? ""));
  setEpisodeOutcome(profile.id, id!, String(formData.get("outcome") ?? ""));
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
  const { profile } = await requireWriteAccess();
  const id = parseEpisodeId(formData);
  if (!id) return { ok: false, error: "That episode is no longer available." };
  const outcome = endEpisodeCore(profile.id, id);
  if (outcome.kind === "missing")
    return { ok: false, error: "That episode is no longer available." };
  revalidatePath("/medical/episodes/[id]", "page");
  revalidatePath("/");
  revalidatePath("/nutrition");
  return { ok: true };
}
