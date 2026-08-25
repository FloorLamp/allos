import ts from "typescript";

// DESTINATION-DOOR GRAMMAR (#3502).
//
// A destination door is the quiet trailing link from an owning surface to the
// registry/history surface that serves it. It is not every arrow: record rows,
// disclosures, carousels and pagers use chevrons too. The exact whole-tree
// registry in `lib/__tests__/destination-door-grammar.test.ts` classifies those
// neighbours and authenticates every current renderer and mount.
//
// This reader fails closed. A spread, duplicate attribute, dynamic treatment,
// alias/re-export, extra mount or extra chevron is a finding, not a source shape
// silently skipped by an absence assertion.

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

export type DoorLabel =
  { kind: "literal"; value: string } | { kind: "expression"; value: string };

export type DoorAccessibleName =
  | { kind: "visible-label" }
  | { kind: "aria-label"; value: string }
  | { kind: "row-content"; value: string };

export interface ExactBinding {
  name: string;
  expression: string;
}

export interface ExactReturn {
  functionName: string;
  expression: string;
}

export interface DestinationDoorContract {
  testId: string;
  destinationExpression: string;
  destinationBinding?: "module";
  moduleBindings?: readonly { name: string; moduleName: string }[];
  title?: string;
  label: DoorLabel;
  childShape: readonly string[];
  accessibleName: DoorAccessibleName;
  treatment: { owner: "link" | "door"; tokens: readonly string[] };
  decorationHidden?: boolean;
  bindings?: readonly ExactBinding[];
  returns?: readonly ExactReturn[];
}

export interface DoorAudit {
  issues: string[];
  line: number | null;
}

export type DoorOwner =
  | {
      kind: "jsx-attribute";
      ownerTag: string;
      attribute: string;
    }
  | {
      kind: "ancestor-attribute";
      ownerTag: string;
      attribute: string;
      value: string;
    }
  | {
      kind: "ancestor-heading";
      ownerTag: string;
      headingTag: string;
      text: string;
    }
  | { kind: "logical-and"; expression: string };

export interface ModuleReference {
  kind: "import" | "re-export" | "dynamic-import" | "require";
  moduleName: string;
  line: number;
  local?: string;
  canonical?: boolean;
}

export interface ComponentRuntimeReference {
  kind: "jsx" | "non-jsx";
  line: number;
}

export interface ChevronOccurrence {
  line: number;
  ownerTag: string;
  role: string | null;
  label: string | null;
  testId: string | null;
  ariaHidden: string | null;
}

function sourceFile(
  source: string,
  name = "destination-door.tsx"
): ts.SourceFile {
  return ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

function tagName(node: ts.JsxTagNameExpression): string {
  return node.getText();
}

function openingOf(node: ts.Node): Opening | null {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return null;
}

function jsxElements(node: ts.Node): JsxNode[] {
  const found: JsxNode[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      found.push(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function attributes(opening: Opening, name: string): ts.JsxAttribute[] {
  return opening.attributes.properties.filter(
    (prop): prop is ts.JsxAttribute =>
      ts.isJsxAttribute(prop) && prop.name.getText() === name
  );
}

function attribute(opening: Opening, name: string): ts.JsxAttribute | null {
  const found = attributes(opening, name);
  return found.length === 1 ? found[0] : null;
}

function attributeValue(attr: ts.JsxAttribute | null): string | null {
  if (!attr) return null;
  if (!attr.initializer) return "true";
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    if (ts.isStringLiteralLike(attr.initializer.expression)) {
      return attr.initializer.expression.text;
    }
    if (attr.initializer.expression.kind === ts.SyntaxKind.TrueKeyword) {
      return "true";
    }
    if (attr.initializer.expression.kind === ts.SyntaxKind.FalseKeyword) {
      return "false";
    }
    return compact(attr.initializer.expression.getText());
  }
  return null;
}

function staticString(node: ts.Expression | ts.ModuleName): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function exactAttributeIssues(opening: Opening, role: string): string[] {
  const issues: string[] = [];
  if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) {
    issues.push(`${role}-spread-attributes`);
  }
  const counts = new Map<string, number>();
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxAttribute(prop)) continue;
    const name = prop.name.getText();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) issues.push(`${role}-duplicate-attribute:${name}`);
  }
  return issues;
}

function hasStaticClassTokens(
  opening: Opening,
  tokens: readonly string[]
): boolean {
  const attr = attribute(opening, "className");
  if (!attr?.initializer || !ts.isStringLiteral(attr.initializer)) return false;
  const classes = new Set(attr.initializer.text.split(/\s+/).filter(Boolean));
  return tokens.every((token) => classes.has(token));
}

function hiddenClassToken(value: string): boolean {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => /(^|:)(hidden|invisible|collapse)$/.test(token));
}

function visibilityIssues(opening: Opening, role: string): string[] {
  const issues: string[] = [];
  if (role !== "hidden-ancestry" && attribute(opening, "aria-labelledby")) {
    issues.push(`${role}-aria-labelledby`);
  }
  for (const name of ["hidden", "inert"] as const) {
    const attr = attribute(opening, name);
    const value = attributeValue(attr);
    if (attr && value !== "false") issues.push(`${role}-${name}`);
  }
  if (attribute(opening, "style")) issues.push(`${role}-style`);
  const className = attribute(opening, "className");
  if (className) {
    const value = attributeValue(className);
    if (
      (value != null && hiddenClassToken(value)) ||
      /(?:["'`\s:])(hidden|invisible|collapse)(?:["'`\s}]|$)/.test(
        className.getText()
      )
    ) {
      issues.push(`${role}-hidden-class`);
    }
  }
  return issues;
}

function directText(node: JsxNode): string[] {
  if (!ts.isJsxElement(node)) return [];
  return node.children
    .filter(ts.isJsxText)
    .map((child) => child.text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function directExpressions(node: JsxNode): string[] {
  if (!ts.isJsxElement(node)) return [];
  return node.children
    .filter(ts.isJsxExpression)
    .flatMap((child) =>
      child.expression ? [compact(child.expression.getText())] : []
    );
}

function directChildShape(node: JsxNode): string[] {
  if (!ts.isJsxElement(node)) return [];
  return node.children.flatMap((child): string[] => {
    if (ts.isJsxText(child)) {
      const text = child.text.replace(/\s+/g, " ").trim();
      return text ? [`text:${text}`] : [];
    }
    if (ts.isJsxExpression(child)) {
      return child.expression
        ? [`expr:${compact(child.expression.getText())}`]
        : [];
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      return [`tag:${tagName(openingOf(child)!.tagName)}`];
    }
    return [`unsupported:${child.kind}`];
  });
}

function nearestLink(node: ts.Node): JsxNode | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      if (tagName(openingOf(current)!.tagName) === "Link") return current;
    }
    current = current.parent;
  }
  return null;
}

function hiddenJsxAncestorIssues(node: JsxNode): string[] {
  const issues: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      const opening = openingOf(current)!;
      issues.push(...visibilityIssues(opening, "hidden-ancestry"));
      if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) {
        issues.push("hidden-ancestry-spread");
      }
      if (attributes(opening, "aria-hidden").length > 1) {
        issues.push("hidden-ancestry-duplicate");
      }
      const hidden = attribute(opening, "aria-hidden");
      const hiddenValue = attributeValue(hidden);
      if (hiddenValue === "true") {
        issues.push("hidden-ancestry");
      } else if (hidden && hiddenValue !== "false") {
        issues.push("hidden-ancestry-dynamic");
      }
    }
    current = current.parent;
  }
  return issues;
}

function hasCanonicalDefaultImport(
  file: ts.SourceFile,
  moduleName: string,
  local: string
): boolean {
  const imports = file.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName
  );
  return (
    imports.length === 1 &&
    imports[0].importClause?.isTypeOnly !== true &&
    imports[0].importClause?.name?.text === local
  );
}

function declarationNames(file: ts.SourceFile, name: string): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      bindingNames(node.name).includes(name)
    ) {
      found.push(node);
    } else if (ts.isParameter(node) && bindingNames(node.name).includes(name)) {
      found.push(node);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name?.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function hasCanonicalNamedImport(
  file: ts.SourceFile,
  moduleName: string,
  imported: string
): boolean {
  const imports = file.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName
  );
  if (imports.length !== 1 || imports[0].importClause?.isTypeOnly) return false;
  const bindings = imports[0].importClause?.namedBindings;
  return (
    bindings != null &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some(
      (element) =>
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === imported &&
        element.name.text === imported
    )
  );
}

function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function nearestFunctionScope(
  node: ts.Node
): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionScope(current)) return current;
    current = current.parent;
  }
  return null;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function exactBinding(
  scope: ts.FunctionLikeDeclaration | null,
  binding: ExactBinding
): boolean {
  if (!scope || !scope.body || !ts.isBlock(scope.body)) return false;
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      if (bindingNames(node.name).includes(binding.name)) matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope.body);
  const direct = scope.body.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === binding.name
    );
  return (
    matches.length === 1 &&
    direct.length === 1 &&
    direct[0] === matches[0] &&
    direct[0].initializer != null &&
    compact(direct[0].initializer.getText()) === compact(binding.expression)
  );
}

function exactReturn(
  file: ts.SourceFile,
  scope: ts.FunctionLikeDeclaration | null,
  contract: ExactReturn
): boolean {
  const functions = file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === contract.functionName
  );
  if (functions.length !== 1 || !functions[0].body) return false;
  const returns = functions[0].body.statements.filter(ts.isReturnStatement);
  if (!(
    returns.length === 1 &&
    returns[0].expression != null &&
    compact(returns[0].expression.getText()) === compact(contract.expression)
  ))
    return false;

  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === contract.functionName) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return (
    scope != null &&
    references.length === 2 &&
    references.some((reference) => reference === functions[0].name) &&
    references.some(
      (reference) =>
        ts.isCallExpression(reference.parent) &&
        reference.parent.expression === reference &&
        reference.getStart(file) >= scope.getStart(file) &&
        reference.getEnd() <= scope.getEnd()
    )
  );
}

function exactDirectLabel(node: JsxNode, label: DoorLabel): boolean {
  if (label.kind === "literal") {
    const text = directText(node);
    return text.length === 1 && text[0] === label.value;
  }
  const expressions = directExpressions(node);
  return (
    expressions.filter((value) => value === compact(label.value)).length === 1
  );
}

/** Audit one governed renderer. All returned issue strings are stable test keys. */
export function auditDestinationDoorSource(
  source: string,
  contract: DestinationDoorContract
): DoorAudit {
  const file = sourceFile(source);
  const matches = jsxElements(file).filter((node) => {
    const values = attributes(openingOf(node)!, "data-testid").map(
      attributeValue
    );
    return values.includes(contract.testId);
  });
  const issues: string[] = [];

  if (!hasCanonicalDefaultImport(file, "next/link", "Link")) {
    issues.push("link-import");
  }
  if (
    !hasCanonicalNamedImport(file, "@tabler/icons-react", "IconChevronRight")
  ) {
    issues.push("chevron-import");
  }
  if (matches.length !== 1) {
    issues.push(`target-count:${matches.length}`);
    return { issues, line: null };
  }

  const door = matches[0];
  const doorOpening = openingOf(door)!;
  const link = nearestLink(door);
  if (!link) {
    issues.push("link-ancestor");
    return { issues, line: null };
  }
  const linkOpening = openingOf(link)!;
  const scope = nearestFunctionScope(door);

  if (declarationNames(file, "Link").length > 0) issues.push("link-shadow");
  if (declarationNames(file, "IconChevronRight").length > 0) {
    issues.push("chevron-shadow");
  }
  for (const binding of contract.moduleBindings ?? []) {
    if (!hasCanonicalNamedImport(file, binding.moduleName, binding.name)) {
      issues.push(`module-binding:${binding.name}`);
    }
    if (declarationNames(file, binding.name).length > 0) {
      issues.push(`module-binding-shadow:${binding.name}`);
    }
  }

  issues.push(...exactAttributeIssues(linkOpening, "link"));
  if (door !== link) issues.push(...exactAttributeIssues(doorOpening, "door"));
  issues.push(...visibilityIssues(linkOpening, "link"));
  if (door !== link) issues.push(...visibilityIssues(doorOpening, "door"));

  const href = attributeValue(attribute(linkOpening, "href"));
  if (
    href == null ||
    compact(href) !== compact(contract.destinationExpression)
  ) {
    issues.push("destination");
  }
  const destinationRoot =
    contract.destinationExpression.match(/^[A-Za-z_$][\w$]*/)?.[0];
  if (
    contract.destinationBinding === "module" &&
    destinationRoot &&
    scope &&
    declarationNames(scope.getSourceFile(), destinationRoot).some(
      (declaration) =>
        declaration.getStart(file) >= scope.getStart(file) &&
        declaration.getEnd() <= scope.getEnd()
    )
  ) {
    issues.push(`destination-shadow:${destinationRoot}`);
  }
  if (
    contract.title != null &&
    attributeValue(attribute(linkOpening, "title")) !== contract.title
  ) {
    issues.push("title");
  }

  const treatmentOpening =
    contract.treatment.owner === "link" ? linkOpening : doorOpening;
  const treatmentAttribute = attribute(treatmentOpening, "className");
  if (
    treatmentAttribute?.initializer != null &&
    !ts.isStringLiteral(treatmentAttribute.initializer)
  ) {
    issues.push("dynamic-treatment");
  } else if (
    !hasStaticClassTokens(treatmentOpening, contract.treatment.tokens)
  ) {
    issues.push("treatment");
  }

  if (!exactDirectLabel(door, contract.label)) issues.push("label");
  if (
    JSON.stringify(directChildShape(door)) !==
    JSON.stringify(contract.childShape)
  ) {
    issues.push("content-shape");
  }

  const linkAriaLabel = attribute(linkOpening, "aria-label");
  const linkAriaHiddenAttribute = attribute(linkOpening, "aria-hidden");
  const linkAriaHidden = attributeValue(linkAriaHiddenAttribute);
  if (linkAriaHidden === "true") issues.push("hidden-link");
  else if (linkAriaHiddenAttribute && linkAriaHidden !== "false") {
    issues.push("hidden-link-dynamic");
  }
  issues.push(...hiddenJsxAncestorIssues(link));
  if (contract.accessibleName.kind === "aria-label") {
    const ariaValue = attributeValue(linkAriaLabel);
    if (
      ariaValue == null ||
      compact(ariaValue) !== compact(contract.accessibleName.value)
    ) {
      issues.push("accessible-name");
    }
  } else {
    if (linkAriaLabel) issues.push("accessible-name-override");
    if (contract.accessibleName.kind === "row-content") {
      const content = compact(contract.accessibleName.value);
      if (
        directExpressions(link).filter((value) => value === content).length !==
        1
      ) {
        issues.push("accessible-name");
      }
    } else if (
      door !== link &&
      attributeValue(attribute(doorOpening, "aria-hidden")) === "true"
    ) {
      issues.push("hidden-label");
    }
  }

  if (contract.decorationHidden) {
    if (attributeValue(attribute(doorOpening, "aria-hidden")) !== "true") {
      issues.push("decoration-accessibility");
    }
  } else if (
    door !== link &&
    attributeValue(attribute(doorOpening, "aria-hidden")) === "true"
  ) {
    issues.push("hidden-label");
  }

  const chevrons = jsxElements(door).filter(
    (node) => tagName(openingOf(node)!.tagName) === "IconChevronRight"
  );
  if (chevrons.length !== 1) {
    issues.push(`chevron-count:${chevrons.length}`);
  } else {
    const chevronOpening = openingOf(chevrons[0])!;
    issues.push(...exactAttributeIssues(chevronOpening, "chevron"));
    if (attributeValue(attribute(chevronOpening, "aria-hidden")) !== "true") {
      issues.push("chevron-accessibility");
    }
  }

  if (ts.isJsxElement(door)) {
    for (const child of door.children) {
      if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child))
        continue;
      const childOpening = openingOf(child)!;
      const childTag = tagName(childOpening.tagName);
      if (!childTag.startsWith("Icon")) continue;
      issues.push(...exactAttributeIssues(childOpening, `icon:${childTag}`));
      if (attributeValue(attribute(childOpening, "aria-hidden")) !== "true") {
        issues.push(`icon-accessibility:${childTag}`);
      }
    }
  }

  if (/[›→]/.test(door.getText(file))) issues.push("retired-arrow-glyph");

  for (const binding of contract.bindings ?? []) {
    if (!exactBinding(scope, binding)) issues.push(`binding:${binding.name}`);
  }
  for (const requiredReturn of contract.returns ?? []) {
    if (!exactReturn(file, scope, requiredReturn)) {
      issues.push(`return:${requiredReturn.functionName}`);
    }
  }

  return {
    issues,
    line: file.getLineAndCharacterOfPosition(door.getStart(file)).line + 1,
  };
}

/** Find actual JSX mounts, not prose, comments, strings, or import names. */
export function jsxMountLines(source: string, component: string): number[] {
  const file = sourceFile(source, "destination-door-mount.tsx");
  return jsxElements(file)
    .filter((node) => tagName(openingOf(node)!.tagName) === component)
    .map(
      (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    );
}

/** Find exact literal `data-testid` occurrences in rendered JSX. */
export function testIdLines(source: string, testId: string): number[] {
  const file = sourceFile(source, "destination-door-testid.tsx");
  return jsxElements(file)
    .filter((node) =>
      attributes(openingOf(node)!, "data-testid")
        .map(attributeValue)
        .includes(testId)
    )
    .map(
      (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    );
}

function directHeadingMatches(
  owner: ts.JsxElement,
  headingTag: string,
  text: string
): boolean {
  return owner.children.some(
    (child) =>
      ts.isJsxElement(child) &&
      tagName(child.openingElement.tagName) === headingTag &&
      directText(child).length === 1 &&
      directText(child)[0] === text
  );
}

function ownedBy(
  node: JsxNode,
  owner: DoorOwner,
  file: ts.SourceFile
): boolean {
  let current: ts.Node | undefined = node.parent;
  let conditionalPath = false;
  let deadPath = false;
  while (current) {
    if (owner.kind === "jsx-attribute" && ts.isJsxAttribute(current)) {
      const opening = current.parent.parent;
      if (
        current.name.getText() === owner.attribute &&
        (ts.isJsxOpeningElement(opening) ||
          ts.isJsxSelfClosingElement(opening)) &&
        tagName(opening.tagName) === owner.ownerTag &&
        !conditionalPath &&
        opening.attributes.properties.every(ts.isJsxAttribute) &&
        attributes(opening, owner.attribute).length === 1 &&
        current.initializer != null &&
        ts.isJsxExpression(current.initializer) &&
        current.initializer.expression != null &&
        (ts.isJsxElement(current.initializer.expression) ||
          ts.isJsxSelfClosingElement(current.initializer.expression))
      ) {
        return true;
      }
    }
    if (
      owner.kind === "ancestor-attribute" &&
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current))
    ) {
      const opening = openingOf(current)!;
      if (
        tagName(opening.tagName) === owner.ownerTag &&
        !deadPath &&
        opening.attributes.properties.every(ts.isJsxAttribute) &&
        attributes(opening, owner.attribute).length === 1 &&
        attributeValue(attribute(opening, owner.attribute)) === owner.value
      ) {
        return true;
      }
    }
    if (
      owner.kind === "ancestor-heading" &&
      ts.isJsxElement(current) &&
      tagName(current.openingElement.tagName) === owner.ownerTag &&
      !deadPath &&
      directHeadingMatches(current, owner.headingTag, owner.text)
    ) {
      return true;
    }
    if (
      owner.kind === "logical-and" &&
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      compact(current.left.getText(file)) === compact(owner.expression) &&
      !deadPath
    ) {
      return true;
    }
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isCallExpression(current)
    ) {
      conditionalPath = true;
      deadPath = true;
    } else if (ts.isConditionalExpression(current)) {
      conditionalPath = true;
      if (
        (current.condition.kind === ts.SyntaxKind.FalseKeyword &&
          node.getStart(file) >= current.whenTrue.getStart(file) &&
          node.getEnd() <= current.whenTrue.getEnd()) ||
        (current.condition.kind === ts.SyntaxKind.TrueKeyword &&
          node.getStart(file) >= current.whenFalse.getStart(file) &&
          node.getEnd() <= current.whenFalse.getEnd())
      ) {
        deadPath = true;
      }
    } else if (ts.isBinaryExpression(current)) {
      conditionalPath = true;
      if (
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        current.left.kind === ts.SyntaxKind.FalseKeyword
      ) {
        deadPath = true;
      }
    }
    current = current.parent;
  }
  return false;
}

export function jsxMountOwnerLines(
  source: string,
  component: string,
  owner: DoorOwner
): number[] {
  const file = sourceFile(source, "destination-door-owner.tsx");
  return jsxElements(file)
    .filter((node) => tagName(openingOf(node)!.tagName) === component)
    .filter((node) => ownedBy(node, owner, file))
    .map(
      (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    );
}

export function testIdOwnerLines(
  source: string,
  testId: string,
  owner: DoorOwner
): number[] {
  const file = sourceFile(source, "destination-door-testid-owner.tsx");
  return jsxElements(file)
    .filter((node) =>
      attributes(openingOf(node)!, "data-testid")
        .map(attributeValue)
        .includes(testId)
    )
    .filter((node) => ownedBy(node, owner, file))
    .map(
      (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    );
}

/** Every real IconChevronRight JSX use in a source. */
export function chevronLines(source: string): number[] {
  return jsxMountLines(source, "IconChevronRight");
}

/** Structural identity and accessibility of every chevron occurrence. */
export function chevronOccurrences(source: string): ChevronOccurrence[] {
  const file = sourceFile(source, "destination-door-chevron.tsx");
  const parentOpening = (node: ts.Node): Opening | null => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
        return openingOf(current)!;
      }
      current = current.parent;
    }
    return null;
  };
  return jsxElements(file)
    .filter((node) => tagName(openingOf(node)!.tagName) === "IconChevronRight")
    .map((icon) => {
      let owner: JsxNode | null = null;
      let ancestor: ts.Node | undefined = icon.parent;
      let testId: string | null = null;
      let bindingName: string | null = null;
      let functionName: string | null = null;
      while (ancestor) {
        if (ts.isJsxElement(ancestor) || ts.isJsxSelfClosingElement(ancestor)) {
          const opening = openingOf(ancestor)!;
          testId ??= attributeValue(attribute(opening, "data-testid"));
          if (!owner) owner = ancestor;
        }
        if (
          ts.isVariableDeclaration(ancestor) &&
          ts.isIdentifier(ancestor.name)
        ) {
          bindingName ??= ancestor.name.text;
        }
        if (ts.isFunctionDeclaration(ancestor) && ancestor.name) {
          functionName ??= ancestor.name.text;
        }
        ancestor = ancestor.parent;
      }
      const ownerOpening = owner ? openingOf(owner)! : null;
      const indirect: Opening[] = [];
      if (!ownerOpening && bindingName) {
        const visit = (node: ts.Node): void => {
          if (
            ts.isJsxExpression(node) &&
            node.expression != null &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === bindingName
          ) {
            const opening = parentOpening(node);
            if (opening) indirect.push(opening);
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      } else if (!ownerOpening && functionName) {
        for (const mount of jsxElements(file).filter(
          (node) => tagName(openingOf(node)!.tagName) === functionName
        )) {
          const opening = parentOpening(mount);
          if (opening) indirect.push(opening);
        }
      }
      const openings = ownerOpening ? [ownerOpening] : indirect;
      const values = (name: string): string[] =>
        [
          ...new Set(
            openings
              .map((opening) => attributeValue(attribute(opening, name)))
              .filter((value): value is string => value != null)
          ),
        ].sort();
      const tags = [
        ...new Set(openings.map((opening) => tagName(opening.tagName))),
      ].sort();
      const labels = [
        ...new Set([...values("aria-label"), ...values("title")]),
      ];
      testId ??= values("data-testid").join("|") || null;
      const indirectPrefix = bindingName
        ? `binding:${bindingName}→`
        : functionName
          ? `component:${functionName}→`
          : "";
      const fallbackIdentity = ["href", "aria-expanded", "name", "type"]
        .flatMap((name) => {
          const found = values(name);
          return found.length > 0 ? [`${name}:${found.join("|")}`] : [];
        })
        .join(",");
      const ownerIdentity = tags.join("|") || "<none>";
      return {
        line: file.getLineAndCharacterOfPosition(icon.getStart(file)).line + 1,
        ownerTag: ownerOpening
          ? `${tagName(ownerOpening.tagName)}${
              labels.length === 0 && !testId && fallbackIdentity
                ? `[${fallbackIdentity}]`
                : ""
            }`
          : `${indirectPrefix}${ownerIdentity}`,
        role: values("role").join("|") || null,
        label:
          labels.join("|") ||
          (owner && ts.isJsxElement(owner)
            ? directText(owner).join(" ") || null
            : null),
        testId,
        ariaHidden: attributeValue(attribute(openingOf(icon)!, "aria-hidden")),
      };
    });
}

/** Every syntax identifier with this exact spelling (comments/strings excluded). */
export function identifierLines(source: string, identifier: string): number[] {
  const file = sourceFile(source, "destination-door-identifier.tsx");
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === identifier) {
      lines.push(
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/** Runtime references to a canonically imported component binding. */
export function componentRuntimeReferences(
  source: string,
  component: string
): ComponentRuntimeReference[] {
  const file = sourceFile(source, "destination-door-component-reference.tsx");
  const found: ComponentRuntimeReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === component) {
      if (
        (ts.isImportClause(node.parent) && node.parent.name === node) ||
        ts.isImportSpecifier(node.parent)
      ) {
        return;
      }
      const parent = node.parent;
      const jsx =
        (ts.isJsxOpeningElement(parent) && parent.tagName === node) ||
        (ts.isJsxSelfClosingElement(parent) && parent.tagName === node);
      // Closing tags repeat the opening binding without creating another mount.
      if (ts.isJsxClosingElement(parent) && parent.tagName === node) return;
      found.push({
        kind: jsx ? "jsx" : "non-jsx",
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every way one source can reach a governed component module. A re-export,
 * dynamic import, require, or renamed default is deliberately not a mount the
 * census tries to follow: it is a loud unsupported indirection.
 */
export function componentModuleReferences(
  source: string,
  canonicalLocal: string
): ModuleReference[] {
  const file = sourceFile(source, "destination-door-module-reference.tsx");
  const found: ModuleReference[] = [];
  const line = (node: ts.Node) =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleName = staticString(statement.moduleSpecifier);
      if (moduleName == null) continue;
      const clause = statement.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause?.name == null &&
          named != null &&
          ts.isNamedImports(named) &&
          named.elements.every((element) => element.isTypeOnly));
      if (typeOnly) continue;
      const local = statement.importClause?.name?.text;
      found.push({
        kind: "import",
        moduleName,
        line: line(statement),
        local,
        canonical:
          statement.importClause?.isTypeOnly !== true &&
          local === canonicalLocal,
      });
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const moduleName = staticString(statement.moduleSpecifier);
      if (moduleName == null) continue;
      found.push({
        kind: "re-export",
        moduleName,
        line: line(statement),
      });
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const moduleName = staticString(node.arguments[0]);
      if (moduleName == null) {
        ts.forEachChild(node, visit);
        return;
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        found.push({
          kind: "dynamic-import",
          moduleName,
          line: line(node),
        });
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        found.push({
          kind: "require",
          moduleName,
          line: line(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
