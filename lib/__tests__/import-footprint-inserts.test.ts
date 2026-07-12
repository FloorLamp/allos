import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMPORT_FOOTPRINT_TABLES } from "@/lib/import-footprint";

// Reflection binding: the footprint list ⇄ the persist core's actual INSERTs.
//
// IMPORT_FOOTPRINT_TABLES drives clear/move/count for a document's whole footprint
// (lib/import-persist.ts). The cross-tier fixtures (lib/__db_tests__/imports.test.ts,
// lib/__action_tests__/import-reassign.actions.test.ts) prove the list is correct
// TODAY, but a future INSERT added to persistDocumentImport without a footprint
// entry is invisible to clear/move/count and only caught if someone remembers to
// extend those fixtures. This test converts the contract from "tested" to
// "can't drift" (#422 item 1), in the style of profile-scoping.test.ts /
// owned-tables: it reads lib/import-persist.ts as TEXT — no DB, no network, so it
// stays "pure" in the vitest sense — extracts every `INSERT … INTO <table>`
// target, and fails if a target isn't a footprint table (or an allowlisted
// non-footprint write). It also checks the reverse: every footprint table is
// actually written by the persist core, so a stale entry for a table nothing
// inserts is caught too.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PERSIST_FILE = "lib/import-persist.ts";

// INSERT targets in the persist core that are DELIBERATELY not footprint tables —
// each justified. A footprint table is one whose rows must be individually
// cleared/moved/counted by document; anything here is covered another way (or is
// not a per-row document artifact) and must NOT be added to IMPORT_FOOTPRINT_TABLES.
const ALLOW_INSERT: { table: string; why: string }[] = [
  {
    table: "intake_item_doses",
    why: "child of intake_items (FK item_id → intake_items(id) ON DELETE CASCADE): a dose row follows its parent extracted-medication row, which IS the footprint entry (intake_items, source='extracted'), so it is cleared/moved/counted transitively via the parent — not a footprint row of its own",
  },
];

// Every `INSERT [OR IGNORE|OR REPLACE] INTO <table>` target in a source string.
function insertTargets(src: string): string[] {
  const re =
    /\bINSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+([a-zA-Z_][\w]*)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

describe("import footprint: reflection-bound to the persist core's INSERTs", () => {
  const src = fs.readFileSync(path.join(REPO, PERSIST_FILE), "utf8");
  const inserted = insertTargets(src);
  const insertedSet = new Set(inserted);
  const footprint = new Set(IMPORT_FOOTPRINT_TABLES.map((t) => t.table));
  const allowed = new Set(ALLOW_INSERT.map((a) => a.table));

  it("finds the persist core's INSERT statements", () => {
    // Guard against a broken regex silently passing: the core writes ~14 tables.
    expect(inserted.length).toBeGreaterThan(10);
  });

  it("every INSERT target is a footprint table or an allowlisted non-footprint write", () => {
    const violations = [...insertedSet].filter(
      (t) => !footprint.has(t) && !allowed.has(t)
    );
    expect(
      violations,
      `\nINSERT into a table missing from IMPORT_FOOTPRINT_TABLES — clear/move/count won't see its rows. Add it to lib/import-footprint.ts, or allowlist it here with a justification:\n${violations.join("\n")}\n`
    ).toEqual([]);
  });

  it("every footprint table is actually written by the persist core", () => {
    // Reverse coverage: a footprint entry for a table the core never inserts is a
    // stale contract (clear/move/count spend work on rows that can't exist).
    const orphans = [...footprint].filter((t) => !insertedSet.has(t));
    expect(
      orphans,
      `\nfootprint table(s) not INSERTed by lib/import-persist.ts:\n${orphans.join("\n")}\n`
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    // An allowlisted table must still be inserted (else the exemption is dead) and
    // must NOT have since become a footprint table (else the exemption hides it).
    for (const a of ALLOW_INSERT) {
      expect(
        insertedSet.has(a.table),
        `allowlisted INSERT target '${a.table}' is no longer inserted — remove it`
      ).toBe(true);
      expect(
        footprint.has(a.table),
        `allowlisted table '${a.table}' is now a footprint table — drop the allowlist entry`
      ).toBe(false);
    }
  });
});
