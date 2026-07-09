// Pure password-strength gate — issue #23. No external dependency (no zxcvbn):
// a small, offline, deterministic rule set that a self-hosted instance can run
// with zero egress. Unit-tested in lib/__tests__/password-strength.test.ts.
//
// The bar is deliberately modest but meaningfully better than the old 8-char
// length-only check: a real minimum length, at least two character classes (so
// "aaaaaaaaaa" / "1234567890" are rejected), and a ban on passwords that contain
// (or are contained by) the username. It is NOT a substitute for a password
// manager, but it stops the weakest reused/trivial passwords.

// Raised from the historical 8 (issue #23). Applied everywhere a password is
// set: admin create/reset (family actions) and self-service change (settings).
export const MIN_PASSWORD_LENGTH = 10;

// A hard upper bound so a hostile client can't submit a multi-megabyte password
// and make scrypt chew CPU. Well above any real passphrase.
export const MAX_PASSWORD_LENGTH = 200;

export type StrengthResult = { ok: true } | { ok: false; error: string };

// Count how many distinct character classes appear (lower, upper, digit, other).
function characterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  return classes;
}

// Validate a candidate password. `username` (optional) is used only for the
// "must not contain your username" rule; a short username (< 3 chars) is ignored
// for that rule so a 2-char name can't ban half the alphabet. Returns the FIRST
// failing rule so the UI shows one actionable message at a time.
export function checkPasswordStrength(
  password: string,
  opts: { username?: string } = {}
): StrengthResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  if (characterClasses(password) < 2) {
    return {
      ok: false,
      error:
        "Use a mix of at least two of: lowercase, uppercase, numbers, symbols.",
    };
  }
  const username = opts.username?.trim().toLowerCase();
  if (username && username.length >= 3) {
    const pw = password.toLowerCase();
    if (pw.includes(username) || username.includes(pw)) {
      return { ok: false, error: "Password must not contain your username." };
    }
  }
  return { ok: true };
}
