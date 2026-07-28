import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

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

describe("native browser dialogs", () => {
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
