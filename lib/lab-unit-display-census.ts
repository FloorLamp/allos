import ts from "typescript";
import path from "node:path";

export interface RawRenderedUnitExit {
  line: number;
  text: string;
}

const UNIT_PROPERTY =
  /^(?:bio(?:marker)?Unit|correctedUnit|latestUnit|latest_unit|statedUnit|unit|vitaminDUnit)$/i;
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
  /(?:\.\s*(?:bio(?:marker)?Unit|correctedUnit|latestUnit|latest_unit|statedUnit|unit|vitaminDUnit)\b|\[\s*["'](?:bio(?:marker)?Unit|correctedUnit|latestUnit|latest_unit|statedUnit|unit|vitaminDUnit)["']\s*\]|\b(?:bio(?:marker)?Unit|chartUnit|correctedUnit|latestUnit|otherUnits|statedUnit|units?|vitaminDUnit)\b)/i;

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

function importedDisplayUnitDeclarations(
  sourceFile: ts.SourceFile,
  fileName: string
): Set<ts.Identifier> {
  const declarations = new Set<ts.Identifier>();
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
        declarations.add(element.name);
      }
    }
  }
  return declarations;
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
  const formatterDeclarations = importedDisplayUnitDeclarations(
    sourceFile,
    fileName
  );

  interface LexicalScope {
    node: ts.Node;
    parent: LexicalScope | null;
    bindings: Map<string, UnitBinding>;
  }

  interface BindingWrite {
    node: ts.Node;
    position: number;
    expression?: ts.Expression;
    raw?: boolean;
    appliesWithin?: ts.Node;
  }

  interface UnitBinding {
    id: number;
    name: string;
    scope: LexicalScope;
    initialRaw: boolean;
    writes: BindingWrite[];
  }

  let nextBindingId = 1;
  const scopeAt = new Map<ts.Node, LexicalScope>();
  const declarationBindings = new Map<ts.Identifier, UnitBinding>();
  const trustedFormatterBindings = new Set<UnitBinding>();

  type RuntimeFunction =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration;

  function runtimeFunction(node: ts.Node): node is RuntimeFunction {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    );
  }

  function childScope(node: ts.Node, parent: LexicalScope): LexicalScope {
    return { node, parent, bindings: new Map() };
  }

  function nearestVarScope(scope: LexicalScope): LexicalScope {
    for (
      let current: LexicalScope | null = scope;
      current;
      current = current.parent
    ) {
      if (ts.isSourceFile(current.node) || runtimeFunction(current.node))
        return current;
    }
    return scope;
  }

  function conventionalUnitName(name: string): boolean {
    return UNIT_IDENTIFIER.test(name) || LAB_UNIT_IDENTIFIER.test(name);
  }

  function declareIdentifier(
    identifier: ts.Identifier,
    scope: LexicalScope,
    initialRaw = false
  ): UnitBinding {
    let binding = scope.bindings.get(identifier.text);
    if (!binding) {
      binding = {
        id: nextBindingId++,
        name: identifier.text,
        scope,
        initialRaw,
        writes: [],
      };
      scope.bindings.set(identifier.text, binding);
    } else if (initialRaw) {
      binding.initialRaw = true;
    }
    declarationBindings.set(identifier, binding);
    if (formatterDeclarations.has(identifier))
      trustedFormatterBindings.add(binding);
    return binding;
  }

  function propertyText(name: ts.PropertyName | ts.BindingName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression))
      return name.expression.text;
    return null;
  }

  function declarePattern(
    name: ts.BindingName,
    scope: LexicalScope,
    parameter: boolean,
    rawFromProperty = false
  ) {
    if (ts.isIdentifier(name)) {
      declareIdentifier(
        name,
        scope,
        rawFromProperty || (parameter && conventionalUnitName(name.text))
      );
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName ?? element.name;
      const propertyName = propertyText(property);
      const raw =
        rawFromProperty ||
        (propertyName != null && UNIT_PROPERTY.test(propertyName));
      declarePattern(element.name, scope, parameter, raw);
    }
  }

  const rootScope: LexicalScope = {
    node: sourceFile,
    parent: null,
    bindings: new Map(),
  };

  function collectScopes(node: ts.Node, inherited: LexicalScope) {
    let scope = inherited;

    if (node !== sourceFile && runtimeFunction(node)) {
      if (ts.isFunctionDeclaration(node) && node.name)
        declareIdentifier(node.name, inherited);
      scope = childScope(node, inherited);
      scopeAt.set(node, scope);
      if (ts.isFunctionExpression(node) && node.name)
        declareIdentifier(node.name, scope);
      for (const parameter of node.parameters) collectScopes(parameter, scope);
      if (node.body) collectScopes(node.body, scope);
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (ts.isClassDeclaration(node) && node.name)
        declareIdentifier(node.name, inherited);
      scope = childScope(node, inherited);
      scopeAt.set(node, scope);
      if (node.name) declareIdentifier(node.name, scope);
      for (const member of node.members) collectScopes(member, scope);
      return;
    }

    if (
      node !== sourceFile &&
      (ts.isBlock(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isCatchClause(node))
    ) {
      scope = childScope(node, inherited);
    }
    scopeAt.set(node, scope);

    if (ts.isImportSpecifier(node)) {
      declareIdentifier(node.name, rootScope);
    } else if (ts.isVariableDeclaration(node)) {
      const list = ts.isVariableDeclarationList(node.parent)
        ? node.parent
        : null;
      const declarationScope =
        list && (list.flags & ts.NodeFlags.BlockScoped) !== 0
          ? scope
          : nearestVarScope(scope);
      declarePattern(node.name, declarationScope, false);
    } else if (ts.isParameter(node)) {
      declarePattern(node.name, scope, true);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      declarePattern(node.variableDeclaration.name, scope, false);
    }

    ts.forEachChild(node, (child) => collectScopes(child, scope));
  }
  collectScopes(sourceFile, rootScope);

  function resolveIdentifier(identifier: ts.Identifier): UnitBinding | null {
    if (declarationBindings.has(identifier))
      return declarationBindings.get(identifier) ?? null;
    for (
      let scope: LexicalScope | null = scopeAt.get(identifier) ?? null;
      scope;
      scope = scope.parent
    ) {
      const binding = scope.bindings.get(identifier.text);
      if (binding) return binding;
    }
    return null;
  }

  function isAuthenticDisplayUnitCall(node: ts.Node): boolean {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
      return false;
    const binding = resolveIdentifier(node.expression);
    return binding != null && trustedFormatterBindings.has(binding);
  }

  function identifierIsReference(identifier: ts.Identifier): boolean {
    if (declarationBindings.has(identifier)) return false;
    const parent = identifier.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
      (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
      (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
      (ts.isImportSpecifier(parent) &&
        (parent.name === identifier || parent.propertyName === identifier))
    )
      return false;
    return true;
  }

  function bindingForTarget(identifier: ts.Identifier): UnitBinding | null {
    return declarationBindings.get(identifier) ?? resolveIdentifier(identifier);
  }

  function addWrite(binding: UnitBinding | null, write: BindingWrite) {
    if (binding) binding.writes.push(write);
  }

  function addRawBindingTargets(
    name: ts.BindingName,
    owner: ts.Node,
    appliesWithin?: ts.Node,
    rawFromProperty = false
  ) {
    if (ts.isIdentifier(name)) {
      if (rawFromProperty)
        addWrite(bindingForTarget(name), {
          node: owner,
          position: owner.end,
          raw: true,
          appliesWithin,
        });
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName ?? element.name;
      const propertyName = propertyText(property);
      const raw =
        rawFromProperty ||
        (propertyName != null && UNIT_PROPERTY.test(propertyName));
      addRawBindingTargets(element.name, owner, appliesWithin, raw);
    }
  }

  function unwrapAssignmentTarget(node: ts.Expression): ts.Expression {
    let current = node;
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

  function addRawExpressionTargets(
    expression: ts.Expression,
    owner: ts.Node,
    rawFromProperty = false
  ) {
    const target = unwrapAssignmentTarget(expression);
    if (ts.isIdentifier(target)) {
      if (rawFromProperty)
        addWrite(bindingForTarget(target), {
          node: owner,
          position: owner.end,
          raw: true,
        });
      return;
    }
    if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      addRawExpressionTargets(target.left, owner, rawFromProperty);
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyText(property.name);
          addRawExpressionTargets(
            property.initializer,
            owner,
            rawFromProperty || (name != null && UNIT_PROPERTY.test(name))
          );
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const name = property.name.text;
          addRawExpressionTargets(
            property.name,
            owner,
            rawFromProperty || UNIT_PROPERTY.test(name)
          );
        } else if (ts.isSpreadAssignment(property)) {
          addRawExpressionTargets(property.expression, owner, rawFromProperty);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (!ts.isOmittedExpression(element))
          addRawExpressionTargets(element, owner, rawFromProperty);
      }
    }
  }

  function collectWrites(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      !(
        directVariableExit(node) &&
        ts.isIdentifier(node.name) &&
        !conventionalUnitName(node.name.text)
      )
    ) {
      const forOf =
        ts.isVariableDeclarationList(node.parent) &&
        ts.isForOfStatement(node.parent.parent)
          ? node.parent.parent
          : null;
      if (ts.isIdentifier(node.name) && node.initializer) {
        addWrite(bindingForTarget(node.name), {
          node,
          position: node.end,
          expression: node.initializer,
        });
      } else if (!ts.isIdentifier(node.name)) {
        addRawBindingTargets(node.name, node, forOf?.statement);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = unwrapAssignmentTarget(node.left);
      if (ts.isIdentifier(target)) {
        addWrite(bindingForTarget(target), {
          node,
          position: node.end,
          expression: node.right,
        });
      } else {
        addRawExpressionTargets(target, node);
      }
    }
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(sourceFile);
  for (const scope of new Set(scopeAt.values())) {
    for (const binding of scope.bindings.values())
      binding.writes.sort((a, b) => a.position - b.position);
  }

  function isDescendant(node: ts.Node, ancestor: ts.Node): boolean {
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    ) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function enclosingRuntime(node: ts.Node): ts.Node {
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    ) {
      if (runtimeFunction(current) || ts.isSourceFile(current)) return current;
    }
    return sourceFile;
  }

  function guardedRegions(node: ts.Node, boundary: ts.Node): ts.Node[] {
    const regions: ts.Node[] = [];
    for (
      let current: ts.Node | undefined = node;
      current && current !== boundary;
      current = current.parent
    ) {
      const parent = current.parent;
      if (!parent) break;
      if (ts.isIfStatement(parent)) {
        if (isDescendant(node, parent.thenStatement))
          regions.push(parent.thenStatement);
        else if (
          parent.elseStatement &&
          isDescendant(node, parent.elseStatement)
        )
          regions.push(parent.elseStatement);
      } else if (ts.isConditionalExpression(parent)) {
        if (isDescendant(node, parent.whenTrue)) regions.push(parent.whenTrue);
        else if (isDescendant(node, parent.whenFalse))
          regions.push(parent.whenFalse);
      } else if (
        (ts.isForStatement(parent) ||
          ts.isForInStatement(parent) ||
          ts.isForOfStatement(parent) ||
          ts.isWhileStatement(parent) ||
          ts.isDoStatement(parent)) &&
        isDescendant(node, parent.statement)
      ) {
        regions.push(parent.statement);
      } else if (ts.isCaseOrDefaultClause(parent)) {
        regions.push(parent);
      } else if (
        ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
        isDescendant(node, parent.right)
      ) {
        regions.push(parent.right);
      } else if (ts.isCatchClause(parent)) {
        regions.push(parent.block);
      }
    }
    return regions;
  }

  function writeIsDefiniteForUse(write: BindingWrite, use: ts.Node): boolean {
    if (write.appliesWithin) return isDescendant(use, write.appliesWithin);
    const execution = enclosingRuntime(write.node);
    if (!isDescendant(use, execution)) return false;
    return guardedRegions(write.node, execution).every((region) =>
      isDescendant(use, region)
    );
  }

  const taintMemo = new Map<string, boolean>();
  const evaluatingTaint = new Set<string>();

  function bindingTaintedAt(binding: UnitBinding, use: ts.Node): boolean {
    const key = `${binding.id}:${use.pos}:${use.end}`;
    const memoized = taintMemo.get(key);
    if (memoized != null) return memoized;
    if (evaluatingTaint.has(key)) return binding.initialRaw;
    evaluatingTaint.add(key);

    let tainted = binding.initialRaw;
    const useStart = use.getStart(sourceFile);
    for (const write of binding.writes) {
      if (write.position >= useStart) continue;
      const writeTainted =
        write.raw === true ||
        (write.expression != null && carriesRawUnit(write.expression));
      if (writeIsDefiniteForUse(write, use)) tainted = writeTainted;
      else if (writeTainted) tainted = true;
    }

    evaluatingTaint.delete(key);
    taintMemo.set(key, tainted);
    return tainted;
  }

  function rawIdentifierUse(identifier: ts.Identifier): boolean {
    if (!identifierIsReference(identifier)) return false;
    const binding = resolveIdentifier(identifier);
    if (binding) return bindingTaintedAt(binding, identifier);
    return conventionalUnitName(identifier.text);
  }

  // Does this expression still CARRY the raw unit string? Do not taint arbitrary
  // values merely because their computation consulted a unit (range badges,
  // conversion results, formatter-return objects). Only spelling-preserving
  // operations and copy composition propagate the value to a later display sink.
  function carriesRawUnit(node: ts.Node): boolean {
    if (isAuthenticDisplayUnitCall(node)) return false;
    if (
      ts.isPropertyAccessExpression(node) &&
      UNIT_PROPERTY.test(node.name.text)
    )
      return true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      UNIT_PROPERTY.test(node.argumentExpression.text)
    )
      return true;
    if (ts.isIdentifier(node) && rawIdentifierUse(node)) return true;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return carriesRawUnit(node.expression);
    if (ts.isConditionalExpression(node))
      return carriesRawUnit(node.whenTrue) || carriesRawUnit(node.whenFalse);
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.PlusToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return carriesRawUnit(node.left) || carriesRawUnit(node.right);
      return false;
    }
    if (ts.isTemplateExpression(node))
      return node.templateSpans.some((span) => carriesRawUnit(span.expression));
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        /^(?:trim|toString|valueOf)$/.test(node.expression.name.text)
      )
        return carriesRawUnit(node.expression.expression);
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "String" &&
        node.arguments.length === 1
      )
        return carriesRawUnit(node.arguments[0]);
    }
    return false;
  }

  function directVariableExit(node: ts.VariableDeclaration): boolean {
    return (
      (isLabCopyProducer(node, fileName) &&
        (isWithinBiomarkerBranch(node) ||
          isPrecomposedLabCopyProducer(node))) ||
      (ts.isIdentifier(node.name) &&
        /^(?:correctedUnit|shownUnit|shownVitaminDUnit|statedUnit|suffix)$/.test(
          node.name.text
        ) &&
        isDirectDisplayProducer(node))
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
        protectedByFormatter || isAuthenticDisplayUnitCall(node);
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
      if (!protectedHere && ts.isIdentifier(node) && rawIdentifierUse(node)) {
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
      directVariableExit(node)
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
