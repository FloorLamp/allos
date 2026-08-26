import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript-api";

// The compiler API this repo's scan tests walk comes from `typescript-api`, an
// alias devDependency pinned to the 5.x line, NOT from `typescript` (#3559).
//
// WHY THE ALIAS EXISTS. TypeScript 7 restructured its package: the root export is a
// version stub, and `createSourceFile` / `isCallExpression` / `forEachChild` moved
// to entries the package itself marks UNSTABLE. So `import ts from "typescript"`
// stops resolving to a compiler at all — and the sixteen files that walk an AST here
// are guards (the Server Action authorization sweep, the adult-only write scan, the
// migration child-link scan), not incidental tests. Putting them on a surface whose
// own name says it may move without a major is the trade this repo declined: a minor
// release could take the authorization sweep red, or worse, quietly change what a
// walk finds. `tsc` is free to move to 7 whenever the owner merges the bump; the
// scanners keep parsing with 5.x.
//
// THE STATED COST is a version skew — the parser that reads these sources can be a
// major behind the one that typechecks them. It is bounded: the scanners read SYNTAX
// (call expressions, identifiers, imports, string literals), never type-level
// constructs, so the two parsers can only disagree where the GRAMMAR changed.
//
// THIS FILE is what stops the skew being re-opened by accident. Sixteen importers
// were converted at once; three of them had landed in the two days before the
// conversion, so "nobody will add a seventeenth" was not a safe assumption.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOTS = ["app", "components", "lib", "e2e", "scripts"];

// The sanctioned alias. Everything else that resolves into the typescript package
// — the bare root export and every subpath of it — is what this scan refuses.
const SANCTIONED = "typescript-api";

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(absolute));
    else if (/\.[cm]?tsx?$/.test(entry.name)) out.push(absolute);
  }
  return out;
}

// Membership is the MODULE SPECIFIER, resolved from the AST — never a text match on
// the word. A grep for `typescript` matches this file's own prose, `typescript-eslint`,
// and every package.json mention, while missing a `require()` or a dynamic import; it
// would be wrong in both directions at once.
function rootCompilerApiSpecifiers(source: string): string[] {
  const file = ts.createSourceFile(
    "scan.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found: string[] = [];
  const offending = (spec: string) =>
    spec === "typescript" || spec.startsWith("typescript/");

  function visit(node: ts.Node) {
    // `import ts from "typescript"`, `import * as ts`, `import type {…}`, and the
    // side-effect form — every static import shape shares this node.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      offending(node.moduleSpecifier.text)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    // `import ts = require("typescript")`
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      offending(node.moduleReference.expression.text)
    ) {
      found.push(node.moduleReference.expression.text);
    }
    // `require("typescript")` and `await import("typescript")`
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      const first = node.arguments[0];
      if (
        (isRequire || isDynamic) &&
        first &&
        ts.isStringLiteral(first) &&
        offending(first.text)
      ) {
        found.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return found;
}

describe("compiler-API imports go through the pinned alias (#3559)", () => {
  // Parsing every source file under five roots costs more than this question is
  // worth, and the answer cannot hide from a text pre-filter: a specifier that
  // resolves into the typescript package contains the word.
  const candidates = ROOTS.flatMap((root) =>
    sourceFiles(path.join(REPO, root))
  ).filter((file) => fs.readFileSync(file, "utf8").includes("typescript"));

  it("still finds the scanners it is guarding (the sweep is not vacuous)", () => {
    // A walk that silently stopped finding imports would report a clean tree. This
    // is the floor that makes the green above mean something: the conversion moved
    // sixteen files onto the alias, and they are all still here.
    const onAlias = candidates.filter((file) =>
      fs.readFileSync(file, "utf8").includes(`from "${SANCTIONED}"`)
    );
    expect(onAlias.length).toBeGreaterThanOrEqual(14);
  });

  it("no source file imports the compiler API off the typescript root export", () => {
    const offenses = candidates.flatMap((file) =>
      rootCompilerApiSpecifiers(fs.readFileSync(file, "utf8")).map(
        (spec) =>
          `${path.relative(REPO, file).replaceAll(path.sep, "/")}: ${spec}`
      )
    );
    expect(
      offenses,
      `\nImport the compiler API from "${SANCTIONED}" (the pinned 5.x alias), not from "typescript" — see #3559.\n${offenses.join("\n")}\n`
    ).toEqual([]);
  }, 20_000);

  // A guard proven only against a complying tree has proven nothing. These are the
  // spellings someone could actually reach for.
  it("SEES every import shape that would re-block the bump", () => {
    expect(rootCompilerApiSpecifiers(`import ts from "typescript";`)).toEqual([
      "typescript",
    ]);
    expect(
      rootCompilerApiSpecifiers(`import * as ts from "typescript";`)
    ).toEqual(["typescript"]);
    expect(
      rootCompilerApiSpecifiers(`import type { Node } from "typescript";`)
    ).toEqual(["typescript"]);
    expect(
      rootCompilerApiSpecifiers(
        `import ts from "typescript/lib/typescript.js";`
      )
    ).toEqual(["typescript/lib/typescript.js"]);
    expect(
      rootCompilerApiSpecifiers(`const ts = require("typescript");`)
    ).toEqual(["typescript"]);
    expect(
      rootCompilerApiSpecifiers(`const ts = await import("typescript");`)
    ).toEqual(["typescript"]);
    expect(
      rootCompilerApiSpecifiers(`export { SyntaxKind } from "typescript";`)
    ).toEqual(["typescript"]);
  });

  // And it must stay QUIET on the neighbours, or it gets deleted within a week and
  // takes the real guard with it. `typescript-eslint` is the trap: a prefix match on
  // "typescript" flags the lint toolchain the whole repo depends on.
  it("stays SILENT on the alias and on its lookalike neighbours", () => {
    expect(
      rootCompilerApiSpecifiers(`import ts from "typescript-api";`)
    ).toEqual([]);
    expect(
      rootCompilerApiSpecifiers(`import tseslint from "typescript-eslint";`)
    ).toEqual([]);
    expect(
      rootCompilerApiSpecifiers(
        `import { parser } from "@typescript-eslint/parser";`
      )
    ).toEqual([]);
    // A comment about the rule, and a bare string that names the package but imports
    // nothing — both are what a text grep would have flagged.
    expect(
      rootCompilerApiSpecifiers(
        `// never: import ts from "typescript";\nconst dep = "typescript";`
      )
    ).toEqual([]);
  });
});
