import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Scanner } from "@tailwindcss/oxide";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import ts from "typescript";
import {
  COMPILED_BYTE_FLOOR,
  PHONE_BLOCK_FLOOR,
  PHONE_DECLARATION_FLOOR,
  PHONE_ONLY_UTILITIES,
} from "./phone-only-css-registry.mjs";

const TAILWIND_IMPORT = '@import "tailwindcss";';
const RUNTIME_SOURCE_DIRECTORIES = ["app", "components", "lib"];
const RUNTIME_SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
let moduleRuntimeCandidates;

function normalizeSpace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isPhoneMedia(params) {
  return (
    /^\(\s*width\s*<\s*40rem\s*\)$/.test(params) ||
    /^\(\s*max-width\s*:\s*639\.98px\s*\)$/.test(params)
  );
}

function contributesAtPhone(atRule) {
  if (atRule.name === "media") return isPhoneMedia(atRule.params);
  if (atRule.name === "variant")
    return normalizeSpace(atRule.params) === "max-sm";
  return atRule.name === "apply" && /(?:^|[\s:])max-sm:/.test(atRule.params);
}

export function phoneOnlyUtilityCandidates(source, label = "app/globals.css") {
  let root;
  try {
    root = postcss.parse(source);
  } catch (error) {
    throw new Error(
      `${label}: cannot parse custom utilities: ${error.message}`,
      {
        cause: error,
      }
    );
  }
  const candidates = [];
  root.walkAtRules("utility", (utility) => {
    let contributes = false;
    utility.walkAtRules((atRule) => {
      if (contributesAtPhone(atRule)) contributes = true;
    });
    if (contributes) candidates.push(normalizeSpace(utility.params));
  });
  return candidates;
}

function customUtilityCandidates(source, label) {
  let root;
  try {
    root = postcss.parse(source);
  } catch (error) {
    throw new Error(
      `${label}: cannot parse custom utilities: ${error.message}`,
      {
        cause: error,
      }
    );
  }
  const candidates = [];
  root.walkAtRules("utility", (utility) => {
    const name = normalizeSpace(utility.params);
    const duplicate = candidates.find((candidate) => candidate === name);
    if (duplicate)
      throw new Error(`${label}: duplicate custom utility ${duplicate}`);
    // Functional utilities are emitted from their real callsite candidates;
    // a bare wildcard is not itself a valid candidate for @source inline.
    if (!name.endsWith("-*")) candidates.push(name);
  });
  return candidates;
}

function runtimeSourceFiles(root, label) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`${label}: cannot read ${directory}: ${error.message}`, {
        cause: error,
      });
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("__")) visit(resolved);
      } else if (
        entry.isFile() &&
        RUNTIME_SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
        !/\.(?:test|spec)\.[^.]+$/.test(entry.name)
      ) {
        files.push(resolved);
      }
    }
  };

  for (const directory of RUNTIME_SOURCE_DIRECTORIES) {
    const sourceDirectory = path.join(root, directory);
    if (!fs.statSync(sourceDirectory, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(
        `${label}: runtime candidate source directory is missing: ${sourceDirectory}`
      );
    visit(sourceDirectory);
  }
  return files;
}

function runtimeClassCandidates(root, label) {
  if (path.resolve(root) === MODULE_ROOT && moduleRuntimeCandidates)
    return moduleRuntimeCandidates;
  const sourceFiles = runtimeSourceFiles(root, label);
  const program = ts.createProgram({
    rootNames: sourceFiles,
    options: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      baseUrl: root,
      paths: { "@/*": ["*"] },
    },
  });
  const checker = program.getTypeChecker();
  const runtimeFiles = new Set(sourceFiles.map((file) => path.resolve(file)));
  const classRoots = [];
  const runtimeNodes = [];
  for (const file of sourceFiles) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile)
      throw new Error(
        `${label}: TypeScript did not load runtime source ${file}`
      );
    const parseError = program.getSyntacticDiagnostics(sourceFile)[0];
    if (parseError) {
      throw new Error(
        `${label}: cannot parse runtime candidates in ${file}: ${ts.flattenDiagnosticMessageText(parseError.messageText, "\n")}`
      );
    }
    const visit = (node) => {
      runtimeNodes.push(node);
      if (
        ts.isJsxAttribute(node) &&
        (node.name.text === "className" || node.name.text === "class") &&
        node.initializer
      )
        classRoots.push(node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const location = (node) => {
    const sourceFile = node.getSourceFile();
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    return `${path.relative(root, sourceFile.fileName)}:${line + 1}:${character + 1}`;
  };
  const bindingError = (node, detail) => {
    throw new Error(
      `${label}: cannot resolve class-bearing binding ${node.getText()} at ${location(node)}${detail ? ` (${detail})` : ""}`
    );
  };
  const fragments = [];
  const visitedDeclarations = new Set();
  const permissivelyVisitedDeclarations = new Set();

  const lookupSymbol = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (
      node.parent &&
      ts.isShorthandPropertyAssignment(node.parent) &&
      node.parent.name === node
    )
      symbol = checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol;
    if (!symbol) return null;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
      if (!symbol || symbol.flags & ts.SymbolFlags.Unknown) return null;
    }
    return symbol;
  };

  let callsiteIndex;
  const indexedCallsites = () => {
    if (callsiteIndex) return callsiteIndex;
    const calls = new Map();
    const jsx = new Map();
    const append = (index, symbol, node) => {
      if (!symbol) return;
      const nodes = index.get(symbol) ?? [];
      nodes.push(node);
      index.set(symbol, nodes);
    };
    for (const node of runtimeNodes) {
      if (ts.isCallExpression(node))
        append(
          calls,
          lookupSymbol(
            ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name
              : node.expression
          ),
          node
        );
      else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        append(jsx, lookupSymbol(node.tagName), node);
    }
    callsiteIndex = { calls, jsx };
    return callsiteIndex;
  };

  const unresolvedPackageOperator = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return false;
    for (const declaration of symbol.declarations ?? []) {
      let current = declaration;
      while (current && !ts.isImportDeclaration(current))
        current = current.parent;
      if (
        current &&
        ts.isStringLiteral(current.moduleSpecifier) &&
        !current.moduleSpecifier.text.startsWith(".") &&
        !current.moduleSpecifier.text.startsWith("@/")
      )
        return true;
    }
    return false;
  };

  const returnExpressions = (body) => {
    const expressions = [];
    if (!body) return;
    if (!ts.isBlock(body)) return [body];
    const visit = (node) => {
      if (ts.isFunctionLike(node) && node !== body) return;
      if (ts.isReturnStatement(node) && node.expression) {
        expressions.push(node.expression);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return expressions;
  };

  const visitReturns = (body, { allowDynamic = false } = {}) => {
    for (const expression of returnExpressions(body) ?? [])
      visitValue(expression, { allowDynamic });
  };

  const visitDeclaration = (declaration, { allowDynamic = false } = {}) => {
    if (visitedDeclarations.has(declaration)) return;
    if (allowDynamic && permissivelyVisitedDeclarations.has(declaration))
      return;
    if (allowDynamic) permissivelyVisitedDeclarations.add(declaration);
    else visitedDeclarations.add(declaration);
    if (ts.isBindingElement(declaration)) {
      if (declaration.initializer)
        visitValue(declaration.initializer, { allowDynamic });
      if (allowDynamic) return;
      const values = bindingOwnerValues(declaration);
      for (const value of values) visitValue(value);
      const descriptor = bindingDescriptor(declaration);
      if (
        !values.length &&
        !declaration.initializer &&
        descriptor?.owner?.kind === ts.SyntaxKind.Parameter &&
        !["className", "class"].includes(descriptor.pathSegments[0]) &&
        !parameterHasStaticOwner(descriptor.owner, descriptor.pathSegments)
      )
        bindingError(
          declaration,
          "class-bearing parameter has no statically readable owner"
        );
      return;
    }
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isEnumMember(declaration)
    ) {
      if (declaration.initializer)
        visitValue(declaration.initializer, { allowDynamic });
      return;
    }
    if (ts.isParameter(declaration)) {
      if (declaration.initializer)
        visitValue(declaration.initializer, { allowDynamic });
      if (allowDynamic) return;
      const values = parameterBindingValues(declaration, []);
      for (const value of values) visitValue(value);
      if (
        !values.length &&
        !declaration.initializer &&
        (ts.isArrowFunction(declaration.parent) ||
          ts.isFunctionExpression(declaration.parent)) &&
        ts.isCallExpression(declaration.parent.parent) &&
        declaration.parent.parent.arguments[0] === declaration.parent &&
        ts.isPropertyAccessExpression(declaration.parent.parent.expression) &&
        declaration.parent.parent.expression.name.text === "map" &&
        !parameterHasStaticOwner(declaration, [])
      )
        bindingError(
          declaration,
          "class-bearing parameter has no statically readable owner"
        );
      return;
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      visitBinding(declaration.name, { allowDynamic });
      return;
    }
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isGetAccessorDeclaration(declaration) ||
      ts.isArrowFunction(declaration)
    ) {
      visitReturns(declaration.body);
      return;
    }
    if (ts.isExportAssignment(declaration)) {
      visitValue(declaration.expression);
      return;
    }
    // Interface/type declarations and parameter properties describe values
    // supplied by a caller. Their static call-site strings are separate JSX
    // class roots, so they contribute no candidate from this binding.
    if (
      ts.isPropertySignature(declaration) ||
      ts.isMethodSignature(declaration) ||
      ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration)
    )
      return;
    bindingError(declaration, `unsupported ${ts.SyntaxKind[declaration.kind]}`);
  };

  const visitBinding = (
    node,
    { allowExternalDeclaration = false, allowDynamic = false } = {}
  ) => {
    const symbol = lookupSymbol(node);
    if (!symbol) {
      if (allowExternalDeclaration && unresolvedPackageOperator(node)) return;
      bindingError(node, "no lexical symbol or import target");
    }
    const declarations = symbol.declarations ?? [];
    if (!declarations.length) {
      if (allowExternalDeclaration && unresolvedPackageOperator(node)) return;
      bindingError(node, "symbol has no declaration");
    }
    const runtimeDeclarations = declarations.filter((declaration) =>
      runtimeFiles.has(path.resolve(declaration.getSourceFile().fileName))
    );
    if (!runtimeDeclarations.length) {
      // Imported functions such as clsx are class-expression operators. Their
      // arguments are walked by the call expression; package declarations do
      // not themselves contain application candidates.
      if (
        allowExternalDeclaration &&
        declarations.every(
          (declaration) => declaration.getSourceFile().isDeclarationFile
        )
      )
        return;
      bindingError(node, "binding is outside the runtime source inventory");
    }
    for (const declaration of runtimeDeclarations)
      visitDeclaration(declaration, { allowDynamic });
  };

  const unwrapExpression = (node) => {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      node = node.expression;
    return node;
  };

  const staticValues = (expression, seen = new Set(), callDepth = 0) => {
    expression = unwrapExpression(expression);
    if (seen.has(expression)) return [];
    seen.add(expression);
    if (ts.isIdentifier(expression)) {
      const symbol = lookupSymbol(expression);
      if (!symbol) return [];
      return (symbol.declarations ?? []).flatMap((declaration) => {
        if (
          !runtimeFiles.has(path.resolve(declaration.getSourceFile().fileName))
        )
          return [];
        if (
          (ts.isVariableDeclaration(declaration) ||
            ts.isPropertyDeclaration(declaration) ||
            ts.isPropertyAssignment(declaration) ||
            ts.isEnumMember(declaration)) &&
          declaration.initializer
        )
          return staticValues(
            declaration.initializer,
            new Set(seen),
            callDepth
          );
        if (ts.isBindingElement(declaration))
          return bindingOwnerValues(declaration, new Set(seen)).flatMap(
            (value) => staticValues(value, new Set(seen), callDepth)
          );
        if (ts.isParameter(declaration))
          return parameterBindingValues(declaration, []).flatMap((value) =>
            staticValues(value, new Set(seen), callDepth)
          );
        if (ts.isExportAssignment(declaration))
          return staticValues(declaration.expression, new Set(seen), callDepth);
        return [];
      });
    }
    if (ts.isPropertyAccessExpression(expression))
      return staticMemberValues(
        expression.expression,
        expression.name.text,
        seen,
        callDepth
      ).flatMap((value) => staticValues(value, new Set(seen), callDepth));
    if (ts.isElementAccessExpression(expression)) {
      const resolution = staticComputedKeys(
        expression.argumentExpression,
        seen
      );
      if (!resolution.keys.length)
        return allStaticMemberValues(
          expression.expression,
          new Set(seen),
          callDepth
        ).flatMap((value) => staticValues(value, new Set(seen), callDepth));
      if (
        resolution.source === "syntax" &&
        resolution.keys.length !== 1 &&
        hasAmbiguousStaticKeySource(expression.argumentExpression)
      )
        return [];
      return resolution.keys
        .flatMap((key) =>
          staticMemberValues(
            expression.expression,
            key,
            new Set(seen),
            callDepth
          )
        )
        .flatMap((value) => staticValues(value, new Set(seen), callDepth));
    }
    if (ts.isCallExpression(expression)) {
      if (callDepth >= 8) return [];
      const callee = ts.isPropertyAccessExpression(expression.expression)
        ? expression.expression.name
        : expression.expression;
      if (!ts.isIdentifier(callee)) return [];
      const symbol = lookupSymbol(callee);
      if (!symbol) return [];
      return (symbol.declarations ?? []).flatMap((declaration) => {
        const callable =
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          (ts.isFunctionExpression(declaration.initializer) ||
            ts.isArrowFunction(declaration.initializer))
            ? declaration.initializer
            : declaration;
        if (
          !runtimeFiles.has(
            path.resolve(declaration.getSourceFile().fileName)
          ) ||
          !(
            ts.isFunctionDeclaration(callable) ||
            ts.isFunctionExpression(callable) ||
            ts.isMethodDeclaration(callable) ||
            ts.isArrowFunction(callable)
          ) ||
          !callable.body ||
          seen.has(callable)
        )
          return [];
        seen.add(callable);
        return (returnExpressions(callable.body) ?? []).flatMap((value) =>
          staticValues(value, new Set(seen), callDepth + 1)
        );
      });
    }
    if (ts.isConditionalExpression(expression))
      return [
        ...staticValues(expression.whenTrue, new Set(seen), callDepth),
        ...staticValues(expression.whenFalse, new Set(seen), callDepth),
      ];
    return [expression];
  };

  const staticComputedKeys = (expression, seen = new Set()) => {
    if (!expression) return { keys: [], source: "none" };
    const syntaxKeys = [
      ...new Set(
        staticValues(expression, seen)
          .map(unwrapExpression)
          .filter(
            (value) =>
              ts.isStringLiteral(value) ||
              ts.isNoSubstitutionTemplateLiteral(value) ||
              ts.isNumericLiteral(value)
          )
          .map((value) => value.text)
      ),
    ];
    if (syntaxKeys.length) return { keys: syntaxKeys, source: "syntax" };

    const typeKeys = [];
    const collectTypeKeys = (type) => {
      if (type.isUnion()) {
        for (const member of type.types) collectTypeKeys(member);
      } else if (type.flags & ts.TypeFlags.StringLiteral) {
        typeKeys.push(type.value);
      } else if (type.flags & ts.TypeFlags.NumberLiteral) {
        typeKeys.push(String(type.value));
      }
    };
    collectTypeKeys(checker.getTypeAtLocation(expression));
    return { keys: [...new Set(typeKeys)], source: "type" };
  };

  const hasAmbiguousStaticKeySource = (expression, seen = new Set()) => {
    expression = unwrapExpression(expression);
    if (seen.has(expression)) return false;
    seen.add(expression);
    if (ts.isConditionalExpression(expression)) return true;
    if (!ts.isIdentifier(expression)) return false;
    const symbol = lookupSymbol(expression);
    return (symbol?.declarations ?? []).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        hasAmbiguousStaticKeySource(declaration.initializer, seen)
    );
  };

  const mayBeClassText = (node) => {
    const seen = new Set();
    const inspect = (type) => {
      if (seen.has(type)) return false;
      seen.add(type);
      if (type.isUnionOrIntersection()) return type.types.some(inspect);
      return Boolean(
        type.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.TypeParameter)
      );
    };
    return inspect(checker.getTypeAtLocation(node));
  };

  const isSyntacticCallArgument = (node) => {
    let current = node;
    while (current.parent && !ts.isFunctionLike(current.parent)) {
      const parent = current.parent;
      if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
        return parent.arguments?.includes(current) ?? false;
      if (
        ts.isStatement(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isJsxExpression(parent)
      )
        return false;
      current = parent;
    }
    return false;
  };

  const staticMemberValues = (
    expression,
    key,
    seen = new Set(),
    callDepth = 0
  ) => {
    const values = [];
    const owner = unwrapExpression(expression);
    if (ts.isIdentifier(owner)) {
      const symbol = lookupSymbol(owner);
      for (const declaration of symbol?.declarations ?? [])
        if (ts.isParameter(declaration))
          values.push(
            ...parameterBindingValues(declaration, [key], new Set(seen))
          );
      if (values.length) return values;
    }
    for (const initializer of staticValues(expression, seen, callDepth)) {
      if (ts.isArrayLiteralExpression(initializer)) {
        const index = Number(key);
        if (
          Number.isInteger(index) &&
          index >= 0 &&
          index < initializer.elements.length
        ) {
          const element = initializer.elements[index];
          if (!ts.isOmittedExpression(element))
            values.push(
              ts.isSpreadElement(element) ? element.expression : element
            );
        }
        continue;
      }
      if (!ts.isObjectLiteralExpression(initializer)) continue;
      for (const property of initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name) ||
            ts.isNumericLiteral(property.name)) &&
          property.name.text === key
        )
          values.push(property.initializer);
        else if (
          ts.isShorthandPropertyAssignment(property) &&
          property.name.text === key
        )
          values.push(property.name);
        else if (ts.isSpreadAssignment(property))
          values.push(
            ...staticMemberValues(
              property.expression,
              key,
              new Set(seen),
              callDepth
            )
          );
      }
    }
    return values;
  };

  const allStaticMemberValues = (
    expression,
    seen = new Set(),
    callDepth = 0
  ) => {
    const values = [];
    for (const initializer of staticValues(expression, seen, callDepth)) {
      if (ts.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.elements)
          if (!ts.isOmittedExpression(element))
            values.push(
              ts.isSpreadElement(element) ? element.expression : element
            );
      } else if (ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if (ts.isPropertyAssignment(property))
            values.push(property.initializer);
          else if (ts.isShorthandPropertyAssignment(property))
            values.push(property.name);
          else if (ts.isSpreadAssignment(property))
            values.push(
              ...allStaticMemberValues(
                property.expression,
                new Set(seen),
                callDepth
              )
            );
        }
      }
    }
    return values;
  };

  const bindingDescriptor = (binding) => {
    const pathSegments = [];
    let current = binding;
    while (ts.isBindingElement(current)) {
      if (current.dotDotDotToken) return null;
      if (ts.isObjectBindingPattern(current.parent)) {
        const keyNode = current.propertyName ?? current.name;
        if (!ts.isIdentifier(keyNode) && !ts.isStringLiteral(keyNode))
          return null;
        pathSegments.unshift(keyNode.text);
      } else if (ts.isArrayBindingPattern(current.parent)) {
        const index = current.parent.elements.indexOf(current);
        if (index < 0) return null;
        pathSegments.unshift(String(index));
      } else {
        return null;
      }
      const owner = current.parent.parent;
      if (!ts.isBindingElement(owner)) return { owner, pathSegments };
      current = owner;
    }
    return null;
  };

  const applyStaticPath = (initialValues, pathSegments, seen = new Set()) => {
    let values = initialValues.map((value) =>
      ts.isJsxExpression(value) && value.expression ? value.expression : value
    );
    for (const key of pathSegments)
      values = values.flatMap((value) =>
        staticMemberValues(value, key, new Set(seen))
      );
    return values;
  };

  const callableSymbol = (callable) => {
    if (callable.name && ts.isIdentifier(callable.name))
      return lookupSymbol(callable.name);
    if (
      (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) &&
      ts.isVariableDeclaration(callable.parent) &&
      ts.isIdentifier(callable.parent.name)
    )
      return lookupSymbol(callable.parent.name);
    return null;
  };

  const jsxAttributeValues = (attributes, key) => {
    let values = [];
    for (const property of attributes.properties) {
      if (
        ts.isJsxAttribute(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === key
      )
        values = property.initializer ? [property.initializer] : [];
      else if (ts.isJsxSpreadAttribute(property)) {
        const spreadValues = staticMemberValues(property.expression, key);
        if (spreadValues.length) values = spreadValues;
      }
    }
    return values;
  };

  const parameterBindingValues = (
    parameter,
    pathSegments,
    seen = new Set()
  ) => {
    const callable = parameter.parent;
    if (!ts.isFunctionLike(callable)) return [];
    const parameterIndex = callable.parameters.indexOf(parameter);
    if (parameterIndex < 0) return [];

    // Inline Array#map callbacks receive the values of their statically known
    // receiver. The first callback parameter is the item; later parameters are
    // runtime index/collection data and cannot carry a static class binding.
    if (
      parameterIndex === 0 &&
      (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) &&
      ts.isCallExpression(callable.parent) &&
      callable.parent.arguments[0] === callable &&
      ts.isPropertyAccessExpression(callable.parent.expression) &&
      callable.parent.expression.name.text === "map"
    )
      return applyStaticPath(
        allStaticMemberValues(callable.parent.expression.expression),
        pathSegments,
        seen
      );

    const symbol = callableSymbol(callable);
    if (!symbol) return [];
    const values = [];
    const callsites = indexedCallsites();
    for (const node of callsites.calls.get(symbol) ?? []) {
      const argument = node.arguments[parameterIndex];
      if (argument)
        values.push(...applyStaticPath([argument], pathSegments, seen));
    }
    if (parameterIndex === 0 && pathSegments.length)
      for (const node of callsites.jsx.get(symbol) ?? []) {
        const [propName, ...nestedPath] = pathSegments;
        values.push(
          ...applyStaticPath(
            jsxAttributeValues(node.attributes, propName),
            nestedPath,
            seen
          )
        );
      }
    return values;
  };

  const parameterHasStaticOwner = (parameter, pathSegments) => {
    const callable = parameter.parent;
    if (!ts.isFunctionLike(callable)) return false;
    const parameterIndex = callable.parameters.indexOf(parameter);
    if (parameterIndex < 0) return false;
    if (
      parameterIndex === 0 &&
      (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) &&
      ts.isCallExpression(callable.parent) &&
      callable.parent.arguments[0] === callable &&
      ts.isPropertyAccessExpression(callable.parent.expression) &&
      callable.parent.expression.name.text === "map"
    )
      return staticValues(callable.parent.expression.expression).some(
        ts.isArrayLiteralExpression
      );

    const symbol = callableSymbol(callable);
    if (!symbol) return false;
    const callsites = indexedCallsites();
    return (
      (callsites.calls.get(symbol)?.length ?? 0) > 0 ||
      (parameterIndex === 0 &&
        pathSegments.length > 0 &&
        (callsites.jsx.get(symbol)?.length ?? 0) > 0)
    );
  };

  const bindingOwnerValues = (binding, seen = new Set()) => {
    const descriptor = bindingDescriptor(binding);
    if (!descriptor) return [];
    if (ts.isVariableDeclaration(descriptor.owner)) {
      if (!descriptor.owner.initializer) return [];
      return applyStaticPath(
        [descriptor.owner.initializer],
        descriptor.pathSegments,
        seen
      );
    }
    if (ts.isParameter(descriptor.owner))
      return parameterBindingValues(
        descriptor.owner,
        descriptor.pathSegments,
        seen
      );
    return [];
  };

  const visitPropertyName = (name, { allowDynamic = false } = {}) => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name))
      fragments.push(name.text);
    else if (ts.isComputedPropertyName(name))
      visitValue(name.expression, { allowDynamic });
  };

  function visitValue(node, { allowDynamic = false } = {}) {
    if (!node) return;
    const visitChild = (child) => visitValue(child, { allowDynamic });
    if (ts.isJsxExpression(node)) {
      visitChild(node.expression);
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      fragments.push(node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      fragments.push(node.head.text);
      for (const span of node.templateSpans) {
        visitChild(span.expression);
        fragments.push(span.literal.text);
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return;
      visitBinding(node, { allowDynamic });
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const values = staticMemberValues(node.expression, node.name.text);
      if (values.length) {
        for (const value of values) visitChild(value);
        return;
      }
      const propertySymbol = lookupSymbol(node.name);
      if (propertySymbol?.declarations?.length)
        visitBinding(node.name, {
          allowExternalDeclaration: true,
          allowDynamic,
        });
      else
        bindingError(
          node.name,
          "member initializer is not statically readable"
        );
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const resolution = staticComputedKeys(node.argumentExpression);
      if (
        resolution.source === "syntax" &&
        resolution.keys.length !== 1 &&
        hasAmbiguousStaticKeySource(node.argumentExpression)
      )
        bindingError(
          node,
          resolution.keys.length
            ? `computed class key is ambiguous: ${resolution.keys.join(", ")}`
            : "computed class key is not statically readable"
        );
      const values = resolution.keys.length
        ? resolution.keys.flatMap((key) =>
            staticMemberValues(node.expression, key)
          )
        : allStaticMemberValues(node.expression);
      if (
        !values.length &&
        (!allowDynamic ||
          (isSyntacticCallArgument(node) && mayBeClassText(node)))
      )
        bindingError(
          node,
          resolution.keys.length
            ? `computed class members ${resolution.keys.join(", ")} are not readable`
            : "computed class owner is not statically enumerable"
        );
      for (const value of values) visitChild(value);
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      // Calls inside class expressions often combine class strings with
      // ordinary runtime data. Resolve any static argument candidates, but do
      // not require unrelated business data to have a finite static owner.
      for (const argument of node.arguments ?? [])
        visitValue(argument, { allowDynamic: true });
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      if (ts.isIdentifier(callee))
        visitBinding(callee, { allowExternalDeclaration: true });
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      visitChild(node.template);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visitChild(node.whenTrue);
      visitChild(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      visitChild(node.left);
      visitChild(node.right);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements)
        visitChild(ts.isSpreadElement(element) ? element.expression : element);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          visitPropertyName(property.name, { allowDynamic });
          visitChild(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          fragments.push(property.name.text);
          visitBinding(property.name, { allowDynamic });
        } else if (ts.isSpreadAssignment(property)) {
          visitChild(property.expression);
        } else if (ts.isMethodDeclaration(property)) {
          visitReturns(property.body, { allowDynamic });
        }
      }
      return;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      visitChild(node.expression);
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      visitReturns(node.body, { allowDynamic });
      return;
    }
    if (
      ts.isPrefixUnaryExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    )
      return;
    // Unsupported syntax inside a class value can hide a static binding, so an
    // apparently empty candidate set is not a valid proof.
    bindingError(node, `unsupported ${ts.SyntaxKind[node.kind]}`);
  }

  for (const rootNode of classRoots) visitValue(rootNode);

  const scanner = new Scanner({ sources: [] });
  const candidates = scanner
    .scanFiles([{ content: fragments.join("\n"), extension: "html" }])
    .sort();
  if (path.resolve(root) === MODULE_ROOT) moduleRuntimeCandidates = candidates;
  return candidates;
}

function assertPhoneOnlyRegistry(source, registry, label, requireRegistry) {
  const registered = registry.map(({ name }) => name);
  const duplicate = registered.find(
    (name, index) => registered.indexOf(name) !== index
  );
  if (duplicate)
    throw new Error(
      `${label}: duplicate phone-only registry entry ${duplicate}`
    );

  const candidates = phoneOnlyUtilityCandidates(source, label);
  if (requireRegistry) {
    const omitted = candidates.find((name) => !registered.includes(name));
    if (omitted) {
      throw new Error(
        `${label}: phone-contributing utility ${omitted} is not registered`
      );
    }
    const missing = registered.find((name) => !candidates.includes(name));
    if (missing) {
      throw new Error(
        `${label}: registered utility ${missing} has no phone contribution in the source sheet`
      );
    }
  }
}

function deterministicInput(source, root, registry, label) {
  const occurrences = source.split(TAILWIND_IMPORT).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one ${TAILWIND_IMPORT} in app/globals.css; found ${occurrences}`
    );
  }
  const names = [
    ...new Set([
      ...customUtilityCandidates(source, label),
      ...registry.map(({ name }) => name),
      ...runtimeClassCandidates(root, label),
    ]),
  ].join(" ");
  return source.replace(
    TAILWIND_IMPORT,
    `@import "tailwindcss" source(none);\n@source inline(${JSON.stringify(names)});`
  );
}

export function assertCompiledSheet(css, label) {
  if (!css?.trim())
    throw new Error(`${label}: CSS compilation produced no output`);
  if (Buffer.byteLength(css) < COMPILED_BYTE_FLOOR) {
    throw new Error(
      `${label}: compiled CSS is only ${Buffer.byteLength(css)} bytes; expected at least ${COMPILED_BYTE_FLOOR}, so the sheet was not read completely`
    );
  }
  return css;
}

export async function compilePhoneOnlyCssText(
  source,
  {
    root,
    label = root,
    registry = PHONE_ONLY_UTILITIES,
    requireRegistry = true,
  }
) {
  if (!root) throw new Error("compilePhoneOnlyCssText requires a root");
  assertPhoneOnlyRegistry(source, registry, label, requireRegistry);
  const css = deterministicInput(source, root, registry, label);
  try {
    const compiled = (
      await postcss([tailwind({ base: root })]).process(css, {
        // Resolve Tailwind from the implementation worktree even when the
        // control worktree deliberately has no node_modules directory.
        from: path.join(MODULE_ROOT, "app", "globals.css"),
      })
    ).css;
    return assertCompiledSheet(compiled, label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label}:`))
      throw error;
    throw new Error(`${label}: CSS compilation failed: ${error.message}`, {
      cause: error,
    });
  }
}

export async function compilePhoneOnlyCss(
  root,
  { label = root, registry = PHONE_ONLY_UTILITIES, requireRegistry = true } = {}
) {
  const globals = path.join(root, "app", "globals.css");
  let source;
  try {
    source = fs.readFileSync(globals, "utf8");
  } catch (error) {
    throw new Error(`${label}: cannot read ${globals}: ${error.message}`, {
      cause: error,
    });
  }
  return compilePhoneOnlyCssText(source, {
    root,
    label,
    registry,
    requireRegistry,
  });
}

function utilityPattern(name) {
  return new RegExp(`(^|[^\\w-])\\.${name}(?![\\w-])`);
}

function phoneAncestor(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.type === "atrule" &&
      parent.name === "media" &&
      isPhoneMedia(parent.params)
    )
      return true;
  }
  return false;
}

function registeredDeclarations(root, registry) {
  const byUtility = new Map(registry.map(({ name }) => [name, []]));
  root.walkRules((rule) => {
    for (const { name } of registry) {
      if (!utilityPattern(name).test(rule.selector)) continue;
      for (const node of rule.nodes ?? []) {
        if (node.type !== "decl") continue;
        byUtility.get(name).push({
          selector: normalizeSpace(rule.selector),
          property: node.prop,
          value: normalizeSpace(node.value),
          important: node.important,
          phoneOnly: phoneAncestor(rule),
        });
      }
    }
  });
  return byUtility;
}

function pruneEmpty(container) {
  for (const node of [...(container.nodes ?? [])]) {
    if ("nodes" in node) pruneEmpty(node);
    if (
      (node.type === "rule" || node.type === "atrule") &&
      Array.isArray(node.nodes) &&
      node.nodes.every((child) => child.type === "comment")
    )
      node.remove();
  }
}

export function stripPhoneContributions(css) {
  const root = postcss.parse(css);
  let blocks = 0;
  let declarations = 0;
  root.walkAtRules("media", (rule) => {
    if (!isPhoneMedia(rule.params)) return;
    blocks++;
    rule.walkDecls(() => declarations++);
    rule.remove();
  });
  pruneEmpty(root);
  return { root, blocks, declarations };
}

function propertyRegistrationContext(root) {
  const seen = new Set();
  const atomic = new Set();
  for (const node of root.nodes ?? []) {
    if (node.type !== "atrule" || node.name !== "property") continue;
    const name = normalizeSpace(node.params);
    if (seen.has(name))
      throw new Error(`duplicate @property registration ${name}`);
    seen.add(name);
    if (
      /^--[\w-]+$/.test(name) &&
      Array.isArray(node.nodes) &&
      node.nodes.every(
        (child) => child.type === "decl" || child.type === "comment"
      )
    )
      atomic.add(node);
  }
  return { names: seen, atomic };
}

function isPropertyFallbackRule(node, propertyNames) {
  if (
    node.type !== "rule" ||
    normalizeSpace(node.selector) !== "*, ::before, ::after, ::backdrop" ||
    node.parent?.type !== "atrule" ||
    node.parent.name !== "supports" ||
    node.parent.parent?.type !== "atrule" ||
    node.parent.parent.name !== "layer" ||
    normalizeSpace(node.parent.parent.params) !== "properties"
  )
    return false;
  const declarations = (node.nodes ?? []).filter(
    (child) => child.type !== "comment"
  );
  return (
    declarations.length > 0 &&
    declarations.every(
      (child) => child.type === "decl" && propertyNames.has(child.prop)
    )
  );
}

function semanticChildren(container, propertyContext) {
  const nodes = (container.nodes ?? []).filter(
    (node) => node.type !== "comment"
  );
  const children = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (container.type === "root" && propertyContext.atomic.has(node)) {
      const registrations = [];
      while (index < nodes.length && propertyContext.atomic.has(nodes[index])) {
        const registration = nodes[index];
        registrations.push([
          "atrule",
          registration.name,
          registration.params,
          semanticChildren(registration, propertyContext),
        ]);
        index++;
      }
      index--;
      registrations.sort((left, right) => left[2].localeCompare(right[2]));
      children.push(...registrations);
      continue;
    }
    if (node.type === "decl") {
      children.push(["decl", node.prop, node.value, node.important]);
    } else if (node.type === "rule") {
      let descendants;
      if (isPropertyFallbackRule(node, propertyContext.names)) {
        const declarations = node.nodes.filter(
          (child) => child.type !== "comment"
        );
        const seen = new Set();
        for (const declaration of declarations) {
          if (seen.has(declaration.prop))
            throw new Error(
              `duplicate fallback declaration ${declaration.prop}`
            );
          seen.add(declaration.prop);
        }
        descendants = declarations
          .map((declaration) => [
            "decl",
            declaration.prop,
            declaration.value,
            declaration.important,
          ])
          .sort((left, right) => left[1].localeCompare(right[1]));
      } else {
        descendants = semanticChildren(node, propertyContext);
      }
      if (!descendants.length) continue;
      children.push(["rule", node.selector, descendants]);
    } else if (node.type === "atrule") {
      children.push([
        "atrule",
        node.name,
        node.params,
        node.nodes ? semanticChildren(node, propertyContext) : null,
      ]);
    } else {
      throw new Error(`unsupported compiled CSS node type: ${node.type}`);
    }
  }
  return children;
}

export function inspectPhoneOnlyCss(
  css,
  {
    label = "compiled sheet",
    registry = PHONE_ONLY_UTILITIES,
    requireRegistry = true,
  } = {}
) {
  assertCompiledSheet(css, label);
  const fullRoot = postcss.parse(css);
  const found = registeredDeclarations(fullRoot, registry);
  const counts = Object.fromEntries(
    [...found].map(([name, declarations]) => [name, declarations.length])
  );
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  const leaked = [...found].flatMap(([name, declarations]) =>
    declarations
      .filter(({ phoneOnly }) => !phoneOnly)
      .map(
        ({ selector, property, value }) =>
          `${name}: ${selector} { ${property}: ${value} }`
      )
  );
  if (leaked.length) {
    throw new Error(
      `${label}: registered phone-only declarations can apply at sm or above:\n${leaked.join("\n")}`
    );
  }

  if (requireRegistry) {
    for (const entry of registry) {
      const declarations = found.get(entry.name) ?? [];
      if (declarations.length < entry.minDeclarations) {
        throw new Error(
          `${label}: registered utility ${entry.name} compiled ${declarations.length} declarations; expected at least ${entry.minDeclarations} (missing, renamed, or no longer scanned)`
        );
      }
      const properties = new Set(declarations.map(({ property }) => property));
      const missing = entry.properties.filter(
        (property) => !properties.has(property)
      );
      if (missing.length) {
        throw new Error(
          `${label}: registered utility ${entry.name} is missing expected compiled declarations: ${missing.join(", ")}`
        );
      }
    }
    if (total < PHONE_DECLARATION_FLOOR) {
      throw new Error(
        `${label}: registry census found ${total} declarations; expected at least ${PHONE_DECLARATION_FLOOR}`
      );
    }
  }

  const stripped = stripPhoneContributions(css);
  if (
    stripped.blocks < PHONE_BLOCK_FLOOR ||
    stripped.declarations < PHONE_DECLARATION_FLOOR
  ) {
    throw new Error(
      `${label}: structural strip reached only ${stripped.blocks} phone blocks / ${stripped.declarations} declarations for a ${total}-declaration registry census`
    );
  }
  return {
    bytes: Buffer.byteLength(css),
    counts,
    total,
    strippedBlocks: stripped.blocks,
    strippedDeclarations: stripped.declarations,
    // Serialize semantic AST fields, not presentation whitespace. Declaration
    // values and every child stay in source order: spaces inside strings and a
    // later declaration winning the cascade are both browser-visible.
    desktop: JSON.stringify(
      semanticChildren(
        stripped.root,
        propertyRegistrationContext(stripped.root)
      )
    ),
  };
}

export async function provePhoneOnlyCss({ branchRoot, controlRoot }) {
  const [branchCss, controlCss] = await Promise.all([
    compilePhoneOnlyCss(branchRoot, { label: "branch" }),
    compilePhoneOnlyCss(controlRoot, {
      label: "control",
      requireRegistry: false,
    }),
  ]);
  const branch = inspectPhoneOnlyCss(branchCss, { label: "branch" });
  const control = inspectPhoneOnlyCss(controlCss, {
    label: "control",
    requireRegistry: false,
  });
  if (branch.desktop !== control.desktop) {
    throw new Error(
      "desktop-visible compiled declarations differ after structurally removing the registered phone contributions; this proof cannot claim the change contributes nothing at sm or above"
    );
  }
  return { branch, control };
}

function parseArgs(argv) {
  let branchRoot = process.cwd();
  let controlRoot = null;
  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--"))
        throw new Error(`${argv[i - 1]} requires a path`);
      return path.resolve(next);
    };
    if (argv[i] === "--branch") branchRoot = value();
    else if (argv[i] === "--control") controlRoot = value();
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!controlRoot)
    throw new Error(
      "usage: node scripts/phone-only-css-proof.mjs [--branch <worktree>] --control <origin/main worktree>"
    );
  return { branchRoot, controlRoot };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await provePhoneOnlyCss(parseArgs(process.argv.slice(2)));
    for (const [name, receipt] of Object.entries(result))
      console.log(
        `${name}: ${receipt.bytes} bytes; ${receipt.total} registered declarations; ` +
          `${receipt.strippedBlocks} phone blocks / ${receipt.strippedDeclarations} declarations stripped`
      );
    console.log(
      "PASS: registered phone-only utilities introduce no declaration that can apply at sm or above (scope only; this does not prove cascade replacement safety)"
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
