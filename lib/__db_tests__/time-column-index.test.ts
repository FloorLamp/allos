// DB INTEGRATION TIER — the declared temporal-column index, run against the REAL
// migrated schema (issue #2205 phase 3).
//
// The index in lib/time-columns.ts is only worth having if it cannot drift from the
// database it describes, and #2090 was closed because the prose version did exactly
// that. So this is the scan the issue asks for: a new table with a non-conforming
// temporal column fails CI, and so does a declaration for a column that no longer
// exists.
//
// It opens its own in-memory database and runs every migration through the runner —
// the same thing scripts/schema-dump.ts does — rather than reading the shared test
// singleton, because the claim is about the SCHEMA and nothing about any row.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import {
  NOT_TEMPORAL,
  TEMPORAL_NAME_RE,
  TIME_COLUMNS,
  type TemporalTable,
  type TimeColumn,
} from "@/lib/time-columns";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface SchemaColumn {
  table: string;
  column: string;
  type: string;
  dflt: string | null;
}

function migratedSchema(): SchemaColumn[] {
  const mem = new Database(":memory:");
  try {
    runMigrations(mem);
    const tables = mem
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all() as { name: string }[];
    const out: SchemaColumn[] = [];
    for (const t of tables) {
      const cols = mem.prepare(`PRAGMA table_info(${t.name})`).all() as {
        name: string;
        type: string;
        dflt_value: string | null;
      }[];
      for (const c of cols) {
        out.push({
          table: t.name,
          column: c.name,
          type: c.type,
          dflt: c.dflt_value,
        });
      }
    }
    return out;
  } finally {
    mem.close();
  }
}

// A column the index has to have an opinion about: TEXT (which drops every duration and
// count — `moving_time_sec`, `start_index`) and named like a time.
function isCandidate(c: SchemaColumn): boolean {
  return /^TEXT$/i.test(c.type) && TEMPORAL_NAME_RE.test(c.column);
}

const SCHEMA = migratedSchema();

function declared(table: string, column: string): TimeColumn | undefined {
  const cols = (TIME_COLUMNS as Record<string, readonly TimeColumn[]>)[table];
  return cols?.find((c) => c.column === column);
}

describe("the temporal-column index matches the migrated schema", () => {
  it("finds temporal columns at all", () => {
    // A silently-empty candidate set would make every rule below pass vacuously — the
    // same guard the phase-1 scan puts on its SQL extraction.
    expect(SCHEMA.filter(isCandidate).length).toBeGreaterThan(150);
  });

  it("declares every temporal column in the schema", () => {
    const missing = SCHEMA.filter(isCandidate)
      .filter((c) => !NOT_TEMPORAL[c.column] && !declared(c.table, c.column))
      .map((c) => `${c.table}.${c.column} (${c.type})`);
    expect(
      missing,
      `Undeclared temporal columns. Add each to TIME_COLUMNS in lib/time-columns.ts ` +
        `with its semantic, grain and convention — or, if the name only LOOKS ` +
        `temporal, to NOT_TEMPORAL with the reason. Then run ` +
        `\`npm run gen:time-columns\`.\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("declares nothing the schema does not have", () => {
    const phantom: string[] = [];
    for (const table of Object.keys(TIME_COLUMNS) as TemporalTable[]) {
      for (const col of TIME_COLUMNS[table] as readonly TimeColumn[]) {
        const found = SCHEMA.find(
          (c) => c.table === table && c.column === col.column
        );
        if (!found) phantom.push(`${table}.${col.column}`);
      }
    }
    expect(
      phantom,
      `Declared but absent from the schema — a rename that did not reach the index is ` +
        `exactly what phase 2 must not leave behind:\n${phantom.join("\n")}`
    ).toEqual([]);
  });

  it("exempts nothing that does not exist", () => {
    const stale = Object.keys(NOT_TEMPORAL).filter(
      (name) => !SCHEMA.some((c) => c.column === name)
    );
    expect(stale, stale.join(", ")).toEqual([]);
  });

  // ---- The one claim the schema itself can settle ----------------------------
  //
  // A column DEFAULT is the only part of a serialization the database states out loud,
  // and phase 1's own worked example is a column whose two writers disagreed about it.
  // So wherever a DEFAULT exists it must agree with the declaration.
  const CANONICAL_DEFAULT = /strftime\s*\(\s*'%Y-%m-%dT%H:%M:%SZ'/i;
  const BARE_DEFAULT = /datetime\s*\(\s*'now'\s*\)|CURRENT_TIMESTAMP/i;

  it("agrees with every column DEFAULT the schema states", () => {
    const bad: string[] = [];
    for (const c of SCHEMA.filter(isCandidate)) {
      const d = declared(c.table, c.column);
      if (!d || !c.dflt) continue;
      const canonical = CANONICAL_DEFAULT.test(c.dflt);
      const bare = BARE_DEFAULT.test(c.dflt);
      if (!canonical && !bare) continue; // a literal or an expression this rule has no view on
      if (d.grain !== "instant") {
        bad.push(
          `${c.table}.${c.column} is declared grain ${d.grain} but DEFAULTs to a clock read (${c.dflt}).`
        );
        continue;
      }
      if (canonical && d.convention !== "canonical") {
        bad.push(
          `${c.table}.${c.column} DEFAULTs to the canonical UTC+Z shape but is declared "${d.convention}".`
        );
      }
      if (bare && d.convention !== "bare") {
        bad.push(
          `${c.table}.${c.column} DEFAULTs to SQLite's bare shape but is declared "${d.convention}".`
        );
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("keeps day-grained columns off a clock DEFAULT", () => {
    // A `date` column that defaulted to datetime('now') would be a day attribution
    // silently written as an instant — the collapse #2205 constraint 4 forbids.
    const bad = SCHEMA.filter(isCandidate)
      .filter((c) => {
        const d = declared(c.table, c.column);
        return (
          d?.grain === "day" &&
          !!c.dflt &&
          (CANONICAL_DEFAULT.test(c.dflt) || BARE_DEFAULT.test(c.dflt))
        );
      })
      .map((c) => `${c.table}.${c.column}`);
    expect(bad, bad.join(", ")).toEqual([]);
  });
});

describe("the index agrees with phase 1's canonical registry", () => {
  // lib/__tests__/instant-writer-scan.test.ts holds CANONICAL_INSTANT_COLUMNS — the
  // columns a converting migration has actually moved onto UTC+Z. Two registries that
  // can disagree are worse than one, so this reads that file's declaration as text and
  // requires this index to declare the same columns canonical. (It is a subset, not an
  // equality: a column can already store UTC+Z without a migration having converted it,
  // and phase 1 deliberately only claims what it converted.)
  const SCAN = "lib/__tests__/instant-writer-scan.test.ts";

  function phase1Canonical(): string[] {
    const text = fs.readFileSync(path.join(REPO, SCAN), "utf8");
    const start = text.indexOf("const CANONICAL_INSTANT_COLUMNS");
    expect(
      start,
      `${SCAN} no longer declares CANONICAL_INSTANT_COLUMNS`
    ).toBeGreaterThan(0);
    const body = text.slice(start, text.indexOf("\n};", start));
    const out: string[] = [];
    const tableRe = /(\w+):\s*\{\s*columns:\s*\[([^\]]*)\]/g;
    for (let m = tableRe.exec(body); m; m = tableRe.exec(body)) {
      for (const c of m[2].split(",")) {
        const name = c.trim().replace(/["']/g, "");
        if (name) out.push(`${m[1]}.${name}`);
      }
    }
    return out;
  }

  it("declares every phase-1 canonical column canonical", () => {
    const claimed = phase1Canonical();
    // Self-check: a parse that silently returned nothing would pass this vacuously.
    expect(claimed.length).toBeGreaterThan(2);
    const disagreements = claimed.filter((key) => {
      const [table, column] = key.split(".");
      return declared(table, column)?.convention !== "canonical";
    });
    expect(
      disagreements,
      `These are on the canonical convention per ${SCAN} but not per ` +
        `lib/time-columns.ts:\n${disagreements.join("\n")}`
    ).toEqual([]);
  });
});
