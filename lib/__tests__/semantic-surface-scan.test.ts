import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      files.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function literals(
  file: string,
  text: string
): { line: number; value: string }[] {
  const out: { line: number; value: string }[] = [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source)
      );
      out.push({ line: line + 1, value: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function isWhiteIndicator(rel: string, value: string): boolean {
  if (value.includes("appearance-none") && value.includes("checked:bg-brand")) {
    return true;
  }
  if (rel === "components/SingleReadingMark.tsx") {
    return value.includes("h-5 w-5") && value.includes("rounded-full");
  }
  if (rel === "app/(app)/training/StrengthStandardsLadder.tsx") {
    return value.includes("h-3 w-3") && value.includes("rounded-full");
  }
  return false;
}

describe("semantic Botanical surfaces", () => {
  it("does not hand-code light and dark structural backgrounds", () => {
    const offenders: string[] = [];
    const indicators: string[] = [];

    for (const root of ["app", "components"]) {
      for (const full of walk(path.join(REPO, root))) {
        const rel = path.relative(REPO, full).split(path.sep).join("/");
        const text = fs.readFileSync(full, "utf8");
        for (const { line, value } of literals(full, text)) {
          const hasLightSurface =
            /(?:^|\s)(?:[\w-]+:)*bg-white(?:\/\d+)?(?:\s|$)/.test(value);
          const hasDarkSurface =
            /(?:^|\s)(?:[\w-]+:)*dark:bg-(?:ink|slate|black)-?\d*(?:\/\d+)?(?:\s|$)/.test(
              value
            );
          if (!hasLightSurface || !hasDarkSurface) continue;

          const location = `${rel}:${line}`;
          if (isWhiteIndicator(rel, value)) indicators.push(location);
          else offenders.push(location);
        }
      }
    }

    expect(
      offenders,
      "These class strings still hard-code a light/dark surface pair. Use " +
        "bg-surface, bg-field, bg-(--nav), or a semantic ghost token."
    ).toEqual([]);
    expect(indicators).toHaveLength(7);
  });
});
