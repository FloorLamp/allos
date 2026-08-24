import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import {
  COMPILED_BYTE_FLOOR,
  PHONE_BLOCK_FLOOR,
  PHONE_DECLARATION_FLOOR,
  PHONE_ONLY_UTILITIES,
} from "./phone-only-css-registry.mjs";

const TAILWIND_IMPORT = '@import "tailwindcss";';
const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

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

function deterministicInput(source, registry) {
  const occurrences = source.split(TAILWIND_IMPORT).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one ${TAILWIND_IMPORT} in app/globals.css; found ${occurrences}`
    );
  }
  const names = registry.map(({ name }) => name).join(" ");
  return source.replace(
    TAILWIND_IMPORT,
    `@import "tailwindcss" source(none);\n@source inline("${names}");`
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
  const css = deterministicInput(source, registry);
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

function semanticChildren(container) {
  const children = [];
  for (const node of container.nodes ?? []) {
    if (node.type === "comment") continue;
    if (node.type === "decl") {
      children.push(["decl", node.prop, node.value, node.important]);
    } else if (node.type === "rule") {
      const descendants = semanticChildren(node);
      if (!descendants.length) continue;
      children.push(["rule", node.selector, descendants]);
    } else if (node.type === "atrule") {
      children.push([
        "atrule",
        node.name,
        node.params,
        node.nodes ? semanticChildren(node) : null,
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
    desktop: JSON.stringify(semanticChildren(stripped.root)),
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
