"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import {
  normalizeShareFields,
  expiresAtFor,
  type ShareField,
} from "@/lib/share-links";
import { createShareLink, revokeShareLink } from "@/lib/share-links-db";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

// Share-link management for the profile passport. Every action is
// gated by requireWriteAccess() and operates ONLY on the session's active profile
// (session.profile.id) — a login can only act as a profile it's authorized for
// (admins: any; members: their granted ones), so this enforces the grant rule by
// construction: there is no profile_id input to tamper with.

export type ShareResult =
  { ok: true; path?: string; message?: string } | { ok: false; error: string };

// Create a link and return its RELATIVE path (`/share/<token>`); the client turns
// it into an absolute URL with its own origin. The raw token is returned exactly
// once and never stored — only its hash is persisted.
export async function createShareLinkAction(
  formData: FormData
): Promise<ShareResult> {
  const { login, profile } = requireWriteAccess();

  const fields = normalizeShareFields(
    formData.getAll("field").map((v) => String(v))
  ) as ShareField[];
  if (fields.length === 0)
    return { ok: false, error: "Pick at least one section to share." };

  const ttl = String(formData.get("ttl") ?? "");
  const expiresAt = expiresAtFor(ttl, new Date());

  const { id, token } = createShareLink(
    profile.id,
    login.id,
    fields,
    expiresAt
  );
  // Audit the creation by the link's id — NEVER the raw token (a live secret).
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.shareLinkCreate,
    target: String(id),
  });

  revalidatePath("/profile");
  return { ok: true, path: `/share/${token}` };
}

export async function revokeShareLinkAction(
  formData: FormData
): Promise<ShareResult> {
  const { login, profile } = requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { ok: false, error: "Unknown link." };

  const revoked = revokeShareLink(profile.id, id);
  if (!revoked)
    return { ok: false, error: "Link not found or already revoked." };
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.shareLinkRevoke,
    target: String(id),
  });

  revalidatePath("/profile");
  return { ok: true, message: "Link revoked." };
}
