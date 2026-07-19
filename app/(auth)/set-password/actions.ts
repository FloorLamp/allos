"use server";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { checkPasswordStrength } from "@/lib/password-strength";
import { destroyLoginSessions } from "@/lib/auth";
import {
  consumeAuthToken,
  invalidateAuthTokensForLogin,
  peekAuthToken,
} from "@/lib/auth-tokens";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

export interface SetPasswordState {
  error?: string;
  ok?: boolean;
}

// One generic message for every dead-token case (unknown, consumed, expired), so a
// prober learns nothing — the same no-oracle posture as the reset request.
const INVALID_LINK =
  "This link is invalid or has expired. Request a new one from the sign-in page.";

// Complete an invite or reset: set the login's password from a single-use token.
// Shared by both flows — the token carries its own kind. On success it:
//   • sets the new password (2FA is UNTOUCHED — a TOTP login still needs its code
//     at the next sign-in; email reset is not a second 2FA escape hatch),
//   • invalidates every other outstanding token for the login, and
//   • destroys ALL of the login's sessions (the reset discipline; an invite login
//     has none, so it's a harmless no-op there).
export async function completeSetPassword(
  _prev: SetPasswordState,
  formData: FormData
): Promise<SetPasswordState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!token) return { error: INVALID_LINK };

  // Peek (no consume) to resolve the username for the strength check, so a weak
  // password doesn't burn a still-valid token — the user can retry.
  const peeked = peekAuthToken(token);
  if (!peeked) return { error: INVALID_LINK };
  const acct = db
    .prepare("SELECT username FROM logins WHERE id = ?")
    .get(peeked.loginId) as { username: string } | undefined;
  if (!acct) return { error: INVALID_LINK };

  const strength = checkPasswordStrength(password, { username: acct.username });
  if (!strength.ok) return { error: strength.error };

  // Atomically spend the token (single-use + expiry checked in the one UPDATE). A
  // lost race / just-expired token returns null here.
  const consumed = consumeAuthToken(token);
  if (!consumed) return { error: INVALID_LINK };

  const passwordHash = await hashPassword(password);
  db.prepare("UPDATE logins SET password_hash = ? WHERE id = ?").run(
    passwordHash,
    consumed.loginId
  );
  invalidateAuthTokensForLogin(consumed.loginId);
  destroyLoginSessions(consumed.loginId);
  recordAudit({
    loginId: consumed.loginId,
    action: AUDIT_ACTIONS.passwordReset,
    detail: consumed.kind,
  });
  return { ok: true };
}
