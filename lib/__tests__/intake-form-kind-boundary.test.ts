import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { requireIntakeFormKind } from "@/lib/intake-form-kind";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const EXPECTED_CALLERS = [
  ["app/(app)/medications/MedicationAddWorkspace.tsx", "medication"],
  ["app/(app)/medications/MedicationCard.tsx", "medication"],
  ["app/(app)/nutrition/AddSupplementModal.tsx", "supplement"],
  ["app/(app)/nutrition/EditableSupplementRow.tsx", "supplement"],
  ["components/illness/IllnessMedicationLogger.tsx", "medication"],
  ["components/illness/SymptomMedQuickAdd.tsx", "medication"],
] as const;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, rel), {
      withFileTypes: true,
    })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".tsx")) out.push(child);
    }
  };
  walk(root);
  return out;
}

function intakeFormCallers(): [string, string][] {
  const callers: [string, string][] = [];
  for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(REPO, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let localName: string | null = null;
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@/components/IntakeItemForm"
      ) {
        localName = statement.importClause?.name?.text ?? null;
      }
    }
    if (localName == null) continue;

    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        node.tagName.text === localName
      ) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const kinds = attributes.filter(
          (attribute) => attribute.name.getText(source) === "kind"
        );
        expect(kinds, `${file} must pass one kind prop`).toHaveLength(1);
        const initializer = kinds[0].initializer;
        expect(
          initializer && ts.isStringLiteral(initializer),
          `${file}'s kind must be a literal medication or supplement`
        ).toBe(true);
        callers.push([file, (initializer as ts.StringLiteral).text]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return callers.sort((a, b) => a[0].localeCompare(b[0]));
}

function intakeFormKindProp() {
  const file = "components/IntakeItemForm.tsx";
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(REPO, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const form = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "IntakeItemForm"
  );
  expect(
    form,
    "the default IntakeItemForm function must remain visible"
  ).toBeDefined();
  const type = form!.parameters[0]?.type;
  expect(
    type && ts.isTypeLiteralNode(type),
    "IntakeItemForm props stay explicit"
  ).toBe(true);
  const kind = (type as ts.TypeLiteralNode).members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText(source) === "kind"
  );
  return {
    optional: kind?.questionToken != null,
    type: kind?.type?.getText(source),
  };
}

describe("IntakeItemForm's locked-kind boundary", () => {
  it("accepts only the two shipped kinds at runtime", () => {
    expect(requireIntakeFormKind("medication")).toBe("medication");
    expect(requireIntakeFormKind("supplement")).toBe("supplement");
    for (const value of [undefined, null, "", "other"])
      expect(() => requireIntakeFormKind(value), String(value)).toThrow(
        "IntakeItemForm requires a locked intake kind"
      );
  });

  it("keeps the component prop required and non-null", () => {
    expect(intakeFormKindProp()).toEqual({
      optional: false,
      type: "IntakeItemKind",
    });
  });

  it("has exactly the six shipped literal-kind callers", () => {
    expect(intakeFormCallers()).toEqual(EXPECTED_CALLERS);
  });
});
