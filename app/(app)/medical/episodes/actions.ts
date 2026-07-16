"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { expiresAtFor } from "@/lib/share-links";
import { createEpisodeShareLink } from "@/lib/share-links-db";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { getEpisodeRow } from "@/lib/illness-episode-store";
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
