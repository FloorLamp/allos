import { describe, expect, it } from "vitest";
import {
  STATEFUL_WRITE_TABLES,
  isStatefulWriteCore,
  writesGatedTable,
  type StatefulWriteTable,
} from "@/lib/stateful-writes";
import {
  execArgs,
  norm,
  prepareArgs,
  readSource,
  relPath,
  sourceFiles,
} from "./sql-scan";

// GATED-TABLE WRITE SCAN (issue #1893) — the enforcement layer of the stateful-affordance
// pattern. Where a table has a stateful write CORE, no other module may reach past it
// with a raw INSERT/UPDATE/DELETE, so every write passes the core that enforces the gate
// and returns a typed refusal.
//
// It reuses the profile-scoping guard's source scanner verbatim (./sql-scan.ts) — same
// file enumeration, same `.prepare`/`.exec` first-argument extraction, same normalization.
// Two questions, one scanner; a third hand-rolled SQL parser would be this issue's own
// disease, in the test tier.
//
// WHAT THIS DOES NOT GUARANTEE, stated so the guarantee isn't overread:
//   • It is a TEXT scan. A statement whose table name is interpolated (the generic
//     undo-delete/restore machinery builds `DELETE FROM ${root.table}`) is invisible to
//     it, and no allowlist entry pretends otherwise.
//   • It says nothing about whether an AFFORDANCE renders the offer state. That is the
//     audit's job; the registry's `offerState` field names the derivation so review has
//     one place to look. With this scan in place a state-blind button degrades to
//     tap → honest refusal, never corruption.

// Statements that legitimately write a gated table from OUTSIDE its cores, keyed by the
// file they live in (so an unrelated file can't ride the exemption). Matched as a
// normalized-SQL substring. Same SHORT-and-justified discipline as the profile-scoping
// allowlist — an entry here is a reviewed exception, not a way to be done with the guard.
const ALLOW_WRITE: { file: string; includes: string; why: string }[] = [
  {
    file: "app/(app)/encounters/appointment-actions.ts",
    includes: "INSERT INTO appointments",
    why: "createAppointment: the booking form's CREATE names `status` only as the born row's literal initial value ('scheduled') — there is no prior state to transition from, the additive case the audit criterion leaves plain (#2134). Every later flip of the flag goes through the registered core.",
  },
  {
    file: "lib/import-persist.ts",
    includes: "INSERT OR IGNORE INTO appointments",
    why: "the importer's appointment CREATE (#416) names `status` only as the extracted row's initial value — a born row, deduplicated by external_id, not a transition (#2134). The import path's own completion of a matched appointment goes through the registered core's scheduled-only CAS.",
  },
  {
    file: "app/(app)/settings/family/actions.ts",
    includes: "DELETE FROM intake_item_logs WHERE item_id IN",
    why: "deleteProfile's erasure sweep (#2039): removing a whole profile is not a dose TRANSITION — there is no state to refuse into and no supply counter left to keep in lock-step, because the intake_items rows carrying it are erased by the same sweep. Routing it through the per-(dose,date) core would mean walking every log row of every item to delete each one individually. The sweep runs with foreign_keys OFF inside one writeTx and is profile-scoped through the parent item, which is the reason it is written as a set delete in the first place.",
  },
  {
    file: "app/(app)/nutrition/intake-actions.ts",
    includes: "INSERT INTO intake_items",
    why: "createSupplement/createMedication: the item's own CREATE form, where quantity_on_hand is the opt-in initial stock the user typed. There is no prior state to transition from — a born row is the additive case the audit criterion leaves plain — and the refill cores only ever adjust an EXISTING counter relative to its locked read.",
  },
  {
    file: "app/(app)/nutrition/intake-actions.ts",
    includes: "UPDATE intake_items SET name = ?",
    why: "updateIntakeItem: the item EDIT form writes quantity_on_hand as an ABSOLUTE value alongside name/dose/cadence, because the user is stating what is in the bottle. It is not a blind clobber — it goes through the #467 compare-and-set (resolveOnHandWrite over the `quantity_on_hand_loaded` snapshot the form was rendered with), so a dose confirm that landed between page-load and save is preserved exactly as the refill core preserves it. Splitting one form save into two writes would be the second decrement path #1374 removed.",
  },
  {
    file: "lib/import-persist.ts",
    includes: "INSERT INTO intake_items",
    why: "the importer's medication CREATE names `active` only as the born row's literal initial value (1) — there is no prior state to transition from, the additive case the audit criterion leaves plain (#2133). Every later flip of the flag, including the import path's own course-derived re-sync, goes through the registered cores.",
  },
  {
    file: "app/(app)/protocols/actions.ts",
    includes:
      "INSERT INTO protocols (profile_id, name, start_date, end_date, notes, outcome_keys, situation, equipment_id, frequency_target_id, owns_frequency_target, intake_item_id) VALUES (?, ?, ?, ?,",
    why: "createProtocol: the form's CREATE names `end_date` as the born row's initial window bound — usually NULL, and a past-dated backfill when the user is recording a block they already finished. There is no prior state to transition from, the additive case the audit criterion leaves plain (#2135). Every later flip of the flag goes through the registered core.",
  },
  {
    file: "app/(app)/protocols/actions.ts",
    includes:
      "INSERT INTO protocols (profile_id, name, start_date, end_date, notes, outcome_keys, situation, equipment_id, frequency_target_id, owns_frequency_target, intake_item_id) VALUES (?, ?, ?, NULL,",
    why: "runProtocolAgain: a born row again — the literal NULL is the new run's open window, not a transition of the expired run it copies from (that row is left closed on purpose, so its finished comparison window survives). The eligibility question it asks first is the same pure protocolReopenEligibility the core and the Resume control use.",
  },
  {
    file: "app/(app)/protocols/actions.ts",
    includes: "UPDATE protocols SET name = ?",
    why: "updateProtocol: the protocol EDIT form writes the whole record, and `end_date` is one of its FIELDS — the user is stating the window this block ran over, in the same save as its name, notes and outcomes, and a date typed into a dated form is a correction rather than a one-tap transition. It is not a blind write: the save reconciles the situation activation with the new window inside the same writeTx, exactly as the core does. Splitting one form save into two writes would put a second reason to fail inside a form the user is trying to submit.",
  },
  {
    file: "app/(app)/nutrition/intake-actions.ts",
    includes: "UPDATE intake_item_doses SET amount = ?",
    why: "updateIntakeItem's dose EDIT: amount/time/window on a live dose are ordinary last-write-wins form writes; `retired` appears only as the guard PREDICATE (`AND retired = 0`) that keeps a forged/stale id from rewriting a retired dose's row — the column is never SET here (#2131). The retire/un-retire transitions themselves live in the registered dose-lifecycle core.",
  },
];

// MIGRATIONS are allowlisted wholesale (the issue's own carve-out): a numbered migration
// is schema DDL and one-shot data moves by construction, is frozen by the immutable hash
// manifest, and runs before any core exists.
//
// The DB/action TEST TIERS are likewise out of scope. Their `INSERT INTO intake_items`
// fixtures seed a starting world for a test to act on — they are not a runtime write path
// a user's tap can reach, and forcing them through the cores would make a fixture unable
// to set up the very refusal states the cores are tested against. `lib/__tests__/**` is
// already excluded by the shared scanner's file walk.
const OUT_OF_SCOPE = [
  "lib/migrations/",
  "lib/__db_tests__/",
  "lib/__action_tests__/",
];
const isOutOfScope = (rel: string) =>
  OUT_OF_SCOPE.some((p) => rel.startsWith(p));

// THE SCAN, as one function over (path, source) so the real tree and a synthetic fixture
// go through exactly the same decision. A guard proven only on its inner predicate is not
// proven; the fixture case below runs this whole pipeline.
function scanFile(rel: string, src: string): string[] {
  if (isOutOfScope(rel)) return [];
  const violations: string[] = [];
  for (const arg of [...prepareArgs(src), ...execArgs(src)]) {
    if (arg.kind !== "sql") continue; // a computed arg can't be inspected
    const sql = norm(arg.text);
    for (const entry of STATEFUL_WRITE_TABLES) {
      if (!writesGatedTable(sql, entry)) continue;
      if (isStatefulWriteCore(rel, entry)) continue;
      if (
        ALLOW_WRITE.some(
          (a) => rel.endsWith(a.file) && sql.includes(a.includes)
        )
      )
        continue;
      violations.push(
        `${rel}: writes gated table "${entry.table}"${
          entry.columns ? ` (${entry.columns.join("/")})` : ""
        } outside its write core (${entry.cores.join(", ")}) — route the write ` +
          `through the core so it can refuse, or allowlist it with a justification. SQL: ${sql}`
      );
    }
  }
  return violations;
}

const REGISTRY_BY_TABLE = new Map(
  STATEFUL_WRITE_TABLES.map((e) => [e.table, e] as const)
);

describe("gated tables: raw writes only inside the registered write core", () => {
  const files = sourceFiles();

  it("scans a meaningful number of source files", () => {
    // Guards against a broken walk silently passing the whole suite.
    expect(files.length).toBeGreaterThan(30);
  });

  it("has no gated-table write outside its registered core", () => {
    const violations = files.flatMap((f) =>
      scanFile(relPath(f), readSource(f))
    );
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });

  // THE FIXTURE THAT PROVES THE GUARD CAN FAIL. A guard that cannot fail is not a guard,
  // and this one passes today precisely because the tree is clean — indistinguishable
  // from a scan whose regex never matches anything.
  it("FLAGS a raw gated-table write planted in a non-core module", () => {
    const planted = `
      import { db } from "./db";
      export function closePeriod(profileId: number, id: number, end: string) {
        db.prepare(
          \`UPDATE cycles SET period_end = ? WHERE id = ? AND profile_id = ?\`
        ).run(end, id, profileId);
      }
    `;
    const violations = scanFile("lib/queries/rogue-cycle-writer.ts", planted);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('writes gated table "cycles"');
    expect(violations[0]).toContain("lib/cycle-store.ts");
    // The identical statement inside the registered core is clean.
    expect(scanFile("lib/cycle-store.ts", planted)).toEqual([]);
  });

  it("FLAGS a raw supply-counter write, and ignores an ordinary field edit", () => {
    const counter = `
      db.prepare("UPDATE intake_items SET quantity_on_hand = ? WHERE id = ? AND profile_id = ?").run(n, id, p);
    `;
    expect(scanFile("app/(app)/records/actions.ts", counter)).toHaveLength(1);
    const label = `
      db.prepare("UPDATE intake_items SET notes = ? WHERE id = ? AND profile_id = ?").run(n, id, p);
    `;
    // The column narrowing is what keeps the gate from swallowing the whole medication
    // record: name/dose/cadence edits are ordinary last-write-wins form writes.
    expect(scanFile("app/(app)/records/actions.ts", label)).toEqual([]);
  });

  it("does not flag a migration, or a READ of a gated table", () => {
    const write = `db.exec("DELETE FROM cycles WHERE profile_id = 1");`;
    expect(scanFile("lib/migrations/versions/999-example.ts", write)).toEqual(
      []
    );
    expect(scanFile("lib/queries/anything.ts", write)).toHaveLength(1);
    const read = `db.prepare("SELECT id FROM cycles WHERE profile_id = ?").all(p);`;
    expect(scanFile("lib/queries/anything.ts", read)).toEqual([]);
  });
});

describe("stateful-write registry (#1893)", () => {
  it("names a real, unique table per entry with at least one core and a justification", () => {
    expect(STATEFUL_WRITE_TABLES.length).toBeGreaterThan(0);
    // `intake_items` and `shared_supplies` are two DIFFERENT tables carrying the same
    // counter, so uniqueness is per table, not per column set.
    expect(REGISTRY_BY_TABLE.size).toBe(STATEFUL_WRITE_TABLES.length);
    for (const e of STATEFUL_WRITE_TABLES) {
      expect(e.table).toMatch(/^[a-z_]+$/);
      expect(e.cores.length).toBeGreaterThan(0);
      expect(e.why.length).toBeGreaterThan(40);
    }
  });

  it("every registered core and gate module is a scanned source file", () => {
    const scanned = sourceFiles().map(relPath);
    for (const e of STATEFUL_WRITE_TABLES) {
      for (const core of e.cores) {
        expect(
          scanned.some((f) => f.endsWith(core)),
          `${e.table}: core ${core} is not a scanned source file`
        ).toBe(true);
      }
      if (e.gate) {
        expect(
          scanned.some((f) => f.endsWith(e.gate!)),
          `${e.table}: gate ${e.gate} is not a scanned source file`
        ).toBe(true);
      }
    }
  });

  it("each registered core actually writes the table it is registered for", () => {
    // A core that no longer holds the DML is a STALE entry: the gate would keep passing
    // while the real write moved somewhere unregistered — the guard's quietest failure.
    const files = sourceFiles();
    for (const e of STATEFUL_WRITE_TABLES) {
      const writers = new Set<string>();
      for (const file of files) {
        const src = readSource(file);
        for (const arg of [...prepareArgs(src), ...execArgs(src)]) {
          if (arg.kind !== "sql") continue;
          if (writesGatedTable(norm(arg.text), e)) writers.add(relPath(file));
        }
      }
      for (const core of e.cores) {
        expect(
          [...writers].some((f) => f.endsWith(core)),
          `${e.table}: registered core ${core} contains no write to it — stale entry?`
        ).toBe(true);
      }
    }
    // Re-reads and re-parses every source file once per registered table. That
    // fits the default 5s budget on Linux CI but not on a Windows filesystem,
    // where the per-file read overhead is enough to overrun it.
  }, 30_000);

  it("the gate module holds no DML of its own — it reaches the table through the store", () => {
    // lib/cycle-write.ts is the guard layer: it owns the typed refusals and calls the
    // store. If DML appeared there it would be a core, not a gate, and the registry
    // would be describing a shape the code no longer has.
    for (const e of STATEFUL_WRITE_TABLES) {
      if (!e.gate) continue;
      const file = sourceFiles().find((f) => relPath(f).endsWith(e.gate!))!;
      const src = readSource(file);
      for (const arg of [...prepareArgs(src), ...execArgs(src)]) {
        if (arg.kind !== "sql") continue;
        expect(
          writesGatedTable(norm(arg.text), e),
          `${e.gate}: holds DML for ${e.table}; register it as a core instead`
        ).toBe(false);
      }
    }
  });
});

// UNIT cases for the pure detector, pinned on inline SQL so the rule is proven
// independently of the live tree.
describe("writesGatedTable (#1893)", () => {
  const cycles = REGISTRY_BY_TABLE.get("cycles")!;
  const items = REGISTRY_BY_TABLE.get("intake_items")!;

  it("matches every DML verb against the literal table name", () => {
    for (const sql of [
      "INSERT INTO cycles (profile_id, period_start) VALUES (?, ?)",
      "INSERT OR REPLACE INTO cycles (profile_id) VALUES (?)",
      "UPDATE cycles SET period_end = ? WHERE id = ?",
      "UPDATE OR IGNORE cycles SET flow = ? WHERE id = ?",
      "DELETE FROM cycles WHERE id = ? AND profile_id = ?",
    ]) {
      expect(writesGatedTable(sql, cycles), sql).toBe(true);
    }
  });

  it("does not match a read, another table, or a name that merely contains it", () => {
    expect(writesGatedTable("SELECT * FROM cycles WHERE id = ?", cycles)).toBe(
      false
    );
    expect(
      writesGatedTable("UPDATE cycle_symptoms SET x = ? WHERE id = ?", cycles)
    ).toBe(false);
    expect(
      writesGatedTable("UPDATE symptom_logs SET x = ? WHERE id = ?", cycles)
    ).toBe(false);
  });

  it("column narrowing gates the counter, not the record", () => {
    expect(
      writesGatedTable(
        "UPDATE intake_items SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?",
        items
      )
    ).toBe(true);
    expect(
      writesGatedTable("UPDATE intake_items SET name = ? WHERE id = ?", items)
    ).toBe(false);
    expect(
      writesGatedTable("DELETE FROM intake_items WHERE id = ?", items)
    ).toBe(false);
  });

  it("isStatefulWriteCore suffix-matches a registered module", () => {
    expect(isStatefulWriteCore("lib/cycle-store.ts", cycles)).toBe(true);
    expect(isStatefulWriteCore("lib/cycle-write.ts", cycles)).toBe(false);
    // Suffix match, like the profile-scoping allowlist — a same-named neighbour is not
    // the core.
    expect(isStatefulWriteCore("lib/cycle-store-extra.ts", cycles)).toBe(false);
  });
});

// Type-level pin: the registry's shape is what review reads, so keep it named.
const _shape: StatefulWriteTable = STATEFUL_WRITE_TABLES[0];
void _shape;
