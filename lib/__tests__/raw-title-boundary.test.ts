import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_ROOTS = ["app", "components"];
const TITLE_PASSTHROUGH_IMPORTS = new Map<string, ReadonlySet<string>>([
  ["next/link", new Set(["default"])],
  ["@/components/CardFootnote", new Set(["default"])],
  [
    "@/components/DestinationLink",
    new Set(["default", "DestinationActionLink", "StandingDestinationLink"]),
  ],
]);

function tsxFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return tsxFiles(file);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [file] : [];
  });
}

function rawTitleFindings(source: string): string[] {
  // JSX parsing cannot create an attribute spelling that is absent from source.
  // Keep the AST verdict for candidates without building guaranteed-empty trees.
  if (!/\btitle\s*=/.test(source)) return [];
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const findings: string[] = [];
  const titlePassthroughNames = new Set<string>();

  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const registered = TITLE_PASSTHROUGH_IMPORTS.get(
      statement.moduleSpecifier.text
    );
    const clause = statement.importClause;
    if (!registered || !clause) continue;
    if (clause.name && registered.has("default")) {
      titlePassthroughNames.add(clause.name.text);
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (registered.has(imported)) {
          titlePassthroughNames.add(element.name.text);
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      const hasTitle = node.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(file) === "title"
      );
      if (hasTitle && (/^[a-z]/.test(tag) || titlePassthroughNames.has(tag))) {
        findings.push(tag);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return findings;
}

describe("raw explanatory title boundary", () => {
  it("rejects raw title on intrinsic DOM owners", () => {
    expect(rawTitleFindings('<span title="Only hover">Value</span>')).toEqual([
      "span",
    ]);
    expect(rawTitleFindings("<div\n  title={detail}\n>Value</div>")).toEqual([
      "div",
    ]);
    expect(
      rawTitleFindings('<span data-label=">" title="Only hover">Value</span>')
    ).toEqual(["span"]);
    expect(rawTitleFindings('<button title="Copy">Copy</button>')).toEqual([
      "button",
    ]);
    expect(rawTitleFindings('<a href="/data" title={detail}>Data</a>')).toEqual(
      ["a"]
    );
  });

  it("rejects registered title-passthrough owners without scanning arbitrary components", () => {
    expect(
      rawTitleFindings(
        'import Link from "next/link"; <Link href="/data" title="Only hover">Data</Link>'
      )
    ).toEqual(["Link"]);
    expect(
      rawTitleFindings(
        'import DestinationLink from "@/components/DestinationLink"; <DestinationLink href="/data" title={detail}>Data</DestinationLink>'
      )
    ).toEqual(["DestinationLink"]);
    expect(
      rawTitleFindings(
        'import { StandingDestinationLink as Renamed } from "@/components/DestinationLink"; <Renamed href="/sleep" title={note}>Sleep</Renamed>'
      )
    ).toEqual(["Renamed"]);
    expect(
      rawTitleFindings(
        'import { DestinationActionLink as Act } from "@/components/DestinationLink"; <Act href="/data" title={note}>Open</Act>'
      )
    ).toEqual(["Act"]);
    expect(
      rawTitleFindings(
        'import Footnote from "@/components/CardFootnote"; <Footnote title={note}>Note</Footnote>'
      )
    ).toEqual(["Footnote"]);
    expect(
      rawTitleFindings('const Link = () => null; <Link title="Heading" />')
    ).toEqual([]);
    expect(rawTitleFindings('<ModalShell title="Edit" />')).toEqual([]);
  });

  it("keeps production free of hover-only explanatory titles", () => {
    const findings = SOURCE_ROOTS.flatMap((root) =>
      tsxFiles(path.join(REPO, root)).flatMap((file) =>
        rawTitleFindings(fs.readFileSync(file, "utf8")).map(
          (match) => `${path.relative(REPO, file)}: ${match}`
        )
      )
    );

    expect(findings).toEqual([]);
  });
});
