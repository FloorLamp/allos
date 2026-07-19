"use server";

import { headers } from "next/headers";
import { db } from "@/lib/db";
import { findLoginIdByEmail } from "@/lib/auth-tokens";
import {
  canSendAuthEmail,
  isValidEmail,
  normalizeEmail,
  RESET_REQUEST_MESSAGE,
  sendResetEmail,
} from "@/lib/auth-email";
import {
  hitRateLimit,
  pruneRateBuckets,
  RESET_PER_EMAIL_LIMIT,
  RESET_PER_IP_LIMIT,
  RESET_WINDOW_MS,
  type RateBucket,
} from "@/lib/auth-email-ratelimit";
import { createLogger } from "@/lib/log";

const log = createLogger("password-reset");

// In-process, family-scale rate-limit state for the reset REQUEST endpoint
// (issue #985). Module-scoped so the buckets persist across requests; pure
// hit/prune logic lives in lib/auth-email-ratelimit (unit-tested).
const emailBuckets = new Map<string, RateBucket>();
const ipBuckets = new Map<string, RateBucket>();

export interface ResetRequestState {
  message?: string;
}

async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}

// Self-service password-reset REQUEST. ENUMERATION-SAFE: it always returns the same
// generic message (the calendar-feed no-oracle precedent), so a prober can't tell
// whether an address is registered, is throttled, or the instance can't send.
// Rate-limited per-email + per-IP. The token mint + email only happen when the
// address actually resolves to a login and the instance can send.
export async function requestPasswordReset(
  _prev: ResetRequestState,
  formData: FormData
): Promise<ResetRequestState> {
  const generic: ResetRequestState = { message: RESET_REQUEST_MESSAGE };
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!email || !isValidEmail(email)) return generic;
  // Instance can't send (SMTP or public URL unconfigured): answer generically so
  // there's still no oracle. The page hides the form in this case anyway.
  if (!canSendAuthEmail()) return generic;

  const now = Date.now();
  const ip = await clientIp();
  pruneRateBuckets(emailBuckets, now, RESET_WINDOW_MS);
  pruneRateBuckets(ipBuckets, now, RESET_WINDOW_MS);
  const emailOk = hitRateLimit(
    emailBuckets,
    email.toLowerCase(),
    now,
    RESET_PER_EMAIL_LIMIT,
    RESET_WINDOW_MS
  ).allowed;
  const ipOk = hitRateLimit(
    ipBuckets,
    ip,
    now,
    RESET_PER_IP_LIMIT,
    RESET_WINDOW_MS
  ).allowed;
  if (!emailOk || !ipOk) {
    log.warn("password reset request throttled", { ip });
    return generic; // no oracle: throttled looks identical to success
  }

  const loginId = findLoginIdByEmail(email);
  if (loginId != null) {
    const row = db
      .prepare("SELECT username FROM logins WHERE id = ?")
      .get(loginId) as { username: string } | undefined;
    if (row) {
      try {
        await sendResetEmail(loginId, row.username, email);
      } catch (err) {
        // Log server-side; the user still sees the generic message (no oracle, and
        // an SMTP hiccup shouldn't leak).
        log.error("password reset email failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return generic;
}
