// Shared lifecycle logic for the two long-lived, token-authed surfaces (issue
// #24): the calendar `.ics` subscribe token (per-profile, in profile_settings)
// and the Health Connect ingest token (per-profile, in the connection config).
// Both are minted once and can otherwise live forever, so this module centralises
// the pure decisions around them — optional expiry, last-used throttling, and the
// "consider rotating" nudge — so the two call sites (lib/settings, lib/integrations
// /connections) and the two setup UIs can't drift, and the rules are unit-tested
// without a DB. Nothing here touches the DB or reads the clock implicitly: `nowMs`
// is always injected so the behaviour is deterministic in tests.

// The optional expiry a user can pick when minting/rotating a token. "never"
// (default) preserves the historical behaviour — the token never expires.
export type TokenExpiryChoice = "never" | "90d" | "1y";

// Offered in the UI in this order (safest-default first).
export const TOKEN_EXPIRY_CHOICES: readonly TokenExpiryChoice[] = [
  "never",
  "90d",
  "1y",
] as const;

// Mirrors the session sliding-refresh throttle in lib/auth (a 1-hour WHERE guard):
// a calendar client polls the feed as often as every ~30s, so writing last_used on
// every request would be pure churn. We persist at most once an hour instead.
export const TOKEN_LAST_USED_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

// A token older than ~1 year earns a gentle inline "consider rotating" nudge.
export const TOKEN_ROTATION_NUDGE_MS = 365 * 24 * 60 * 60 * 1000; // ~1 year

const DAY_MS = 24 * 60 * 60 * 1000;

export function isValidExpiryChoice(v: unknown): v is TokenExpiryChoice {
  return v === "never" || v === "90d" || v === "1y";
}

// Normalise a stored timestamp to epoch ms, or null when absent/unparseable.
// Accepts both an ISO 8601 string (what this module's writers store) and the
// SQLite `datetime('now')` form ("YYYY-MM-DD HH:MM:SS", UTC) that other callers
// may persist, so a value from either convention compares correctly.
export function parseTokenTimestamp(
  value: string | null | undefined
): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// The absolute expiry instant (ISO 8601) for a mint choice, or null for "never".
export function expiresAtFromChoice(
  choice: TokenExpiryChoice,
  nowMs: number
): string | null {
  if (choice === "never") return null;
  const days = choice === "90d" ? 90 : 365;
  return new Date(nowMs + days * DAY_MS).toISOString();
}

// A token is expired only when it HAS an expiry and that instant is at/before now.
// A null/absent expiry ("never") is never expired — preserving default behaviour.
export function isTokenExpired(
  expiresAt: string | null | undefined,
  nowMs: number
): boolean {
  const ms = parseTokenTimestamp(expiresAt);
  return ms !== null && ms <= nowMs;
}

// Whether to persist a fresh last-used timestamp on this successful auth: only when
// none is stored or the stored one is older than the throttle window. Mirrors the
// session-touch WHERE clause so a busy token isn't written on every request.
export function shouldRecordUse(
  lastUsedAt: string | null | undefined,
  nowMs: number
): boolean {
  const ms = parseTokenTimestamp(lastUsedAt);
  return ms === null || nowMs - ms >= TOKEN_LAST_USED_THROTTLE_MS;
}

// Whether to show the gentle "consider rotating" nudge: the token was minted more
// than ~1 year ago. (An expired token gets the stronger "Expired" cue instead —
// see tokenLifecycleStatus.)
export function isRotationDue(
  createdAt: string | null | undefined,
  nowMs: number
): boolean {
  const ms = parseTokenTimestamp(createdAt);
  return ms !== null && nowMs - ms >= TOKEN_ROTATION_NUDGE_MS;
}

// A single UI-facing status for a token surface, so both setup pages render the
// same badge/nudge decisions.
export type TokenLifecycleStatus = "none" | "active" | "rotate" | "expired";

export function tokenLifecycleStatus(
  info: {
    hasToken: boolean;
    createdAt?: string | null;
    expiresAt?: string | null;
  },
  nowMs: number
): TokenLifecycleStatus {
  if (!info.hasToken) return "none";
  if (isTokenExpired(info.expiresAt, nowMs)) return "expired";
  if (isRotationDue(info.createdAt, nowMs)) return "rotate";
  return "active";
}
