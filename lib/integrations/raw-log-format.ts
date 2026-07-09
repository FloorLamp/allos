// PURE helpers for the integration raw-payload store (lib/integrations/raw-log.ts).
// Kept free of node:fs so they stay in the pure unit tier (lib/__tests__): the
// fs-bound reader/writer lives in raw-log.ts and calls into these. This mirrors
// the pure sync-log.ts vs. impure connections.ts split already in this directory.

// Max bytes we persist for a single raw payload. A rolling-48h Health Connect
// batch or a page of Strava activities is small; 512KB is generous headroom while
// bounding a pathological payload — larger ones are truncated with a marker.
export const MAX_PAYLOAD_BYTES = 512 * 1024;

// Newest-N raw payload files kept per (profile, provider); older ones are unlinked
// so the store never grows unbounded.
export const KEEP_PER_PROVIDER = 50;

// Validate that a stored ref is a bare, safe filename: [A-Za-z0-9._-] only (no
// path separators, no NUL), non-empty and bounded, and not the `.`/`..` directory
// entries. Because `/` and `\` are outside the allowed set, the only traversal a
// ref could express is a literal `.`/`..`, both rejected — so a valid ref can
// never escape the profile's payload directory.
export function isSafeRawRef(ref: string): boolean {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= 128 &&
    ref !== "." &&
    ref !== ".." &&
    /^[\w.-]+$/.test(ref)
  );
}

// Truncate a payload to at most `maxBytes` UTF-8 bytes, appending a marker noting
// how many bytes were dropped. Returns the string unchanged when already within
// the cap. Slicing may split a multibyte char at the boundary — acceptable for a
// best-effort debug artifact. Pure.
export function capPayload(s: string, maxBytes = MAX_PAYLOAD_BYTES): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  const kept = buf.subarray(0, maxBytes).toString("utf8");
  return `${kept}\n… (truncated ${buf.length - maxBytes} bytes)`;
}
