// CAUGHT ERROR IN, HOUSE COPY OUT (#3198).
//
// The failed ride-detail backfill rendered
// `UNIQUE constraint failed: activity_segment_efforts.profile_id, …` — a SQLite
// internal — verbatim on a settings page, and sat there for a week. #2820 built the
// right chokepoint for that column and solved the other axis at it:
// `backfillErrorMessage` redacts secrets and caps length, then persists the raw
// redacted `err.message`. Redaction protects tokens; it does nothing for a reader.
// AGENTS.md is the standard being missed — "Health is complex, this app shouldn't
// be."
//
// Unlike authored jargon (#3071's list), this text cannot be fixed by rewriting: it
// is minted at runtime by code that never considered a reader. So it is TRANSLATED
// at the boundary instead. The classifier never returns raw text, which is what
// makes the guarantee structural — a surface cannot leak what it never receives.
// The raw detail's home is the admin error log, which already redacts
// (lib/error-log-format.ts).
//
// The in-repo precedent is `app/(app)/settings/family/actions.ts`, which
// pattern-matches `UNIQUE constraint failed: logins.username` and answers "that
// username is taken". This is the general form of that move; the specialized one
// stays where it is, because a specific answer beats a shaped one every time.
//
// PURE (no db, no fs, no clock).

import { redactSecrets } from "@/lib/error-log-format";

// An error whose message is ALREADY HOUSE COPY, written for a person by someone who
// meant it to be read. `updateProviderIdentity`'s "Another provider already matches
// this identity — merge the duplicates instead." is the shape: a domain answer the
// admin needs, thrown from a data-layer function so its two call paths cannot drift.
//
// Without this marker a boundary has to choose between surfacing EVERY caught
// message (the defect) and surfacing none (which silently downgrades the authored
// ones to a generic sentence, and nobody notices because both look fine). The
// marker is what lets a boundary do the right thing for both.
//
// `lib/zip-index.ts`'s ZipIndexError is the same idea, arrived at independently and
// already documented as such at its one call site.
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

// `authored` — the thrower wrote this sentence for a reader.
// `upstream`  — a network or third-party failure; asking again may well work.
// `busy`      — the database was locked; asking again may well work.
// `write`     — the write itself was refused (a constraint, a schema mismatch).
//               Our bug, and retrying changes nothing.
// `unknown`   — anything else.
export type UserErrorFamily =
  "authored" | "upstream" | "busy" | "write" | "unknown";

// The SPELLINGS this repo actually meets, not the ones an issue describes.
// better-sqlite3 hangs a `code` off the error (`SQLITE_CONSTRAINT_UNIQUE`,
// `SQLITE_BUSY`) and puts the same vocabulary in the message; Node's fetch and
// socket layer use errno strings and `AbortError` / `TimeoutError` names. Both
// halves are matched, because the repo already reaches for both:
// `lib/providers-db.ts` tests `err.code`, `lib/migrations/schema-utils.ts` tests
// `/SQLITE_BUSY/i.test(String(err))`.
const BUSY_RE = /\bSQLITE_BUSY\b|database is locked|database table is locked/i;
const WRITE_RE =
  /\bSQLITE_(?:CONSTRAINT|MISMATCH|READONLY|CORRUPT|FULL|IOERR|SCHEMA|RANGE|TOOBIG|PERM|NOTADB|CANTOPEN|ERROR)|constraint failed|no such (?:table|column)|datatype mismatch/i;
const UPSTREAM_RE =
  /\bfetch failed\b|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bENOTFOUND\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|socket hang up|\bUND_ERR_|\bTimeoutError\b|\bAbortError\b|The operation was aborted|connection (?:reset|refused|closed|error|timed out|dropped)|\bnetwork error\b/i;

function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  return `${name} ${code} ${message}`;
}

export function classifyUserError(err: unknown): UserErrorFamily {
  if (err instanceof UserFacingError) return "authored";
  const detail = detailOf(err);
  if (BUSY_RE.test(detail)) return "busy";
  if (WRITE_RE.test(detail)) return "write";
  if (UPSTREAM_RE.test(detail)) return "upstream";
  return "unknown";
}

export interface UserErrorContext {
  // A verb phrase completing "Couldn't ___" — lower case, no terminal period, and
  // NAMING THE OBJECT where the object is knowable (copy.md rule 1):
  // "save this provider", not "save".
  doing: string;
  // The third party this call reached for, when there is one. Used only by the
  // upstream family, where naming it is the whole of what a reader can act on.
  service?: string;
}

// The house sentence for a caught error. Never raw text, in any branch.
//
// "Try again." appears only where retrying can plausibly succeed (copy.md rule 1):
// a busy database and a network hiccup, never a refused write. That distinction is
// the ONLY thing separating the write family's sentence from a transient one, and
// it is the thing a reader actually needs.
export function userErrorCopy(err: unknown, ctx: UserErrorContext): string {
  const family = classifyUserError(err);
  if (family === "authored") {
    // Authored copy is still redacted: a house sentence may legitimately quote the
    // failing address or account back to the reader, and redactSecrets removes only
    // credentials (#2938's recorded decision — one rule for both readers).
    const authored = redactSecrets((err as Error).message).trim();
    if (authored) return authored;
  }
  return houseErrorSentence(family === "authored" ? "unknown" : family, ctx);
}

// THE SENTENCE BANK, split out of userErrorCopy (#3618) so the STATUS-keyed sibling
// — lib/integrations/sync-failure-copy.ts — spends these same sentences instead of a
// second set that drifts. A thrown ECONNRESET reaching Oura and a 503 answered by
// Oura are one thing to a reader, and the two paths that produce them are in
// different modules; sharing the bank is what stops them reading as two things.
//
// `authored` is deliberately not a member: that family's text comes from the
// thrower, not from here.
export function houseErrorSentence(
  family: Exclude<UserErrorFamily, "authored">,
  ctx: UserErrorContext
): string {
  switch (family) {
    case "upstream":
      return ctx.service
        ? `Couldn't reach ${ctx.service}. Try again.`
        : `Couldn't ${ctx.doing}. Try again.`;
    case "busy":
      return `Couldn't ${ctx.doing}. Try again.`;
    case "write":
      // No retry advice, deliberately: the write was refused and will be refused
      // again. Saying whose fault it is saves a person from hunting for what they
      // did wrong.
      return `Couldn't ${ctx.doing}. It's a bug on our side.`;
    default:
      return `Couldn't ${ctx.doing}.`;
  }
}
