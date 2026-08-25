import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

// DESTINATION-DOOR SOURCE-SHAPE REGISTRY (#3502).
//
// This is deliberately not a JavaScript interpreter. The four governed renderers,
// nine mounts, their owner paths, every runtime top-level statement in each
// governed module, and the local modules behind claimed external bindings are
// pinned by exact token digests. A source-shape change is a review event. The
// corpus is parsed and indexed once, using each file's real syntax mode.

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

export interface DoorSource {
  path: string;
  source: string;
}

export interface DoorFinding {
  key: string;
  path: string;
  line: number | null;
  detail: string;
}

export interface ImportRequirement {
  moduleName: string;
  imported: "default" | string;
  local: string;
}

export type OwnerSelector =
  | { kind: "jsx-attribute"; tag: string; attribute: string }
  | {
      kind: "ancestor-attribute";
      tag: string;
      attribute: string;
      value: string;
    }
  | {
      kind: "ancestor-heading";
      tag: string;
      headingTag: string;
      text: string;
    }
  | { kind: "logical-and"; expression: string };

export interface RendererPlan {
  key: string;
  path: string;
  name: string;
  imports: readonly ImportRequirement[];
  chevronCount: number;
  supportNames?: readonly string[];
}

export interface MountPlan {
  key: string;
  path: string;
  identity:
    | { kind: "component"; name: string; modulePath: string }
    | { kind: "test-id"; value: string };
  occurrence: number;
  owner: OwnerSelector;
  ownerImport?: ImportRequirement;
}

export interface TrustedSlotPlan {
  key: string;
  path: string;
  name: string;
  exportKind: "default" | "named";
}

export interface DestinationDoorPlan {
  renderers: readonly RendererPlan[];
  mounts: readonly MountPlan[];
  trustedSlots: readonly TrustedSlotPlan[];
  nonDoorReasons: Readonly<Record<string, string>>;
}

export interface RendererSnapshot extends RendererPlan {
  declarationDigest: string;
  declarationTrace: readonly string[];
  declarationSpan?: string;
  supportDigests: Readonly<Record<string, string>>;
}

export interface MountSnapshot extends MountPlan {
  nodeDigest: string;
  ownerDigest: string;
  pathDigest: string;
  declarationDigest: string;
  declarationTrace: readonly string[];
  declarationSpan?: string;
}

export interface TrustedSlotSnapshot extends TrustedSlotPlan {
  declarationDigest: string;
  declarationTrace: readonly string[];
  declarationSpan?: string;
}

export interface ExternalModuleSnapshot {
  key: string;
  path: string;
  moduleDigest: string;
  moduleTrace: readonly string[];
}

export interface DestinationDoorRegistry {
  descriptorVersion: string;
  typescriptVersion: string;
  renderers: readonly RendererSnapshot[];
  mounts: readonly MountSnapshot[];
  trustedSlots: readonly TrustedSlotSnapshot[];
  externalModules: readonly ExternalModuleSnapshot[];
  nonDoorChevrons: Readonly<Record<string, readonly string[]>>;
  nonDoorReasons: Readonly<Record<string, string>>;
}

const DESCRIPTOR_VERSION = "door-ast-token-v3";

interface ImportRecord {
  kind: "import" | "re-export" | "dynamic-import" | "require";
  moduleName: string;
  imported?: "default" | string;
  local?: string;
  line: number;
  binding?: ts.ImportDeclaration;
}

interface IdentifierReference {
  kind: "jsx" | "other";
  line: number;
  node: ts.Identifier;
}

interface IndexedFile {
  path: string;
  file: ts.SourceFile;
  jsx: Map<string, JsxNode[]>;
  imports: ImportRecord[];
  declarations: Map<string, number>;
  references: Map<string, IdentifierReference[]>;
  functions: Map<string, ts.FunctionDeclaration[]>;
  supportNodes: Map<string, ts.Node[]>;
}

function scriptKind(file: string): ts.ScriptKind {
  switch (path.posix.extname(file).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ??
        false)
    : false;
}

function tagName(node: ts.JsxTagNameExpression): string {
  return node.getText();
}

function opening(node: JsxNode): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function attributes(
  node: ts.JsxOpeningLikeElement,
  name: string
): ts.JsxAttribute[] {
  return node.attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name
  );
}

function literalAttribute(
  node: ts.JsxOpeningLikeElement,
  name: string
): string | null {
  const matches = attributes(node, name);
  if (matches.length !== 1) return null;
  const initializer = matches[0].initializer;
  if (!initializer) return "true";
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    ts.isStringLiteralLike(initializer.expression)
  ) {
    return initializer.expression.text;
  }
  return null;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function addToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function importBindingNames(statement: ts.ImportDeclaration): string[] {
  const clause = statement.importClause;
  if (!clause) return [];
  return [
    ...(clause.name ? [clause.name.text] : []),
    ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements.map((element) => element.name.text)
      : []),
    ...(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
      ? [clause.namedBindings.name.text]
      : []),
  ];
}

function statementBindings(statement: ts.Statement, name: string): ts.Node[] {
  if (ts.isImportDeclaration(statement)) {
    return importBindingNames(statement).includes(name) ? [statement] : [];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.filter((declaration) =>
      bindingNames(declaration.name).includes(name)
    );
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return [statement];
  }
  return [];
}

function functionVarBindings(
  fn: ts.SignatureDeclaration,
  name: string
): ts.VariableDeclaration[] {
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    ) {
      matches.push(
        ...node.declarations.filter((declaration) =>
          bindingNames(declaration.name).includes(name)
        )
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return matches;
}

function lexicalBinding(reference: ts.Identifier): ts.Node | null {
  const name = reference.text;
  let current: ts.Node | undefined = reference.parent;
  while (current) {
    const matches: ts.Node[] = [];
    if (ts.isFunctionLike(current)) {
      if (
        current.name &&
        ts.isIdentifier(current.name) &&
        current.name.text === name
      ) {
        matches.push(current.name);
      }
      for (const parameter of current.parameters) {
        if (bindingNames(parameter.name).includes(name))
          matches.push(parameter);
      }
      matches.push(...functionVarBindings(current, name));
    }
    if (ts.isCatchClause(current) && current.variableDeclaration) {
      if (bindingNames(current.variableDeclaration.name).includes(name)) {
        matches.push(current.variableDeclaration);
      }
    }
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isModuleBlock(current)
    ) {
      for (const statement of current.statements) {
        matches.push(...statementBindings(statement, name));
      }
    }
    if (ts.isCaseBlock(current)) {
      for (const clause of current.clauses) {
        for (const statement of clause.statements) {
          matches.push(...statementBindings(statement, name));
        }
      }
    }
    if (
      (ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current)) &&
      current.initializer &&
      ts.isVariableDeclarationList(current.initializer)
    ) {
      matches.push(
        ...current.initializer.declarations.filter((declaration) =>
          bindingNames(declaration.name).includes(name)
        )
      );
    }
    if (matches.length > 0) return matches[0];
    current = current.parent;
  }
  return null;
}

function staticString(
  expression: ts.Expression,
  seen: ReadonlySet<ts.Node> = new Set()
): string | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const binding = lexicalBinding(current);
    if (
      !binding ||
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !ts.isVariableDeclarationList(binding.parent) ||
      (binding.parent.flags & ts.NodeFlags.Const) === 0 ||
      seen.has(binding)
    ) {
      return null;
    }
    return staticString(binding.initializer, new Set([...seen, binding]));
  }
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const expression = staticString(span.expression, seen);
      if (expression == null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(current.left, seen);
    const right = staticString(current.right, seen);
    return left == null || right == null ? null : left + right;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return staticString(current.right, seen);
  }
  return null;
}

function staticModuleName(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression);
  return ts.isStringLiteralLike(current) ? current.text : null;
}

function makeFinding(
  key: string,
  file: string,
  detail: string,
  line: number | null = null
): DoorFinding {
  return { key, path: file, line, detail };
}

function directRequireReference(node: ts.Identifier): boolean {
  return (
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.questionDotToken == null
  );
}

function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ts.isQualifiedName(parent) ||
    ts.isTypeReferenceNode(parent) ||
    ts.isTypeQueryNode(parent) ||
    ts.isLiteralTypeNode(parent)
  );
}

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isStatement(current) && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function loaderReceiver(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return (
      (current.text === "module" || current.text === "globalThis") &&
      lexicalBinding(current) == null
    );
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return loaderReceiver(current.right);
  }
  return false;
}

function indexFile(source: DoorSource): {
  indexed: IndexedFile;
  findings: DoorFinding[];
} {
  const file = ts.createSourceFile(
    source.path,
    source.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(source.path)
  );
  const jsx = new Map<string, JsxNode[]>();
  const imports: ImportRecord[] = [];
  const declarations = new Map<string, number>();
  const references = new Map<string, IdentifierReference[]>();
  const functions = new Map<string, ts.FunctionDeclaration[]>();
  const supportNodes = new Map<string, ts.Node[]>();
  const findings: DoorFinding[] = [];
  const loaderKeys = new Set<string>();
  const loaderFinding = (node: ts.Node, detail: string): void => {
    const key = String(node.getStart(file));
    if (loaderKeys.has(key)) return;
    loaderKeys.add(key);
    findings.push(
      makeFinding("runtime-loader", source.path, detail, lineOf(file, node))
    );
  };

  const parseDiagnostics = (
    file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  for (const diagnostic of parseDiagnostics) {
    const line =
      diagnostic.start == null
        ? null
        : file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    findings.push(
      makeFinding(
        "parse",
        source.path,
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        line
      )
    );
  }

  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const moduleName = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      const emptyNamedBindings =
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length === 0;
      if (emptyNamedBindings) {
        imports.push({
          kind: "import",
          moduleName,
          line: lineOf(file, statement),
          binding: statement,
        });
      }
      if (clause && !clause.isTypeOnly) {
        if (clause.name) {
          imports.push({
            kind: "import",
            moduleName,
            imported: "default",
            local: clause.name.text,
            line: lineOf(file, statement),
            binding: statement,
          });
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            imports.push({
              kind: "import",
              moduleName,
              imported: element.propertyName?.text ?? element.name.text,
              local: element.name.text,
              line: lineOf(file, element),
              binding: statement,
            });
          }
        } else if (
          clause.namedBindings &&
          ts.isNamespaceImport(clause.namedBindings)
        ) {
          imports.push({
            kind: "import",
            moduleName,
            imported: "*",
            local: clause.namedBindings.name.text,
            line: lineOf(file, clause.namedBindings),
            binding: statement,
          });
        }
      }
      if (
        (moduleName === "node:module" || moduleName === "module") &&
        clause &&
        !clause.isTypeOnly
      ) {
        const importsCreateRequire =
          Boolean(clause.name) ||
          Boolean(
            clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
          ) ||
          Boolean(
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.some(
              (element) =>
                !element.isTypeOnly &&
                (element.propertyName?.text ?? element.name.text) ===
                  "createRequire"
            )
          );
        if (importsCreateRequire) {
          loaderFinding(
            statement,
            `runtime ${moduleName} import capable of createRequire is unsupported`
          );
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const moduleName = statement.moduleSpecifier.text;
      const named =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause
          : null;
      const emptyNamed = named?.elements.length === 0;
      const hasRuntimeExport =
        emptyNamed ||
        (!statement.isTypeOnly &&
          !(
            named?.elements.length &&
            named.elements.every((element) => element.isTypeOnly)
          ));
      if (hasRuntimeExport) {
        imports.push({
          kind: "re-export",
          moduleName,
          line: lineOf(file, statement),
        });
      }
      if (
        moduleName === "@tabler/icons-react" &&
        !statement.isTypeOnly &&
        (!named ||
          named.elements.some(
            (element) =>
              !element.isTypeOnly &&
              (element.propertyName?.text ?? element.name.text) ===
                "IconChevronRight"
          ))
      ) {
        findings.push(
          makeFinding(
            "chevron-re-export",
            source.path,
            "re-exporting IconChevronRight from @tabler/icons-react is unsupported",
            lineOf(file, statement)
          )
        );
      }
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      loaderFinding(statement, "import-equals require is unsupported");
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      addToMap(jsx, tagName(opening(node).tagName), node);
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      for (const name of bindingNames(node.name)) {
        declarations.set(name, (declarations.get(name) ?? 0) + 1);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        addToMap(supportNodes, node.name.text, node);
      }
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      declarations.set(
        node.name.text,
        (declarations.get(node.name.text) ?? 0) + 1
      );
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      addToMap(supportNodes, node.name.text, node);
      const exportKind = hasModifier(node, ts.SyntaxKind.DefaultKeyword)
        ? "default"
        : hasModifier(node, ts.SyntaxKind.ExportKeyword)
          ? "named"
          : "local";
      addToMap(functions, `${exportKind}:${node.name.text}`, node);
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const exportSpecifier = ts.isExportSpecifier(parent) ? parent : null;
      const exportDeclaration =
        exportSpecifier && ts.isExportDeclaration(exportSpecifier.parent.parent)
          ? exportSpecifier.parent.parent
          : null;
      const typeOnlyExport =
        Boolean(exportSpecifier?.isTypeOnly) ||
        Boolean(exportDeclaration?.isTypeOnly);
      const importBinding =
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent);
      const closing = ts.isJsxClosingElement(parent) && parent.tagName === node;
      if (
        !importBinding &&
        !closing &&
        !typeOnlyExport &&
        !isInTypePosition(node)
      ) {
        const jsxReference =
          (ts.isJsxOpeningElement(parent) && parent.tagName === node) ||
          (ts.isJsxSelfClosingElement(parent) && parent.tagName === node);
        addToMap(references, node.text, {
          kind: jsxReference ? "jsx" : "other",
          line: lineOf(file, node),
          node,
        });
      }
      if (
        node.text === "require" &&
        !isNamePosition(node) &&
        !isInTypePosition(node) &&
        lexicalBinding(node) == null &&
        !directRequireReference(node)
      ) {
        loaderFinding(node, "require alias/property/call form is unsupported");
      }
      if (
        node.text === "createRequire" &&
        !isNamePosition(node) &&
        !isInTypePosition(node) &&
        lexicalBinding(node) == null
      ) {
        loaderFinding(node, "createRequire loaders are unsupported");
      }
      if (
        node.text === "module" &&
        !isNamePosition(node) &&
        !isInTypePosition(node) &&
        lexicalBinding(node) == null
      ) {
        loaderFinding(node, "CommonJS module loaders are unsupported");
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      !isInTypePosition(node) &&
      node.name.text === "require" &&
      loaderReceiver(node.expression)
    ) {
      loaderFinding(node, "property require loaders are unsupported");
    }
    if (
      ts.isElementAccessExpression(node) &&
      !isInTypePosition(node) &&
      loaderReceiver(node.expression)
    ) {
      const key = node.argumentExpression
        ? staticString(node.argumentExpression)
        : null;
      if (key === "require") {
        loaderFinding(node, "element require loaders are unsupported");
      } else if (key == null) {
        loaderFinding(
          node,
          "computed CommonJS/global loader receiver is unsupported"
        );
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const moduleName =
          node.arguments.length === 1
            ? staticModuleName(node.arguments[0])
            : null;
        if (moduleName == null) {
          loaderFinding(node, "non-literal import() is unsupported");
        } else {
          imports.push({
            kind: "dynamic-import",
            moduleName,
            line: lineOf(file, node),
          });
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        lexicalBinding(node.expression) == null &&
        node.questionDotToken == null
      ) {
        loaderFinding(node, "runtime require() is unsupported");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return {
    indexed: {
      path: source.path,
      file,
      jsx,
      imports,
      declarations,
      references,
      functions,
      supportNodes,
    },
    findings,
  };
}

export class DestinationDoorCorpus {
  readonly files = new Map<string, IndexedFile>();
  readonly candidatesByStem = new Map<string, string[]>();
  readonly findings: readonly DoorFinding[];

  constructor(sources: readonly DoorSource[]) {
    const findings: DoorFinding[] = [];
    for (const source of sources) {
      if (this.files.has(source.path)) {
        findings.push(
          makeFinding("source-duplicate", source.path, "duplicate corpus path")
        );
        continue;
      }
      const result = indexFile(source);
      this.files.set(source.path, result.indexed);
      findings.push(...result.findings);
    }
    for (const file of this.files.keys()) {
      const stem = withoutExtension(file);
      addToMap(this.candidatesByStem, stem, file);
      if (stem.endsWith("/index")) {
        addToMap(this.candidatesByStem, stem.slice(0, -"/index".length), file);
      }
    }
    this.findings = findings;
  }
}

function tokenStream(text: string, language: ts.LanguageVariant): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    language,
    text
  );
  const tokens: string[] = [];
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    tokens.push(`${token}:${JSON.stringify(scanner.getTokenText())}`);
  }
  return tokens.join("|");
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function nodeDigest(node: ts.Node, file: ts.SourceFile): string {
  const descriptor: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isJsxText(current) && current.text.trim() === "") return;
    descriptor.push(String(current.kind));
    if (ts.isJsxText(current)) {
      descriptor.push(`jsx-text:${JSON.stringify(current.text)}`);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return digest(
    `${descriptor.join(",")}::${tokenStream(node.getText(file), file.languageVariant)}`
  );
}

interface StructuralShape {
  digest: string;
  trace: readonly string[];
  span: string;
}

function runtimeTopLevelStatement(statement: ts.Statement): boolean {
  if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return false;
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  ) {
    return false;
  }
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length === 0
    ) {
      return true;
    }
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      return true;
    }
    return Boolean(
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some((element) => !element.isTypeOnly)
    );
  }
  if (ts.isExportDeclaration(statement)) {
    if (
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.length === 0
    ) {
      return true;
    }
    if (statement.isTypeOnly) return false;
    if (!statement.exportClause) return true;
    return !(
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.every((element) => element.isTypeOnly)
    );
  }
  if (ts.isFunctionDeclaration(statement) && !statement.body) {
    return false;
  }
  return true;
}

function nodeSelector(node: ts.Node, file: ts.SourceFile): string {
  if (ts.isImportDeclaration(node)) {
    return `import:${node.moduleSpecifier.getText(file)}`;
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    return `${ts.SyntaxKind[node.kind]}:${node.name.text}`;
  }
  if (ts.isVariableStatement(node)) {
    const names = node.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
    return `VariableStatement:${names.join(",")}`;
  }
  return ts.SyntaxKind[node.kind];
}

function structuralShape(
  indexed: IndexedFile,
  root: ts.Node | null
): StructuralShape {
  const nodes = indexed.file.statements.filter(runtimeTopLevelStatement);
  const trace: string[] = [];
  const selectorCounts = new Map<string, number>();
  for (const node of nodes) {
    const baseSelector = nodeSelector(node, indexed.file);
    const ordinal = (selectorCounts.get(baseSelector) ?? 0) + 1;
    selectorCounts.set(baseSelector, ordinal);
    const selector = `${baseSelector}#${ordinal}`;
    trace.push(`${selector}=${nodeDigest(node, indexed.file)}`);
    if (node === root) {
      node.forEachChild((child) => {
        trace.push(
          `${selector}>${ts.SyntaxKind[child.kind]}=${nodeDigest(child, indexed.file)}`
        );
      });
    }
  }
  const start = root ? lineOf(indexed.file, root) : 1;
  const end = root
    ? indexed.file.getLineAndCharacterOfPosition(root.getEnd()).line + 1
    : indexed.file.getLineAndCharacterOfPosition(indexed.file.getEnd()).line +
      1;
  return { digest: digest(trace.join("|")), trace, span: `${start}-${end}` };
}

function hasRequiredImport(
  file: IndexedFile,
  requirement: ImportRequirement
): boolean {
  return (
    file.imports.filter(
      (record) =>
        record.kind === "import" &&
        record.moduleName === requirement.moduleName &&
        record.imported === requirement.imported &&
        record.local === requirement.local
    ).length === 1
  );
}

function exportedFunction(
  file: IndexedFile,
  name: string,
  exportKind: "default" | "named"
): ts.FunctionDeclaration | null {
  const matches = file.functions.get(`${exportKind}:${name}`) ?? [];
  return matches.length === 1 && matches[0].body ? matches[0] : null;
}

function directHeading(
  owner: ts.JsxElement,
  headingTag: string,
  text: string
): boolean {
  return owner.children.some((child) => {
    if (
      !ts.isJsxElement(child) ||
      tagName(child.openingElement.tagName) !== headingTag
    ) {
      return false;
    }
    const visible = child.children
      .filter(ts.isJsxText)
      .map((entry) => entry.text.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return visible.length === 1 && visible[0] === text;
  });
}

function findOwner(
  mount: JsxNode,
  selector: OwnerSelector,
  file: ts.SourceFile
): ts.Node | null {
  let current: ts.Node | undefined = mount.parent;
  while (current) {
    if (selector.kind === "jsx-attribute" && ts.isJsxAttribute(current)) {
      const ownerOpening = current.parent.parent;
      if (
        current.name.getText(file) === selector.attribute &&
        (ts.isJsxOpeningElement(ownerOpening) ||
          ts.isJsxSelfClosingElement(ownerOpening)) &&
        tagName(ownerOpening.tagName) === selector.tag
      ) {
        return ownerOpening;
      }
    }
    if (
      selector.kind === "ancestor-attribute" &&
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current))
    ) {
      const ownerOpening = opening(current);
      if (
        tagName(ownerOpening.tagName) === selector.tag &&
        literalAttribute(ownerOpening, selector.attribute) === selector.value
      ) {
        return current;
      }
    }
    if (
      selector.kind === "ancestor-heading" &&
      ts.isJsxElement(current) &&
      tagName(current.openingElement.tagName) === selector.tag &&
      directHeading(current, selector.headingTag, selector.text)
    ) {
      return current;
    }
    if (
      selector.kind === "logical-and" &&
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      tokenStream(current.left.getText(file), file.languageVariant) ===
        tokenStream(selector.expression, file.languageVariant)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function pathDigest(mount: JsxNode, file: ts.SourceFile): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = mount.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      parts.push(`jsx:${nodeDigest(current.openingElement, file)}`);
    } else if (ts.isJsxSelfClosingElement(current)) {
      parts.push(`jsx:${nodeDigest(current, file)}`);
    } else if (ts.isJsxAttribute(current)) {
      parts.push(`attribute:${current.name.getText(file)}`);
    } else if (ts.isBinaryExpression(current)) {
      parts.push(
        `binary:${current.operatorToken.kind}:${nodeDigest(current.left, file)}`
      );
    } else if (ts.isConditionalExpression(current)) {
      parts.push(`conditional:${nodeDigest(current.condition, file)}`);
    } else if (ts.isIfStatement(current)) {
      parts.push(`if:${nodeDigest(current.expression, file)}`);
    } else if (ts.isCallExpression(current)) {
      parts.push(`call:${nodeDigest(current.expression, file)}`);
    } else if (ts.isFunctionDeclaration(current)) {
      parts.push(`function:${current.name?.text ?? "<anonymous>"}`);
      break;
    } else if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      parts.push(`callback:${nodeDigest(current, file)}`);
    }
    current = current.parent;
  }
  return digest(parts.join("|"));
}

function mountCandidates(file: IndexedFile, plan: MountPlan): JsxNode[] {
  if (plan.identity.kind === "component") {
    return file.jsx.get(plan.identity.name) ?? [];
  }
  const found: JsxNode[] = [];
  for (const nodes of file.jsx.values()) {
    for (const node of nodes) {
      if (
        literalAttribute(opening(node), "data-testid") === plan.identity.value
      ) {
        found.push(node);
      }
    }
  }
  return found.sort((a, b) => a.getStart(file.file) - b.getStart(file.file));
}

function captureRenderer(
  corpus: DestinationDoorCorpus,
  plan: RendererPlan
): RendererSnapshot {
  const indexed = corpus.files.get(plan.path);
  if (!indexed) throw new Error(`${plan.key}: missing ${plan.path}`);
  const renderer = exportedFunction(indexed, plan.name, "default");
  if (!renderer?.body) {
    throw new Error(`${plan.key}: missing default renderer ${plan.name}`);
  }
  const supportDigests: Record<string, string> = {};
  for (const name of plan.supportNames ?? []) {
    const nodes = indexed.supportNodes.get(name) ?? [];
    if (nodes.length !== 1) {
      throw new Error(`${plan.key}: expected one support node ${name}`);
    }
    supportDigests[name] = nodeDigest(nodes[0], indexed.file);
  }
  const shape = structuralShape(indexed, renderer);
  return {
    ...plan,
    declarationDigest: shape.digest,
    declarationTrace: shape.trace,
    declarationSpan: shape.span,
    supportDigests,
  };
}

function enclosingTopLevelDeclaration(
  node: ts.Node,
  file: ts.SourceFile
): ts.Node | null {
  let current: ts.Node | undefined = node;
  while (current.parent && current.parent !== file) current = current.parent;
  return current.parent === file ? current : null;
}

function captureMount(
  corpus: DestinationDoorCorpus,
  plan: MountPlan
): MountSnapshot {
  const indexed = corpus.files.get(plan.path);
  if (!indexed) throw new Error(`${plan.key}: missing ${plan.path}`);
  const mount = mountCandidates(indexed, plan)[plan.occurrence];
  if (!mount) {
    throw new Error(
      `${plan.key}: missing occurrence ${plan.occurrence} in ${plan.path}`
    );
  }
  const owner = findOwner(mount, plan.owner, indexed.file);
  if (!owner) throw new Error(`${plan.key}: owner not found in ${plan.path}`);
  const declaration = enclosingTopLevelDeclaration(mount, indexed.file);
  if (!declaration) {
    throw new Error(
      `${plan.key}: enclosing declaration not found in ${plan.path}`
    );
  }
  const declarationShape = structuralShape(indexed, declaration);
  return {
    ...plan,
    nodeDigest: nodeDigest(mount, indexed.file),
    ownerDigest: nodeDigest(owner, indexed.file),
    pathDigest: pathDigest(mount, indexed.file),
    declarationDigest: declarationShape.digest,
    declarationTrace: declarationShape.trace,
    declarationSpan: declarationShape.span,
  };
}

function captureTrustedSlot(
  corpus: DestinationDoorCorpus,
  plan: TrustedSlotPlan
): TrustedSlotSnapshot {
  const indexed = corpus.files.get(plan.path);
  if (!indexed) throw new Error(`${plan.key}: missing ${plan.path}`);
  const component = exportedFunction(indexed, plan.name, plan.exportKind);
  if (!component?.body) {
    throw new Error(`${plan.key}: missing trusted slot ${plan.name}`);
  }
  const shape = structuralShape(indexed, component);
  return {
    ...plan,
    declarationDigest: shape.digest,
    declarationTrace: shape.trace,
    declarationSpan: shape.span,
  };
}

function nearestFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function chevronNodes(indexed: IndexedFile): JsxNode[] {
  const localNames = new Set(
    indexed.imports
      .filter(
        (record) =>
          record.kind === "import" &&
          record.moduleName === "@tabler/icons-react" &&
          record.imported === "IconChevronRight" &&
          record.local
      )
      .map((record) => record.local!)
  );
  return [...indexed.jsx]
    .filter(
      ([name]) => localNames.has(name) || name.endsWith(".IconChevronRight")
    )
    .flatMap(([, nodes]) => nodes)
    .sort(
      (left, right) =>
        left.getStart(indexed.file) - right.getStart(indexed.file)
    );
}

function chevronSignatures(indexed: IndexedFile): string[] {
  return chevronNodes(indexed)
    .map((icon) => {
      const scope = nearestFunction(icon);
      const scopeName =
        scope && "name" in scope && scope.name && ts.isIdentifier(scope.name)
          ? scope.name.text
          : "<callback>";
      const scopeDigest = scope?.body
        ? nodeDigest(scope.body, indexed.file)
        : nodeDigest(indexed.file, indexed.file);
      return `icon:${nodeDigest(icon, indexed.file)}|scope:${scopeName}:${scopeDigest}`;
    })
    .sort();
}

function claimedExternalPaths(
  corpus: DestinationDoorCorpus,
  plan: DestinationDoorPlan
): string[] {
  const governed = new Set([
    ...plan.renderers.map((entry) => entry.path),
    ...plan.mounts.map((entry) => entry.path),
    ...plan.trustedSlots.map((entry) => entry.path),
  ]);
  const claims: { from: string; requirement: ImportRequirement }[] = [
    ...plan.renderers.flatMap((entry) =>
      entry.imports.map((requirement) => ({ from: entry.path, requirement }))
    ),
    ...plan.mounts.flatMap((entry) =>
      entry.ownerImport
        ? [{ from: entry.path, requirement: entry.ownerImport }]
        : []
    ),
  ];
  const paths = new Set<string>();
  for (const claim of claims) {
    const candidates = moduleCandidates(
      corpus,
      claim.from,
      claim.requirement.moduleName
    );
    if (candidates.length === 1 && !governed.has(candidates[0])) {
      paths.add(candidates[0]);
    }
  }
  return [...paths].sort();
}

function captureExternalModules(
  corpus: DestinationDoorCorpus,
  plan: DestinationDoorPlan
): ExternalModuleSnapshot[] {
  return claimedExternalPaths(corpus, plan).map((file) => {
    const indexed = corpus.files.get(file)!;
    const shape = structuralShape(indexed, null);
    return {
      key: `external:${file}`,
      path: file,
      moduleDigest: shape.digest,
      moduleTrace: shape.trace,
    };
  });
}

export function captureDestinationDoorRegistry(
  corpus: DestinationDoorCorpus,
  plan: DestinationDoorPlan
): DestinationDoorRegistry {
  const rendererPaths = new Set(plan.renderers.map((entry) => entry.path));
  const nonDoorChevrons: Record<string, readonly string[]> = {};
  for (const [file, indexed] of corpus.files) {
    if (rendererPaths.has(file)) continue;
    const signatures = chevronSignatures(indexed);
    if (signatures.length > 0) nonDoorChevrons[file] = signatures;
  }
  return {
    descriptorVersion: DESCRIPTOR_VERSION,
    typescriptVersion: ts.version,
    renderers: plan.renderers.map((entry) => captureRenderer(corpus, entry)),
    mounts: plan.mounts.map((entry) => captureMount(corpus, entry)),
    trustedSlots: plan.trustedSlots.map((entry) =>
      captureTrustedSlot(corpus, entry)
    ),
    externalModules: captureExternalModules(corpus, plan),
    nonDoorChevrons: Object.fromEntries(
      Object.entries(nonDoorChevrons).sort(([a], [b]) => a.localeCompare(b))
    ),
    nonDoorReasons: plan.nonDoorReasons,
  };
}

function withoutExtension(file: string): string {
  return file.replace(/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
}

function resolveModule(from: string, moduleName: string): string | null {
  if (moduleName.startsWith("@/")) {
    return withoutExtension(path.posix.normalize(moduleName.slice(2)));
  }
  if (!moduleName.startsWith(".")) return null;
  return withoutExtension(
    path.posix.normalize(path.posix.join(path.posix.dirname(from), moduleName))
  );
}

function moduleCandidates(
  corpus: DestinationDoorCorpus,
  from: string,
  moduleName: string
): string[] {
  const resolved = resolveModule(from, moduleName);
  if (!resolved) return [];
  return corpus.candidatesByStem.get(resolved) ?? [];
}

function listFingerprint(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}

function compareDigest(
  findings: DoorFinding[],
  key: string,
  file: string,
  label: string,
  expected: string,
  actual: string
): void {
  if (expected !== actual) {
    findings.push(
      makeFinding(
        key,
        file,
        `${label} digest changed: expected ${expected}, received ${actual}`
      )
    );
  }
}

function compareShape(
  findings: DoorFinding[],
  key: string,
  file: string,
  selector: string,
  expectedDigest: string,
  actualDigest: string,
  expectedTrace: readonly string[],
  actualTrace: readonly string[],
  actualSpan: string | undefined
): void {
  if (expectedDigest === actualDigest) return;
  const length = Math.max(expectedTrace.length, actualTrace.length);
  const differences = Array.from({ length }, (_, index) => index).filter(
    (index) => expectedTrace[index] !== actualTrace[index]
  );
  const index =
    differences.find((candidate) =>
      [expectedTrace[candidate], actualTrace[candidate]].some((entry) =>
        entry?.slice(0, entry.indexOf("=")).includes(">")
      )
    ) ??
    differences[0] ??
    0;
  findings.push(
    makeFinding(
      key,
      file,
      `${selector} changed at span ${actualSpan ?? "unknown"}; first structural difference [${index}]: expected ${expectedTrace[index] ?? "<end>"}, received ${actualTrace[index] ?? "<end>"}`
    )
  );
}

export function auditDestinationDoorRegistry(
  corpus: DestinationDoorCorpus,
  registry: DestinationDoorRegistry
): DoorFinding[] {
  const findings = [...corpus.findings];
  if (
    registry.descriptorVersion !== DESCRIPTOR_VERSION ||
    registry.typescriptVersion !== ts.version
  ) {
    findings.push(
      makeFinding(
        "registry-version",
        "<registry>",
        `descriptor/TypeScript version changed: expected ${registry.descriptorVersion}/${registry.typescriptVersion}, received ${DESCRIPTOR_VERSION}/${ts.version}`
      )
    );
  }
  for (const [file, indexed] of corpus.files) {
    for (const iconImport of indexed.imports.filter(
      (record) =>
        record.kind === "import" &&
        record.moduleName === "@tabler/icons-react" &&
        record.imported === "IconChevronRight" &&
        record.local &&
        record.binding
    )) {
      for (const reference of indexed.references.get(iconImport.local!) ?? []) {
        if (
          reference.kind === "other" &&
          lexicalBinding(reference.node) === iconImport.binding
        ) {
          findings.push(
            makeFinding(
              "chevron:value-use",
              file,
              `unsupported non-JSX reference to canonical ${iconImport.local} binding`,
              reference.line
            )
          );
        }
      }
    }
    for (const record of indexed.imports) {
      if (
        (!record.moduleName.startsWith("@/") &&
          !record.moduleName.startsWith(".")) ||
        /\.(?:css|json|svg|png|jpe?g|webp)$/.test(record.moduleName)
      ) {
        continue;
      }
      const candidates = moduleCandidates(corpus, file, record.moduleName);
      if (candidates.length !== 1) {
        findings.push(
          makeFinding(
            "module-resolution",
            file,
            `${record.moduleName} resolves to ${candidates.length} tracked runtime candidates`,
            record.line
          )
        );
      }
    }
  }
  let actual: DestinationDoorRegistry;
  try {
    actual = captureDestinationDoorRegistry(corpus, {
      renderers: registry.renderers,
      mounts: registry.mounts,
      trustedSlots: registry.trustedSlots,
      nonDoorReasons: registry.nonDoorReasons,
    });
  } catch (error) {
    findings.push(
      makeFinding(
        "registry-capture",
        "<registry>",
        error instanceof Error ? error.message : String(error)
      )
    );
    return findings;
  }

  registry.renderers.forEach((expected, index) => {
    const received = actual.renderers[index];
    compareShape(
      findings,
      expected.key,
      expected.path,
      `renderer:${expected.name}`,
      expected.declarationDigest,
      received.declarationDigest,
      expected.declarationTrace,
      received.declarationTrace,
      received.declarationSpan
    );
    for (const name of expected.supportNames ?? []) {
      compareDigest(
        findings,
        expected.key,
        expected.path,
        `support:${name}`,
        expected.supportDigests[name] ?? "<missing>",
        received.supportDigests[name] ?? "<missing>"
      );
    }
    const indexed = corpus.files.get(expected.path)!;
    for (const requirement of expected.imports) {
      if (!hasRequiredImport(indexed, requirement)) {
        findings.push(
          makeFinding(
            expected.key,
            expected.path,
            `missing canonical import ${requirement.local} from ${requirement.moduleName}`
          )
        );
      }
    }
    const count = chevronNodes(indexed).length;
    if (count !== expected.chevronCount) {
      findings.push(
        makeFinding(
          expected.key,
          expected.path,
          `IconChevronRight count changed: expected ${expected.chevronCount}, received ${count}`
        )
      );
    }
  });

  registry.mounts.forEach((expected, index) => {
    const received = actual.mounts[index];
    compareDigest(
      findings,
      expected.key,
      expected.path,
      "mount-node",
      expected.nodeDigest,
      received.nodeDigest
    );
    compareDigest(
      findings,
      expected.key,
      expected.path,
      "owner",
      expected.ownerDigest,
      received.ownerDigest
    );
    compareDigest(
      findings,
      expected.key,
      expected.path,
      "owner-path",
      expected.pathDigest,
      received.pathDigest
    );
    compareShape(
      findings,
      expected.key,
      expected.path,
      "mount-owner-declaration",
      expected.declarationDigest,
      received.declarationDigest,
      expected.declarationTrace,
      received.declarationTrace,
      received.declarationSpan
    );
    if (
      expected.ownerImport &&
      !hasRequiredImport(corpus.files.get(expected.path)!, expected.ownerImport)
    ) {
      findings.push(
        makeFinding(
          expected.key,
          expected.path,
          `missing trusted owner import ${expected.ownerImport.local} from ${expected.ownerImport.moduleName}`
        )
      );
    }
  });

  registry.trustedSlots.forEach((expected, index) => {
    compareShape(
      findings,
      expected.key,
      expected.path,
      `trusted-slot:${expected.name}`,
      expected.declarationDigest,
      actual.trustedSlots[index].declarationDigest,
      expected.declarationTrace,
      actual.trustedSlots[index].declarationTrace,
      actual.trustedSlots[index].declarationSpan
    );
  });

  const expectedExternalKeys = registry.externalModules.map(
    (entry) => entry.key
  );
  const actualExternalKeys = actual.externalModules.map((entry) => entry.key);
  if (
    JSON.stringify(expectedExternalKeys) !== JSON.stringify(actualExternalKeys)
  ) {
    findings.push(
      makeFinding(
        "external-module:key-set",
        "<registry>",
        `claimed external module keys changed: expected ${JSON.stringify(expectedExternalKeys)}, received ${JSON.stringify(actualExternalKeys)}`
      )
    );
  }
  registry.externalModules.forEach((expected) => {
    const received = actual.externalModules.find(
      (entry) => entry.key === expected.key
    );
    if (!received) return;
    compareShape(
      findings,
      expected.key,
      expected.path,
      `external-module:${expected.path}`,
      expected.moduleDigest,
      received.moduleDigest,
      expected.moduleTrace,
      received.moduleTrace,
      "1-end"
    );
  });

  const componentMounts = registry.mounts.filter(
    (
      entry
    ): entry is MountSnapshot & {
      identity: { kind: "component"; name: string; modulePath: string };
    } => entry.identity.kind === "component"
  );
  const components = new Map(
    componentMounts.map((entry) => [entry.identity.name, entry.identity])
  );
  for (const component of components.values()) {
    const expectedByFile = new Map<string, number>();
    for (const mount of componentMounts.filter(
      (entry) => entry.identity.name === component.name
    )) {
      expectedByFile.set(mount.path, (expectedByFile.get(mount.path) ?? 0) + 1);
    }
    const actualByFile = new Map<string, number>();
    const target = withoutExtension(component.modulePath);
    for (const [file, indexed] of corpus.files) {
      const count = indexed.jsx.get(component.name)?.length ?? 0;
      if (count > 0) actualByFile.set(file, count);
      for (const record of indexed.imports) {
        if (resolveModule(file, record.moduleName) !== target) continue;
        if (
          record.kind !== "import" ||
          record.imported !== "default" ||
          record.local !== component.name ||
          !expectedByFile.has(file)
        ) {
          findings.push(
            makeFinding(
              `component:${component.name}`,
              file,
              `unsupported ${record.kind} reference to ${component.modulePath}`,
              record.line
            )
          );
        }
      }
      if (
        expectedByFile.has(file) &&
        (indexed.declarations.get(component.name) ?? 0) > 0
      ) {
        findings.push(
          makeFinding(
            `component:${component.name}`,
            file,
            `local declaration shadows ${component.name}`
          )
        );
      }
      for (const reference of indexed.references.get(component.name) ?? []) {
        if (expectedByFile.has(file) && reference.kind !== "jsx") {
          findings.push(
            makeFinding(
              `component:${component.name}`,
              file,
              `unsupported non-JSX reference to ${component.name}`,
              reference.line
            )
          );
        }
      }
    }
    if (
      listFingerprint(
        [...expectedByFile].map(([file, count]) => `${file}:${count}`)
      ) !==
      listFingerprint(
        [...actualByFile].map(([file, count]) => `${file}:${count}`)
      )
    ) {
      findings.push(
        makeFinding(
          `component:${component.name}`,
          component.modulePath,
          `mount census changed: expected ${JSON.stringify(
            Object.fromEntries(expectedByFile)
          )}, received ${JSON.stringify(Object.fromEntries(actualByFile))}`
        )
      );
    }
    for (const [file] of expectedByFile) {
      const indexed = corpus.files.get(file);
      const count =
        indexed?.imports.filter(
          (record) =>
            record.kind === "import" &&
            resolveModule(file, record.moduleName) === target &&
            record.imported === "default" &&
            record.local === component.name
        ).length ?? 0;
      if (count !== 1) {
        findings.push(
          makeFinding(
            `component:${component.name}`,
            file,
            `expected one canonical default import; received ${count}`
          )
        );
      }
    }
  }

  for (const expected of registry.mounts) {
    if (expected.identity.kind !== "test-id") continue;
    const testId = expected.identity.value;
    let count = 0;
    for (const indexed of corpus.files.values()) {
      for (const nodes of indexed.jsx.values()) {
        count += nodes.filter(
          (node) => literalAttribute(opening(node), "data-testid") === testId
        ).length;
      }
    }
    if (count !== 1) {
      findings.push(
        makeFinding(
          expected.key,
          expected.path,
          `test id ${testId} count changed: expected 1, received ${count}`
        )
      );
    }
  }

  const expectedKeys = Object.keys(registry.nonDoorChevrons).sort();
  const actualKeys = Object.keys(actual.nonDoorChevrons).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    findings.push(
      makeFinding(
        "non-door:key-set",
        "<corpus>",
        `non-door chevron file keys changed: expected ${JSON.stringify(
          expectedKeys
        )}, received ${JSON.stringify(actualKeys)}`
      )
    );
  }
  const expectedReasonKeys = Object.keys(registry.nonDoorReasons).sort();
  const actualReasonKeys = actualKeys.flatMap((file) =>
    (actual.nonDoorChevrons[file] ?? []).map(
      (_, index) => `${file}#${index + 1}`
    )
  );
  if (
    JSON.stringify(expectedReasonKeys) !==
    JSON.stringify(actualReasonKeys.sort())
  ) {
    findings.push(
      makeFinding(
        "non-door:reason-key-set",
        "<corpus>",
        `non-door reason keys changed: expected ${JSON.stringify(
          expectedReasonKeys
        )}, received ${JSON.stringify(actualReasonKeys)}`
      )
    );
  }
  for (const [key, why] of Object.entries(registry.nonDoorReasons)) {
    if (why.trim().length < 6) {
      findings.push(
        makeFinding(
          "non-door:reason",
          key.split("#")[0],
          `missing reason for ${key}`
        )
      );
    }
  }
  for (const file of new Set([...expectedKeys, ...actualKeys])) {
    const expected = registry.nonDoorChevrons[file] ?? [];
    const received = actual.nonDoorChevrons[file] ?? [];
    if (JSON.stringify(expected) !== JSON.stringify(received)) {
      findings.push(
        makeFinding(
          "non-door:signature",
          file,
          `chevron signatures changed: expected ${JSON.stringify(
            expected
          )}, received ${JSON.stringify(received)}`
        )
      );
    }
    const indexed = corpus.files.get(file);
    if (indexed && received.length > 0) {
      const iconImports = indexed.imports.filter(
        (record) =>
          record.kind === "import" &&
          record.moduleName === "@tabler/icons-react" &&
          record.imported === "IconChevronRight" &&
          record.local
      );
      if (iconImports.length !== 1) {
        findings.push(
          makeFinding(
            "non-door:icon-import",
            file,
            `expected one canonical IconChevronRight import; received ${iconImports.length}`
          )
        );
      }
      for (const iconImport of iconImports) {
        if ((indexed.declarations.get(iconImport.local!) ?? 0) > 0) {
          findings.push(
            makeFinding(
              "non-door:icon-shadow",
              file,
              `local declaration shadows ${iconImport.local}`
            )
          );
        }
      }
    }
  }
  return findings;
}
