// Pure helpers for classifying better-sqlite3 errors, so call sites can react to a
// specific failure (a lost UNIQUE race) without a brittle message-substring match.
// No DB import here — this only inspects an already-thrown error's `.code`, so it's
// unit-testable in the pure tier.
//
// better-sqlite3 surfaces a `SqliteError` whose `.code` is the extended SQLite
// result code, e.g. "SQLITE_CONSTRAINT_UNIQUE" / "SQLITE_CONSTRAINT_PRIMARYKEY" for
// a uniqueness violation. We key on the code prefix rather than the human message.

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
