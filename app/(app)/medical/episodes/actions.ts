"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { expiresAtFor } from "@/lib/share-links";
import { createEpisodeShareLink } from "@/lib/share-links-db";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { isRealIsoDate } from "@/lib/date";
import { episodeForProfileDate } from "@/lib/illness-episode";
import {
  promoteEpisodeToConditionCore,
  unpromoteEpisodeConditionCore,
} from "@/lib/illness-episode-write";

// Illness-episode Server Actions (issue #801). Each is gated by requireWriteAccess()
// and operates ONLY on the session's active profile — there is no profile_id input to
// tamper with (the same posture as the passport share actions). The episode itself is
// resolved from an anchor DATE inside it via the shared derivation, never re-derived here.

export type EpisodeShareResult =
  { ok: true; path: string } | { ok: false; error: string };

export type EpisodeActionResult = { ok: true } | { ok: false; error: string };

// Mint a revocable share link for the episode containing `anchor` (a date the detail
// page passes). Stores the situation + anchor; the range re-derives at view time.
export async function createEpisodeShareLinkAction(
  formData: FormData
): Promise<EpisodeShareResult> {
  const { login, profile } = await requireWriteAccess();
  const anchor = String(formData.get("anchor") ?? "");
  if (!isRealIsoDate(anchor))
    return { ok: false, error: "That episode is no longer available." };
  const episode = episodeForProfileDate(profile.id, anchor);
  if (!episode)
    return { ok: false, error: "No illness episode covers that day." };

  const ttl = String(formData.get("ttl") ?? "");
  const expiresAt = expiresAtFor(ttl, new Date());
  const { id, token } = createEpisodeShareLink(
    profile.id,
    login.id,
    episode.situation,
    anchor,
    expiresAt
  );
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.shareLinkCreate,
    target: String(id),
  });
  revalidatePath("/medical/episodes/[date]", "page");
  return { ok: true, path: `/share/${token}` };
}

// Promote the episode containing `anchor` to a durable Condition (onset/resolved from
// the range). Idempotent.
export async function promoteEpisodeToConditionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const { profile } = await requireWriteAccess();
  const anchor = String(formData.get("anchor") ?? "");
  if (!isRealIsoDate(anchor))
    return { ok: false, error: "That episode is no longer available." };
  const episode = episodeForProfileDate(profile.id, anchor);
  if (!episode)
    return { ok: false, error: "No illness episode covers that day." };

  const outcome = promoteEpisodeToConditionCore(
    profile.id,
    episode.situation,
    episode.start,
    episode.end
  );
  if (outcome.kind === "invalid")
    return { ok: false, error: "Could not create the condition." };
  revalidatePath("/medical/episodes/[date]", "page");
  revalidatePath("/conditions");
  return { ok: true };
}

// Undo the promotion (delete only the episode-sourced condition).
export async function unpromoteEpisodeConditionAction(
  formData: FormData
): Promise<EpisodeActionResult> {
  const { profile } = await requireWriteAccess();
  const anchor = String(formData.get("anchor") ?? "");
  if (!isRealIsoDate(anchor))
    return { ok: false, error: "That episode is no longer available." };
  const episode = episodeForProfileDate(profile.id, anchor);
  if (!episode)
    return { ok: false, error: "No illness episode covers that day." };

  unpromoteEpisodeConditionCore(profile.id, episode.situation, episode.start);
  revalidatePath("/medical/episodes/[date]", "page");
  revalidatePath("/conditions");
  return { ok: true };
}
