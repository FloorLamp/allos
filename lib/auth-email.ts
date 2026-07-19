import { getPublicUrl } from "./settings";
import { isEmailConfigured, sendEmail } from "./email";
import { createAuthToken } from "./auth-tokens";
import {
  buildInviteEmail,
  buildResetEmail,
  setPasswordLink,
} from "./auth-email-content";
import type { AuthTokenKind } from "./auth-token-crypto";

// Login-lifecycle email orchestration (issue #985): minting a token and handing the
// composed invite / reset message to the lib/email chokepoint. AUTH-BLIND — it takes
// ids/strings, never imports lib/auth; the calling Server Actions own the gate. The
// pure pieces (address validation, the no-enumeration message, the message bodies,
// the link builder) live in lib/auth-email-content (unit-tested) and are re-exported
// here so existing import paths keep resolving them from lib/auth-email.

export {
  isValidEmail,
  normalizeEmail,
  RESET_REQUEST_MESSAGE,
  buildInviteEmail,
  buildResetEmail,
  setPasswordLink,
  type EmailBody,
} from "./auth-email-content";

// Whether the instance can send login-lifecycle mail at all: SMTP configured AND a
// public URL set (a reset link to localhost is worse than none). Every email
// affordance gates on this — a false value hides the "Forgot password?" link and
// the invite button and makes the send actions refuse with honest copy.
export function canSendAuthEmail(): boolean {
  return isEmailConfigured() && !!getPublicUrl();
}

// Mint a token of `kind`, build the link from the public URL, and send the matching
// mail. Throws when no public URL is configured (the link can't be built) or when
// the send itself fails; callers gate on canSendAuthEmail() first and surface
// friendly copy.
async function sendLifecycleEmail(
  loginId: number,
  username: string,
  email: string,
  kind: AuthTokenKind
): Promise<void> {
  const raw = createAuthToken(loginId, kind);
  const link = setPasswordLink(getPublicUrl(), raw);
  if (!link) throw new Error("no public URL configured");
  const body =
    kind === "invite"
      ? buildInviteEmail(username, link)
      : buildResetEmail(username, link);
  await sendEmail({ to: email, subject: body.subject, text: body.text });
}

export function sendInviteEmail(
  loginId: number,
  username: string,
  email: string
): Promise<void> {
  return sendLifecycleEmail(loginId, username, email, "invite");
}

export function sendResetEmail(
  loginId: number,
  username: string,
  email: string
): Promise<void> {
  return sendLifecycleEmail(loginId, username, email, "reset");
}
