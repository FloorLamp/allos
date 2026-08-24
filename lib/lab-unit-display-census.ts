import path from "node:path";
import ts from "typescript";

export interface RawRenderedUnitExit {
  line: number;
  text: string;
}

const UNIT_PROPERTY =
  /^(?:bio(?:marker)?Unit|correctedUnit|latestUnit|latest_unit|statedUnit|unit|vitaminDUnit)$/i;
const UNIT_IDENTIFIER = /^(?:units?|chartUnit|otherUnits)$/;
const LAB_UNIT_IDENTIFIER = /^(?:bioUnit)$/i;
const LAB_CONTEXT_IDENTIFIER =
  /(?:BioAgeEffect|Biomarker|Bio(?:Option|Target|Unit)|CensoredInput|Clinical|Immun|ImportResult|Lab(?:Observation|Reading|Result|Value)|Medical|OutcomeComparison|OutOfWindow|ReadingReference|ReferenceCell|ReferenceHint|RevisionSummary|SunExposure|Titer)/i;
const LAB_EXPRESSION_IDENTIFIER =
  /^(?:bioOption|bioTarget|bioUnit|referenceHint|shownBioUnit)$/i;
const LAB_CONTEXT_PATH =
  /(?:^|\/)(?:import|immunizations?|longevity|protocols?|results)(?:\/|$)|(?:^|\/)(?:ImportClient|ImmunizationsSection|UnitMislabelReview)\.tsx$|(?:^|\/)lib\/(?:biomarker-(?:goal|trajectory)|followup-labs|import-diff|queries\/search|reading-reference-cell)\.ts$/i;
const RAW_UNIT_PARAMETER_PRODUCER =
  /(?:Copy|Description|Hint|Label|Note|Phrase|Subtitle|Suffix|Summary|Text|buildBiomarkerSeries|buildSavedClinicalResultTile|decideSunExposure|recordRow|referenceCell)/i;
const POSSIBLE_UNIT_EXIT =
  /(?:\.\s*(?:bio(?:marker)?Unit|correctedUnit|latestUnit|latest_unit|statedUnit|unit|vitaminDUnit)\b|\[\s*["'](?:bio(?:marker)?Unit|correctedUnit|latestUnit|latest_unit|statedUnit|unit|vitaminDUnit)["']\s*\]|\b(?:bio(?:marker)?Unit|chartUnit|correctedUnit|latestUnit|otherUnits|statedUnit|units?|vitaminDUnit)\b)/i;
const POSSIBLE_LAB_CONTEXT_SOURCE =
  /(?:BioAgeEffect|Biomarker|Bio(?:Option|Target|Unit)|CensoredInput|Clinical|Immun|ImportResult|Lab(?:Observation|Reading|Result|Value)|Medical|OutcomeComparison|OutOfWindow|ReadingReference|ReferenceCell|ReferenceHint|RevisionSummary|SunExposure|Titer|\b(?:bioOption|bioTarget|bioUnit|referenceHint|shownBioUnit)\b|["'`]biomarker["'`])/i;

function displayUnitModule(moduleName: string, fileName: string): boolean {
  if (moduleName === "@/lib/display-unit") return true;
  if (!moduleName.startsWith(".")) return false;
  const normalized = fileName.replaceAll("\\", "/");
  const root = /^(.*)\/(?:app|components|lib)\//.exec(normalized);
  return (
    !!root &&
    path.posix.resolve("/", path.posix.dirname(normalized), moduleName) ===
      `${root[1]}/lib/display-unit`
  );
}

function medicalValueModule(moduleName: string, fileName: string): boolean {
  if (moduleName === "@/components/ui") return true;
  if (!moduleName.startsWith(".")) return false;
  const normalized = fileName.replaceAll("\\", "/");
  const root = /^(.*)\/(?:app|components|lib)\//.exec(normalized);
  return (
    !!root &&
    path.posix.resolve("/", path.posix.dirname(normalized), moduleName) ===
      `${root[1]}/components/ui`
  );
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name
  )
    return node.name.getText();
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
    return node.name.text;
  return null;
}

function subtreeMatches(
  node: ts.Node,
  match: (node: ts.Node) => boolean
): boolean {
  let found = false;
  function visit(current: ts.Node) {
    if (found) return;
    if (match(current)) found = true;
    else ts.forEachChild(current, visit);
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
    const biomarker = (candidate: ts.Node) =>
      subtreeMatches(
        candidate,
        (part) =>
          (ts.isStringLiteral(part) ||
            ts.isNoSubstitutionTemplateLiteral(part)) &&
          part.text === "biomarker"
      );
    if (
      parent &&
      ts.isIfStatement(parent) &&
      current === parent.thenStatement &&
      biomarker(parent.expression)
    )
      return true;
    if (
      parent &&
      ts.isConditionalExpression(parent) &&
      current === parent.whenTrue &&
      biomarker(parent.condition)
    )
      return true;
    if (ts.isCaseClause(current) && biomarker(current.expression)) return true;
  }
  return false;
}

function isLabDisplayContext(node: ts.Node, fileName: string): boolean {
  if (LAB_CONTEXT_PATH.test(fileName.replaceAll("\\", "/"))) return true;
  if (
    subtreeMatches(
      node,
      (part) =>
        ts.isIdentifier(part) && LAB_EXPRESSION_IDENTIFIER.test(part.text)
    ) ||
    isWithinBiomarkerBranch(node)
  )
    return true;
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

interface Binding {
  constString: string | null;
  trustedFormatter: boolean;
  trustedFormatterNamespace: boolean;
  trustedStoredUnit: boolean;
  trustedUnitRenderer: boolean;
  rawUnit: boolean;
}
interface Scope {
  parent: Scope | null;
  bindings: Map<string, Binding>;
}

function propertyName(node: ts.Node | undefined): string | null {
  return node &&
    (ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node))
    ? node.text
    : null;
}

function patternBindings(
  name: ts.BindingName,
  inheritedRaw: boolean,
  add: (identifier: ts.Identifier, raw: boolean) => void,
  nameOf: (node: ts.Node | undefined) => string | null = propertyName
) {
  if (ts.isIdentifier(name)) return add(name, inheritedRaw);
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const key = ts.isObjectBindingPattern(name)
      ? nameOf(element.propertyName ?? element.name)
      : null;
    patternBindings(
      element.name,
      inheritedRaw || (key !== null && UNIT_PROPERTY.test(key)),
      add,
      nameOf
    );
  }
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    ((ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
      parent.name === node)
  )
    return true;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  )
    return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  )
    return true;
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    if (ts.isTypeNode(current)) return true;
    if (
      ts.isExpression(current) ||
      ts.isStatement(current) ||
      ts.isSourceFile(current)
    )
      break;
  }
  return false;
}

function unitPropertyRead(
  node: ts.Node,
  nameOf: (node: ts.Node | undefined) => string | null = propertyName
): boolean {
  return (
    (ts.isPropertyAccessExpression(node) &&
      UNIT_PROPERTY.test(node.name.text)) ||
    (ts.isElementAccessExpression(node) &&
      !!node.argumentExpression &&
      UNIT_PROPERTY.test(nameOf(node.argumentExpression) ?? ""))
  );
}

/**
 * Finds the first boundary crossing of every raw lab-unit read.
 *
 * This deliberately does not execute JavaScript or propagate aliases. In a
 * declared lab-display context a raw unit read must be consumed directly by the
 * canonical formatter. The only exceptions are syntax-local non-display
 * semantics: comparisons/guards, named conversion/import operations, and the
 * authenticated `storedLabUnit` contract for an intentional raw transfer.
 * Arbitrary calls, assignments, spreads, aliases, and callbacks therefore fail
 * at the original read regardless of later execution order.
 */
export function rawRenderedUnitExits(
  source: string,
  fileName = "candidate.tsx"
): RawRenderedUnitExit[] {
  const normalized = fileName.replaceAll("\\", "/");
  if (
    !POSSIBLE_UNIT_EXIT.test(source) ||
    (!LAB_CONTEXT_PATH.test(normalized) &&
      !POSSIBLE_LAB_CONTEXT_SOURCE.test(source))
  )
    return [];
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const sourceScope: Scope = { parent: null, bindings: new Map() };
  const scopeAt = new Map<ts.Node, Scope>();

  function makeScopes(node: ts.Node, incoming: Scope) {
    let scope = incoming;
    if (node !== sourceFile && (ts.isFunctionLike(node) || ts.isBlock(node)))
      scope = { parent: incoming, bindings: new Map() };
    scopeAt.set(node, scope);
    ts.forEachChild(node, (child) => makeScopes(child, scope));
  }
  makeScopes(sourceFile, sourceScope);

  function addBinding(
    scope: Scope,
    identifier: ts.Identifier,
    rawUnit = false,
    trustedFormatter = false,
    trustedFormatterNamespace = false,
    trustedStoredUnit = false,
    trustedUnitRenderer = false,
    constString: string | null = null
  ) {
    scope.bindings.set(identifier.text, {
      constString,
      rawUnit,
      trustedFormatter,
      trustedFormatterNamespace,
      trustedStoredUnit,
      trustedUnitRenderer,
    });
  }
  function resolve(node: ts.Node, name: string): Binding | null {
    for (
      let scope: Scope | null = scopeAt.get(node) ?? sourceScope;
      scope;
      scope = scope.parent
    ) {
      const binding = scope.bindings.get(name);
      if (binding) return binding;
    }
    return null;
  }
  function constantString(node: ts.Node | undefined): string | null {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isIdentifier(node))
      return resolve(node, node.text)?.constString ?? null;
    return null;
  }
  function resolvedPropertyName(node: ts.Node | undefined): string | null {
    if (node && ts.isComputedPropertyName(node))
      return constantString(node.expression);
    if (node && ts.isIdentifier(node))
      return constantString(node) ?? propertyName(node);
    return propertyName(node) ?? constantString(node);
  }
  function collect(node: ts.Node) {
    const scope = scopeAt.get(node) ?? sourceScope;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      displayUnitModule(node.moduleSpecifier.text, fileName) &&
      node.importClause?.namedBindings
    ) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements)
          addBinding(
            scope,
            element.name,
            false,
            (element.propertyName ?? element.name).text === "displayUnit",
            false,
            (element.propertyName ?? element.name).text === "storedLabUnit"
          );
      } else addBinding(scope, bindings.name, false, false, true);
    } else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      medicalValueModule(node.moduleSpecifier.text, fileName) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements)
        addBinding(
          scope,
          element.name,
          false,
          false,
          false,
          false,
          (element.propertyName ?? element.name).text === "MedicalValue"
        );
    } else if (ts.isVariableDeclaration(node)) {
      patternBindings(
        node.name,
        false,
        (id, raw) =>
          addBinding(
            scope,
            id,
            raw,
            false,
            false,
            false,
            false,
            ts.isIdentifier(node.name) &&
              ts.isVariableDeclarationList(node.parent) &&
              (node.parent.flags & ts.NodeFlags.Const) !== 0
              ? constantString(node.initializer)
              : null
          ),
        resolvedPropertyName
      );
    } else if (ts.isParameter(node)) {
      const owner = node.parent;
      const ownerName =
        declarationName(owner) ?? declarationName(owner.parent) ?? "";
      const rawProducer =
        RAW_UNIT_PARAMETER_PRODUCER.test(ownerName) ||
        LAB_CONTEXT_IDENTIFIER.test(ownerName);
      patternBindings(
        node.name,
        false,
        (id, raw) =>
          addBinding(
            scope,
            id,
            rawProducer &&
              (raw ||
                UNIT_IDENTIFIER.test(id.text) ||
                LAB_UNIT_IDENTIFIER.test(id.text))
          ),
        resolvedPropertyName
      );
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      addBinding(scopeAt.get(node.parent) ?? sourceScope, node.name);
    } else if (
      (ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name
    ) {
      addBinding(scope, node.name);
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);
  function authenticFormatterCall(node: ts.CallExpression): boolean {
    if (ts.isIdentifier(node.expression))
      return (
        resolve(node.expression, node.expression.text)?.trustedFormatter ===
        true
      );
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "displayUnit" &&
      ts.isIdentifier(node.expression.expression)
    )
      return (
        resolve(node.expression.expression, node.expression.expression.text)
          ?.trustedFormatterNamespace === true
      );
    return false;
  }
  function authenticStoredUnitCall(node: ts.CallExpression): boolean {
    if (ts.isIdentifier(node.expression))
      return (
        resolve(node.expression, node.expression.text)?.trustedStoredUnit ===
        true
      );
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "storedLabUnit" &&
      ts.isIdentifier(node.expression.expression)
    )
      return (
        resolve(node.expression.expression, node.expression.expression.text)
          ?.trustedFormatterNamespace === true
      );
    return false;
  }
  function explicitStoredUnitTransfer(node: ts.CallExpression): boolean {
    let current: ts.Node = node;
    while (current.parent) {
      const parent = current.parent;
      if (
        ts.isJsxExpression(parent) ||
        ts.isJsxAttribute(parent) ||
        ts.isTemplateSpan(parent) ||
        ts.isTaggedTemplateExpression(parent)
      )
        return false;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
        return false;
      if (ts.isPropertyAssignment(parent) && parent.initializer === current)
        return UNIT_PROPERTY.test(resolvedPropertyName(parent.name) ?? "");
      if (
        (ts.isVariableDeclaration(parent) && parent.initializer === current) ||
        (ts.isBinaryExpression(parent) &&
          parent.right === current &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      )
        return true;
      if (ts.isFunctionLike(parent)) return true;
      if (
        ts.isReturnStatement(parent) ||
        ts.isCallExpression(parent) ||
        ts.isStatement(parent)
      )
        return false;
      current = parent;
    }
    return false;
  }
  function directlyFormatted(node: ts.Node): boolean {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isCallExpression(parent))
        return (
          parent.arguments.includes(current as ts.Expression) &&
          authenticFormatterCall(parent)
        );
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isAwaitExpression(parent)
      )
        current = parent;
      else return false;
    }
    return false;
  }
  function directlyStored(node: ts.Node): boolean {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isCallExpression(parent))
        return (
          parent.arguments.includes(current as ts.Expression) &&
          authenticStoredUnitCall(parent) &&
          explicitStoredUnitTransfer(parent)
        );
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isAwaitExpression(parent)
      )
        current = parent;
      else return false;
    }
    return false;
  }
  function semanticCallName(call: ts.CallExpression): string | null {
    return ts.isIdentifier(call.expression)
      ? call.expression.text
      : ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.text
        : null;
  }
  function insideSemanticCall(node: ts.Node): boolean {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isCallExpression(parent)) {
        const name = semanticCallName(parent);
        return (
          parent.arguments.includes(current as ts.Expression) &&
          !!name &&
          ((name === "convertToCanonical" &&
            /(?:components\/BiomarkerScale\.tsx|app\/\(app\)\/results\/clinical-results\/view\/page\.tsx)$/.test(
              normalized
            )) ||
            (name === "sameUnit" &&
              /(?:app\/\(app\)\/results\/clinical-results\/view\/page\.tsx|lib\/(?:biomarker-goal|clinical-result-index|reading-reference-cell|rule-findings)\.ts)$/.test(
                normalized
              )) ||
            (name === "reconciledFlag" &&
              normalized.endsWith("/lib/queries/derived.ts")) ||
            (/^(?:fmtTemp|fmtWeight|normalizeImportedTemperature|toCm|unitKey|waistCircToCm|headCircToCm)$/.test(
              name
            ) &&
              /(?:lib\/(?:cda\/extractors\/observations|height-extract|head-circ-extract|migrations\/versions\/074-imported-temperature-degf|notifications\/telegram-quick-log|waist-circ-extract)\.ts)$/.test(
                normalized
              )))
        );
      }
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isCallExpression(parent)
      )
        current = parent;
      else return false;
    }
    return false;
  }
  function comparisonOrGuard(node: ts.Node): boolean {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (
        ((ts.isIfStatement(parent) ||
          ts.isWhileStatement(parent) ||
          ts.isDoStatement(parent)) &&
          parent.expression === current) ||
        (ts.isForStatement(parent) && parent.condition === current) ||
        (ts.isConditionalExpression(parent) && parent.condition === current) ||
        (ts.isPrefixUnaryExpression(parent) &&
          parent.operator === ts.SyntaxKind.ExclamationToken)
      )
        return true;
      if (ts.isBinaryExpression(parent)) {
        if (
          [
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ].includes(parent.operatorToken.kind)
        )
          return true;
        if (
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(parent.operatorToken.kind)
        ) {
          current = parent;
          continue;
        }
      }
      if (ts.isParenthesizedExpression(parent)) current = parent;
      else return false;
    }
    return false;
  }
  function sameFormatterFallback(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (
      !ts.isBinaryExpression(parent) ||
      parent.right !== node ||
      parent.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
      !ts.isCallExpression(parent.left) ||
      !authenticFormatterCall(parent.left) ||
      parent.left.arguments.length !== 1
    )
      return false;
    const argument = parent.left.arguments[0];
    return ts.isIdentifier(argument) && argument.text === node.text;
  }
  function unitJsxTransport(node: ts.Node): boolean {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isJsxAttribute(parent) && parent.initializer === current) {
        if (parent.name.getText(sourceFile) !== "unit") return false;
        const attributes = parent.parent;
        const element = attributes.parent;
        if (
          !ts.isJsxSelfClosingElement(element) &&
          !ts.isJsxOpeningElement(element)
        )
          return false;
        const tag = element.tagName;
        return (
          ts.isIdentifier(tag) &&
          resolve(tag, tag.text)?.trustedUnitRenderer === true
        );
      }
      if (ts.isJsxExpression(parent) || ts.isParenthesizedExpression(parent))
        current = parent;
      else return false;
    }
    return false;
  }
  function unitExport(node: ts.Node): boolean {
    if (!normalized.endsWith("/lib/queries/biomarker-plot.ts")) return false;
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    ) {
      if (ts.isFunctionLike(current)) {
        const name =
          declarationName(current) ?? declarationName(current.parent) ?? "";
        return name === "biomarkerTargetUnit";
      }
    }
    return false;
  }
  function trustedDisplayInput(node: ts.Node): boolean {
    if (!ts.isIdentifier(node)) return false;
    if (
      !/(?:components\/(?:BiomarkerChartInner|BiomarkerTrendChart)\.tsx)$/.test(
        normalized
      )
    )
      return false;
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    ) {
      if (ts.isFunctionLike(current)) {
        const name =
          declarationName(current) ?? declarationName(current.parent) ?? "";
        if (/^(?:BiomarkerChart|BiomarkerTrendChart)$/.test(name)) return true;
      }
    }
    return false;
  }
  function allowed(node: ts.Node): boolean {
    return (
      directlyFormatted(node) ||
      directlyStored(node) ||
      insideSemanticCall(node) ||
      comparisonOrGuard(node) ||
      unitJsxTransport(node) ||
      unitExport(node) ||
      trustedDisplayInput(node) ||
      (ts.isIdentifier(node) && sameFormatterFallback(node))
    );
  }

  function destructuringAssignmentUnitTarget(node: ts.Node): boolean {
    if (
      !ts.isPropertyAssignment(node) ||
      !UNIT_PROPERTY.test(resolvedPropertyName(node.name) ?? "")
    )
      return false;
    let current: ts.Node = node.parent;
    while (
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isParenthesizedExpression(current)
    )
      current = current.parent;
    return (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (current.left === node.parent ||
        current.left.getStart(sourceFile) <= node.getStart(sourceFile))
    );
  }

  const out: RawRenderedUnitExit[] = [];
  const seen = new Set<number>();
  function report(node: ts.Node) {
    const start = node.getStart(sourceFile);
    if (seen.has(start)) return;
    seen.add(start);
    out.push({
      line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
      text: node.getText(sourceFile),
    });
  }
  function visit(node: ts.Node) {
    const assignmentTarget = destructuringAssignmentUnitTarget(node);
    const candidate =
      unitPropertyRead(node, resolvedPropertyName) ||
      assignmentTarget ||
      (ts.isIdentifier(node) &&
        !isDeclarationIdentifier(node) &&
        resolve(node, node.text)?.rawUnit === true);
    if (candidate && isLabDisplayContext(node, fileName) && !allowed(node))
      report(
        assignmentTarget && ts.isPropertyAssignment(node)
          ? node.initializer
          : node
      );
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return out.sort((a, b) => a.line - b.line);
}
