// What does this symbol reach? (#5680)
//
// Given a function declared in one mod, walk the import/call graph OUTWARD —
// to the functions that use it, to the functions that use those, across barrels
// and re-exports — until the value lands on a TERMINAL: a rendered `app/` mod,
// a Server Action, a served route, or a notification send. The reviewer CLI
// (scripts/reach.ts) prints the paths; lib/__tests__/reach.test.ts pins the
// terminal sets of the derivations that feed notifications.
//
// EDGES are import bindings, not names. A file consumes a symbol only when it
// imports that exact name from a mod that exports it (directly or through
// `export *` / `export { a as b } from`), or when it is the defining mod. The
// consumer is the top-level declaration whose body references the binding —
// a function, a `const`, a class, a default export. Type-only imports, type
// positions and `typeof` queries are not edges: a type carries no value anywhere.
//
// TERMINALS. `app/**/*.tsx` renders; `app/**/*actions.ts` exports are Server
// Actions; `app/**/route.ts` exports are served routes; a call, inside any
// walked function, to one of the SENDERS below puts a message on a channel.
// The walk stops at a rendered mod, an action and a route (nothing consumes
// a page). A send is recorded and the walk continues, because the function
// that sends may also be reached by a route or a page.
//
// KNOWN BLIND SPOTS, by construction: a symbol reached through a string-keyed
// registry (`handlers[kind](...)` where the table maps to the function) is one
// hop — the table's declaration — and the walk follows the table's consumers,
// which is right; but a name looked up from an untyped `Record<string, unknown>`
// is not followed past the lookup. A `dynamic()` import is followed only through
// the three shapes below (`const { a } = await import()`, `const m = await
// import()`, `const X = dynamic(() => import())`). Local shadowing of an
// imported name inside a function is not modelled. Module-level statements
// outside any declaration are not attributed to a consumer.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript-api";

export const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const ROOTS = ["app", "components", "lib"] as const;
const SKIP_DIR =
  /(^|\/)(__tests__|__db_tests__|__action_tests__|node_modules)(\/|$)/;

// (mod, export) pairs whose call puts a message on a channel. Bound by import,
// so a same-named local helper elsewhere is not mistaken for one. tick.ts's `send`
// is file-local, hence the third form.
const SENDERS: ReadonlyArray<readonly [string, string]> = [
  ["lib/notifications/index.ts", "dispatch"],
  ["lib/notifications/telegram.ts", "sendTelegramMessage"],
  ["lib/notifications/telegram.ts", "rebuildMessage"],
  ["lib/notifications/telegram.ts", "closeMessage"],
  ["lib/notifications/telegram.ts", "updateMessageKeyboard"],
  ["lib/notifications/telegram-api.ts", "sendMessageRaw"],
  ["lib/notifications/telegram-api.ts", "editMessageTextRaw"],
  ["lib/notifications/telegram-api.ts", "editMessageReplyMarkupRaw"],
  ["lib/notifications/tick.ts", "send"],
];
const SENDER_KEYS = new Set(SENDERS.map(([m, n]) => `${m}#${n}`));

export type TerminalKind = "render" | "action" | "route" | "send";

export interface SymbolRef {
  file: string; // repo-relative
  name: string; // top-level declaration name ("default" for an anonymous default export)
}

export interface Terminal extends SymbolRef {
  kind: TerminalKind;
  line: number; // where the reach lands: the reference line, or the send call
}

export interface ReachEdge {
  from: SymbolRef;
  to: SymbolRef;
  line: number; // line in `to.file` where `from` is referenced
  repeat?: true; // `to` was already reached by an earlier edge; not expanded again
}

export interface ReachResult {
  start: SymbolRef & { line: number };
  edges: ReachEdge[]; // BFS order; the non-repeat edges form a spanning tree
  terminals: Terminal[];
}

// ─── per-file facts ──────────────────────────────────────────────────────────

interface Binding {
  mod: string; // resolved repo-relative file
  name: string; // imported export name, "*" for a namespace, "default"
}

interface Decl {
  name: string;
  names: string[]; // every name a destructuring declaration binds
  line: number;
  exported: boolean;
  refs: Map<string, number>; // identifier -> first reference line
  members: Map<string, number>; // "ns.member" -> first reference line
  calls: Map<string, number[]>; // callee identifier -> call lines
}

type ExportEntry =
  | { kind: "local"; local: string }
  | { kind: "reexport"; mod: string; name: string };

interface FileFacts {
  file: string;
  bindings: Map<string, Binding>; // local name -> import
  exports: Map<string, ExportEntry>;
  stars: string[]; // `export * from` targets
  decls: Decl[];
}

const factsCache = new Map<string, FileFacts>();
let fileList: string[] | null = null;
let importersIndex: Map<string, Set<string>> | null = null;

function listFiles(): string[] {
  if (fileList) return fileList;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(ROOT, abs);
      if (SKIP_DIR.test(rel)) continue;
      if (entry.isDirectory()) walk(abs);
      else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !/\.(test|d)\.tsx?$/.test(entry.name)
      )
        out.push(rel);
    }
  };
  for (const root of ROOTS) walk(path.join(ROOT, root));
  fileList = out;
  return out;
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export function resolveSpecifier(
  fromFile: string,
  spec: string
): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.join(path.dirname(fromFile), spec);
  else return null;
  base = path.normalize(base);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (
      /\.(ts|tsx)$/.test(candidate) &&
      fs.existsSync(path.join(ROOT, candidate)) &&
      fs.statSync(path.join(ROOT, candidate)).isFile()
    )
      return candidate;
  }
  return null;
}

// Reverse import index from a cheap text scan: which files name each mod in
// an import, re-export or dynamic import. Only the files this finds are parsed.
function importersOf(file: string): Set<string> {
  if (!importersIndex) {
    importersIndex = new Map();
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
    for (const f of listFiles()) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const m of text.matchAll(re)) {
        const target = resolveSpecifier(f, m[1]);
        if (!target || target === f) continue;
        let set = importersIndex.get(target);
        if (!set) importersIndex.set(target, (set = new Set()));
        set.add(f);
      }
    }
  }
  return importersIndex.get(file) ?? new Set();
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else
    for (const el of name.elements)
      if (ts.isBindingElement(el)) bindingNames(el.name, out);
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.DefaultKeyword
    )
  );
}

// The literal mod a dynamic `import("...")` names, if `node` is one.
function dynamicImportSpecifier(node: ts.Node): string | null {
  const inner = ts.isAwaitExpression(node) ? node.expression : node;
  if (
    ts.isCallExpression(inner) &&
    inner.expression.kind === ts.SyntaxKind.ImportKeyword &&
    inner.arguments.length === 1 &&
    ts.isStringLiteral(inner.arguments[0])
  )
    return inner.arguments[0].text;
  return null;
}

function collectRefs(sf: ts.SourceFile, root: ts.Node, decl: Decl): void {
  const line = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const first = (map: Map<string, number>, key: string, n: ts.Node): void => {
    if (!map.has(key)) map.set(key, line(n));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isInterfaceDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isJsxAttribute(parent) && parent.name === node) ||
        ((ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isBindingElement(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isEnumMember(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isName) first(decl.refs, node.text, node);
      return;
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
      first(decl.members, `${node.expression.text}.${node.name.text}`, node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const lines = decl.calls.get(node.expression.text) ?? [];
      lines.push(line(node));
      decl.calls.set(node.expression.text, lines);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
}

export function fileFacts(file: string): FileFacts {
  const cached = factsCache.get(file);
  if (cached) return cached;
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const facts: FileFacts = {
    file,
    bindings: new Map(),
    exports: new Map(),
    stars: [],
    decls: [],
  };
  const lineOf = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const newDecl = (name: string, names: string[], node: ts.Node): Decl => ({
    name,
    names,
    line: lineOf(node),
    exported: hasExportModifier(node),
    refs: new Map(),
    members: new Map(),
    calls: new Map(),
  });
  // Named `export { a as b }` lists with no mod resolve after imports and
  // declarations are known, so they are collected first and applied last.
  const localExportLists: ts.NamedExports[] = [];

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (!ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
      if (st.importClause.isTypeOnly) continue;
      const mod = resolveSpecifier(file, st.moduleSpecifier.text);
      if (!mod) continue;
      const clause = st.importClause;
      if (clause.name)
        facts.bindings.set(clause.name.text, { mod, name: "default" });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named))
        facts.bindings.set(named.name.text, { mod, name: "*" });
      if (named && ts.isNamedImports(named))
        for (const el of named.elements) {
          if (el.isTypeOnly) continue;
          facts.bindings.set(el.name.text, {
            mod,
            name: el.propertyName?.text ?? el.name.text,
          });
        }
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const mod =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? resolveSpecifier(file, st.moduleSpecifier.text)
          : null;
      if (!st.exportClause) {
        if (mod) facts.stars.push(mod);
      } else if (ts.isNamedExports(st.exportClause)) {
        if (!mod) localExportLists.push(st.exportClause);
        else
          for (const el of st.exportClause.elements) {
            if (el.isTypeOnly) continue;
            facts.exports.set(el.name.text, {
              kind: "reexport",
              mod,
              name: el.propertyName?.text ?? el.name.text,
            });
          }
      }
      continue;
    }
    if (ts.isExportAssignment(st)) {
      // `export default expr` — an identifier names a declaration; anything else
      // is a declaration of its own called "default".
      if (!st.isExportEquals && ts.isIdentifier(st.expression)) {
        facts.exports.set("default", {
          kind: "local",
          local: st.expression.text,
        });
      } else {
        const decl = newDecl("default", ["default"], st);
        decl.exported = true;
        collectRefs(sf, st, decl);
        facts.decls.push(decl);
        facts.exports.set("default", { kind: "local", local: "default" });
      }
      continue;
    }
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      const name = st.name?.text ?? "default";
      const decl = newDecl(name, [name], st);
      collectRefs(sf, st, decl);
      facts.decls.push(decl);
      if (decl.exported) {
        facts.exports.set(hasDefaultModifier(st) ? "default" : name, {
          kind: "local",
          local: name,
        });
      }
      continue;
    }
    if (ts.isVariableStatement(st)) {
      const exported = hasExportModifier(st);
      for (const vd of st.declarationList.declarations) {
        const names: string[] = [];
        bindingNames(vd.name, names);
        const decl = newDecl(names[0] ?? "default", names, vd);
        decl.exported = exported;
        collectRefs(sf, vd, decl);
        // Dynamic import shapes: bind what the declaration receives.
        if (vd.initializer) {
          const direct = dynamicImportSpecifier(vd.initializer);
          const lazy =
            !direct &&
            ts.isCallExpression(vd.initializer) &&
            vd.initializer.arguments.length > 0 &&
            ts.isArrowFunction(vd.initializer.arguments[0])
              ? dynamicImportSpecifier(vd.initializer.arguments[0].body)
              : null;
          const spec = direct ?? lazy;
          const mod = spec ? resolveSpecifier(file, spec) : null;
          if (mod && direct && ts.isObjectBindingPattern(vd.name)) {
            for (const el of vd.name.elements)
              if (ts.isIdentifier(el.name))
                facts.bindings.set(el.name.text, {
                  mod,
                  name:
                    el.propertyName && ts.isIdentifier(el.propertyName)
                      ? el.propertyName.text
                      : el.name.text,
                });
          } else if (mod && direct && ts.isIdentifier(vd.name)) {
            facts.bindings.set(vd.name.text, { mod, name: "*" });
          } else if (mod && lazy && ts.isIdentifier(vd.name)) {
            facts.bindings.set(vd.name.text, { mod, name: "default" });
          }
        }
        facts.decls.push(decl);
        if (exported)
          for (const n of names)
            facts.exports.set(n, { kind: "local", local: n });
      }
      continue;
    }
  }
  // Dynamic-import bindings declared inside function bodies (`const { a } = await
  // import("x")` in a handler) are found by the body walk; hoist them to the file.
  const hoistDynamic = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const spec = dynamicImportSpecifier(node.initializer);
      const mod = spec ? resolveSpecifier(file, spec) : null;
      if (mod && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements)
          if (ts.isIdentifier(el.name) && !facts.bindings.has(el.name.text))
            facts.bindings.set(el.name.text, {
              mod,
              name:
                el.propertyName && ts.isIdentifier(el.propertyName)
                  ? el.propertyName.text
                  : el.name.text,
            });
      } else if (mod && ts.isIdentifier(node.name)) {
        if (!facts.bindings.has(node.name.text))
          facts.bindings.set(node.name.text, { mod, name: "*" });
      }
    }
    ts.forEachChild(node, hoistDynamic);
  };
  hoistDynamic(sf);

  for (const list of localExportLists)
    for (const el of list.elements) {
      if (el.isTypeOnly) continue;
      const local = el.propertyName?.text ?? el.name.text;
      const imported = facts.bindings.get(local);
      facts.exports.set(
        el.name.text,
        imported
          ? { kind: "reexport", mod: imported.mod, name: imported.name }
          : { kind: "local", local }
      );
      for (const d of facts.decls)
        if (d.names.includes(local)) d.exported = true;
    }
  factsCache.set(file, facts);
  return facts;
}

// ─── the walk ────────────────────────────────────────────────────────────────

function declOf(facts: FileFacts, name: string): Decl | undefined {
  return facts.decls.find((d) => d.names.includes(name));
}

// Every (mod, exportName) under which `sym` can be imported, following named
// re-exports, `export *` barrels, and import-then-export.
function visibleAs(sym: SymbolRef): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  const queue: Array<[string, string]> = [];
  const push = (mod: string, name: string): void => {
    const key = `${mod}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([mod, name]);
    queue.push([mod, name]);
  };
  const origin = fileFacts(sym.file);
  for (const [exportName, entry] of origin.exports)
    if (entry.kind === "local" && entry.local === sym.name)
      push(sym.file, exportName);
  while (queue.length) {
    const [mod, name] = queue.shift()!;
    for (const importer of importersOf(mod)) {
      const facts = fileFacts(importer);
      for (const [exportName, entry] of facts.exports)
        if (
          entry.kind === "reexport" &&
          entry.mod === mod &&
          entry.name === name
        )
          push(importer, exportName);
      if (
        name !== "default" &&
        facts.stars.includes(mod) &&
        !facts.exports.has(name)
      )
        push(importer, name);
    }
  }
  return out;
}

function consumersOf(sym: SymbolRef): ReachEdge[] {
  const edges: ReachEdge[] = [];
  const seen = new Set<string>();
  const add = (to: SymbolRef, line: number): void => {
    const key = `${to.file}#${to.name}`;
    if (seen.has(key) || (to.file === sym.file && to.name === sym.name)) return;
    seen.add(key);
    edges.push({ from: sym, to, line });
  };
  const origin = fileFacts(sym.file);
  const originDecl = declOf(origin, sym.name);
  if (originDecl)
    for (const d of origin.decls) {
      if (d === originDecl) continue;
      for (const n of originDecl.names) {
        const line = d.refs.get(n);
        if (line != null) add({ file: sym.file, name: d.name }, line);
      }
    }
  for (const [mod, exportName] of visibleAs(sym))
    for (const importer of importersOf(mod)) {
      const facts = fileFacts(importer);
      for (const [local, binding] of facts.bindings) {
        if (binding.mod !== mod) continue;
        for (const d of facts.decls) {
          const line =
            binding.name === exportName
              ? d.refs.get(local)
              : binding.name === "*"
                ? d.members.get(`${local}.${exportName}`)
                : undefined;
          if (line != null) add({ file: importer, name: d.name }, line);
        }
      }
    }
  return edges;
}

function isServerActionFile(file: string): boolean {
  return file.startsWith("app/") && /actions\.ts$/.test(file);
}

function terminalsAt(
  sym: SymbolRef,
  line: number
): {
  terminals: Terminal[];
  stop: boolean;
} {
  const facts = fileFacts(sym.file);
  const decl = declOf(facts, sym.name);
  const terminals: Terminal[] = [];
  if (sym.file.startsWith("app/") && sym.file.endsWith(".tsx"))
    return { terminals: [{ ...sym, kind: "render", line }], stop: true };
  if (sym.file.startsWith("app/") && /(^|\/)route\.ts$/.test(sym.file))
    return { terminals: [{ ...sym, kind: "route", line }], stop: true };
  if (isServerActionFile(sym.file) && decl?.exported)
    return { terminals: [{ ...sym, kind: "action", line }], stop: true };
  if (decl)
    for (const [callee, lines] of decl.calls) {
      const binding = facts.bindings.get(callee);
      const key = binding
        ? `${binding.mod}#${binding.name}`
        : declOf(facts, callee)
          ? `${sym.file}#${callee}`
          : null;
      if (key && SENDER_KEYS.has(key))
        for (const l of lines)
          terminals.push({ ...sym, kind: "send", line: l });
    }
  return { terminals, stop: false };
}

/** Walk outward from `symbol` in `file` (repo-relative) to every terminal. */
export function reach(file: string, symbol: string): ReachResult {
  const origin = fileFacts(file);
  const startDecl = declOf(origin, symbol);
  if (!startDecl)
    throw new Error(
      `${file} declares no top-level \`${symbol}\`; it has: ${origin.decls
        .map((d) => d.name)
        .join(", ")}`
    );
  const start = { file, name: startDecl.name, line: startDecl.line };
  const edges: ReachEdge[] = [];
  const terminals: Terminal[] = [];
  const visited = new Set([`${file}#${startDecl.name}`]);
  const queue: SymbolRef[] = [start];
  while (queue.length) {
    const sym = queue.shift()!;
    for (const edge of consumersOf(sym)) {
      const key = `${edge.to.file}#${edge.to.name}`;
      if (visited.has(key)) {
        edges.push({ ...edge, repeat: true });
        continue;
      }
      visited.add(key);
      edges.push(edge);
      const { terminals: found, stop } = terminalsAt(edge.to, edge.line);
      terminals.push(...found);
      if (!stop) queue.push(edge.to);
    }
  }
  return { start, edges, terminals };
}

/** The pinnable answer: one string per terminal, without line numbers. */
export function terminalSet(result: ReachResult): string[] {
  return [
    ...new Set(result.terminals.map((t) => `${t.kind} ${t.file} ${t.name}`)),
  ].sort();
}

/** Every hop as "from -> to", so a test can pin the path a table missed. */
export function hops(result: ReachResult): string[] {
  return result.edges.map(
    (e) => `${e.from.file}#${e.from.name} -> ${e.to.file}#${e.to.name}`
  );
}

/** The reach tree, indented, for a reviewer; a repeat hop is marked (seen). */
export function formatReach(result: ReachResult): string {
  const children = new Map<string, ReachEdge[]>();
  for (const e of result.edges) {
    const key = `${e.from.file}#${e.from.name}`;
    const list = children.get(key) ?? [];
    list.push(e);
    children.set(key, list);
  }
  const tags = new Map<string, string[]>();
  for (const t of result.terminals) {
    const key = `${t.file}#${t.name}`;
    const list = tags.get(key) ?? [];
    list.push(t.kind === "send" ? `send @${t.file}:${t.line}` : t.kind);
    tags.set(key, list);
  }
  const lines = [
    `${result.start.name}  ${result.start.file}:${result.start.line}`,
  ];
  const print = (key: string, prefix: string): void => {
    const list = children.get(key) ?? [];
    list.forEach((e, i) => {
      const last = i === list.length - 1;
      const toKey = `${e.to.file}#${e.to.name}`;
      const tag = tags.get(toKey);
      lines.push(
        `${prefix}${last ? "└─ " : "├─ "}${e.to.name}  ${e.to.file}:${e.line}${
          e.repeat
            ? "  (seen)"
            : tag
              ? `  [${[...new Set(tag)].join(", ")}]`
              : ""
        }`
      );
      if (!e.repeat) print(toKey, prefix + (last ? "   " : "│  "));
    });
  };
  print(`${result.start.file}#${result.start.name}`, "");
  return lines.join("\n");
}
