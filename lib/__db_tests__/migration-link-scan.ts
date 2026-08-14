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
//
// WHAT THE SCAN CANNOT SEE, AND WHY THAT IS A FAILURE NOW (#2772). The pair shape
// recognised below is `{ table: "…", column: "…" }` and nothing else. A registry
// spelled as tuples (`[["t", "c"]] as const`), built by a helper, or assembled out
// of template literals resolves to NO pairs — and both guards then pass VACUOUSLY:
// one finds no unknown pairs because it found no pairs, and the census that
// requires a fixture per declared link finds nothing declared, so it requires
// nothing. That is #2444's shape at one remove — a guard reading like protection
// while covering nothing — except here there is no misspelled string to find, only
// an absence.
//
// Widening the matcher chases syntax forever; the next author writes something the
// widened matcher also misses. So the scan FAILS CLOSED instead: a binding named
// CHILD_LINKS whose contents cannot be resolved to pairs is a hard error naming the
// file, not a silent zero. It does not care what shape arrives next, and it is the
// same move `deleteRowsWithCascade` made by DERIVING links from
// `PRAGMA foreign_key_list` rather than transcribing them.
//
// The residual, stated rather than implied: a registry under a name with no
// CHILD_LINK in it, in an unrecognised shape, is still invisible here. The backstop
// is the exercised census, which reads the non-cascading parents of the deleted
// table out of the MIGRATED SCHEMA and requires the migration to declare each one —
// so an unreadable registry under any name fails there as an undeclared parent, for
// every migration registered in CHILD_LINK_FIXTURES.

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

/** A part of a CHILD_LINKS binding the pair matcher could not read. */
export interface UnreadableLinkRegistry {
  file: string;
  /** The binding name as declared, e.g. `CHILD_LINKS`. */
  name: string;
  /** 1-based line of the part that could not be read. */
  line: number;
  /** That part's source text, whitespace-collapsed and truncated. */
  text: string;
}

export interface MigrationLinkScan {
  links: LinkLiteral[];
  unreadable: UnreadableLinkRegistry[];
}

/** `table.column`, the form both guards compare and report in. */
export function linkKey(link: { table: string; column: string }): string {
  return `${link.table}.${link.column}`;
}

// Which binding names are held to the pair shape. Substring, not equality, so
// CHILD_LINKS_EXTRA and RECORD_CHILD_LINKS are covered too — splitting one registry
// in two must not drop either half out of the check.
const REGISTRY_NAME = /CHILD_LINK/;

/** Strip `as const`, `satisfies …`, `<T>x`, `x!` and parentheses off a value. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** The (table, column) pair a node spells, or null if it does not spell one. */
function pairOf(node: ts.Expression): { table: string; column: string } | null {
  const n = unwrap(node);
  if (!ts.isObjectLiteralExpression(n)) return null;
  const props = new Map<string, string>();
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
    if (!ts.isStringLiteral(p.initializer)) continue;
    props.set(p.name.text, p.initializer.text);
  }
  const table = props.get("table");
  const column = props.get("column");
  return table && column ? { table, column } : null;
}

function locate(
  sf: ts.SourceFile,
  node: ts.Node,
  name: string
): UnreadableLinkRegistry {
  const raw = node.getText(sf).replace(/\s+/g, " ").trim();
  return {
    file: sf.fileName,
    name,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    text: raw.length > 120 ? `${raw.slice(0, 117)}…` : raw,
  };
}

/**
 * Scan one migration source. Pure — it takes the text, so a guard can drive it
 * with a shape no migration in the tree uses today.
 *
 * `links` is every `{ table: "…", column: "…" }` object literal ANYWHERE in the
 * file: shape-matched rather than name-matched, so renaming CHILD_LINKS does not
 * escape it. `unreadable` is every part of a CHILD_LINKS-named binding that is not
 * one of those literals.
 */
export function scanMigrationSource(
  file: string,
  src: string
): MigrationLinkScan {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const links: LinkLiteral[] = [];
  const unreadable: UnreadableLinkRegistry[] = [];

  // The binding must be an array, and every element of it a readable pair.
  // Anything else is reported rather than skipped.
  const checkRegistry = (name: string, init: ts.Expression): void => {
    const value = unwrap(init);
    if (!ts.isArrayLiteralExpression(value)) {
      unreadable.push(locate(sf, value, name));
      return;
    }
    for (const el of value.elements) {
      if (ts.isSpreadElement(el) || pairOf(el) === null) {
        unreadable.push(locate(sf, el, name));
      }
    }
  };

  const registryName = (name: ts.Node): string | null =>
    ts.isIdentifier(name) && REGISTRY_NAME.test(name.text) ? name.text : null;

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const pair = pairOf(node);
      if (pair) links.push({ file, ...pair });
    }
    if (ts.isVariableDeclaration(node)) {
      const name = registryName(node.name);
      if (name !== null) {
        if (node.initializer) checkRegistry(name, node.initializer);
        // A registry declared with no value is assigned somewhere this scan does
        // not follow — the same blind spot, reported the same way.
        else unreadable.push(locate(sf, node, name));
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = registryName(node.name);
      if (name !== null) checkRegistry(name, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { links, unreadable };
}

/** Scan every migration in `versions/`, without deciding what to do about gaps. */
export function scanMigrationVersions(): MigrationLinkScan {
  const links: LinkLiteral[] = [];
  const unreadable: UnreadableLinkRegistry[] = [];
  for (const file of fs
    .readdirSync(MIGRATION_VERSIONS)
    // Both eras: the closed numbered prefix (NNN-slug.ts) and the name-keyed era
    // after it (YYYYMMDD-slug.ts) — a new migration's CHILD_LINKS must be scanned
    // regardless of which naming scheme it shipped under.
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort()) {
    const src = fs.readFileSync(path.join(MIGRATION_VERSIONS, file), "utf8");
    const scan = scanMigrationSource(file, src);
    links.push(...scan.links);
    unreadable.push(...scan.unreadable);
  }
  return { links, unreadable };
}

/** The message an unreadable registry fails with. Shared with its own guard. */
export function unreadableRegistryMessage(
  gaps: readonly UnreadableLinkRegistry[]
): string {
  return (
    `Unreadable child-link registry in ${gaps.length} place(s) (#2772):\n` +
    gaps
      .map((g) => `  ${g.file}:${g.line} — ${g.name} contains \`${g.text}\``)
      .join("\n") +
    `\nThe two guards over these registries read the migration SOURCE and ` +
    `recognise ONE pair shape: { table: "…", column: "…" } with string literals. ` +
    `A registry they cannot read declares nothing as far as they are concerned, ` +
    `so both pass VACUOUSLY — the unknown-pair check finds no pairs, and the ` +
    `per-link fixture census requires no fixtures, over a migration that deletes ` +
    `rows. Spell every pair as that literal.`
  );
}

/** Throw if any registry in `scan` could not be read. The fail-closed rule. */
export function assertRegistriesReadable(scan: MigrationLinkScan): void {
  if (scan.unreadable.length > 0) {
    throw new Error(unreadableRegistryMessage(scan.unreadable));
  }
}

/**
 * Every `{ table: "…", column: "…" }` object literal in the migration sources.
 *
 * THROWS when a CHILD_LINKS-named binding holds anything else. Both guards call
 * this, so an unreadable registry fails the tier naming the file that wrote it,
 * instead of quietly shrinking what either guard covers (#2772).
 */
export function linkLiterals(): LinkLiteral[] {
  const scan = scanMigrationVersions();
  assertRegistriesReadable(scan);
  return scan.links;
}
