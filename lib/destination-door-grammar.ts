import ts from "typescript";

// DESTINATION-DOOR GRAMMAR (#3502).
//
// A destination door is the quiet trailing link from an owning surface to the
// registry/history surface that serves it. It is not every link with an arrow:
// record rows, disclosure controls, carousels and pagers use chevrons too. The
// guard in `lib/__tests__/destination-door-grammar.test.ts` registers those
// neighbours explicitly and applies this grammar only to the four renderers
// owner rulings #3253/#3479/#3487 govern.
//
// The source reader fails closed around the facts a person experiences:
// destination, destination label, inline treatment, accessible name, and one
// decorative chevron. The test runs the same reader over planted mutations so a
// green census proves the reader can see each regression it claims to prevent.

export type DoorLabel =
  { kind: "literal"; value: string } | { kind: "expression"; value: string };

export type DoorAccessibleName =
  | { kind: "visible-label" }
  | { kind: "aria-label"; value: string }
  | { kind: "row-content"; value: string };

export interface DestinationDoorContract {
  testId: string;
  destinationExpression: string;
  label: DoorLabel;
  accessibleName: DoorAccessibleName;
  treatment: { owner: "link" | "door"; token: string };
  requiredSourceFragments?: readonly string[];
}

export interface DoorAudit {
  issues: string[];
  line: number | null;
}

function tagName(node: ts.JsxTagNameExpression): string {
  return node.getText();
}

function openingOf(
  node: ts.Node
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return null;
}

function attribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string
): ts.JsxAttribute | null {
  for (const prop of opening.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return null;
}

function attributeValue(attribute: ts.JsxAttribute | null): string | null {
  if (!attribute) return null;
  if (!attribute.initializer) return "true";
  if (ts.isStringLiteral(attribute.initializer))
    return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression
  ) {
    return attribute.initializer.expression.getText();
  }
  return null;
}

function classHasToken(value: string | null, token: string): boolean {
  if (!value) return false;
  return new RegExp(
    `(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`
  ).test(value.replace(/[`}]/g, " "));
}

function elementText(node: ts.Node): string {
  const pieces: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJsxText(child)) pieces.push(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return pieces.join(" ").replace(/\s+/g, " ").trim();
}

function nearestLink(
  node: ts.Node
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      const opening = openingOf(current)!;
      if (tagName(opening.tagName) === "Link") return current;
    }
    current = current.parent;
  }
  return null;
}

function jsxElements(
  node: ts.Node
): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
  const found: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))
      found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function hasCanonicalDefaultImport(
  file: ts.SourceFile,
  module: string,
  local: string
): boolean {
  const imports = file.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === module
  );
  return (
    imports.length === 1 &&
    imports[0].importClause?.isTypeOnly !== true &&
    imports[0].importClause?.name?.text === local
  );
}

function hasCanonicalNamedImport(
  file: ts.SourceFile,
  module: string,
  imported: string
): boolean {
  const imports = file.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === module
  );
  if (imports.length !== 1 || imports[0].importClause?.isTypeOnly) return false;
  const bindings = imports[0].importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.some(
    (element) =>
      !element.isTypeOnly &&
      (element.propertyName?.text ?? element.name.text) === imported &&
      element.name.text === imported
  );
}

function expressionExists(node: ts.Node, expression: string): boolean {
  let found = false;
  const compact = expression.replace(/\s+/g, "");
  const visit = (child: ts.Node): void => {
    if (
      ts.isJsxExpression(child) &&
      child.expression?.getText().replace(/\s+/g, "") === compact
    ) {
      found = true;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Audit one governed renderer. All returned issue strings are stable test keys. */
export function auditDestinationDoorSource(
  source: string,
  contract: DestinationDoorContract
): DoorAudit {
  const file = ts.createSourceFile(
    "destination-door.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const matches: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];

  for (const node of jsxElements(file)) {
    const opening = openingOf(node)!;
    if (attributeValue(attribute(opening, "data-testid")) === contract.testId) {
      matches.push(node);
    }
  }

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
  if (!link) return { issues: ["link-ancestor"], line: null };
  const linkOpening = openingOf(link)!;
  const href = attributeValue(attribute(linkOpening, "href"));
  if (
    href?.replace(/\s+/g, "") !==
    contract.destinationExpression.replace(/\s+/g, "")
  ) {
    issues.push("destination");
  }

  const treatmentOpening =
    contract.treatment.owner === "link" ? linkOpening : doorOpening;
  if (
    !classHasToken(
      attributeValue(attribute(treatmentOpening, "className")),
      contract.treatment.token
    )
  ) {
    issues.push("treatment");
  }

  if (contract.label.kind === "literal") {
    if (
      !elementText(door).split(/\s+/).join(" ").includes(contract.label.value)
    ) {
      issues.push("label");
    }
  } else if (!expressionExists(door, contract.label.value)) {
    issues.push("label");
  }

  if (contract.accessibleName.kind === "aria-label") {
    if (
      attributeValue(attribute(linkOpening, "aria-label"))?.replace(
        /\s+/g,
        ""
      ) !== contract.accessibleName.value.replace(/\s+/g, "")
    ) {
      issues.push("accessible-name");
    }
  } else if (contract.accessibleName.kind === "visible-label") {
    const hidden = attributeValue(attribute(doorOpening, "aria-hidden"));
    if (hidden === "true") issues.push("accessible-name");
  } else if (!expressionExists(link, contract.accessibleName.value)) {
    issues.push("accessible-name");
  }

  const chevrons = jsxElements(door).filter(
    (node) => tagName(openingOf(node)!.tagName) === "IconChevronRight"
  );
  if (chevrons.length !== 1) {
    issues.push(`chevron-count:${chevrons.length}`);
  } else {
    const ariaHidden = attributeValue(
      attribute(openingOf(chevrons[0])!, "aria-hidden")
    );
    if (ariaHidden !== "true") issues.push("chevron-accessibility");
  }

  const doorSource = door.getText(file);
  if (/[›→]/.test(doorSource)) issues.push("retired-arrow-glyph");

  for (const fragment of contract.requiredSourceFragments ?? []) {
    if (!source.includes(fragment)) issues.push(`identity:${fragment}`);
  }

  return {
    issues,
    line: file.getLineAndCharacterOfPosition(door.getStart(file)).line + 1,
  };
}

/** Find actual JSX mounts, not imports, prose mentions, aliases, or strings. */
export function jsxMountLines(source: string, component: string): number[] {
  const file = ts.createSourceFile(
    "destination-door-mount.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  return jsxElements(file)
    .filter((node) => tagName(openingOf(node)!.tagName) === component)
    .map(
      (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    );
}

/**
 * Mounts whose JSX ancestry names their owning surface. This checks placement,
 * not just presence: the same component moved elsewhere in the same file stops
 * satisfying the registry.
 */
export function jsxMountOwnerLines(
  source: string,
  component: string,
  ownerTag: string,
  ownerEvidence: string
): number[] {
  const file = ts.createSourceFile(
    "destination-door-owner.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  return jsxElements(file)
    .filter((node) => tagName(openingOf(node)!.tagName) === component)
    .filter((node) => {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        const opening = openingOf(current);
        if (
          opening &&
          tagName(opening.tagName) === ownerTag &&
          current.getText(file).includes(ownerEvidence)
        ) {
          return true;
        }
        // A mount inside a JSX attribute is parented through the opening tag,
        // rather than through the enclosing JsxElement.
        if (
          ts.isJsxOpeningElement(current) &&
          tagName(current.tagName) === ownerTag &&
          current.getText(file).includes(ownerEvidence)
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    })
    .map(
      (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    );
}

/** Every real IconChevronRight JSX use in a source. */
export function chevronLines(source: string): number[] {
  return jsxMountLines(source, "IconChevronRight");
}
