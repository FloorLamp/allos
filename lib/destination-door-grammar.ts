import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

// DESTINATION-DOOR SOURCE-SHAPE REGISTRY (#3502).
//
// This is deliberately not a JavaScript interpreter. The four governed renderers,
// nine mounts, their owner paths, and the trusted slot components are pinned by
// exact token digests. A source-shape change is a review event. The corpus is parsed
// and indexed once, using each file's real syntax mode.

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
  bodyDigest: string;
  supportDigests: Readonly<Record<string, string>>;
}

export interface MountSnapshot extends MountPlan {
  nodeDigest: string;
  ownerDigest: string;
  pathDigest: string;
}

export interface TrustedSlotSnapshot extends TrustedSlotPlan {
  bodyDigest: string;
}

export interface DestinationDoorRegistry {
  descriptorVersion: string;
  typescriptVersion: string;
  renderers: readonly RendererSnapshot[];
  mounts: readonly MountSnapshot[];
  trustedSlots: readonly TrustedSlotSnapshot[];
  nonDoorChevrons: Readonly<Record<string, readonly string[]>>;
  nonDoorReasons: Readonly<Record<string, string>>;
}

const DESCRIPTOR_VERSION = "door-ast-token-v1";

interface ImportRecord {
  kind: "import" | "re-export" | "dynamic-import" | "require";
  moduleName: string;
  imported?: "default" | string;
  local?: string;
  line: number;
}

interface IdentifierReference {
  kind: "jsx" | "other";
  line: number;
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

function staticModuleName(expression: ts.Expression): string | null {
  return ts.isStringLiteralLike(expression) ? expression.text : null;
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
    const key = `${node.getStart(file)}:${detail}`;
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
      if (clause && !clause.isTypeOnly) {
        if (clause.name) {
          imports.push({
            kind: "import",
            moduleName,
            imported: "default",
            local: clause.name.text,
            line: lineOf(file, statement),
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
            });
          }
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push({
        kind: "re-export",
        moduleName: statement.moduleSpecifier.text,
        line: lineOf(file, statement),
      });
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
      const importBinding =
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent);
      const closing = ts.isJsxClosingElement(parent) && parent.tagName === node;
      if (!importBinding && !closing) {
        const jsxReference =
          (ts.isJsxOpeningElement(parent) && parent.tagName === node) ||
          (ts.isJsxSelfClosingElement(parent) && parent.tagName === node);
        addToMap(references, node.text, {
          kind: jsxReference ? "jsx" : "other",
          line: lineOf(file, node),
        });
      }
      if (node.text === "require" && !directRequireReference(node)) {
        loaderFinding(node, "require alias/property/call form is unsupported");
      }
      if (node.text === "createRequire") {
        loaderFinding(node, "createRequire loaders are unsupported");
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "require") {
      loaderFinding(node, "property require loaders are unsupported");
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "require"
    ) {
      loaderFinding(node, "element require loaders are unsupported");
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
  const kinds: number[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isJsxText(current) && current.text.trim() === "") return;
    kinds.push(current.kind);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return digest(
    `${kinds.join(",")}::${tokenStream(node.getText(file), file.languageVariant)}`
  );
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
  return {
    ...plan,
    bodyDigest: nodeDigest(renderer.body, indexed.file),
    supportDigests,
  };
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
  return {
    ...plan,
    nodeDigest: nodeDigest(mount, indexed.file),
    ownerDigest: nodeDigest(owner, indexed.file),
    pathDigest: pathDigest(mount, indexed.file),
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
  return { ...plan, bodyDigest: nodeDigest(component.body, indexed.file) };
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

function chevronSignatures(indexed: IndexedFile): string[] {
  return (indexed.jsx.get("IconChevronRight") ?? [])
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
    compareDigest(
      findings,
      expected.key,
      expected.path,
      "renderer-body",
      expected.bodyDigest,
      received.bodyDigest
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
    const count = indexed.jsx.get("IconChevronRight")?.length ?? 0;
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
    compareDigest(
      findings,
      expected.key,
      expected.path,
      "trusted-slot-body",
      expected.bodyDigest,
      actual.trustedSlots[index].bodyDigest
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
      const iconImport: ImportRequirement = {
        moduleName: "@tabler/icons-react",
        imported: "IconChevronRight",
        local: "IconChevronRight",
      };
      if (!hasRequiredImport(indexed, iconImport)) {
        findings.push(
          makeFinding(
            "non-door:icon-import",
            file,
            "missing canonical IconChevronRight import"
          )
        );
      }
      if ((indexed.declarations.get("IconChevronRight") ?? 0) > 0) {
        findings.push(
          makeFinding(
            "non-door:icon-shadow",
            file,
            "local declaration shadows IconChevronRight"
          )
        );
      }
    }
  }
  return findings;
}
