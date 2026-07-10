// Pure decision + shaping logic for the "medical passport" share links.
// No DB, no network, no Node built-ins — this module is imported by the
// client share modal (for the field/TTL constants), so it must stay
// browser-safe. Everything here is testable in isolation
// (lib/__tests__/share-links.test.ts). The DB read/write helpers live in
// lib/share-links-db.ts; token hashing in lib/share-token.ts; raw-token minting
// in the action layer.

// The field allow-list: which sections of the passport a share link may expose.
// The creator picks a subset at creation; the public render shows ONLY the
// in-scope sections (so a link can share e.g. blood type + medications without
// the full biomarker history). Keys are stored verbatim in the `fields` column.
export const SHARE_FIELDS = [
  { key: "identity", label: "Age & sex" },
  { key: "blood_type", label: "Blood type" },
  { key: "allergies", label: "Allergies" },
  { key: "conditions", label: "Conditions / problems" },
  // Family history is genetically-sensitive THIRD-PARTY PHI (relatives' diagnoses /
  // onset ages / deceased status), distinct from the subject's OWN problem list — so
  // it gets its OWN share field rather than riding under `conditions`. Existing links
  // (no `family_history` in their stored `fields`) therefore never expose it.
  { key: "family_history", label: "Family history" },
  { key: "body", label: "Body metrics (height, weight, BMI)" },
  { key: "vitals", label: "Vitals & biomarkers" },
  { key: "medications", label: "Medications" },
  { key: "supplements", label: "Supplements" },
  { key: "immunizations", label: "Immunizations" },
  { key: "history", label: "Recent medical history" },
] as const;

export type ShareField = (typeof SHARE_FIELDS)[number]["key"];

const VALID_FIELDS: ReadonlySet<string> = new Set(
  SHARE_FIELDS.map((f) => f.key)
);

export function isShareField(v: unknown): v is ShareField {
  return typeof v === "string" && VALID_FIELDS.has(v);
}

// Coerce an arbitrary submitted selection to a clean, de-duplicated list of known
// field keys, preserving the canonical SHARE_FIELDS order (so the stored + shown
// ordering is stable regardless of submission order). Unknown keys are dropped.
export function normalizeShareFields(input: readonly unknown[]): ShareField[] {
  const chosen = new Set(input.filter(isShareField));
  return SHARE_FIELDS.map((f) => f.key).filter((k) => chosen.has(k));
}

// Serialize a validated field set for the `fields` column (a JSON array).
export function serializeShareFields(fields: readonly ShareField[]): string {
  return JSON.stringify(normalizeShareFields(fields));
}

// Parse the stored `fields` column back to a validated field list. Tolerates a
// malformed/legacy value (returns [] rather than throwing) so a corrupt row can
// never crash the public render — it just shares nothing.
export function parseShareFields(
  stored: string | null | undefined
): ShareField[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? normalizeShareFields(parsed) : [];
  } catch {
    return [];
  }
}

// Whether a given passport section is within a link's shared scope. The pure gate
// the public render uses to decide which sections to render at all.
export function isFieldInScope(
  fields: readonly ShareField[],
  field: ShareField
): boolean {
  return fields.includes(field);
}

export type ShareLinkStatus = "valid" | "revoked" | "expired";

// The minimal validity-relevant fields of a share-link row.
export interface ShareLinkValidity {
  expires_at: string; // ISO 8601 UTC
  revoked_at: string | null; // ISO 8601 UTC, or null
}

// Resolve a link's status at `now`. Revocation wins over expiry (an explicitly
// killed link reads as revoked even after it would also have expired). A row with
// an unparseable expiry is treated as expired — never valid — so a corrupt
// timestamp fails closed.
export function shareLinkStatus(
  link: ShareLinkValidity,
  now: Date
): ShareLinkStatus {
  if (link.revoked_at != null) return "revoked";
  const expiresMs = Date.parse(link.expires_at);
  if (!Number.isFinite(expiresMs)) return "expired";
  return expiresMs > now.getTime() ? "valid" : "expired";
}

export function isShareLinkValid(link: ShareLinkValidity, now: Date): boolean {
  return shareLinkStatus(link, now) === "valid";
}

// The TTL options offered at creation (label + milliseconds). Kept short by
// design — a passport link is meant for an appointment or an emergency, not a
// permanent public URL.
export const SHARE_TTL_OPTIONS = [
  { key: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { key: "1d", label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type ShareTtlKey = (typeof SHARE_TTL_OPTIONS)[number]["key"];

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Resolve a TTL key to its duration in ms, defaulting to 7 days for an unknown
// key (fails safe to a short lifetime rather than a long one).
export function ttlMsForKey(key: string | null | undefined): number {
  return SHARE_TTL_OPTIONS.find((o) => o.key === key)?.ms ?? DEFAULT_TTL_MS;
}

// The ISO 8601 UTC expiry for a link created `now` with the given TTL key.
export function expiresAtFor(
  key: string | null | undefined,
  now: Date
): string {
  return new Date(now.getTime() + ttlMsForKey(key)).toISOString();
}
