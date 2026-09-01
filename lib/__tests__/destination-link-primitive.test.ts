import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RIGHT_GLYPH =
  /(?:→|➜|➔|➡|⇒|⟶|›|»|⟩|❯|►|->|&(?:rarr|rightarrow);|&#(?:8594|8250|187);)\s*$/;
const MAY_HAVE_RIGHT_CUE =
  /Icon[A-Za-z0-9_]*(?:Arrow|Chevron|Caret)[A-Za-z0-9_]*Right|→|➜|➔|➡|⇒|⟶|›|»|⟩|❯|►|->|&(?:rarr|rightarrow);|&#(?:8594|8250|187);/;
const RIGHT_ICON_FAMILY = /(?:Arrow|Chevron|Caret)/;
const COMPOUND_DIRECTION = /(?:UpRight|DownRight|RightUp|RightDown)/;

function isRightwardIndicatorIcon(name: string): boolean {
  return (
    name.startsWith("Icon") &&
    RIGHT_ICON_FAMILY.test(name) &&
    name.includes("Right") &&
    !COMPOUND_DIRECTION.test(name)
  );
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".tsx")) found.push(file);
    }
  };
  walk("app");
  walk("components");
  return found;
}

function directRightwardCues(
  file: string,
  source: string,
  insideLinksOnly: boolean
): string[] {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const links = new Set<string>();
  const icons = new Set<string>();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const clause = statement.importClause;
    if (statement.moduleSpecifier.text === "next/link" && clause?.name) {
      links.add(clause.name.text);
    }
    if (
      statement.moduleSpecifier.text === "@tabler/icons-react" &&
      clause?.namedBindings &&
      ts.isNamedImports(clause.namedBindings)
    ) {
      for (const specifier of clause.namedBindings.elements) {
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        if (isRightwardIndicatorIcon(imported)) icons.add(specifier.name.text);
      }
    }
  }
  const findings: string[] = [];
  const inspect = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree);
      if (icons.has(tag)) findings.push(`${file}: ${tag}`);
    }
    if (ts.isJsxText(node) && RIGHT_GLYPH.test(node.text.trim())) {
      findings.push(`${file}: text arrow`);
    }
    if (ts.isStringLiteralLike(node) && RIGHT_GLYPH.test(node.text.trim())) {
      findings.push(`${file}: expression arrow`);
    }
    ts.forEachChild(node, inspect);
  };
  const visitLinks = (node: ts.Node): void => {
    if (
      ts.isJsxElement(node) &&
      links.has(node.openingElement.tagName.getText(tree))
    ) {
      node.children.forEach(inspect);
    }
    ts.forEachChild(node, visitLinks);
  };
  if (insideLinksOnly) visitLinks(tree);
  else inspect(tree);
  return findings;
}

function handRolledIndicators(file: string, source: string): string[] {
  return directRightwardCues(file, source, true);
}

describe("DestinationLink", () => {
  it("keeps the approved indicator in one fixed component", () => {
    const indicator = fs.readFileSync(
      path.join(REPO, "components/DestinationIndicator.tsx"),
      "utf8"
    );
    const cues = directRightwardCues(
      "components/DestinationIndicator.tsx",
      indicator,
      false
    );
    expect(cues).toEqual([
      "components/DestinationIndicator.tsx: IconChevronRight",
    ]);
    expect(indicator).toContain('className="h-4 w-4 shrink-0"');
    expect(indicator).toContain("aria-hidden");
  });

  it("finds no raw rightward indicator inside next/link", () => {
    const findings = sourceFiles().flatMap((file) => {
      const source = fs.readFileSync(path.join(REPO, file), "utf8");
      return source.includes("next/link") && MAY_HAVE_RIGHT_CUE.test(source)
        ? handRolledIndicators(file, source)
        : [];
    });
    expect(findings).toEqual([]);
  });

  it.each([
    'import Jump from "next/link"; import { IconArrowRight as Go } from "@tabler/icons-react"; export const Bad = () => <Jump href="/x"><Go /></Jump>;',
    'import Link from "next/link"; import { IconCaretRight } from "@tabler/icons-react"; export const Bad = () => <Link href="/x"><IconCaretRight /></Link>;',
    'import Link from "next/link"; import { IconArrowRightBar } from "@tabler/icons-react"; export const Bad = () => <Link href="/x"><IconArrowRightBar /></Link>;',
    'import Link from "next/link"; import { IconChevronRightFilled } from "@tabler/icons-react"; export const Bad = () => <Link href="/x"><IconChevronRightFilled /></Link>;',
    'import Link from "next/link"; import { IconCaretRightFilled } from "@tabler/icons-react"; export const Bad = () => <Link href="/x"><IconCaretRightFilled /></Link>;',
    'import Link from "next/link"; export const Bad = () => <Link href="/x">Open →</Link>;',
    'import Link from "next/link"; export const Bad = () => <Link href="/x">Open ➔</Link>;',
    'import Link from "next/link"; export const Bad = () => <Link href="/x">Open ⇒</Link>;',
    'import Link from "next/link"; export const Bad = () => <Link href="/x">Open ⟶</Link>;',
    'import Link from "next/link"; export const Bad = () => <Link href="/x">Open &#8594;</Link>;',
  ])("sees an ordinary raw bypass", (source) => {
    expect(MAY_HAVE_RIGHT_CUE.test(source)).toBe(true);
    expect(handRolledIndicators("components/Bad.tsx", source)).not.toEqual([]);
  });

  it("leaves semantic rightward controls outside links alone", () => {
    const source =
      'import { IconChevronRight } from "@tabler/icons-react"; export const NextMonth = () => <button aria-label="Next month"><IconChevronRight /></button>;';
    expect(handRolledIndicators("components/NextMonth.tsx", source)).toEqual(
      []
    );
  });

  it("leaves a diagonal external-link cue alone", () => {
    const source =
      'import Link from "next/link"; import { IconArrowUpRight } from "@tabler/icons-react"; export const External = () => <Link href="https://example.com">Open source <IconArrowUpRight /></Link>;';
    expect(handRolledIndicators("components/External.tsx", source)).toEqual([]);
  });
});
