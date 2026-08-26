import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CREATE_ACTIONS,
  type CreateActionKind,
} from "@/components/CreateAction";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CREATE_MODULE = "@/components/CreateAction";
type Identity = { module: string; exported: string };
type Housing = "page" | "section";
const id = (module: string, exported = "default"): Identity => ({
  module,
  exported,
});

// Semantic identity, not an occurrence/path roster. Controls may have multiple
// mounts, but each kind has one exact component identity.
const CONTROLS: Record<CreateActionKind, Identity> = {
  medication: id(
    "@/app/(app)/medications/MedicationAddWorkspace",
    "MedicationCreateControl"
  ),
  practice: id("@/app/(app)/wellness/AddPracticeButton"),
  "training-activity": id("@/app/(app)/training/AddTrainingActivityButton"),
  protocol: id("@/app/(app)/protocols/ProtocolFormModal"),
  goal: id("@/app/(app)/training/GoalsManager", "GoalCreateControl"),
  routine: id("@/app/(app)/training/RoutinesManager", "RoutineCreateControl"),
  equipment: id("@/components/EquipmentManager", "EquipmentCreateControl"),
  supplement: id("@/components/nutrition/AddSupplementModal"),
};

// Exact host identity keeps unrelated props named `createAction` out.
const CREATE_SLOTS = {
  "@/components/ui#PageHeader": "page",
  "@/components/TabFirstPage#default": "page",
  [`${CREATE_MODULE}#SectionCreateHeader`]: "section",
  "@/components/IntakeContextBar#default": "section",
} as const satisfies Record<string, Housing>;

const identityKey = (identity: Identity) =>
  `${identity.module}#${identity.exported}`;
const CREATE_IDENTITY = id(CREATE_MODULE);
const CONTROL_KINDS = new Map(
  Object.entries(CONTROLS).map(([kind, identity]) => [
    identityKey(identity),
    kind as CreateActionKind,
  ])
);
const BOUNDARY_IDENTITIES = new Set([
  identityKey(CREATE_IDENTITY),
  ...CONTROL_KINDS.keys(),
  ...Object.keys(CREATE_SLOTS),
]);
const BOUNDARY_MODULES = new Set(
  [...BOUNDARY_IDENTITIES].map((identity) =>
    identity.slice(0, identity.lastIndexOf("#"))
  )
);

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(rel);
      } else if (
        /\.[cm]?[jt]sx?$/.test(entry.name) &&
        !/\.d\.[cm]?ts$/.test(entry.name)
      ) {
        out.push(rel);
      }
    }
  };
  walk("app");
  walk("components");
  walk("lib");
  return out.sort();
}

function parse(rel: string, source?: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    source ?? fs.readFileSync(path.join(REPO, rel), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function nodes(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

function normalizeModule(rel: string, raw: string): string {
  const resolved = raw.startsWith(".")
    ? `@/${path.posix.normalize(path.posix.join(path.posix.dirname(rel), raw))}`
    : raw.startsWith("@/")
      ? path.posix.normalize(raw)
      : raw;
  return resolved.replace(/\.[cm]?[jt]sx?$/, "");
}

function fail(rel: string, reason: string): never {
  throw new Error(`${rel}: ${reason}`);
}

function bindings(file: ts.SourceFile, rel: string): Map<string, Identity> {
  const out = new Map<string, Identity>();
  const allNodes = nodes(file);
  for (const node of allNodes) {
    const parent = node.parent;
    const call = parent && ts.isCallExpression(parent) ? parent : undefined;
    const indirectCall =
      call &&
      (call.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(call.expression) &&
          call.expression.text === "require"));
    if (
      ts.isStringLiteralLike(node) &&
      BOUNDARY_MODULES.has(normalizeModule(rel, node.text)) &&
      ((ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isExternalModuleReference(parent) && parent.expression === node) ||
        (indirectCall && call.arguments.includes(node as ts.Expression)))
    )
      fail(rel, "boundary modules require direct static imports");
  }

  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause
    ) {
      const moduleSpecifier = normalizeModule(
        rel,
        statement.moduleSpecifier.text
      );
      const clause = statement.importClause;
      if (clause.name)
        out.set(clause.name.text, {
          module: moduleSpecifier,
          exported: "default",
        });
      const named = clause.namedBindings;
      if (
        named &&
        ts.isNamespaceImport(named) &&
        BOUNDARY_MODULES.has(moduleSpecifier)
      )
        fail(rel, "boundary modules do not accept namespace imports");
      if (named && ts.isNamedImports(named))
        for (const item of named.elements)
          out.set(item.name.text, {
            module: moduleSpecifier,
            exported: (item.propertyName ?? item.name).text,
          });
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const modifiers = ts.getModifiers(statement);
      if (modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword))
        out.set(statement.name.text, {
          module: `@/${rel.replace(/\.[cm]?[jt]sx?$/, "")}`,
          exported: modifiers.some(
            (item) => item.kind === ts.SyntaxKind.DefaultKeyword
          )
            ? "default"
            : statement.name.text,
        });
    }
  }

  for (const node of allNodes) {
    if (!ts.isIdentifier(node)) continue;
    const identity = out.get(node.text);
    if (!identity || !BOUNDARY_IDENTITIES.has(identityKey(identity))) continue;
    const parent = node.parent;
    const directTag =
      (ts.isJsxOpeningElement(parent) ||
        ts.isJsxClosingElement(parent) ||
        ts.isJsxSelfClosingElement(parent)) &&
      parent.tagName === node;
    const declaration =
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node);
    if (!directTag && !declaration && !ts.isTypeQueryNode(parent))
      fail(rel, "boundary components must be used directly as JSX tags");
  }
  return out;
}

function tag(node: ts.Node): string | undefined {
  if (ts.isJsxElement(node)) node = node.openingElement;
  return (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
    ts.isIdentifier(node.tagName)
    ? node.tagName.text
    : undefined;
}

function attributes(node: ts.Node): ts.JsxAttributes | undefined {
  if (ts.isJsxElement(node)) node = node.openingElement;
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
    ? node.attributes
    : undefined;
}

function attr(node: ts.Node, name: string): ts.JsxAttribute | undefined {
  return attributes(node)?.properties.find(
    (item): item is ts.JsxAttribute =>
      ts.isJsxAttribute(item) &&
      ts.isIdentifier(item.name) &&
      item.name.text === name
  );
}

function expressionAttr(
  node: ts.Node,
  name: string
): ts.Expression | undefined {
  const initializer = attr(node, name)?.initializer;
  return initializer &&
    ts.isJsxExpression(initializer) &&
    initializer.expression
    ? initializer.expression
    : undefined;
}

function literalAttr(node: ts.Node, name: string): string | undefined {
  const initializer = attr(node, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer)
    ? initializer.text
    : undefined;
}

function hasSpread(node: ts.Node): boolean {
  return Boolean(attributes(node)?.properties.some(ts.isJsxSpreadAttribute));
}

function same(a: Identity | undefined, b: Identity): boolean {
  return a?.module === b.module && a.exported === b.exported;
}

function slotHousing(identity: Identity | undefined): Housing | undefined {
  return identity
    ? CREATE_SLOTS[identityKey(identity) as keyof typeof CREATE_SLOTS]
    : undefined;
}

function enclosingHousing(
  create: ts.JsxElement,
  bound: Map<string, Identity>
): Housing | undefined {
  const expression = create.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== create)
    return;
  const attribute = expression.parent;
  if (
    !ts.isJsxAttribute(attribute) ||
    !ts.isIdentifier(attribute.name) ||
    attribute.name.text !== "createAction"
  )
    return;
  const hostName = tag(attribute.parent.parent);
  return slotHousing(hostName ? bound.get(hostName) : undefined);
}

type Mount = { kind: CreateActionKind; control: Identity };

function audit(rel: string, source?: string): Mount[] {
  const file = parse(rel, source);
  const bound = bindings(file, rel);
  const mounts: Mount[] = [];

  for (const node of nodes(file)) {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) continue;
    const name = tag(node);
    const identity = name ? bound.get(name) : undefined;
    const hostHousing = slotHousing(identity);

    if (hostHousing) {
      if (hasSpread(node))
        fail(rel, `${name} does not accept spread attributes`);
      const slot = attr(node, "createAction");
      if (slot) {
        const declaration = expressionAttr(node, "createAction");
        const createName =
          declaration && ts.isJsxElement(declaration)
            ? tag(declaration)
            : undefined;
        if (
          !same(createName ? bound.get(createName) : undefined, CREATE_IDENTITY)
        )
          fail(rel, `${name}.createAction must be direct paired CreateAction`);
      }
    }

    if (same(identity, CREATE_IDENTITY)) {
      if (ts.isJsxSelfClosingElement(node))
        fail(rel, "CreateAction must use paired JSX children");
      if (hasSpread(node)) fail(rel, "CreateAction does not accept spreads");
      const kind = literalAttr(node, "kind");
      if (!kind || !Object.hasOwn(CREATE_ACTIONS, kind))
        fail(rel, "CreateAction kind must be a registered literal");
      const action = CREATE_ACTIONS[kind as CreateActionKind];
      if (enclosingHousing(node, bound) !== action.housing)
        fail(rel, "CreateAction must be directly housed with matching housing");
      const children = node.children.filter(
        (child) => ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)
      );
      const childName = children.length === 1 ? tag(children[0]) : undefined;
      const control = childName ? bound.get(childName) : undefined;
      if (!same(control, CONTROLS[kind as CreateActionKind]))
        fail(
          rel,
          "CreateAction must directly own its exact registered control"
        );
      mounts.push({ kind: kind as CreateActionKind, control: control! });
    }

    const controlKind = identity
      ? CONTROL_KINDS.get(identityKey(identity))
      : undefined;
    if (controlKind) {
      const parentName = ts.isJsxElement(node.parent)
        ? tag(node.parent)
        : undefined;
      if (
        !same(parentName ? bound.get(parentName) : undefined, CREATE_IDENTITY)
      )
        fail(
          rel,
          `${controlKind} control must be directly owned by CreateAction`
        );
    }
  }
  return mounts;
}

describe("the create-action boundary", () => {
  it("keeps the label context behind an explicit client boundary", () => {
    const directive = parse("components/CreateAction.tsx").statements[0];
    expect(
      ts.isExpressionStatement(directive) &&
        ts.isStringLiteral(directive.expression) &&
        directive.expression.text
    ).toBe("use client");
  });

  it("houses every semantic with its exact control", () => {
    const mounts = sources().flatMap((rel) => audit(rel));
    expect(new Set(mounts.map((item) => item.kind))).toEqual(
      new Set(Object.keys(CREATE_ACTIONS))
    );
    for (const mount of mounts)
      expect(mount.control).toEqual(CONTROLS[mount.kind]);
  });

  it("rejects shallow identity and housing bypasses", () => {
    const page = (declaration: string, extra = "") =>
      `import C from "@/components/CreateAction"; import {PageHeader} from "@/components/ui"; ${extra}
       export default function X(){return <PageHeader title="X" createAction={${declaration}}/>}`;
    const cases = [
      `import Add from "./AddTrainingActivityButton"; export default function X(){return <Add/>}`,
      `import Add from "./AddTrainingActivityButton"; export default function X(){return <Frame.Action><Add/></Frame.Action>}`,
      `import * as Btn from "./AddTrainingActivityButton.js"; export default function X(){return <Btn.default/>}`,
      `import * as C from "@/components/CreateAction"; export default function X(){return <C.default kind="goal" children={<button/>}/>}`,
      `import * as UI from "@/components/ui"; export default function X(){return <UI.PageHeader title="X" createAction={<button/>}/>}`,
      `import * as C from "@/components/CreateAction.js"; export default function X(){return <C.default kind="goal" children={<button/>}/>}`,
      `import * as UI from "@/components/ui.js"; export default function X(){return <UI.PageHeader title="X" createAction={<button/>}/>}`,
      `import * as UI from "@/components/../components/ui"; export default function X(){return <UI.PageHeader title="X" createAction={<button/>}/>}`,
      `import C,{default as A} from "@/components/CreateAction"; import {PageHeader} from "@/components/ui"; export default function X(){return <PageHeader title="X" createAction={<A kind="training-activity"><button/></A>}/>}`,
      page(`<C kind="training-activity" children={<button/>}/>`),
      `import C from "@/components/CreateAction"; export default function X(){return <C kind="goal" children={<button/>}/>}`,
      `import {PageHeader} from "@/components/ui"; const H=PageHeader; export default function X(){return <H title="X" createAction={<button/>}/>}`,
      `export {PageHeader as H} from "@/components/ui"`,
      `async function x(){return import("@/components/ui")}`,
      `async function x(){return import("@/components/ui",{with:{type:"json"}})}`,
      "async function x(){return import(`@/components/ui`)}",
      `import UI=require("@/components/ui")`,
      `const UI=require("@/components/ui")`,
      "const UI=require(`@/components/ui`)",
      `import C from "@/components/CreateAction"; import Add from "./AddTrainingActivityButton"; export default function X(){return <div><C kind="training-activity"><Add/></C></div>}`,
      page(`<div><button/></div>`),
      page(`<Fake/>`, `function Fake(){return <button/>}`),
      page(
        `<W><C kind="training-activity"><button/></C></W>`,
        `function W({children}:{children:React.ReactNode}){return <>{children}</>}`
      ),
      `import {PageHeader} from "@/components/ui"; const p={createAction:<button/>}; export default function X(){return <PageHeader title="X" {...p}/>}`,
      page(
        `<C kind="training-activity" {...drift}><button/></C>`,
        `const drift={kind:"goal" as const}`
      ),
      page(`<C kind="goal"><button/></C>`),
    ];
    for (const source of cases)
      expect(() => audit("app/(app)/training/hostile.tsx", source)).toThrow();
    expect(() =>
      audit(
        "components/hostile.ts",
        `export {PageHeader as H} from "@/components/ui"`
      )
    ).toThrow();
    expect(() =>
      audit("lib/hostile.js", `export {PageHeader as H} from "@/components/ui"`)
    ).toThrow();
  });
});
