import ts from "typescript";
import path from "node:path";

export interface RawRenderedUnitExit {
  line: number;
  text: string;
}

const UNIT_PROPERTY =
  /^(?:bio(?:marker)?Unit|correctedUnit|latest_unit|statedUnit|unit|vitaminDUnit)$/i;
const UNIT_IDENTIFIER = /^(?:units?|chartUnit|otherUnits)$/;
const LAB_UNIT_IDENTIFIER = /^(?:bioUnit)$/i;
const LAB_CONTEXT_IDENTIFIER =
  /(?:BioAgeEffect|Biomarker|Bio(?:Option|Target|Unit)|CensoredInput|Clinical|Immun|ImportResult|Lab(?:Observation|Reading|Result|Value)|Medical|OutcomeComparison|ReadingReference|ReferenceCell|ReferenceHint|RevisionSummary|SunExposure|Titer)/i;
const LAB_EXPRESSION_IDENTIFIER =
  /^(?:bioOption|bioTarget|bioUnit|referenceHint|shownBioUnit)$/i;
const LAB_CONTEXT_PATH =
  /(?:^|\/)(?:import|immunizations?|longevity|protocols?|results)(?:\/|$)|(?:^|\/)(?:ImportClient|ImmunizationsSection|UnitMislabelReview)\.tsx$|(?:^|\/)lib\/(?:biomarker-(?:goal|trajectory)|followup-labs|import-diff|queries\/search|reading-reference-cell|trends-series)\.ts$/i;
const USER_TEXT_ATTRIBUTES = new Set(["aria-label", "placeholder", "title"]);
const COPY_FIELD = /^(?:description|detail|hint|label|subtitle|text|title)$/i;
const COPY_PRODUCER =
  /(?:Copy|Description|Hint|Label|Note|Phrase|Subtitle|Suffix|Summary|Text)$/i;
const PRECOMPOSED_LAB_COPY_PRODUCER =
  /(?:BioAgeEffect|Biomarker|CensoredInput|ClinicalResult|LabValue|ReferenceCell|ReferenceHint|Revision|SunExposure|Trajectory|unitSuffix)/i;
const POSSIBLE_UNIT_EXIT =
  /(?:\.\s*(?:bio(?:marker)?Unit|correctedUnit|latest_unit|statedUnit|unit|vitaminDUnit)\b|\[\s*["'](?:bio(?:marker)?Unit|correctedUnit|latest_unit|statedUnit|unit|vitaminDUnit)["']\s*\]|\b(?:bio(?:marker)?Unit|chartUnit|correctedUnit|otherUnits|statedUnit|units?|vitaminDUnit)\b)/i;

function displayUnitModule(moduleName: string, fileName: string): boolean {
  if (moduleName === "@/lib/display-unit") return true;
  if (!moduleName.startsWith(".")) return false;
  const normalizedFile = fileName.replaceAll("\\", "/");
  const rootMatch = /^(.*)\/(?:app|components|lib)\//.exec(normalizedFile);
  if (!rootMatch) return false;
  const resolved = path.posix.resolve(
    "/",
    path.posix.dirname(normalizedFile),
    moduleName
  );
  return resolved === `${rootMatch[1]}/lib/display-unit`;
}

function importedDisplayUnitBindings(
  sourceFile: ts.SourceFile,
  fileName: string
): Set<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !displayUnitModule(statement.moduleSpecifier.text, fileName) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === "displayUnit") {
        bindings.add(element.name.text);
      }
    }
  }

  // Be conservative about shadowing. A formatter import cannot protect an exit
  // if any local declaration reuses its binding name; requiring an alias in that
  // unusual case is preferable to licensing an identity function by spelling.
  function removeShadowedBinding(node: ts.Node) {
    if (
      ts.isIdentifier(node) &&
      bindings.has(node.text) &&
      ((ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
        (ts.isParameter(node.parent) && node.parent.name === node) ||
        (ts.isBindingElement(node.parent) && node.parent.name === node) ||
        ((ts.isFunctionDeclaration(node.parent) ||
          ts.isFunctionExpression(node.parent) ||
          ts.isClassDeclaration(node.parent) ||
          ts.isClassExpression(node.parent) ||
          ts.isMethodDeclaration(node.parent)) &&
          node.parent.name === node))
    ) {
      bindings.delete(node.text);
    }
    ts.forEachChild(node, removeShadowedBinding);
  }
  removeShadowedBinding(sourceFile);
  return bindings;
}

function isDisplayUnitCall(
  node: ts.Node,
  trustedBindings: Set<string>
): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    trustedBindings.has(node.expression.text)
  );
}

function renderedExpression(node: ts.JsxExpression): ts.Expression | null {
  if (!node.expression) return null;
  if (!ts.isJsxAttribute(node.parent)) return node.expression;
  const name = node.parent.name.getText();
  return USER_TEXT_ATTRIBUTES.has(name) ? node.expression : null;
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText();
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function subtreeNamesLabDomain(node: ts.Node): boolean {
  let found = false;
  function visit(current: ts.Node) {
    if (found) return;
    if (
      ts.isIdentifier(current) &&
      LAB_EXPRESSION_IDENTIFIER.test(current.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function subtreeNamesBiomarkerKind(node: ts.Node): boolean {
  let found = false;
  function visit(current: ts.Node) {
    if (found) return;
    if (
      (ts.isStringLiteral(current) ||
        ts.isNoSubstitutionTemplateLiteral(current)) &&
      current.text === "biomarker"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isWithinBiomarkerBranch(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const parent: ts.Node | undefined = current.parent;
    if (
      parent &&
      ts.isIfStatement(parent) &&
      current === parent.thenStatement &&
      subtreeNamesBiomarkerKind(parent.expression)
    ) {
      return true;
    }
    if (
      parent &&
      ts.isConditionalExpression(parent) &&
      current === parent.whenTrue &&
      subtreeNamesBiomarkerKind(parent.condition)
    ) {
      return true;
    }
    if (
      ts.isCaseClause(current) &&
      subtreeNamesBiomarkerKind(current.expression)
    ) {
      return true;
    }
  }
  return false;
}

function isLabDisplayContext(node: ts.Node, fileName: string): boolean {
  if (LAB_CONTEXT_PATH.test(fileName.replaceAll("\\", "/"))) return true;
  if (subtreeNamesLabDomain(node)) return true;
  if (isWithinBiomarkerBranch(node)) return true;
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const name = declarationName(current);
    if (name && LAB_CONTEXT_IDENTIFIER.test(name)) return true;
  }
  return false;
}

function isLabCopyProducer(node: ts.Node, fileName: string): boolean {
  if (!isLabDisplayContext(node, fileName)) return false;
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const name = declarationName(current);
    if (name && COPY_PRODUCER.test(name)) return true;
  }
  return false;
}

function isPrecomposedLabCopyProducer(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const name = declarationName(current);
    if (name && PRECOMPOSED_LAB_COPY_PRODUCER.test(name)) return true;
  }
  return false;
}

function isDirectDisplayProducer(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const name = declarationName(current);
    if (
      name &&
      /^(?:buildBiomarkerSeries|buildSavedClinicalResultTile|decideSunExposure|outOfWindowText|recordRow|referenceCell|UnitMislabelReview)$/i.test(
        name
      )
    )
      return true;
  }
  return false;
}

function isTrendDisplayProducer(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const name = declarationName(current);
    if (
      name &&
      /^(?:buildBiomarkerSeries|buildSavedClinicalResultTile|outOfWindowText)$/i.test(
        name
      )
    )
      return true;
  }
  return false;
}

/**
 * Find a stored `.unit`/`.latest_unit` read at a lab-copy boundary.
 *
 * This is intentionally syntax-aware: comments, local same-named functions, and
 * formatter calls elsewhere cannot license a raw exit. JSX text is scanned where
 * it renders; user-copy return values and object fields are scanned where a lab
 * helper composes them. Plain data passed between components remains raw until
 * the receiving display boundary.
 */
export function rawRenderedUnitExits(
  source: string,
  fileName = "candidate.tsx"
): RawRenderedUnitExit[] {
  // The repository census calls this for every app/component/lib source. Most
  // files cannot contain a unit exit; reject those before TypeScript builds an
  // AST. The prefilter is deliberately broader than the classifier below and is
  // mutation-tested by every hostile spelling in the suite.
  if (!POSSIBLE_UNIT_EXIT.test(source)) return [];
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const out: RawRenderedUnitExit[] = [];
  const seen = new Set<number>();
  const trustedBindings = importedDisplayUnitBindings(sourceFile, fileName);

  function rawAlias(identifier: ts.Identifier) {
    return (
      UNIT_IDENTIFIER.test(identifier.text) ||
      LAB_UNIT_IDENTIFIER.test(identifier.text)
    );
  }

  function inspect(expression: ts.Expression) {
    function visit(node: ts.Node, protectedByFormatter: boolean) {
      // Nested JSX owns its own expression containers. Walking into it here
      // would mistake conditions and component props for rendered text, then
      // report the same actual child again when the outer walker reaches it.
      if (
        ts.isJsxElement(node) ||
        ts.isJsxSelfClosingElement(node) ||
        ts.isJsxFragment(node)
      )
        return;
      const protectedHere =
        protectedByFormatter || isDisplayUnitCall(node, trustedBindings);
      if (ts.isConditionalExpression(node)) {
        visit(node.whenTrue, protectedHere);
        visit(node.whenFalse, protectedHere);
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        visit(node.right, protectedHere);
        return;
      }
      if (
        !protectedHere &&
        ts.isPropertyAccessExpression(node) &&
        UNIT_PROPERTY.test(node.name.text)
      ) {
        const start = node.getStart(sourceFile);
        if (seen.has(start)) return;
        seen.add(start);
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        out.push({ line, text: node.getText(sourceFile) });
        return;
      }
      if (
        !protectedHere &&
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        UNIT_PROPERTY.test(node.argumentExpression.text)
      ) {
        const start = node.getStart(sourceFile);
        if (seen.has(start)) return;
        seen.add(start);
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        out.push({ line, text: node.getText(sourceFile) });
        return;
      }
      if (
        !protectedHere &&
        ts.isIdentifier(node) &&
        rawAlias(node) &&
        // The property/element cases above own their key; declarations are not
        // rendered reads even when a JSX expression happens to contain a callback.
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        ) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      ) {
        const start = node.getStart(sourceFile);
        if (seen.has(start)) return;
        seen.add(start);
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        out.push({ line, text: node.getText(sourceFile) });
        return;
      }
      ts.forEachChild(node, (child) => visit(child, protectedHere));
    }
    visit(expression, false);
  }

  function walk(node: ts.Node) {
    if (ts.isJsxExpression(node)) {
      const expression = renderedExpression(node);
      if (expression && isLabDisplayContext(node, fileName)) {
        inspect(expression);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      COPY_FIELD.test(node.name.getText(sourceFile).replace(/["']/g, "")) &&
      isLabDisplayContext(node, fileName)
    ) {
      inspect(node.initializer);
    }
    if (
      ts.isPropertyAssignment(node) &&
      UNIT_PROPERTY.test(node.name.getText(sourceFile).replace(/["']/g, "")) &&
      isTrendDisplayProducer(node)
    ) {
      inspect(node.initializer);
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      isLabCopyProducer(node, fileName)
    ) {
      inspect(node.expression);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ((isLabCopyProducer(node, fileName) &&
        (isWithinBiomarkerBranch(node) ||
          isPrecomposedLabCopyProducer(node))) ||
        (ts.isIdentifier(node.name) &&
          /^(?:correctedUnit|shownUnit|shownVitaminDUnit|statedUnit|suffix)$/.test(
            node.name.text
          ) &&
          isDirectDisplayProducer(node)))
    ) {
      inspect(node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ((ts.isIdentifier(node.expression) &&
        COPY_PRODUCER.test(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          COPY_PRODUCER.test(node.expression.name.text))) &&
      isWithinBiomarkerBranch(node)
    ) {
      for (const argument of node.arguments) {
        inspect(argument);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "toast" &&
      isLabDisplayContext(node, fileName)
    ) {
      for (const argument of node.arguments) {
        inspect(argument);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sourceFile);
  return out;
}
