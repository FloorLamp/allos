// Shared source scan for the migration CHILD_LINKS registries (#2444, #2677).
//
// A one-shot row-move migration declares the (table, column) pairs whose reference
// must BLOCK its delete. Both guards over those declarations read them out of the
// migration SOURCE rather than importing them, for two reasons: the arrays are
// module-private consts inside hash-locked files, and a text scan picks up a NEW
// migration's registry without anyone remembering to register it.
//
//   migration-child-links.test.ts       — every declared pair names a real column
//   migration-child-links-exercised.ts  — every declared pair actually blocks
//
// Not a `.test.ts`: this is the scanner the two guards share, so a change to what
// counts as a link literal reaches both at once.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const MIGRATION_VERSIONS = path.join(REPO, "lib/migrations/versions");

export interface LinkLiteral {
  file: string;
  table: string;
  column: string;
}

/** `table.column`, the form both guards compare and report in. */
export function linkKey(link: { table: string; column: string }): string {
  return `${link.table}.${link.column}`;
}

/**
 * Every `{ table: "…", column: "…" }` object literal in the migration sources.
 * Shape-matched rather than name-matched, so renaming CHILD_LINKS does not escape
 * the scan.
 */
export function linkLiterals(): LinkLiteral[] {
  const out: LinkLiteral[] = [];
  for (const file of fs
    .readdirSync(MIGRATION_VERSIONS)
    // Both eras: the closed numbered prefix (NNN-slug.ts) and the name-keyed era
    // after it (YYYYMMDD-slug.ts) — a new migration's CHILD_LINKS must be scanned
    // regardless of which naming scheme it shipped under.
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort()) {
    const src = fs.readFileSync(path.join(MIGRATION_VERSIONS, file), "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map<string, string>();
        for (const p of node.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          if (!ts.isStringLiteral(p.initializer)) continue;
          props.set(p.name.text, p.initializer.text);
        }
        const table = props.get("table");
        const column = props.get("column");
        if (table && column) out.push({ file, table, column });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
