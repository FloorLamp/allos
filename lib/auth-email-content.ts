// Pure content + validation for the login-lifecycle emails (issue #985), split out
// of lib/auth-email.ts (which touches settings/DB and the mail chokepoint) so the
// address check, the no-enumeration message, and the message bodies are unit-tested
// without any DB — the lib/share-token.ts precedent. No DB, no network.

// The app's product name in copy. (No i18n layer — the copy standard lives in
// docs/internals/copy.md; these strings follow it.)
export const APP_NAME = "Allos";

// The single set-password destination for BOTH flows — the link carries the token,
// and the page/action resolve its kind. Public (middleware allowlist).
export const SET_PASSWORD_PATH = "/set-password";

// Enumeration-safe reply for the reset REQUEST (the calendar-feed no-oracle
// precedent applied to auth): the same message whether or not the address is
// registered, so a prober learns nothing.
export const RESET_REQUEST_MESSAGE =
  "If that email is registered, we've sent a link to reset the password.";

// A deliberately loose, dependency-free email check — enough to reject obvious
// non-addresses in a form without pretending to validate deliverability (the
// invite/reset mail itself proves the address).
export function isValidEmail(value: string): boolean {
  const s = value.trim();
  if (!s || s.length > 254) return false;
  // one @, non-empty local part, a dotted domain, no spaces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Normalize an address for storage: trim only (case is preserved for display; the
// unique index + lookups are COLLATE NOCASE, so casing never causes a collision or
// a missed match).
export function normalizeEmail(value: string): string {
  return value.trim();
}

// Build the absolute set-password link from a base URL + a raw token. Returns null
// when no base URL is configured (the caller then refuses to send).
export function setPasswordLink(
  baseUrl: string,
  rawToken: string
): string | null {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${SET_PASSWORD_PATH}?token=${encodeURIComponent(rawToken)}`;
}

export interface EmailBody {
  subject: string;
  text: string;
}

// Invite email — no PHI, names only the app + the action.
export function buildInviteEmail(username: string, link: string): EmailBody {
  return {
    subject: `Set up your ${APP_NAME} login`,
    text:
      `An ${APP_NAME} login was created for you (username: ${username}).\n\n` +
      `Set your password to finish signing up:\n${link}\n\n` +
      `This link expires in 24 hours. If you weren't expecting this, you can ignore this email.`,
  };
}

// Password-reset email — no PHI.
export function buildResetEmail(username: string, link: string): EmailBody {
  return {
    subject: `Reset your ${APP_NAME} password`,
    text:
      `A password reset was requested for your ${APP_NAME} login (username: ${username}).\n\n` +
      `Choose a new password:\n${link}\n\n` +
      `This link expires in 1 hour. If you didn't request this, you can ignore this email — your password is unchanged.`,
  };
}
