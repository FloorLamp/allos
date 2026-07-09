// Pure RFC 6238 (TOTP) / RFC 4226 (HOTP) implementation — issue #23. Zero
// external dependencies: the whole thing is base32 + one HMAC-SHA1 from
// node:crypto plus integer math, so it stays unit-testable against the RFC 6238
// Appendix B test vectors (see lib/__tests__/totp.test.ts). This module owns NO
// state — the login_id → secret mapping, the enrolled flag, and the last-used
// step (replay guard) all live in the DB (lib/two-factor.ts). Everything here is
// a pure function of its arguments (the clock is injected as `timeMs`), so there
// is no I/O and no hidden clock read.

import { createHmac, timingSafeEqual } from "node:crypto";

// Standard TOTP parameters (matches Google Authenticator / Authy defaults):
// 30-second step, 6 digits, SHA-1. Kept as named constants so the login verify,
// the enrollment verify, and the otpauth:// URI can't drift on the numbers.
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
// ±1 step (±30s) of clock-skew tolerance on verify — the RFC's recommended
// default. Wider windows trade security for tolerance; 1 is the norm.
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, no padding

// Encode raw bytes to unpadded RFC 4648 base32 (the form authenticator apps and
// the otpauth:// URI expect). Uppercase, no `=` padding.
export function base32Encode(bytes: Buffer | Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

// Decode an RFC 4648 base32 string to bytes. Tolerant of lowercase, spaces, and
// `=` padding (all stripped); returns null for any character outside the
// alphabet so a malformed secret fails verification rather than throwing.
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// HOTP (RFC 4226): the HMAC-SHA1 dynamic-truncation of an 8-byte big-endian
// counter, reduced to `digits` decimal digits and zero-padded.
export function hotp(
  key: Buffer,
  counter: number,
  digits = TOTP_DIGITS
): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = bin % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

// The step counter for a given wall-clock time (ms since epoch).
export function stepForTime(
  timeMs: number,
  stepSeconds = TOTP_STEP_SECONDS
): number {
  return Math.floor(timeMs / 1000 / stepSeconds);
}

export interface TotpOptions {
  timeMs?: number;
  stepSeconds?: number;
  digits?: number;
}

// The TOTP code for a base32 secret at a given time. Returns null for a
// malformed secret.
export function totp(
  secretBase32: string,
  opts: TotpOptions = {}
): string | null {
  const key = base32Decode(secretBase32);
  if (!key) return null;
  const {
    timeMs = Date.now(),
    stepSeconds = TOTP_STEP_SECONDS,
    digits = TOTP_DIGITS,
  } = opts;
  return hotp(key, stepForTime(timeMs, stepSeconds), digits);
}

// Constant-time string compare for equal-length ASCII (the OTP digit strings).
// Differing lengths short-circuit false — the length of a 6-digit code is not a
// secret, so this leaks nothing useful.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface VerifyTotpOptions extends TotpOptions {
  // Clock-skew tolerance in steps (checks current ± window).
  window?: number;
  // The most recently ACCEPTED step for this login, or null if none. Any step at
  // or below this is refused, so a code (or one from an older step within the
  // window) can't be replayed after it has already been used once.
  lastStep?: number | null;
}

export interface VerifyTotpResult {
  ok: boolean;
  // The step the token matched at, so the caller can persist it as the new
  // last-used step (the replay guard). Present only when ok.
  step?: number;
}

// Verify a submitted token against a secret, allowing ±window steps of skew and
// enforcing the monotonic last-step replay guard. Pure: the clock is injected.
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: VerifyTotpOptions = {}
): VerifyTotpResult {
  const normalized = token.replace(/\s/g, "");
  const {
    timeMs = Date.now(),
    stepSeconds = TOTP_STEP_SECONDS,
    digits = TOTP_DIGITS,
    window = TOTP_WINDOW,
    lastStep = null,
  } = opts;
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return { ok: false };
  const key = base32Decode(secretBase32);
  if (!key) return { ok: false };
  const current = stepForTime(timeMs, stepSeconds);
  for (let w = -window; w <= window; w++) {
    const step = current + w;
    if (step < 0) continue;
    if (lastStep != null && step <= lastStep) continue; // replay guard
    if (constantTimeEqual(hotp(key, step, digits), normalized)) {
      return { ok: true, step };
    }
  }
  return { ok: false };
}

// Build the otpauth:// URI an authenticator app imports (via QR or manual key).
// label/issuer are percent-encoded; the secret is passed as-is (already base32).
export function otpauthURL(opts: {
  secret: string;
  account: string;
  issuer: string;
  digits?: number;
  stepSeconds?: number;
}): string {
  const {
    secret,
    account,
    issuer,
    digits = TOTP_DIGITS,
    stepSeconds = TOTP_STEP_SECONDS,
  } = opts;
  // Encode issuer and account separately and join with a LITERAL colon — the
  // otpauth label is `issuer:account` and the colon is a structural separator
  // apps expect unescaped (encodeURIComponent would turn it into %3A).
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
