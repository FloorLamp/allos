import { describe, expect, it } from "vitest";
import {
  norm,
  prepareArgs,
  readSource,
  relPath,
  sourceFiles,
} from "./sql-scan";

// Issue #2059 — the ONE statement that mutates a ledger row by its raw id must name the
// profile itself.
//
// The two dated-observation ledgers this covers, `food_log_events` and
// `intake_item_logs`, are written from token/callback paths where the row id arrives
// from OUTSIDE (a Telegram button, a form field). Both are reached the same way in
// practice: a profile-scoped SELECT resolves the row, and then a second statement
// mutates it by primary key. That second statement is the one this guard is about.
//
// profile-scoping.test.ts cannot ask this. `food_log_events` is directly owned and is
// already covered there for MENTIONING profile_id anywhere in the statement, while
// `intake_item_logs` is a CHILD table and therefore outside that scan by design — its
// writes are documented as relying on "a prior profile-scoped ownership check". That
// assumption is exactly what #2059 found had quietly stopped being true for the #2020
// time-correction write: the burst ids came from a scoped read, but the UPDATE that
// moved `recorded_at` trusted them, so a later refactor of the burst query — or a new call
// site handing in an id from somewhere else — would have turned a defence-in-depth gap
// into a cross-profile write with nothing failing.
//
// So the rule is narrow and mechanical: a statement whose WHERE begins at a bare
// `id = ?` on one of these tables must also carry `profile_id`, whether directly (the
// owned table) or through a subquery/EXISTS on the parent (the child table). Statements
// keyed on something else (`dose_id = ? AND date = ?`) are not row-by-id writes and are
// not the shape this is about. Reads are irrelevant — a leaked SELECT is a different
// bug with a different guard.
const LEDGERS = ["food_log_events", "intake_item_logs"] as const;

const ROW_WRITE = new RegExp(
  `^(?:UPDATE|DELETE FROM)\\s+(?:${LEDGERS.join("|")})\\b`,
  "i"
);

// The WHERE that names a single row by primary key, with or without a table alias.
const BY_BARE_ID = /\bWHERE\s+(?:[a-z_]+\.)?id\s*=\s*\?/i;

describe("#2059 — a ledger row mutated by id names the profile in the same statement", () => {
  it("finds the row-by-id writes it is meant to be guarding", () => {
    // A canary: if the extraction or the table names ever drift, the scan below would
    // silently pass over an empty set and prove nothing.
    expect(rowByIdWrites().length).toBeGreaterThanOrEqual(4);
  });

  it("has none that mutate by id without a profile scope", () => {
    const unscoped = rowByIdWrites()
      .filter(({ sql }) => !/profile_id/i.test(sql))
      .map(({ file, sql }) => `${file}: ${sql}`);
    expect(unscoped).toEqual([]);
  });
});

function rowByIdWrites(): { file: string; sql: string }[] {
  const out: { file: string; sql: string }[] = [];
  for (const file of sourceFiles()) {
    for (const arg of prepareArgs(readSource(file))) {
      if (arg.kind !== "sql") continue;
      const sql = norm(arg.text);
      if (!ROW_WRITE.test(sql) || !BY_BARE_ID.test(sql)) continue;
      out.push({ file: relPath(file), sql });
    }
  }
  return out;
}
