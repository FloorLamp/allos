import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const IMPLEMENTATION = "components/Chip.tsx";
const TOKENS = new Set(["chip", "chip-nav", "chip-filter", "chip-sm"]);

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory())
        return entry.name === "__tests__" ? [] : sourceFiles(rel);
      return /\.tsx?$/.test(entry.name) ? [rel] : [];
    });
}

function tokens(text: string): string[] {
  return text.split(/\s+/).filter((token) => TOKENS.has(token));
}

function rawChipTokens(file: string, text?: string): string[] {
  if (file === IMPLEMENTATION) return [];
  const source = ts.createSourceFile(
    file,
    text ?? fs.readFileSync(path.join(ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const findings = new Set<string>();
  function report(node: ts.Node, used: string[]) {
    if (used.length === 0) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    findings.add(`${file}:${line} ${used.join(" ")}`);
  }
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node)) {
      const used = tokens(node.text).filter((token) => token !== "chip");
      report(node, used);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "className" &&
      node.initializer
    ) {
      const used: string[] = [];
      function collectLiteralTokens(part: ts.Node) {
        if (ts.isStringLiteralLike(part)) {
          used.push(...tokens(part.text));
          return;
        }
        ts.forEachChild(part, collectLiteralTokens);
      }
      collectLiteralTokens(node.initializer);
      report(node, used);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...findings];
}

describe("Chip residual", () => {
  it("keeps raw chip presentation inside the typed primitive", () => {
    const findings = ["app", "components"]
      .flatMap(sourceFiles)
      .flatMap((file) => rawChipTokens(file));
    expect(findings).toEqual([]);
  });

  it.each([
    ["direct", '<button className="chip chip-filter">A</button>'],
    [
      "hoisted",
      'const raw = "chip chip-nav"; export default () => <a className={raw}>A</a>',
    ],
    [
      "conditional",
      '<button className={`chip ${on ? "chip-filter" : "chip-nav"}`}>A</button>',
    ],
  ])("rejects a %s raw presentation", (_name, source) => {
    expect(rawChipTokens("components/Plant.tsx", source)).not.toEqual([]);
  });
});
