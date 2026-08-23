// Pure helpers for classifying better-sqlite3 errors, so call sites can react to a
// specific failure (a lost UNIQUE race) without a brittle message-substring match.
// No DB import here — this only inspects an already-thrown error's `.code`, so it's
// unit-testable in the pure tier.
//
// better-sqlite3 surfaces a `SqliteError` whose `.code` is the extended SQLite
// result code, e.g. "SQLITE_CONSTRAINT_UNIQUE" / "SQLITE_CONSTRAINT_PRIMARYKEY" for
// a uniqueness violation. We key on the code prefix rather than the human message.

// The PRIMARY result code, in extended-code form, that means "another connection
// holds a lock this statement needs". SQLite appends a suffix for the specific
// flavour — SQLITE_BUSY_SNAPSHOT (a DEFERRED transaction's read snapshot cannot be
// upgraded to a write, thrown IMMEDIATELY and NOT covered by busy_timeout),
// SQLITE_BUSY_RECOVERY, SQLITE_BUSY_TIMEOUT — so the test is a PREFIX, and a
// flavour SQLite adds later is retried rather than escaping as an unknown code.
const BUSY_CODE_PREFIX = "SQLITE_BUSY";

// The extended-result-code prefixes that mean "a row with this key already exists".
const UNIQUE_VIOLATION_CODES = [
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
] as const;

// The `.code` string off a thrown error, or null when it has none (a non-SqliteError).
export function sqliteErrorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

// True when the error is a UNIQUE / PRIMARY KEY constraint violation — the signal a
// concurrent writer already inserted the row this INSERT was racing for.
export function isUniqueConstraintError(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  return (
    code != null && (UNIQUE_VIOLATION_CODES as readonly string[]).includes(code)
  );
}

// True when the error is a lock contention — the signal that a competing writer holds
// the lock and the operation is worth retrying rather than failing.
//
// KEYED ON `.code`, NOT ON THE MESSAGE, and that is the whole point (#3442).
// better-sqlite3 does not put the code in the human message: a busy error
// stringifies to exactly `SqliteError: database is locked`, with no "SQLITE_BUSY"
// anywhere in it. `runBootTx` guarded its bounded retry on
// `/SQLITE_BUSY/i.test(String(err))` from the day it was written, so the retry had
// NEVER fired — a message-shaped check against a library that does not put the code
// in the message is wrong in the direction that reads as working.
export function isBusyError(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  return code != null && code.startsWith(BUSY_CODE_PREFIX);
}
