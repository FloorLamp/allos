import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript-api";
import { perTestCeiling } from "../../vitest.timeouts";

const REPO = path.resolve(import.meta.dirname, "../..");
const NATIVE_DIALOGS = new Set(["alert", "confirm", "prompt"]);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function sourceFile(source: string) {
  return ts.createSourceFile(
    "scan.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function lineOf(node: ts.Node, file: ts.SourceFile) {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function nativeDialogLines(source: string): number[] {
  const file = sourceFile(source);
  const lines: number[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const windowCall =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "window" &&
        NATIVE_DIALOGS.has(callee.name.text);
      const first = node.arguments[0];
      const literalBareCall =
        ts.isIdentifier(callee) &&
        NATIVE_DIALOGS.has(callee.text) &&
        first != null &&
        (ts.isStringLiteral(first) ||
          ts.isNoSubstitutionTemplateLiteral(first) ||
          ts.isTemplateExpression(first));

      if (windowCall || literalBareCall) lines.push(lineOf(node, file));
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return lines;
}

function playwrightDialogHandlerLines(source: string): number[] {
  const file = sourceFile(source);
  const lines: number[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "page" &&
      (node.expression.name.text === "on" ||
        node.expression.name.text === "once") &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "dialog"
    ) {
      lines.push(lineOf(node, file));
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return lines;
}

// ONE CEILING FOR THE FILE, AND IT IS A MULTIPLE (#4002). Both scans below walk a
// whole source tree with the TypeScript AST, and each carried a hard-coded
// `}, 15_000)` that `ALLOS_VITEST_TIMEOUT_MS` could not reach — and that turned out
// to be THIN, not generous. This file reads 12 427 ms across its 3 tests on the
// green CI run at f1742fa6d; the dispatch box splits that 62% / 38% / ~0 under
// coverage (4 119 / 2 504 / 2 ms), which puts the app+components scan at ~7 700 ms
// on CI. Against the tier's 15 000 ms that is 1.9x, not the ~4x vitest.timeouts.ts
// derives — the same shape of finding as strip-comments' 98.9%. 2x testTimeout is
// 30 000 ms on CI, ~3.9x that reading, and it scales with the orchestration
// override the literal did not.
//
// The reading is the FILE's because that is what the reporter prints; the per-test
// split is the dispatch box's and is stated as such rather than implied.
//
// THIS IS A RE-DERIVATION, NOT THE THING #3986 PROHIBITS, and the difference is
// worth stating because the two look alike from a distance. That ruling — "do not
// raise the ceilings alone; a larger number makes the symptom rarer without saying
// what stalls" — is aimed at raising a number IN RESPONSE TO A FAILURE, WITHOUT A
// DIAGNOSIS. Nothing here is failing. The number moved because the margin was
// measured against the environment that enforces it, coverage included, and came
// back at 1.9x where the rule asks ~4x — the same class of finding as
// migration-reentry's, and the same thing #3999 did for four other ceilings.
const SCAN_CEILING = { timeout: perTestCeiling(2, "green") };

describe("native browser dialogs", SCAN_CEILING, () => {
  it("detects prohibited window and literal bare calls", () => {
    const source = [
      `window.confirm("Delete?");`,
      `window.alert(message);`,
      `prompt(\`Name: \${name}\`);`,
      `confirm("Continue?");`,
      `confirm(options);`,
    ].join("\n");

    expect(nativeDialogLines(source)).toEqual([1, 2, 3, 4]);
  });

  // This parses every app/component source file, and it is the 62% above: coverage
  // plus the other CI checks starve the CPU-bound TypeScript AST walk without
  // weakening or failing the assertion.
  it("keeps app and component code on the shared dialog primitives", () => {
    const offenses = ["app", "components"].flatMap((root) =>
      sourceFiles(path.join(REPO, root)).flatMap((absolute) =>
        nativeDialogLines(fs.readFileSync(absolute, "utf8")).map(
          (line) => `${path.relative(REPO, absolute)}:${line}`
        )
      )
    );

    expect(offenses).toEqual([]);
  });

  // Same CPU-bound AST walk as the scan above, over the e2e suite instead — and it
  // grows with every spec the repo adds, so it runs under the same file ceiling
  // (measured past vitest's old 5 s default under `test:coverage`, where the
  // instrumentation is what makes the parse slow).
  it("does not allow Playwright to silently accept native dialogs", () => {
    expect(
      playwrightDialogHandlerLines(`page.once("dialog", accept);`)
    ).toEqual([1]);

    const offenses = sourceFiles(path.join(REPO, "e2e")).flatMap((absolute) =>
      playwrightDialogHandlerLines(fs.readFileSync(absolute, "utf8")).map(
        (line) => `${path.relative(REPO, absolute)}:${line}`
      )
    );

    expect(offenses).toEqual([]);
  });
});
