import { randomBytes } from "node:crypto";

// The PURE half of API tokens (issue #1734): the capability vocabulary, the wire
// format, and the scope-demand decision. No DB, no network, no request — so the parse
// (the thing an unauthenticated caller controls) and the capability check are
// unit-testable in the pure tier, and lib/api-tokens.ts is left with only the DB work.
//
// ── WIRE FORMAT ───────────────────────────────────────────────────────────────
//
//   Authorization: Bearer <id>.<secret>
//
// The id is the `api_tokens` row id — PUBLIC by design. It is what lets the request
// path do a single indexed lookup and then verify the presented secret against that
// one row's scrypt hash, instead of scanning the table and comparing against every
// stored hash (which would both cost one scrypt per row and leak, through timing, how
// many tokens exist). The secret is base64url, which contains no ".", so the split is
// unambiguous: everything before the FIRST dot is the id, everything after is the
// secret, and an id with any non-digit is rejected outright.
//
// The parse is deliberately TOTAL — every malformed shape returns null rather than
// throwing — so a hostile Authorization header can only ever produce a 401, never a
// 500 and never a stack trace naming this module.

// The capability vocabulary. v1 ships exactly one scope, and it is WRITE-ONLY: a
// leaked upload token can add documents to a profile its login may write, and can read
// nothing back out of the instance. Read scopes are future work and deliberately
// absent — adding one means a rebuild migration to grow the CHECK enum on
// `api_tokens.scope`, which is the intended friction.
export const API_TOKEN_SCOPES = ["upload:documents"] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export function isApiTokenScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

// Human label for a scope, shown in the management UI and in the mint confirmation.
// One place, so the UI and the docs can't describe a capability differently.
export function apiTokenScopeLabel(scope: ApiTokenScope): string {
  switch (scope) {
    case "upload:documents":
      return "Upload documents";
  }
}

export function apiTokenScopeSummary(scope: ApiTokenScope): string {
  switch (scope) {
    case "upload:documents":
      return "Add medical documents to the profiles this login can write to. It cannot read anything back.";
  }
}

// How many random bytes back a token secret. 32 bytes = 256 bits, the same strength as
// a session cookie token, rendered base64url (43 chars, no padding, no ".").
const SECRET_BYTES = 32;

// Mint the secret half of a token. Not a DB call — the caller hashes it, stores the
// hash, and shows the plaintext exactly once.
export function generateApiTokenSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

// Assemble the value the user copies. Kept beside the parser so the two can never
// disagree about the separator.
export function formatApiToken(id: number, secret: string): string {
  return `${id}.${secret}`;
}

export interface ParsedApiToken {
  id: number;
  secret: string;
}

// Pull the raw credential out of an `Authorization` header value. Case-insensitive
// scheme, tolerant of surrounding whitespace, null for anything that isn't a bearer.
export function parseBearerHeader(header: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  const value = match?.[1]?.trim();
  return value ? value : null;
}

// Split `<id>.<secret>` into its halves, or null. Total by construction: an empty
// value, a missing dot, a non-numeric or non-positive id, and an empty secret all
// return null, so the route answers 401 without ever touching the database.
export function parseApiToken(
  raw: string | null | undefined
): ParsedApiToken | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const idPart = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  // Digits only, and no leading-zero/`+1`/`1e3` shapes — Number() would happily
  // accept those and resolve the same row from two different wire values.
  if (!/^[1-9][0-9]*$/.test(idPart)) return null;
  const id = Number(idPart);
  if (!Number.isSafeInteger(id)) return null;
  // The secret must still look like the alphabet we mint, so a value carrying a
  // second dot or a control character is rejected before any lookup.
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  return { id, secret };
}

// Does a token's GRANTED scope satisfy the capability an endpoint DEMANDS? v1 has no
// hierarchy and no wildcards on purpose: capabilities are compared for exact equality,
// so a future broader scope can never silently subsume a narrower one. When scopes
// gain structure, this is the ONE function that learns about it.
export function scopeSatisfies(
  granted: string,
  demanded: ApiTokenScope
): boolean {
  return granted === demanded;
}
