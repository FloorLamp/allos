// THE PRACTICE TOKEN FAMILY (issue #2961 step 2) — `pdone:` / `plog:` and the
// right-sizing ride-along `rslower:`, which the reconcile registry declares under the
// same `practice` family. Carved off `callback-data.ts` verbatim; no imports.

// ---- Wellness-practice "Done ✅" logging over Telegram (#1259 phase 2) ----
// A "pdone:<profileId>:<targetId>:<token>" button logs one practice session NOW for the
// target's practice. Like a dose/PRN tap the profile id is a cross-check (the handler
// re-resolves the acting profile from the chat, and logPracticeByTargetId re-verifies the
// target is that profile's practice), and the handler answers from the typed
// PracticeLogOutcome — never unconditionally, because a session log is NOT idempotent
// (multi-session days are supported). `token` is a per-render nonce keeping a redelivered
// callback distinguishable; the button IS consumed on tap (the keyboard is edited away),
// so a stale message can't double-log.
export interface PracticeDoneCallback {
  profileId: number;
  targetId: number;
  token: string;
}

// Encode the "pdone:<profileId>:<targetId>:<token>" button token. The single source of
// truth for the shape (the builder mints it, the parser reads it).
export function practiceDoneCallback(
  profileId: number,
  targetId: number,
  token: string
): string {
  return `pdone:${profileId}:${targetId}:${token}`;
}

// Parse a "pdone:<profileId>:<targetId>:<token>" token. The token is the greedy tail (a
// nonce with no colons). Malformed (wrong prefix, bad ids, missing token) → null.
export function parsePracticeDoneCallback(
  data: unknown
): PracticeDoneCallback | null {
  if (typeof data !== "string" || !data.startsWith("pdone:")) return null;
  const [, profStr, targStr, token] = data.split(":");
  const profileId = Number(profStr);
  const targetId = Number(targStr);
  if (!profileId || !targetId || !token) return null;
  return { profileId, targetId, token };
}

// The SAME button, on the on-demand `/practice` list (#1895) — under its own prefix,
// because the two messages make different claims and the sweep reads the claim off the
// prefix. `pdone` rides a nudge that asserts "this practice is behind", so its buttons
// die the moment that stops being true. A `/practice` button asserts nothing at all: it
// is an additive access affordance, exactly like `prn` on the `/dose` list — logging
// another session is valid whenever, the token carries no date, and it can never become
// a false claim. Declared INERT in ./reconcile-registry for that reason.
//
// Identical field shape, so the tap routes to the same handler and the same write core:
// what differs is what the message SAYS, not what the button does.
export function practiceLogCallback(
  profileId: number,
  targetId: number,
  token: string
): string {
  return `plog:${profileId}:${targetId}:${token}`;
}

export function parsePracticeLogCallback(
  data: unknown
): PracticeDoneCallback | null {
  if (typeof data !== "string" || !data.startsWith("plog:")) return null;
  const [, profStr, targStr, token] = data.split(":");
  const profileId = Number(profStr);
  const targetId = Number(targStr);
  if (!profileId || !targetId || !token) return null;
  return { profileId, targetId, token };
}

// ---- The right-sizing ride-along on the practice nudge (#1670) ----
// The pace nudge already fires for a practice that is behind its weekly floor. When
// that shortfall has been CHRONIC — every one of the last four completed weeks under
// the floor — the same message carries one extra button offering to lower the floor to
// the cadence actually kept. It is a ride-along in the strict sense: no message is ever
// sent because of a right-sizing suggestion, and a target that has stopped generating
// this nudge has no delivery path, which is correct rather than a gap.
//
// The token carries the TARGET id (plus the profile id as a cross-check, resolved
// against the chat like a dose tap) and DELIBERATELY NOT the new floor. The handler
// re-derives the live candidate before writing, exactly as the in-app accept does, so
// a stale button on a recovered practice refuses instead of applying a number nobody
// is suggesting any more.
export interface RightSizeLowerCallback {
  profileId: number;
  targetId: number;
}

// Encode the "rslower:<profileId>:<targetId>" button token (minted by the nudge
// builder, read by the parser below — one source of truth for the shape).
export function rightSizeLowerCallback(
  profileId: number,
  targetId: number
): string {
  return `rslower:${profileId}:${targetId}`;
}

// Parse a "rslower:<profileId>:<targetId>" token. Malformed (wrong prefix, bad ids)
// -> null.
export function parseRightSizeLowerCallback(
  data: unknown
): RightSizeLowerCallback | null {
  if (typeof data !== "string" || !data.startsWith("rslower:")) return null;
  const [, profStr, targStr] = data.split(":");
  const profileId = Number(profStr);
  const targetId = Number(targStr);
  if (!profileId || !targetId) return null;
  return { profileId, targetId };
}

// The toast answer for a practice Done tap is `practiceLogOutcomeText` in lib/practice.ts
// — the SAME sentence the Wellness card's button, the quick-entry overlay row, and the
// command palette's inline quick log say, because they all answer from one write core's
// one typed outcome (#1633). It used to live here, which made the chat surface the
// accidental owner of a domain string three web surfaces also needed.
