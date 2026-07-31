"use server";
// API token management actions (issue #1734) — the request boundary for minting and
// revoking the login-tied bearer credentials that back remote (non-cookie) API access.
//
// AUTH TIER. A token belongs to a LOGIN, not to a profile, so these gate on
// requireLoginWriteAccess() — the same guard change-own-password / 2FA / session
// revocation use. requireWriteAccess() would be the wrong gate twice over: it checks
// the ACTIVE PROFILE (irrelevant here), and it would wrongly refuse a caregiver whose
// only grant is read-only but who still gets to manage their own credentials. What
// requireLoginWriteAccess() adds over a bare requireSession() is the demo-mode refusal
// (#278): in a public demo the SHARED login must not be able to mint a credential that
// outlives the visit, or revoke another visitor's.
//
// Split into its own "use server" file rather than added to ./actions.ts so the
// write-access enforcement scanner's allowlist entries name a file that contains
// nothing but the token lifecycle.
//
// SECRECY. createApiTokenAction returns the plaintext exactly once, to the caller that
// minted it. Nothing else in the app can ever produce it again: only the scrypt hash is
// stored, no listing exposes secret material, and neither of these actions logs the
// token. The audit rows carry the token ID and the login only.

import { revalidatePath } from "next/cache";
import { requireLoginWriteAccess } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import {
  createApiToken,
  countApiTokensForLogin,
  revokeApiToken,
  MAX_TOKENS_PER_LOGIN,
} from "@/lib/api-tokens";
import { isApiTokenScope, type ApiTokenScope } from "@/lib/api-token-format";

// The mint outcome is TYPED, not a blanket success: the write can legitimately refuse
// (an unknown scope, a missing name, the per-login cap), and the client renders each
// refusal rather than pretending a token exists.
export type MintApiTokenResult =
  | { ok: true; token: string; name: string; scope: ApiTokenScope }
  | { ok: false; error: string };

export type RevokeApiTokenResult = { ok: true } | { ok: false; error: string };

const MAX_NAME = 60;

export async function createApiTokenAction(
  formData: FormData
): Promise<MintApiTokenResult> {
  const { login } = await requireLoginWriteAccess();

  const name = String(formData.get("name") ?? "")
    .trim()
    .slice(0, MAX_NAME);
  if (!name) return { ok: false, error: "Give the token a name." };

  // The scope arrives from a client <select>, so it is untrusted: validate it against
  // the capability vocabulary here. (The column's CHECK would refuse an unknown value
  // too, but as a constraint violation rather than a message anyone can act on.)
  const rawScope = String(formData.get("scope") ?? "");
  if (!isApiTokenScope(rawScope)) {
    return { ok: false, error: "Unknown capability." };
  }

  if (countApiTokensForLogin(login.id) >= MAX_TOKENS_PER_LOGIN) {
    return {
      ok: false,
      error: `You already have ${MAX_TOKENS_PER_LOGIN} tokens. Revoke one first.`,
    };
  }

  const minted = await createApiToken(login.id, name, rawScope);
  recordAudit({
    loginId: login.id,
    // The acting profile at mint time is context only — a token is not scoped to it.
    profileId: null,
    action: AUDIT_ACTIONS.tokenMint,
    target: String(minted.id),
    // Identifiers only: which credential family, and its capability. Never the secret.
    detail: `api-token ${rawScope}`,
  });
  revalidatePath("/settings/tokens");
  return { ok: true, token: minted.token, name, scope: rawScope };
}

export async function revokeApiTokenAction(
  formData: FormData
): Promise<RevokeApiTokenResult> {
  const { login } = await requireLoginWriteAccess();
  const id = Number(formData.get("token_id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Unknown token." };
  }

  // Compare-and-swap inside the DB layer, scoped to the caller's own login unless
  // they are an admin. `false` means the row was already revoked, or was never theirs
  // to revoke — the same answer either way, so this can't be used to probe which
  // token ids exist on other logins.
  const revoked = revokeApiToken(id, login.id, login.role);
  if (!revoked) {
    return { ok: false, error: "That token is already revoked." };
  }

  recordAudit({
    loginId: login.id,
    profileId: null,
    action: AUDIT_ACTIONS.tokenRevoke,
    target: String(id),
    detail: "api-token",
  });
  revalidatePath("/settings/tokens");
  return { ok: true };
}
