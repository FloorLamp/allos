"use server";
import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  linkRecordToEncounter,
  declineRecordVisitLink,
  unlinkRecordFromEncounter,
  linkEpisodeToEncounter,
  declineEpisodeVisitLink,
  unlinkEpisodeFromEncounter,
} from "@/lib/queries";
import type { VisitLinkDomain } from "@/lib/visit-link-suggest";

// Record ↔ visit and episode ↔ visit accept/decline/manual-link writes (#1050/#1053).
// These are rendered as plain server-component <form action={…}> submits, so each
// returns Promise<void> (the form-action contract) and revalidates; the surfaces
// re-render with the new link state. Session-scoped with the cross-profile dual gate
// (the episode/encounter/med detail surfaces resolve across accessible profiles): a
// posted `profileId` gates on that TARGET profile (requireProfileWriteAccess), else
// the active profile (requireWriteAccess — the literal every action body carries for
// the write-access scanner, #319). The lib write cores are auth-blind, profileId-first.

const RECORD_DOMAINS: ReadonlySet<string> = new Set([
  "record",
  "medication",
  "condition",
  "procedure",
  "imaging",
  "immunization",
]);

function recordDomain(
  formData: FormData
): Exclude<VisitLinkDomain, "episode"> | null {
  const d = String(formData.get("domain") ?? "");
  return RECORD_DOMAINS.has(d)
    ? (d as Exclude<VisitLinkDomain, "episode">)
    : null;
}

// The cross-profile dual gate, inlined into EVERY action body so the write-access
// scanner (#319) sees the literal requireWriteAccess() per action: a posted profileId
// gates on that TARGET profile, else the active profile.

function parsePairs(
  formData: FormData
): { domain: string; recordId: number }[] {
  try {
    const raw = JSON.parse(String(formData.get("pairs") ?? "[]"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function revalidateVisitLinks() {
  revalidatePath("/encounters", "layout");
  revalidatePath("/records");
  revalidatePath("/medications", "layout");
  revalidatePath("/medical/episodes", "layout");
  revalidatePath("/");
}

// Accept one suggested (or manually picked) record ↔ visit link.
export async function linkRecordVisitAction(formData: FormData): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const domain = recordDomain(formData);
  const recordId = Number(formData.get("recordId"));
  const encounterId = Number(formData.get("encounterId"));
  if (domain && recordId && encounterId) {
    linkRecordToEncounter(profileId, domain, recordId, encounterId);
    revalidateVisitLinks();
  }
}

// Decline one suggested record ↔ visit pair — remembered, never re-suggested.
export async function declineRecordVisitAction(
  formData: FormData
): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const domain = recordDomain(formData);
  const recordId = Number(formData.get("recordId"));
  const encounterId = Number(formData.get("encounterId"));
  if (domain && recordId && encounterId) {
    declineRecordVisitLink(profileId, domain, recordId, encounterId);
    revalidateVisitLinks();
  }
}

// Batch: accept every listed record ↔ visit pair ("link all").
export async function linkAllFromVisitAction(
  formData: FormData
): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const encounterId = Number(formData.get("encounterId"));
  if (!encounterId) return;
  for (const p of parsePairs(formData)) {
    if (RECORD_DOMAINS.has(p.domain) && Number.isInteger(p.recordId)) {
      linkRecordToEncounter(
        profileId,
        p.domain as Exclude<VisitLinkDomain, "episode">,
        p.recordId,
        encounterId
      );
    }
  }
  revalidateVisitLinks();
}

// Batch: decline every listed record ↔ visit pair ("dismiss" the block).
export async function dismissAllFromVisitAction(
  formData: FormData
): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const encounterId = Number(formData.get("encounterId"));
  if (!encounterId) return;
  for (const p of parsePairs(formData)) {
    if (RECORD_DOMAINS.has(p.domain) && Number.isInteger(p.recordId)) {
      declineRecordVisitLink(
        profileId,
        p.domain as Exclude<VisitLinkDomain, "episode">,
        p.recordId,
        encounterId
      );
    }
  }
  revalidateVisitLinks();
}

// Clear a record's visit link (un-link).
export async function unlinkRecordVisitAction(
  formData: FormData
): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const domain = recordDomain(formData);
  const recordId = Number(formData.get("recordId"));
  if (domain && recordId) {
    unlinkRecordFromEncounter(profileId, domain, recordId);
    revalidateVisitLinks();
  }
}

// ── Episode ↔ visit (#1053) ─────────────────────────────────────────────────────

export async function linkEpisodeVisitAction(
  formData: FormData
): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = Number(formData.get("episodeId"));
  const encounterId = Number(formData.get("encounterId"));
  if (episodeId && encounterId) {
    linkEpisodeToEncounter(profileId, episodeId, encounterId);
    revalidateVisitLinks();
  }
}

export async function declineEpisodeVisitAction(
  formData: FormData
): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = Number(formData.get("episodeId"));
  const encounterId = Number(formData.get("encounterId"));
  if (episodeId && encounterId) {
    declineEpisodeVisitLink(profileId, episodeId, encounterId);
    revalidateVisitLinks();
  }
}

export async function unlinkEpisodeVisitAction(
  formData: FormData
): Promise<void> {
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const episodeId = Number(formData.get("episodeId"));
  if (episodeId) {
    unlinkEpisodeFromEncounter(profileId, episodeId);
    revalidateVisitLinks();
  }
}
