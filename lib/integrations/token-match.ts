import crypto from "node:crypto";

// Pure token → profile resolution (no DB/network), so it can be unit-tested.
// Consumed by resolveHealthConnectProfile() in connections.ts, which builds the
// candidate list from the DB (each profile's connection token, plus the
// HEALTH_CONNECT_TOKEN env fallback mapped to profile 1).

export interface TokenCandidate {
  profileId: number;
  token: string;
}

// Constant-time compare of two strings. Length-checked first (unequal lengths
// can't match); timingSafeEqual requires equal-length buffers.
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Return the profile id whose token matches the presented one, or null. Every
// candidate is compared with a constant-time equality so a presented token
// doesn't leak which (if any) profile it's close to via timing. Candidates are
// checked in order; the first match wins.
export function matchTokenToProfile(
  presented: string | null | undefined,
  candidates: TokenCandidate[]
): number | null {
  if (!presented) return null;
  let matched: number | null = null;
  for (const c of candidates) {
    if (!c.token) continue;
    if (tokensEqual(presented, c.token) && matched === null) {
      matched = c.profileId;
    }
  }
  return matched;
}
