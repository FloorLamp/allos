import { describe, expect, it } from "vitest";
import {
  DYNAMIC_TABLE_RENAMES,
  createdTables,
  finalTableName,
  finalTablesDeclaring,
  migrationFileNames,
  migrationSources,
  tableRenames,
  tablesRetired,
} from "./migration-schema-scan";

// The shared migration-corpus reader (#2995), pinned on SYNTHETIC source so its rules are
// proven independently of the live tree — the same discipline the profile-scoping
// scanner's #1208 unit block uses. The two consumers (profile-scoping, provider-merge)
// each assert their own derived set against the real corpus; what is proven here is the
// name LIFECYCLE those derivations rest on: renames resolve first, retirement is what is
// left, and every surviving declaration is reported under its final name.

describe("migration corpus reader: name lifecycle", () => {
  it("reads a CREATE body past nested parens", () => {
    const [t] = createdTables(
      `CREATE TABLE t (
         id INTEGER PRIMARY KEY,
         kind TEXT NOT NULL CHECK (kind IN ('a','b')),
         at TEXT NOT NULL DEFAULT (datetime('now')),
         profile_id INTEGER NOT NULL
       );`
    );
    expect(t.name).toBe("t");
    expect(t.body).toContain("profile_id");
  });

  it("a rebuild's DROP + RENAME TO retires nothing", () => {
    const src = `
      CREATE TABLE goals__new (id INTEGER, profile_id INTEGER);
      DROP TABLE goals;
      ALTER TABLE goals__new RENAME TO goals;`;
    const renames = tableRenames(src);
    expect(renames.get("goals__new")).toBe("goals");
    expect([...tablesRetired(src, renames)]).toEqual([]);
    expect([...finalTablesDeclaring(src, () => true)]).toEqual(["goals"]);
  });

  it("a DROP with no way back IS a retirement", () => {
    const src = `
      CREATE TABLE starred_biomarkers (id INTEGER, profile_id INTEGER);
      DROP TABLE starred_biomarkers;`;
    const renames = tableRenames(src);
    expect([...tablesRetired(src, renames)]).toEqual(["starred_biomarkers"]);
    expect([...finalTablesDeclaring(src, () => true)]).toEqual([]);
  });

  it("a rename resolves BEFORE retirement, so a renamed-away table is not retired", () => {
    // The ordering the whole module exists for. `old_log` is dropped and never comes
    // back under its own name; only the DECLARED rename says its rows live on as
    // `new_totals`. Retire first and `new_totals`'s own declaration is thrown away with
    // it — the guard reporting a live table as gone.
    const src = `
      CREATE TABLE old_log (id INTEGER, profile_id INTEGER);
      DROP TABLE old_log;
      ALTER TABLE old_log RENAME TO new_totals;`;
    const renames = tableRenames(src);
    expect([...tablesRetired(src, renames)]).toEqual([]);
    expect([...finalTablesDeclaring(src, () => true)]).toEqual(["new_totals"]);
  });

  it("prose about a DROP retires nothing", () => {
    // Migration 006's comments discuss "a DROP TABLE intake_items".
    const src = `
      CREATE TABLE intake_items (id INTEGER, profile_id INTEGER);
      // this is not a DROP TABLE intake_items, it is a sentence about one
      * and neither is ALTER TABLE intake_items RENAME TO something_else`;
    const renames = tableRenames(src);
    expect(renames.has("intake_items")).toBe(false);
    expect([...tablesRetired(src, renames)]).toEqual([]);
    expect([...finalTablesDeclaring(src, () => true)]).toEqual([
      "intake_items",
    ]);
  });

  it("a real table whose name ends in _new survives", () => {
    // The suffix accident this replaced: `endsWith("_new")` treated any such name as
    // rebuild scratch, so a real `whats_new` table would have been silently dropped from
    // every derived set — invisible to the profile-delete sweep and outside the
    // profile-scoping ratchet, which is precisely the failure the guard exists to stop.
    const src = `CREATE TABLE whats_new (id INTEGER, profile_id INTEGER);`;
    expect([...finalTablesDeclaring(src, () => true)]).toEqual(["whats_new"]);
  });

  it("follows a rename chain and refuses a cycle", () => {
    const renames = new Map([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(finalTableName("a", renames)).toBe("c");
    expect(finalTableName("z", renames)).toBe("z");
    expect(() => finalTableName("a", new Map([["a", "a2"], ["a2", "a"]]))).toThrow(
      /cycle/
    );
  });

  it("ignores an ALTER whose subject is a variable", () => {
    // `ALTER TABLE ${scratch} RENAME TO appointments` — several numbered migrations name
    // their scratch through a const. The TARGET is still literal, which is all the
    // rebuild subtraction needs.
    const src = `
      CREATE TABLE appointments (id INTEGER, profile_id INTEGER);
      db.exec(\`DROP TABLE appointments;\`);
      db.exec(\`ALTER TABLE \${scratch} RENAME TO appointments;\`);`;
    const renames = tableRenames(src);
    expect([...renames.keys()]).toEqual([...DYNAMIC_TABLE_RENAMES.keys()]);
    expect([...tablesRetired(src, renames)]).toEqual([]);
  });
});

describe("migration corpus reader: against the real corpus", () => {
  it("enumerates every migration and nothing else", () => {
    const files = migrationFileNames();
    expect(files).not.toContain("index.ts");
    expect(files.every((f) => f.endsWith(".ts"))).toBe(true);
    expect(files.length).toBeGreaterThan(180);
  });

  it("every declared dynamic rename names a table the corpus really created", () => {
    // A stale hand entry would silently un-retire a name nothing renames, so each `from`
    // must be a real CREATE and each `to` must be a final name (not itself renamed away).
    const src = migrationSources();
    const created = new Set(createdTables(src).map((t) => t.name));
    const renames = tableRenames(src);
    for (const [from, to] of DYNAMIC_TABLE_RENAMES) {
      expect(created.has(from)).toBe(true);
      expect(finalTableName(to, renames)).toBe(to);
    }
  });
});
