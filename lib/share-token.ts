import crypto from "node:crypto";

// SHA-256 of a raw share token, matching lib/auth.ts's session-token pattern: the
// DB stores only this hash, never the raw token, so a DB leak yields no usable
// link. Split out from lib/share-links.ts so that (client-safe) module stays free
// of node:crypto — the share modal imports the field/TTL constants from there and
// must not pull a Node built-in into the browser bundle. Still pure (deterministic,
// no DB/network), so it's unit-tested in lib/__tests__/share-links.test.ts.
export function hashShareToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
