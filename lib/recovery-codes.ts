// One-time TOTP recovery codes — issue #23. A login that enrolls in 2FA is shown
// 8 single-use codes ONCE; if they lose their authenticator, one code stands in
// for a TOTP at the second-factor step. Storage decision (mirrors session /
// share-link tokens, NOT passwords): a recovery code is a HIGH-ENTROPY random
// token (40 bits, drawn from a 32-symbol alphabet), not a human-chosen secret,
// so a fast SHA-256 is the right hash — scrypt's slow brute-force resistance only
// buys anything for LOW-entropy secrets, and hashing here must stay synchronous
// on the login path. The DB stores only the SHA-256, so a DB leak yields no
// usable code. Format/normalize/shape helpers are pure and unit-tested; only
// generation (randomness) and the hash touch node:crypto.

import { createHash, randomInt } from "node:crypto";

export const RECOVERY_CODE_COUNT = 8;

// Unambiguous alphabet: Crockford-style base32 minus the visually confusable
// characters (I, L, O, U removed here relative to RFC 4648) so a hand-typed code
// is hard to mistranscribe. 28 symbols.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_GROUP = 4; // XXXX-XXXX
const CODE_GROUPS = 2;
const CODE_LEN = CODE_GROUP * CODE_GROUPS; // 8 significant chars

// Strip everything but the alphabet's characters and uppercase — so "abcd-efgh",
// "ABCD EFGH", and "abcdefgh" all normalize identically before hashing/compare.
export function normalizeRecoveryCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Group the significant characters as XXXX-XXXX for display.
export function formatRecoveryCode(raw: string): string {
  const norm = normalizeRecoveryCode(raw);
  const groups: string[] = [];
  for (let i = 0; i < norm.length; i += CODE_GROUP) {
    groups.push(norm.slice(i, i + CODE_GROUP));
  }
  return groups.join("-");
}

// Whether a normalized input has the right length AND only alphabet characters —
// a cheap shape check that lets the login step tell "this is a recovery code"
// from "this is a 6-digit TOTP" without a DB hit.
export function isRecoveryCodeShape(raw: string): boolean {
  const norm = normalizeRecoveryCode(raw);
  if (norm.length !== CODE_LEN) return false;
  for (const ch of norm) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

// The stored form: SHA-256 of the NORMALIZED code, so display formatting
// (dashes/spacing/case) never affects the match.
export function hashRecoveryCode(raw: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(raw)).digest("hex");
}

// Generate a fresh set of RECOVERY_CODE_COUNT formatted codes. Uses crypto
// randomInt for uniform, unbiased symbol selection. Returns the DISPLAY form
// (XXXX-XXXX); the caller hashes each with hashRecoveryCode before storing.
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    let raw = "";
    for (let i = 0; i < CODE_LEN; i++) {
      raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    const formatted = formatRecoveryCode(raw);
    // Vanishingly unlikely at 28^8, but dedupe to be safe.
    if (!codes.includes(formatted)) codes.push(formatted);
  }
  return codes;
}
