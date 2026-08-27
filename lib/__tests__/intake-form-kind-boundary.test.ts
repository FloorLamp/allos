import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { describe, expect, it } from "vitest";
import { requireIntakeFormKind } from "@/lib/intake-form-kind";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INTAKE_FORM_MODULE = "@/components/IntakeItemForm";

const EXPECTED_CALLERS = [
  ["app/(app)/medications/MedicationAddWorkspace.tsx", "medication"],
  ["app/(app)/medications/MedicationCard.tsx", "medication"],
  ["app/(app)/nutrition/EditableSupplementRow.tsx", "supplement"],
  ["components/illness/IllnessMedicationLogger.tsx", "medication"],
  ["components/nutrition/AddSupplementModal.tsx", "supplement"],
] as const;

function isScannedSource(name: string): boolean {
  return (
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".mts") ||
    name.endsWith(".cts") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs")
  );
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, rel), {
      withFileTypes: true,
    })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (isScannedSource(entry.name)) out.push(child);
    }
  };
  walk(root);
  return out;
}

type IntakeFormCensus = {
  callers: [string, string][];
  violations: string[];
};

function isIntakeFormModule(specifier: string): boolean {
  return (
    specifier === INTAKE_FORM_MODULE ||
    /(?:^|\/)IntakeItemForm(?:\.[cm]?[jt]sx?)?$/.test(specifier)
  );
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isModuleTextLiteral(
  node: ts.Node
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function scanIntakeFormSource(file: string, text: string): IntakeFormCensus {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file)
  );
  const callers: [string, string][] = [];
  const violations: string[] = [];
  const importedNames: string[] = [];

  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isIntakeFormModule(statement.moduleSpecifier.text)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (ts.isExportDeclaration(statement)) {
        violations.push(`${file} must not re-export IntakeItemForm`);
        continue;
      }
      if (specifier !== INTAKE_FORM_MODULE) {
        violations.push(
          `${file} must import IntakeItemForm from ${INTAKE_FORM_MODULE}`
        );
        continue;
      }
      const clause = statement.importClause;
      if (
        clause == null ||
        clause.isTypeOnly ||
        clause.name == null ||
        clause.name.text !== "IntakeItemForm" ||
        clause.namedBindings != null
      ) {
        violations.push(
          `${file} must use the canonical direct default IntakeItemForm import`
        );
        continue;
      }
      importedNames.push(clause.name.text);
    }
  }

  if (importedNames.length > 1) {
    violations.push(`${file} must have one IntakeItemForm import`);
  }
  const localName = importedNames.length === 1 ? importedNames[0] : null;
  let mounts = 0;

  const visit = (node: ts.Node) => {
    const parent = node.parent;
    const executableModuleLoad =
      isModuleTextLiteral(node) &&
      ((ts.isCallExpression(parent) &&
        parent.arguments.includes(node) &&
        (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(parent.expression) &&
            parent.expression.text === "require"))) ||
        ts.isExternalModuleReference(parent));
    if (
      isModuleTextLiteral(node) &&
      isIntakeFormModule(node.text) &&
      executableModuleLoad
    ) {
      violations.push(
        `${file} must not load IntakeItemForm through require() or import()`
      );
    }

    if (localName != null && ts.isIdentifier(node) && node.text === localName) {
      const directImport =
        ts.isImportClause(node.parent) && node.parent.name === node;
      const directTag =
        (ts.isJsxOpeningElement(node.parent) ||
          ts.isJsxSelfClosingElement(node.parent) ||
          ts.isJsxClosingElement(node.parent)) &&
        node.parent.tagName === node;
      if (!directImport && !directTag) {
        violations.push(
          `${file} must not alias, shadow, wrap, or otherwise forward IntakeItemForm`
        );
      }
    }

    if (
      localName != null &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === localName
    ) {
      mounts += 1;
      if (node.attributes.properties.some(ts.isJsxSpreadAttribute)) {
        violations.push(`${file}'s IntakeItemForm mount must not spread props`);
      }
      const kinds = node.attributes.properties.filter(
        (attribute): attribute is ts.JsxAttribute =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(source) === "kind"
      );
      if (kinds.length !== 1) {
        violations.push(`${file} must pass one kind prop`);
      } else {
        const initializer = kinds[0].initializer;
        if (
          initializer == null ||
          !ts.isStringLiteral(initializer) ||
          (initializer.text !== "medication" &&
            initializer.text !== "supplement")
        ) {
          violations.push(
            `${file}'s kind must be a literal medication or supplement`
          );
        } else {
          callers.push([file, initializer.text]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (localName != null && mounts === 0) {
    violations.push(
      `${file} imports IntakeItemForm without mounting it directly`
    );
  }
  return { callers, violations };
}

function intakeFormCensus(): IntakeFormCensus {
  const callers: [string, string][] = [];
  const violations: string[] = [];
  for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
    const result = scanIntakeFormSource(
      file,
      fs.readFileSync(path.join(REPO, file), "utf8")
    );
    callers.push(...result.callers);
    violations.push(...result.violations);
  }
  return {
    callers: callers.sort((a, b) => a[0].localeCompare(b[0])),
    violations,
  };
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
    const census = intakeFormCensus();
    expect(census.violations, census.violations.join("\n")).toEqual([]);
    expect(census.callers).toEqual(EXPECTED_CALLERS);
  });

  it("rejects spreads, aliases, shadows, wrappers, and re-exports", () => {
    const hostile = [
      `
        import IntakeItemForm from "@/components/IntakeItemForm";
        const overrides: Record<string, unknown> = { kind: "supplement" };
        export function Host() {
          return <IntakeItemForm kind="medication" {...overrides} />;
        }
      `,
      `
        import IntakeItemForm from "@/components/IntakeItemForm";
        const Alias = IntakeItemForm;
        export function Host() {
          return <Alias kind="medication" />;
        }
      `,
      `
        import Form from "@/components/IntakeItemForm";
        export function Host() {
          return <Form kind="medication" />;
        }
      `,
      `
        import IntakeItemForm from "@/components/IntakeItemForm";
        export function Host({ IntakeItemForm }: { IntakeItemForm: React.ComponentType }) {
          return <IntakeItemForm kind="medication" />;
        }
      `,
      `
        import IntakeItemForm from "@/components/IntakeItemForm";
        export const Wrapper = (props: Record<string, unknown>) => (
          <IntakeItemForm kind="medication" {...props} />
        );
      `,
      `export { default as IntakeItemForm } from "@/components/IntakeItemForm";`,
      `import IntakeItemForm from "../../components/IntakeItemForm";`,
      `const IntakeItemForm = require("@/components/IntakeItemForm").default;`,
    ];
    for (const [index, source] of hostile.entries()) {
      expect(
        scanIntakeFormSource(`hostile-${index}.tsx`, source).violations,
        `hostile case ${index}`
      ).not.toEqual([]);
    }
  });

  it("accepts only a direct canonical mount with one string-literal kind", () => {
    expect(
      scanIntakeFormSource(
        "safe.tsx",
        `
          import IntakeItemForm from "@/components/IntakeItemForm";
          export function Host() {
            return <IntakeItemForm action={save} kind="supplement" />;
          }
        `
      )
    ).toEqual({
      callers: [["safe.tsx", "supplement"]],
      violations: [],
    });
  });

  it("scans TypeScript barrels without treating prose as executable imports", () => {
    expect(
      scanIntakeFormSource(
        "components/index.ts",
        `
          // import Form from "@/components/IntakeItemForm";
          export const documentation = "@/components/IntakeItemForm";
        `
      )
    ).toEqual({ callers: [], violations: [] });
    expect(
      scanIntakeFormSource(
        "components/index.ts",
        `export { default as Form } from "@/components/IntakeItemForm";`
      ).violations
    ).not.toEqual([]);
  });

  it("rejects JavaScript barrels and JSX aliases with their native syntax", () => {
    expect(
      [
        "Host.ts",
        "Host.tsx",
        "Host.mts",
        "Host.cts",
        "Host.js",
        "Host.jsx",
        "Host.mjs",
        "Host.cjs",
      ].filter(isScannedSource)
    ).toEqual([
      "Host.ts",
      "Host.tsx",
      "Host.mts",
      "Host.cts",
      "Host.js",
      "Host.jsx",
      "Host.mjs",
      "Host.cjs",
    ]);
    expect([
      scriptKind("Host.mjs"),
      scriptKind("Host.cjs"),
      scriptKind("Host.mts"),
      scriptKind("Host.cts"),
    ]).toEqual([
      ts.ScriptKind.JS,
      ts.ScriptKind.JS,
      ts.ScriptKind.TS,
      ts.ScriptKind.TS,
    ]);
    expect(
      scanIntakeFormSource(
        "components/index.js",
        `export { default as Form } from "@/components/IntakeItemForm";`
      ).violations
    ).not.toEqual([]);
    expect(
      scanIntakeFormSource(
        "components/Host.jsx",
        `
          import IntakeItemForm from "@/components/IntakeItemForm";
          const Alias = IntakeItemForm;
          export const Host = () => <Alias kind="medication" />;
        `
      ).violations
    ).not.toEqual([]);
    expect(
      scanIntakeFormSource(
        "components/Host.jsx",
        `
          import IntakeItemForm from "@/components/IntakeItemForm";
          export const Host = () => <IntakeItemForm kind="medication" />;
        `
      )
    ).toEqual({
      callers: [["components/Host.jsx", "medication"]],
      violations: [],
    });
  });

  it("rejects quoted and template executable loads in module-family files", () => {
    const hostile = [
      [
        "components/Quoted.mjs",
        'const Form = await import("@/components/IntakeItemForm");',
      ],
      [
        "components/Host.mjs",
        "const Form = await import(`@/components/IntakeItemForm`);",
      ],
      [
        "components/Host.cjs",
        "const Form = require(`@/components/IntakeItemForm`);",
      ],
      [
        "components/Host.mts",
        "const Form = await import(`@/components/IntakeItemForm`);",
      ],
      [
        "components/Host.cts",
        "const Form = require(`@/components/IntakeItemForm`);",
      ],
    ] as const;
    for (const [file, source] of hostile) {
      expect(scanIntakeFormSource(file, source).violations, file).not.toEqual(
        []
      );
    }
    expect(
      scanIntakeFormSource(
        "components/notes.mjs",
        "export const documentation = `@/components/IntakeItemForm`;"
      )
    ).toEqual({ callers: [], violations: [] });
  });
});
