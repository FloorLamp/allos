"use server";
import { gateItemProfile } from "./gate-item";
import { revalidateRoute } from "@/lib/revalidate";
import {
  linkRecordToEncounter,
  declineRecordVisitLink,
  unlinkRecordFromEncounter,
  linkEpisodeToEncounter,
  declineEpisodeVisitLink,
  unlinkEpisodeFromEncounter,
  createVisitFromRecord,
  declineCreateVisit,
} from "@/lib/queries";
import type { VisitLinkDomain } from "@/lib/visit-link-suggest";
import { isCreateVisitDomain } from "@/lib/visit-link-suggest";

// Record ↔ visit and episode ↔ visit accept/decline/manual-link writes (#1050/#1053).
// These are rendered as plain server-component <form action={…}> submits, so each
// returns Promise<void> (the form-action contract) and revalidates; the surfaces
// re-render with the new link state. The lib write cores are auth-blind and
// profileId-first, so the action layer owns the gate.
//
// ONE SPELLING FOR THE SUBJECT (#4780), the ruling #4730 already made elsewhere.
// Every form here stamps the subject as `profile_id` and `gateItemProfile` is this
// repo’s one reader of it: an explicit target is write-gated with
// requireProfileWriteAccess, its absence falls back to the acting profile. Each of
// these ten actions hand-rolled those two branches around a camelCase `profileId`,
// which is the divergence that made #4730 invisible until someone read the form and
// the action side by side. Nothing reads the old key now — not even as a fallback,
// because a reader for a name nothing posts is how the next copy gets written.
//
// The `requireWriteAccess()` literal the write-access scanner (#319) looks for lives
// in gate-item.ts; these ten are allowlisted as gateItemProfile delegators in
// lib/__tests__/actions-write-access.test.ts, exactly as their siblings are.

const RECORD_DOMAINS: ReadonlySet<string> = new Set([
  "record",
  "medication",
  "condition",
  "procedure",
  "imaging",
  "immunization",
  "optical",
  "dental",
  // #1526: skin_lesions + allergies gained encounter_id (migration 125), so they join
  // the accept/decline/unlink flow like every other clinical observation.
  "skin",
  "allergy",
]);

function recordDomain(
  formData: FormData
): Exclude<VisitLinkDomain, "episode"> | null {
  const d = String(formData.get("domain") ?? "");
  return RECORD_DOMAINS.has(d)
    ? (d as Exclude<VisitLinkDomain, "episode">)
    : null;
}

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
  // The visits surface lives at /records/history/visits (#1079); only the per-visit
  // DETAIL page still sits under /encounters. Revalidating "/encounters" alone was a
  // no-op — that path serves nothing (#1636).
  revalidateRoute("/records/history/visits");
  revalidateRoute("/encounters/[id]", "page");
  revalidateRoute("/records");
  // #1526: the allergy attribution also prints on the emergency card / passport.
  revalidateRoute("/profile");
  revalidateRoute("/results");
  revalidateRoute("/medications", "layout");
  revalidateRoute("/medical/episodes", "layout");
  revalidateRoute("/");
}

// Accept one suggested (or manually picked) record ↔ visit link.
export async function linkRecordVisitAction(formData: FormData): Promise<void> {
  const profileId = await gateItemProfile(formData);
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
  const profileId = await gateItemProfile(formData);
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
  const profileId = await gateItemProfile(formData);
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
  const profileId = await gateItemProfile(formData);
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
  const profileId = await gateItemProfile(formData);
  const domain = recordDomain(formData);
  const recordId = Number(formData.get("recordId"));
  if (domain && recordId) {
    unlinkRecordFromEncounter(profileId, domain, recordId);
    revalidateVisitLinks();
  }
}

// ── "Create a visit from this record?" (#1099) ───────────────────────────────────

// Accept: create the skeleton encounter from the record AND link it (one writeTx in
// the lib core). Only the three visit-implying create domains (optical/dental/imaging)
// are honored.
export async function createVisitFromRecordAction(
  formData: FormData
): Promise<void> {
  const profileId = await gateItemProfile(formData);
  const domain = String(formData.get("domain") ?? "");
  const recordId = Number(formData.get("recordId"));
  if (isCreateVisitDomain(domain) && recordId) {
    createVisitFromRecord(profileId, domain, recordId);
    revalidateVisitLinks();
  }
}

// Decline: remember the "create a visit" decision so the prompt never re-nags.
export async function declineCreateVisitAction(
  formData: FormData
): Promise<void> {
  const profileId = await gateItemProfile(formData);
  const domain = String(formData.get("domain") ?? "");
  const recordId = Number(formData.get("recordId"));
  if (isCreateVisitDomain(domain) && recordId) {
    declineCreateVisit(profileId, domain, recordId);
    revalidateVisitLinks();
  }
}

// ── Episode ↔ visit (#1053) ─────────────────────────────────────────────────────

export async function linkEpisodeVisitAction(
  formData: FormData
): Promise<void> {
  const profileId = await gateItemProfile(formData);
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
  const profileId = await gateItemProfile(formData);
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
  const profileId = await gateItemProfile(formData);
  const episodeId = Number(formData.get("episodeId"));
  const encounterId = Number(formData.get("encounterId"));
  if (episodeId && encounterId) {
    unlinkEpisodeFromEncounter(profileId, episodeId, encounterId);
    revalidateVisitLinks();
  }
}
