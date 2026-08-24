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

  interface CallableTarget {
    runtime: RuntimeFunction;
    boundArguments: ts.Expression[];
  }

  interface CallableValue {
    position: number;
    target: CallableTarget | null;
  }

  const callableValues = new Map<UnitBinding, CallableValue[]>();
  const objectMethods = new Map<string, CallableTarget>();

  function addCallableValue(
    binding: UnitBinding,
    position: number,
    target: CallableTarget | null
  ): boolean {
    const values = callableValues.get(binding) ?? [];
    const signature = (callable: CallableTarget | null) =>
      callable
        ? `${callable.runtime.pos}:${callable.boundArguments
            .map((argument) => argument.pos)
            .join(",")}`
        : "none";
    const existing = values.find((value) => value.position === position);
    if (existing) {
      if (signature(existing.target) === signature(target)) return false;
      existing.target = target;
      return true;
    }
    values.push({ position, target });
    values.sort((a, b) => a.position - b.position);
    callableValues.set(binding, values);
    return true;
  }

  function callableAt(
    binding: UnitBinding,
    position: number
  ): CallableTarget | null {
    let found: CallableTarget | null = null;
    for (const value of callableValues.get(binding) ?? []) {
      if (value.position > position) break;
      found = value.target;
    }
    return found;
  }

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
      if (ts.isFunctionDeclaration(node) && node.name) {
        const binding = declareIdentifier(node.name, inherited);
        addCallableValue(binding, -1, {
          runtime: node,
          boundArguments: [],
        });
      }
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
      if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        const binding = declarationBindings.get(node.name);
        if (binding)
          addCallableValue(binding, node.end, {
            runtime: node.initializer,
            boundArguments: [],
          });
      }
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

  function methodKey(binding: UnitBinding, name: string): string {
    return `${binding.id}:${name}`;
  }

  function resolveCallableExpression(
    expression: ts.Expression
  ): CallableTarget | null {
    const target = unwrapAssignmentTarget(expression);
    if (ts.isIdentifier(target)) {
      const binding = resolveIdentifier(target);
      return binding ? callableAt(binding, target.getStart(sourceFile)) : null;
    }
    if (ts.isArrowFunction(target) || ts.isFunctionExpression(target))
      return { runtime: target, boundArguments: [] };
    if (ts.isPropertyAccessExpression(target)) {
      if (!ts.isIdentifier(target.expression)) return null;
      const binding = resolveIdentifier(target.expression);
      return binding
        ? (objectMethods.get(methodKey(binding, target.name.text)) ?? null)
        : null;
    }
    if (
      ts.isElementAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      ts.isStringLiteral(target.argumentExpression)
    ) {
      const binding = resolveIdentifier(target.expression);
      return binding
        ? (objectMethods.get(
            methodKey(binding, target.argumentExpression.text)
          ) ?? null)
        : null;
    }
    if (
      ts.isCallExpression(target) &&
      ts.isPropertyAccessExpression(target.expression) &&
      target.expression.name.text === "bind"
    ) {
      const callable = resolveCallableExpression(target.expression.expression);
      if (!callable) return null;
      return {
        runtime: callable.runtime,
        boundArguments: [
          ...callable.boundArguments,
          ...target.arguments.slice(1),
        ],
      };
    }
    return null;
  }

  // Resolve named callbacks, aliases, `.bind(...)`, and object-literal methods
  // after every lexical binding exists. Iterate because an object method may name
  // a function alias declared elsewhere in the same scope.
  function collectCallableAliases() {
    const variables: ts.VariableDeclaration[] = [];
    const assignments: ts.BinaryExpression[] = [];
    function collect(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        variables.push(node);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapAssignmentTarget(node.left))
      )
        assignments.push(node);
      ts.forEachChild(node, collect);
    }
    collect(sourceFile);

    let changed = true;
    while (changed) {
      changed = false;
      for (const variable of variables) {
        if (!ts.isIdentifier(variable.name)) continue;
        const binding = declarationBindings.get(variable.name);
        if (!binding || !variable.initializer) continue;
        const initializer = unwrapAssignmentTarget(variable.initializer);
        if (ts.isObjectLiteralExpression(initializer)) {
          for (const property of initializer.properties) {
            let name: string | null = null;
            let callable: CallableTarget | null = null;
            if (ts.isMethodDeclaration(property) && property.name) {
              name = propertyText(property.name);
              callable = { runtime: property, boundArguments: [] };
            } else if (ts.isPropertyAssignment(property)) {
              name = propertyText(property.name);
              callable = resolveCallableExpression(property.initializer);
            } else if (ts.isShorthandPropertyAssignment(property)) {
              name = property.name.text;
              callable = resolveCallableExpression(property.name);
            }
            if (!name || !callable) continue;
            const key = methodKey(binding, name);
            if (!objectMethods.has(key)) {
              objectMethods.set(key, callable);
              changed = true;
            }
          }
          continue;
        }
        const callable = resolveCallableExpression(initializer);
        if (addCallableValue(binding, variable.end, callable)) changed = true;
      }
      for (const assignment of assignments) {
        const target = unwrapAssignmentTarget(assignment.left);
        if (!ts.isIdentifier(target)) continue;
        const binding = resolveIdentifier(target);
        const callable = resolveCallableExpression(assignment.right);
        if (binding && addCallableValue(binding, assignment.end, callable))
          changed = true;
      }
    }
  }
  collectCallableAliases();

  function addWrite(binding: UnitBinding | null, write: BindingWrite) {
    if (binding) binding.writes.push(write);
  }

  function arrayElementSource(
    source: ts.Expression | undefined,
    index: number
  ): ts.Expression | undefined {
    if (!source) return undefined;
    const unwrapped = unwrapAssignmentTarget(source);
    if (!ts.isArrayLiteralExpression(unwrapped)) return source;
    const element = unwrapped.elements[index];
    if (!element || ts.isOmittedExpression(element)) return undefined;
    return ts.isSpreadElement(element) ? element.expression : element;
  }

  function addBindingTargetWrites(
    name: ts.BindingName,
    owner: ts.Node,
    source?: ts.Expression,
    appliesWithin?: ts.Node,
    rawFromProperty = false
  ) {
    if (ts.isIdentifier(name)) {
      addWrite(bindingForTarget(name), {
        node: owner,
        position: owner.end,
        ...(rawFromProperty
          ? { raw: true }
          : source
            ? { expression: source }
            : {}),
        appliesWithin,
      });
      return;
    }
    for (const [index, element] of name.elements.entries()) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName ?? element.name;
      const propertyName = propertyText(property);
      const raw =
        rawFromProperty ||
        (propertyName != null && UNIT_PROPERTY.test(propertyName));
      addBindingTargetWrites(
        element.name,
        owner,
        ts.isArrayBindingPattern(name)
          ? arrayElementSource(source, index)
          : source,
        appliesWithin,
        raw
      );
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

  function addExpressionTargetWrites(
    expression: ts.Expression,
    owner: ts.Node,
    source?: ts.Expression,
    appliesWithin?: ts.Node,
    rawFromProperty = false
  ) {
    const target = unwrapAssignmentTarget(expression);
    if (ts.isIdentifier(target)) {
      addWrite(bindingForTarget(target), {
        node: owner,
        position: owner.end,
        ...(rawFromProperty
          ? { raw: true }
          : source
            ? { expression: source }
            : {}),
        appliesWithin,
      });
      return;
    }
    if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      addExpressionTargetWrites(
        target.left,
        owner,
        source,
        appliesWithin,
        rawFromProperty
      );
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyText(property.name);
          addExpressionTargetWrites(
            property.initializer,
            owner,
            source,
            appliesWithin,
            rawFromProperty || (name != null && UNIT_PROPERTY.test(name))
          );
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const name = property.name.text;
          addExpressionTargetWrites(
            property.name,
            owner,
            source,
            appliesWithin,
            rawFromProperty || UNIT_PROPERTY.test(name)
          );
        } else if (ts.isSpreadAssignment(property)) {
          addExpressionTargetWrites(
            property.expression,
            owner,
            source,
            appliesWithin,
            rawFromProperty
          );
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const [index, element] of target.elements.entries()) {
        if (!ts.isOmittedExpression(element))
          addExpressionTargetWrites(
            ts.isSpreadElement(element) ? element.expression : element,
            owner,
            arrayElementSource(source, index),
            appliesWithin,
            rawFromProperty
          );
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
      } else if (ts.isIdentifier(node.name) && forOf) {
        addWrite(bindingForTarget(node.name), {
          node,
          position: node.end,
          expression: forOf.expression,
          appliesWithin: forOf.statement,
        });
      } else if (!ts.isIdentifier(node.name)) {
        addBindingTargetWrites(
          node.name,
          node,
          node.initializer ?? forOf?.expression,
          forOf?.statement
        );
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
        addExpressionTargetWrites(target, node, node.right);
      }
    }
    if (
      ts.isForOfStatement(node) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      addExpressionTargetWrites(
        node.initializer,
        node.initializer,
        node.expression,
        node.statement
      );
    }
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(sourceFile);
  for (const scope of new Set(scopeAt.values())) {
    for (const binding of scope.bindings.values())
      binding.writes.sort((a, b) => a.position - b.position);
  }

  interface RuntimeInvocation {
    node: ts.CallExpression;
    definite: boolean;
    arguments: ts.Expression[];
  }

  const runtimeInvocations = new Map<RuntimeFunction, RuntimeInvocation[]>();

  // A captured write happens when its function is invoked, not where that
  // function's body happens to appear in the file. Direct calls are definite;
  // callback arguments are conservative joins because the callee may invoke them
  // zero or many times.

  function addRuntimeInvocation(
    callable: CallableTarget,
    node: ts.CallExpression,
    definite: boolean,
    callArguments: readonly ts.Expression[] = []
  ) {
    const sites = runtimeInvocations.get(callable.runtime) ?? [];
    sites.push({
      node,
      definite,
      arguments: [...callable.boundArguments, ...callArguments],
    });
    runtimeInvocations.set(callable.runtime, sites);
  }

  function collectRuntimeInvocations(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const direct = resolveCallableExpression(node.expression);
      if (direct) addRuntimeInvocation(direct, node, true, node.arguments);
      const callbackArguments =
        ts.isPropertyAccessExpression(node.expression) &&
        /^(?:every|filter|find|findIndex|flatMap|forEach|map|reduce|reduceRight|some)$/.test(
          node.expression.name.text
        )
          ? [node.expression.expression]
          : [];
      for (const [index, argument] of node.arguments.entries()) {
        const invokedArguments = index === 0 ? callbackArguments : [];
        const callable = resolveCallableExpression(argument);
        if (callable)
          addRuntimeInvocation(callable, node, false, invokedArguments);
      }
    }
    ts.forEachChild(node, collectRuntimeInvocations);
  }
  collectRuntimeInvocations(sourceFile);

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

  interface EffectiveWrite {
    write: BindingWrite;
    position: number;
    order: number[];
    definite: boolean;
    context?: EvaluationContext;
  }

  interface EvaluationContext {
    key: string;
    runtime: RuntimeFunction;
    site: ts.CallExpression;
    arguments: ts.Expression[];
    parent?: EvaluationContext;
  }

  function invocationContext(
    runtime: RuntimeFunction,
    invocation: RuntimeInvocation,
    parent?: EvaluationContext
  ): EvaluationContext {
    return {
      key: `${runtime.pos}@${invocation.node.pos}:${parent?.key ?? "root"}`,
      runtime,
      site: invocation.node,
      arguments: invocation.arguments,
      parent,
    };
  }

  interface ParameterValue {
    expressions: ts.Expression[];
    raw: boolean;
  }

  interface ParameterSubstitution {
    value: ParameterValue;
    parent?: EvaluationContext;
  }

  function objectPropertySource(
    source: ts.Expression,
    name: string
  ): ts.Expression | null {
    const unwrapped = unwrapAssignmentTarget(source);
    if (!ts.isObjectLiteralExpression(unwrapped)) return null;
    for (const property of unwrapped.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        propertyText(property.name) === name
      )
        return property.initializer;
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === name
      )
        return property.name;
    }
    return null;
  }

  function bindParameterPattern(
    name: ts.BindingName,
    sources: ts.Expression[],
    values: Map<UnitBinding, ParameterValue>,
    rawFromProperty = false
  ) {
    if (ts.isIdentifier(name)) {
      const binding = declarationBindings.get(name);
      if (binding)
        values.set(binding, { expressions: sources, raw: rawFromProperty });
      return;
    }
    for (const [index, element] of name.elements.entries()) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName ?? element.name;
      const propertyName = propertyText(property);
      let exactObjectProperty = false;
      let elementSources: ts.Expression[];
      if (ts.isArrayBindingPattern(name)) {
        if (element.dotDotDotToken) {
          elementSources = sources.flatMap((source) => {
            const unwrapped = unwrapAssignmentTarget(source);
            if (!ts.isArrayLiteralExpression(unwrapped)) return [source];
            return unwrapped.elements
              .slice(index)
              .flatMap((part) =>
                ts.isOmittedExpression(part)
                  ? []
                  : [ts.isSpreadElement(part) ? part.expression : part]
              );
          });
        } else {
          elementSources = sources.flatMap((source) => {
            const found = arrayElementSource(source, index);
            return found ? [found] : [];
          });
        }
      } else if (propertyName != null) {
        elementSources = sources.flatMap((source) => {
          const found = objectPropertySource(source, propertyName);
          if (!found) return [source];
          exactObjectProperty = true;
          return [found];
        });
      } else {
        elementSources = sources;
      }
      if (element.initializer && elementSources.length === 0)
        elementSources.push(element.initializer);
      const raw =
        rawFromProperty ||
        (!exactObjectProperty &&
          propertyName != null &&
          UNIT_PROPERTY.test(propertyName));
      bindParameterPattern(element.name, elementSources, values, raw);
    }
  }

  function parameterValue(
    binding: UnitBinding,
    context: EvaluationContext
  ): ParameterSubstitution | null {
    for (
      let current: EvaluationContext | undefined = context;
      current;
      current = current.parent
    ) {
      const values = new Map<UnitBinding, ParameterValue>();
      for (const [index, parameter] of current.runtime.parameters.entries()) {
        const sources = parameter.dotDotDotToken
          ? current.arguments.slice(index)
          : current.arguments[index]
            ? [current.arguments[index]]
            : [];
        if (parameter.initializer && sources.length === 0)
          sources.push(parameter.initializer);
        bindParameterPattern(parameter.name, sources, values);
      }
      const value = values.get(binding);
      if (value) return { value, parent: current.parent };
    }
    return null;
  }

  interface InvocationOccurrence {
    site: ts.CallExpression;
    position: number;
    order: number[];
    definite: boolean;
    context: EvaluationContext;
  }

  function invocationOccurrences(
    runtime: RuntimeFunction,
    useRuntime: ts.Node,
    parentContext?: EvaluationContext,
    callers = new Set<RuntimeFunction>()
  ): InvocationOccurrence[] {
    if (callers.has(runtime)) return [];
    const nextCallers = new Set(callers).add(runtime);
    const occurrences: InvocationOccurrence[] = [];
    for (const invocation of runtimeInvocations.get(runtime) ?? []) {
      const caller = enclosingRuntime(invocation.node);
      if (caller === useRuntime) {
        occurrences.push({
          site: invocation.node,
          position: invocation.node.end,
          order: [invocation.node.getStart(sourceFile)],
          definite: invocation.definite,
          context: invocationContext(runtime, invocation, parentContext),
        });
        continue;
      }
      if (!runtimeFunction(caller)) continue;
      const internallyDefinite =
        guardedRegions(invocation.node, caller).length === 0;
      for (const outer of invocationOccurrences(
        caller,
        useRuntime,
        parentContext,
        nextCallers
      )) {
        occurrences.push({
          site: outer.site,
          position: outer.position,
          order: [...outer.order, invocation.node.getStart(sourceFile)],
          definite: outer.definite && invocation.definite && internallyDefinite,
          context: invocationContext(runtime, invocation, outer.context),
        });
      }
    }
    return occurrences;
  }

  function effectiveWritesForUse(
    binding: UnitBinding,
    use: ts.Node,
    context?: EvaluationContext
  ): EffectiveWrite[] {
    const useRuntime = enclosingRuntime(use);
    const events: EffectiveWrite[] = [];
    for (const write of binding.writes) {
      const writeRuntime = enclosingRuntime(write.node);
      if (writeRuntime === useRuntime) {
        events.push({
          write,
          position: write.position,
          order: [write.node.getStart(sourceFile)],
          definite: writeIsDefiniteForUse(write, use),
          context,
        });
        continue;
      }

      if (!runtimeFunction(writeRuntime)) continue;
      for (const occurrence of invocationOccurrences(
        writeRuntime,
        useRuntime,
        context
      )) {
        const callWrite: BindingWrite = {
          node: occurrence.site,
          position: occurrence.position,
        };
        const internallyDefinite =
          guardedRegions(write.node, writeRuntime).length === 0;
        events.push({
          write,
          position: occurrence.position,
          order: [...occurrence.order, write.node.getStart(sourceFile)],
          definite:
            occurrence.definite &&
            internallyDefinite &&
            writeIsDefiniteForUse(callWrite, use),
          context: occurrence.context,
        });
      }
    }
    return events.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      for (
        let index = 0;
        index < Math.max(a.order.length, b.order.length);
        index++
      ) {
        const difference =
          (a.order[index] ?? Number.MAX_SAFE_INTEGER) -
          (b.order[index] ?? Number.MAX_SAFE_INTEGER);
        if (difference) return difference;
      }
      return 0;
    });
  }

  function bindingTaintedAt(
    binding: UnitBinding,
    use: ts.Node,
    context?: EvaluationContext
  ): boolean {
    const key = `${binding.id}:${use.pos}:${use.end}:${context?.key ?? "root"}`;
    const memoized = taintMemo.get(key);
    if (memoized != null) return memoized;
    if (evaluatingTaint.has(key)) return binding.initialRaw;
    evaluatingTaint.add(key);

    let tainted = binding.initialRaw;
    const useStart = use.getStart(sourceFile);
    for (const event of effectiveWritesForUse(binding, use, context)) {
      if (event.position >= useStart) continue;
      const write = event.write;
      const writeTainted =
        write.raw === true ||
        (write.expression != null &&
          carriesRawUnit(write.expression, event.context));
      if (event.definite) tainted = writeTainted;
      else if (writeTainted) tainted = true;
    }

    evaluatingTaint.delete(key);
    taintMemo.set(key, tainted);
    return tainted;
  }

  function rawIdentifierUse(
    identifier: ts.Identifier,
    context?: EvaluationContext
  ): boolean {
    if (!identifierIsReference(identifier)) return false;
    const binding = resolveIdentifier(identifier);
    if (binding) {
      if (context) {
        const substitution = parameterValue(binding, context);
        if (substitution)
          return (
            substitution.value.raw ||
            substitution.value.expressions.some((expression) =>
              carriesRawUnit(expression, substitution.parent)
            )
          );
        const bindingRuntime = enclosingRuntime(binding.scope.node);
        for (
          let current: EvaluationContext | undefined = context;
          current;
          current = current.parent
        ) {
          if (enclosingRuntime(current.site) === bindingRuntime)
            return bindingTaintedAt(binding, current.site, current.parent);
        }
      }
      return bindingTaintedAt(binding, identifier, context);
    }
    return conventionalUnitName(identifier.text);
  }

  // Does this expression still CARRY the raw unit string? Do not taint arbitrary
  // values merely because their computation consulted a unit (range badges,
  // conversion results, formatter-return objects). Only spelling-preserving
  // operations and copy composition propagate the value to a later display sink.
  const evaluatingCallableReturns = new Set<string>();

  function callableReturnsRaw(
    callable: CallableTarget,
    callArguments: readonly ts.Expression[],
    site: ts.CallExpression,
    parent?: EvaluationContext
  ): boolean {
    const key = `${callable.runtime.pos}@return:${site.pos}:${parent?.key ?? "root"}`;
    if (evaluatingCallableReturns.has(key)) return false;
    evaluatingCallableReturns.add(key);
    const context: EvaluationContext = {
      key: `${callable.runtime.pos}@map:${site.pos}:${parent?.key ?? "root"}`,
      runtime: callable.runtime,
      site,
      arguments: [...callable.boundArguments, ...callArguments],
      parent,
    };
    const body = callable.runtime.body;
    if (!body) {
      evaluatingCallableReturns.delete(key);
      return false;
    }
    if (!ts.isBlock(body)) {
      const raw = carriesRawUnit(body, context);
      evaluatingCallableReturns.delete(key);
      return raw;
    }
    let rawReturn = false;
    function visit(current: ts.Node) {
      if (
        ts.isReturnStatement(current) &&
        current.expression &&
        carriesRawUnit(current.expression, context)
      )
        rawReturn = true;
      if (!rawReturn && !runtimeFunction(current))
        ts.forEachChild(current, visit);
    }
    for (const statement of body.statements) visit(statement);
    evaluatingCallableReturns.delete(key);
    return rawReturn;
  }

  function carriesRawUnit(node: ts.Node, context?: EvaluationContext): boolean {
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
    if (ts.isIdentifier(node) && rawIdentifierUse(node, context)) return true;
    if (ts.isArrayLiteralExpression(node))
      return node.elements.some(
        (element) =>
          !ts.isOmittedExpression(element) &&
          carriesRawUnit(
            ts.isSpreadElement(element) ? element.expression : element,
            context
          )
      );
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return carriesRawUnit(node.expression, context);
    if (ts.isConditionalExpression(node))
      return (
        carriesRawUnit(node.whenTrue, context) ||
        carriesRawUnit(node.whenFalse, context)
      );
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken &&
        ts.isCallExpression(node.left) &&
        isAuthenticDisplayUnitCall(node.left) &&
        node.left.arguments.length === 1 &&
        node.left.arguments[0].getText(sourceFile) ===
          node.right.getText(sourceFile)
      )
        // The raw fallback is reachable only when displayUnit found no unit to
        // display. A supported ASCII micro spelling always returns formatted text.
        return false;
      if (
        operator === ts.SyntaxKind.PlusToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return (
          carriesRawUnit(node.left, context) ||
          carriesRawUnit(node.right, context)
        );
      return false;
    }
    if (ts.isTemplateExpression(node))
      return node.templateSpans.some((span) =>
        carriesRawUnit(span.expression, context)
      );
    if (ts.isCallExpression(node)) {
      const directCallable = resolveCallableExpression(node.expression);
      if (directCallable)
        return callableReturnsRaw(
          directCallable,
          node.arguments,
          node,
          context
        );
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        /^(?:trim|toString|valueOf)$/.test(node.expression.name.text)
      )
        return carriesRawUnit(node.expression.expression, context);
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const method = node.expression.name.text;
        if (
          /^(?:concat|filter|flat|join|slice|toReversed|toSorted)$/.test(method)
        )
          // These operations retain or compose the receiver's spelling.
          return (
            carriesRawUnit(receiver, context) ||
            node.arguments.some((argument) => carriesRawUnit(argument, context))
          );
        if (/^(?:flatMap|map)$/.test(method)) {
          // A mapper owns the output spelling: an authentic formatter kills raw
          // taint, while a raw-returning callback starts it.
          const mapper = node.arguments[0];
          if (!mapper) return carriesRawUnit(receiver, context);
          if (ts.isArrowFunction(mapper) || ts.isFunctionExpression(mapper)) {
            if (ts.isBlock(mapper.body)) {
              let rawReturn = false;
              function visitReturn(current: ts.Node) {
                if (
                  ts.isReturnStatement(current) &&
                  current.expression &&
                  carriesRawUnit(current.expression, context)
                )
                  rawReturn = true;
                if (!rawReturn) ts.forEachChild(current, visitReturn);
              }
              visitReturn(mapper.body);
              return rawReturn;
            }
            return carriesRawUnit(mapper.body, context);
          }
          if (ts.isIdentifier(mapper)) {
            const binding = resolveIdentifier(mapper);
            if (binding && trustedFormatterBindings.has(binding)) return false;
          }
          const callable = resolveCallableExpression(mapper);
          if (callable)
            return callableReturnsRaw(callable, [receiver], node, context);
          return carriesRawUnit(receiver, context);
        }
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "String" &&
        node.arguments.length === 1
      )
        return carriesRawUnit(node.arguments[0], context);
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
