// WHICH lib MODULES ARE WRITE CORES, AND WHICH DOMAIN ROW DOES EACH BELONG TO? (#5348)
//
//   node scripts/write-core-census.mjs                  the whole report
//   node scripts/write-core-census.mjs --row medical    one domain row's membership
//   node scripts/write-core-census.mjs --core lib/x.ts::f   why one symbol landed where it did
//   node scripts/write-core-census.mjs --json           the same facts, for a script
//
// WHY THIS EXISTS. The predicate below was prose in a manifest comment that reported
// the counts it produced at one commit. Every domain row since re-implemented it on
// the AST to find its own slice — because counts are not membership, and because main
// moves underneath. Two implementations then disagreed on the tranche split with no
// way to adjudicate: auditing a hand instrument means writing a third one, and a third
// answer does not falsify the second. This file is the one instrument, so a reviewer
// RE-RUNS the number instead of re-deriving it, and so a disagreement is a diff.
//
// NO EXPECTED TOTAL IS WRITTEN DOWN ANYWHERE, here or in the test. A count this script
// cannot recompute is exactly the thing it replaces. What IS written down is the
// predicate, the ownership fences, and every place the predicate is ambiguous — and
// each of those is printed in the report so the choice is auditable rather than buried.
//
// WHAT IT REUSES. scripts/reach-graph.ts already owns resolution: which file exports a
// symbol under which name, following `export { a as b } from`, `export *` barrels and
// import-then-export, and which top-level declarations reference it — same-module
// siblings included. That is precisely where the two hand instruments diverged (one
// followed only named, non-type imports called as a bare identifier), so the census
// asks the module that already does it right, and `--compare-naive` measures the gap.
// lib/__tests__/strip-comments.ts owns not mistaking a sentence of prose for SQL.
//
// WHAT THIS CANNOT SEE, by construction, so nothing reads a bucket as more than it is:
//   * Callers outside app/**, components/** and lib/** — scripts/** and e2e/** are not
//     walked, so "no production caller" is not "dead" and not "nothing to edit".
//   * A core reached only through a string-keyed registry or an untyped lookup.
//   * Module-level statements outside any declaration (reach-graph's blind spot).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript-api";
import { stripComments } from "../lib/__tests__/strip-comments.ts";
import {
  ROOT,
  consumersOf,
  fileFacts,
  resolveSpecifier,
  visibleAs,
} from "./reach-graph.ts";

// ─── the predicate, as data ──────────────────────────────────────────────────

// A parameter under one of these names, written as exactly `number`, is the
// unbranded profile id the conversion programme is looking for.
const PROFILE_PARAM_NAMES = new Set([
  "profileId",
  "profile_id",
  "pid",
  "targetProfileId",
  "subjectProfileId",
  "forProfileId",
  "ownerProfileId",
]);
const BRAND = "WriteAuthorizedProfileId";

// Literal DML in the declaration's own text, comments already blanked. UPDATE is
// bounded rather than `[\s\S]*` so a bare `UPDATE` and a distant unrelated `SET`
// cannot pair up across half a file.
const DML = [
  /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i,
  /\bREPLACE\s+INTO\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bUPDATE\b[\s\S]{0,400}?\bSET\b/i,
];
// The other half of the predicate, and the load-bearing half: a core may hold no SQL
// and still be the write, because it opens the transaction its delegates write in.
const TX_FNS = new Set(["writeTx", "maintenanceWrite"]);
const TX_MODULE = "lib/db.ts";

// Ownership fences from the Ladder, applied after the funnel's headline count and
// printed with what each removes. These are OWNER assignments, not facts about the
// code, which is why they are named here and shown in the report rather than folded
// into the predicate. "Already converted" needs no entry: a core whose parameter is
// the brand stops matching the predicate on its own.
const FENCES = [
  [
    "D",
    [
      /^lib\/routines\.ts$/,
      /^lib\/(db|tx|commit-cache|write-revision|home-list)\.ts$/,
    ],
  ],
  [
    "E",
    [
      /^lib\/import-persist(\.ts|\/)/,
      /^lib\/intake-[^/]*\.ts$/,
      /^lib\/notifications\//,
      /^lib\/queries\/intake\//,
    ],
  ],
  ["D (#5189)", [/^lib\/activity-write\.ts$/]],
  ["F (mints the brand)", [/^lib\/auth\.ts$/]],
];

const SKIP_DIR = /(^|\/)(__tests__|__db_tests__|__action_tests__)(\/|$)/;
const ACTION_FILE = /^app\/\(app\)\/(.*\/)?[\w-]*actions\.ts$/;
// How far a non-writing core is followed before its write is called unfound. The
// manifest measured that propagating "calls something that writes" without a
// parameter test yields an unusable 478, so this walk starts only from declarations
// that already passed the parameter half and reports the hop count it needed.
const DELEGATE_MAX_DEPTH = 3;

// ─── scanning lib/** ─────────────────────────────────────────────────────────

/** Every lib production file: no tests, no migrations, no ambient declarations. */
export function libProductionFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (SKIP_DIR.test(rel) || rel.startsWith("lib/migrations/")) continue;
      if (entry.isDirectory()) walk(abs);
      else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|d)\.tsx?$/.test(entry.name)
      )
        out.push(rel);
    }
  };
  walk(path.join(root, "lib"));
  return out.sort();
}

const typeText = (node) =>
  node ? node.getText().replace(/\s+/g, " ").trim() : "";

/** The function-like initializer of `export const f = …`, if that is what it is. */
function functionInitializer(node) {
  let init = node.initializer;
  while (
    init &&
    (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))
  )
    init = init.expression;
  return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
    ? init
    : null;
}

/**
 * Every top-level function-like declaration in one file, with the two facts the
 * predicate asks of it and the call names it would need resolved.
 */
export function declarationsIn(file, root = ROOT) {
  const raw = fs.readFileSync(path.join(root, file), "utf8");
  const blanked = stripComments(raw);
  const sf = ts.createSourceFile(
    file,
    raw,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  // MODULE-LEVEL PREPARED STATEMENTS. `const S = hoistedStatement("UPDATE …")` puts
  // the DML outside every declaration's own body, so the predicate's body half
  // cannot see the write that `S.run(…)` performs. Collected so the report can say
  // how many declarations write that way instead of silently calling them readers.
  const hoistedDml = new Set();
  const exportedByList = new Set();
  for (const st of sf.statements)
    if (
      ts.isExportDeclaration(st) &&
      !st.isTypeOnly &&
      !st.moduleSpecifier &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    )
      for (const el of st.exportClause.elements)
        if (!el.isTypeOnly)
          exportedByList.add((el.propertyName ?? el.name).text);

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const vd of st.declarationList.declarations) {
      if (!ts.isIdentifier(vd.name) || !vd.initializer) continue;
      if (!ts.isCallExpression(vd.initializer)) continue;
      const literal = vd.initializer.arguments.find((a) =>
        ts.isStringLiteralLike(a)
      );
      if (literal && DML.some((re) => re.test(literal.text)))
        hoistedDml.add(vd.name.text);
    }
  }

  const out = [];
  const add = (name, node, fn, exported) => {
    const calls = new Set();
    const memberCalls = new Set();
    // Which identifiers each callee is HANDED. A delegating core is recognised by
    // passing its own profile id on, not merely by calling something that writes.
    const argsTo = new Map();
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        let callee = null;
        if (ts.isIdentifier(n.expression))
          calls.add((callee = n.expression.text));
        else if (
          ts.isPropertyAccessExpression(n.expression) &&
          ts.isIdentifier(n.expression.expression)
        )
          memberCalls.add(
            (callee = `${n.expression.expression.text}.${n.expression.name.text}`)
          );
        if (callee) {
          const seen = argsTo.get(callee) ?? new Set();
          for (const a of n.arguments) if (ts.isIdentifier(a)) seen.add(a.text);
          argsTo.set(callee, seen);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    const text = blanked.slice(node.getStart(sf), node.getEnd());
    const params = fn.parameters.map((p) => ({
      name: ts.isIdentifier(p.name) ? p.name.text : "",
      type: typeText(p.type),
    }));
    out.push({
      file,
      name,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      exported,
      params,
      calls,
      memberCalls,
      argsTo,
      usesHoistedDml: [...memberCalls].some((m) =>
        hoistedDml.has(m.slice(0, m.indexOf(".")))
      ),
      hasDml: DML.some((re) => re.test(text)),
    });
  };
  for (const st of sf.statements) {
    const exported = (ts.getModifiers(st) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    );
    if (ts.isFunctionDeclaration(st) && st.name)
      add(st.name.text, st, st, exported || exportedByList.has(st.name.text));
    else if (ts.isVariableStatement(st))
      for (const vd of st.declarationList.declarations) {
        const fn = functionInitializer(vd);
        if (fn && ts.isIdentifier(vd.name))
          add(
            vd.name.text,
            vd,
            fn,
            exported || exportedByList.has(vd.name.text)
          );
      }
  }
  return out;
}

/** The profile-id-shaped parameter this declaration takes, and how it is written. */
function profileParam(decl) {
  const named = decl.params.filter((p) => PROFILE_PARAM_NAMES.has(p.name));
  const bare = named.find((p) => p.type === "number");
  if (bare) return { kind: "bare", param: bare };
  const branded = named.find((p) => p.type === BRAND);
  if (branded) return { kind: "branded", param: branded };
  if (named.length) return { kind: "other", param: named[0] };
  return { kind: "none" };
}

// ─── resolving a call to the declaration it lands on ─────────────────────────

/** Follow `export { a as b } from` and `export *` inward to the defining file. */
function resolveExport(mod, name, seen = new Set()) {
  const key = `${mod}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  let facts;
  try {
    facts = fileFacts(mod);
  } catch {
    return null;
  }
  const entry = facts.exports.get(name);
  if (entry?.kind === "local") return { file: mod, name: entry.local };
  if (entry?.kind === "reexport")
    return resolveExport(entry.mod, entry.name, seen);
  for (const star of facts.stars) {
    const found = resolveExport(star, name, seen);
    if (found) return found;
  }
  return null;
}

/** Where a bare-identifier call inside `file` lands: an import, or a local sibling. */
function resolveCallee(file, callee) {
  let facts;
  try {
    facts = fileFacts(file);
  } catch {
    return null;
  }
  const binding = facts.bindings.get(callee);
  if (binding)
    return binding.name === "*"
      ? null
      : (resolveExport(binding.mod, binding.name) ?? {
          file: binding.mod,
          name: binding.name,
        });
  return { file, name: callee };
}

/** Does this declaration call `writeTx`/`maintenanceWrite` as lib/db.ts exports them? */
function callsWriteTx(decl) {
  for (const callee of decl.calls) {
    if (!TX_FNS.has(callee)) continue;
    const target = resolveCallee(decl.file, callee);
    if (target && target.file === TX_MODULE) return callee;
  }
  for (const member of decl.memberCalls) {
    const [ns, fn] = member.split(".");
    if (!TX_FNS.has(fn)) continue;
    const binding = fileFacts(decl.file).bindings.get(ns);
    if (binding?.mod === TX_MODULE) return fn;
  }
  return null;
}

// ─── the census ──────────────────────────────────────────────────────────────

const declKey = (d) => `${d.file}::${d.name}`;

function fenceFor(file) {
  for (const [owner, patterns] of FENCES)
    if (patterns.some((re) => re.test(file))) return owner;
  return null;
}

/** `app/(app)/medical/episodes/actions.ts` → `medical`; `saved-actions.ts` → `saved`. */
export function actionDomain(file) {
  const rest = file.slice("app/(app)/".length);
  if (rest.includes("/")) return rest.split("/")[0];
  return rest.replace(/\.tsx?$/, "").replace(/-?actions$/, "") || "(root)";
}

function callerKind(file) {
  if (ACTION_FILE.test(file)) return "action";
  if (file.startsWith("lib/migrations/")) return "migration";
  if (file.startsWith("lib/")) return "lib";
  if (file.startsWith("components/")) return "component";
  if (/(^|\/)route\.ts$/.test(file)) return "route";
  if (file.endsWith(".tsx")) return "page";
  return "other app";
}

/** Call sites of `core` inside one consumer file, counted as bare-identifier calls. */
function siteCount(consumerFile, core, names) {
  const facts = fileFacts(consumerFile);
  const locals = new Set();
  if (consumerFile === core.file) locals.add(core.name);
  for (const [local, binding] of facts.bindings)
    if (names.has(`${binding.mod}#${binding.name}`)) locals.add(local);
  let n = 0;
  for (const d of facts.decls)
    for (const local of locals) n += (d.calls.get(local) ?? []).length;
  return n;
}

/**
 * The whole funnel. Every number below is derived here; nothing is asserted.
 */
export function census(root = ROOT) {
  const files = libProductionFiles(root);
  const decls = [];
  for (const file of files) decls.push(...declarationsIn(file, root));
  const byKey = new Map(decls.map((d) => [declKey(d), d]));

  // A declaration writes if its own body holds DML or opens a write transaction.
  for (const d of decls) d.writes = d.hasDml || Boolean(callsWriteTx(d));

  const shape = { bare: [], branded: [], other: [] };
  for (const d of decls) {
    if (!d.exported) continue;
    const p = profileParam(d);
    if (p.kind !== "none") shape[p.kind].push({ decl: d, param: p.param });
  }

  const cores = shape.bare.filter((c) => c.decl.writes).map((c) => c.decl);
  const nonWriting = shape.bare
    .filter((c) => !c.decl.writes)
    .map((c) => c.decl);

  // DELEGATING CORES. The parameter half passes, the body half does not, and the
  // declaration HANDS ITS OWN PROFILE ID to something that writes. The argument test
  // is what keeps this a bucket rather than a flood: without it, every read helper
  // that happens to call a writer joins in, which is the unusable set the manifest
  // measured. `wideReach` counts that flood so the narrowing is visible, not assumed.
  const delegating = [];
  const hoisted = [];
  let wideReach = 0;
  const writerBehind = (file, callee) => {
    const target = resolveCallee(file, callee);
    const found = target && byKey.get(`${target.file}::${target.name}`);
    return found && found.writes ? found : null;
  };
  for (const { decl: start, param } of shape.bare) {
    if (start.writes) continue;
    let landed = null;
    for (const [callee, args] of start.argsTo) {
      if (!args.has(param.name)) continue;
      const bare = callee.includes(".")
        ? null
        : writerBehind(start.file, callee);
      if (bare) {
        landed ??= { via: bare };
        break;
      }
    }
    if (landed) delegating.push({ decl: start, ...landed });
    else if (start.usesHoistedDml) hoisted.push(start);
    // The wider walk, for the number only.
    const seen = new Set([declKey(start)]);
    let frontier = [start];
    for (let d = 0; d < DELEGATE_MAX_DEPTH && frontier.length && !landed; d++) {
      const next = [];
      for (const cur of frontier)
        for (const callee of cur.calls) {
          const target = resolveCallee(cur.file, callee);
          const found = target && byKey.get(`${target.file}::${target.name}`);
          if (!found || seen.has(declKey(found))) continue;
          seen.add(declKey(found));
          if (found.writes) {
            wideReach++;
            frontier = [];
            next.length = 0;
            break;
          }
          next.push(found);
        }
      frontier = next;
    }
  }

  // Callers, through every name the symbol is exported under.
  const rows = [];
  for (const core of cores) {
    const names = new Set(
      visibleAs({ file: core.file, name: core.name }).map(
        ([mod, name]) => `${mod}#${name}`
      )
    );
    const edges = consumersOf({ file: core.file, name: core.name });
    const callerFiles = [...new Set(edges.map((e) => e.to.file))].sort();
    const naiveFiles = callerFiles.filter(
      (f) =>
        f !== core.file &&
        [...fileFacts(f).bindings].some(
          ([local, b]) =>
            b.mod === core.file &&
            b.name === core.name &&
            fileFacts(f).decls.some((d) => d.calls.has(local))
        )
    );
    const actionFiles = callerFiles.filter((f) => ACTION_FILE.test(f));
    const tranche = !callerFiles.length
      ? "N"
      : callerFiles.every((f) => ACTION_FILE.test(f))
        ? "A"
        : "B";
    const naiveTranche = !naiveFiles.length
      ? "N"
      : naiveFiles.every((f) => ACTION_FILE.test(f))
        ? "A"
        : "B";
    rows.push({
      file: core.file,
      name: core.name,
      line: core.line,
      fence: fenceFor(core.file),
      writesBy: core.hasDml ? "dml" : "writeTx",
      tranche,
      naiveTranche,
      callerFiles,
      naiveFiles,
      actionFiles,
      domains: [...new Set(actionFiles.map(actionDomain))].sort(),
      blockers: [
        ...new Set(
          callerFiles.filter((f) => !ACTION_FILE.test(f)).map(callerKind)
        ),
      ].sort(),
      // Per file, so a domain row sums only its own action files rather than the
      // core's whole caller set — a core called from three domains is not three
      // times as big in each of them.
      sitesByFile: Object.fromEntries(
        callerFiles.map((f) => [f, siteCount(f, core, names)])
      ),
    });
  }
  rows.sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));

  return {
    root,
    head: headSha(root),
    scanned: files.length,
    declarations: decls.length,
    shape: {
      bare: shape.bare.length,
      bareFiles: new Set(shape.bare.map((s) => s.decl.file)).size,
      branded: shape.branded.length,
      other: shape.other.map((s) => ({
        key: declKey(s.decl),
        type: s.param.type,
      })),
    },
    cores: rows,
    delegating: delegating
      .map((d) => ({
        file: d.decl.file,
        name: d.decl.name,
        line: d.decl.line,
        fence: fenceFor(d.decl.file),
        via: declKey(d.via),
      }))
      .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name)),
    wideReach,
    hoisted: hoisted.map((d) => ({
      file: d.file,
      name: d.name,
      line: d.line,
      fence: fenceFor(d.file),
    })),
    nonWritingUnresolved: nonWriting.filter(
      (d) => !delegating.some((x) => x.decl === d)
    ).length,
  };
}

function headSha(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "(not a git checkout)";
  }
}

// ─── the report ──────────────────────────────────────────────────────────────

const uniq = (xs) => [...new Set(xs)];
const sitesIn = (core, files) =>
  files.reduce((n, f) => n + (core.sitesByFile[f] ?? 0), 0);
const pad = (s, n) => String(s).padEnd(n);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function trancheTable(rows, label) {
  const key = label === "naive" ? "naiveTranche" : "tranche";
  const lines = [];
  for (const t of ["A", "B", "N"]) {
    const slice = rows.filter((r) => r[key] === t);
    lines.push(
      `  ${t}  ${pad(plural(uniq(slice.map((r) => r.file)).length, "file"), 12)}${plural(
        slice.length,
        "core"
      )}`
    );
  }
  return lines;
}

export function report(data) {
  const inFence = data.cores.filter((c) => !c.fence);
  const by = (t, key = "tranche") => inFence.filter((c) => c[key] === t);
  const split = (key) =>
    ["A", "B", "N"].map(
      (t) =>
        `  ${t}  ${pad(plural(uniq(by(t, key).map((c) => c.file)).length, "file"), 12)}${plural(
          by(t, key).length,
          "core"
        )}`
    );
  const moved = inFence.filter((c) => c.tranche !== c.naiveTranche);
  const blockers = new Map();
  for (const c of by("B"))
    for (const b of c.blockers) blockers.set(b, (blockers.get(b) ?? 0) + 1);
  const openDelegating = data.delegating.filter((d) => !d.fence);
  const line = (l, n) => pad(`${l.file}:${l.line}`, 46) + pad(l.name, n);

  return [
    `WRITE-CORE CENSUS — ${data.root}`,
    `head ${data.head}`,
    ``,
    `PREDICATE, as this script implements it`,
    `  scanned    lib/**/*.ts(x), minus __tests__ / __db_tests__ / __action_tests__,`,
    `             *.test.*, *.d.ts and lib/migrations/**`,
    `  parameter  a parameter named ${[...PROFILE_PARAM_NAMES].join(" / ")}`,
    `             whose WRITTEN type is exactly \`number\` (not \`${BRAND}\`)`,
    `  body       the declaration's own text holds INSERT INTO / REPLACE INTO /`,
    `             DELETE FROM / UPDATE…SET with comments blanked, OR it calls`,
    `             writeTx( / maintenanceWrite( resolved to ${TX_MODULE}`,
    `  callers    every top-level declaration in app/**, components/** and lib/**`,
    `             that references the core under ANY name it is exported as —`,
    `             named re-exports, \`export *\` barrels and same-module siblings`,
    `             included; type-only imports are not references`,
    ``,
    `AMBIGUITIES — resolved here, printed so the choice is auditable`,
    `  · A profile-shaped parameter written as anything but \`number\` or \`${BRAND}\``,
    `    is NOT a core: \`number | null\`, a union, a field of an options object.`,
    `    ${plural(data.shape.other.length, "declaration")} in this tree:`,
    ...data.shape.other.slice(0, 12).map((o) => `      ${o.key}  ${o.type}`),
    ...(data.shape.other.length > 12
      ? [`      … and ${data.shape.other.length - 12} more (--json for all)`]
      : []),
    `  · ${plural(data.shape.branded, "exported declaration")} already take the brand and are outside`,
    `    the predicate by construction — that is how a converted core leaves this`,
    `    census with nobody maintaining a list of what has been done.`,
    `  · Only top-level \`function f\` and \`const f = (…) =>\` are considered; a class`,
    `    method or an object-literal member is not a core here.`,
    `  · A nested helper declared INSIDE a core's body counts as that core's own`,
    `    text, so a core that inlines its SQL in a closure still reads as writing.`,
    `  · A caller is a REFERENCE; a site is a bare-identifier CALL. Passing a core`,
    `    as a value makes a caller with no site. \`ns.core()\` through a namespace`,
    `    import makes a caller, and its sites are not counted.`,
    `  · A delegating core must HAND ITS OWN profile id to the writer it calls: one`,
    `    hop, argument-checked. Dropping the argument test and walking ${DELEGATE_MAX_DEPTH} hops`,
    `    instead admits ${data.wideReach} further declarations, which is the unusable set the`,
    `    manifest measured rather than a bucket anyone can act on.`,
    ``,
    `FUNNEL`,
    `  lib production files scanned            ${data.scanned}`,
    `  top-level function declarations in them ${data.declarations}`,
    `  exported with a profile-id parameter    ${data.shape.bare}     (${data.shape.bareFiles} files)`,
    `    − its own body does not write           ${data.shape.bare - data.cores.length}`,
    `  WRITE CORES by the predicate              ${data.cores.length}      (${uniq(data.cores.map((c) => c.file)).length} files)`,
    `    of which the body holds literal DML     ${data.cores.filter((c) => c.writesBy === "dml").length}`,
    `    of which the body only opens writeTx    ${data.cores.filter((c) => c.writesBy === "writeTx").length}   ← the half a SQL-only predicate misses`,
    ``,
    `  − ownership fences (Ladder assignments, not facts about the code)`,
    ...FENCES.map(([owner]) => {
      const s = data.cores.filter((c) => c.fence === owner);
      return `      ${pad(owner, 22)}${pad(plural(uniq(s.map((c) => c.file)).length, "file"), 10)}${plural(s.length, "core")}`;
    }),
    `  REMAINING IN G'S lib FENCE                ${inFence.length}      (${uniq(inFence.map((c) => c.file)).length} files)`,
    ``,
    `TRANCHE SPLIT — remaining cores, by where every production caller lives`,
    `  A  every production caller is an app/(app) action file`,
    `  B  at least one caller is a route, page, migration or other lib module`,
    `  N  no production caller found (NOT a claim of deadness — see the top)`,
    ...split("tranche"),
    `  B blockers, cores by kind: ${[...blockers]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
    `  A call sites in action files: ${by("A").reduce((n, c) => n + sitesIn(c, c.actionFiles), 0)}`,
    ``,
    `  THE SAME SPLIT WITH THE HAND INSTRUMENTS' RESOLUTION — a named, non-type`,
    `  import of the core's OWN module, called as a bare identifier: no barrel`,
    `  re-export, no same-module call. This is the measurable gap, not a guess.`,
    ...split("naiveTranche"),
    `  ${plural(moved.length, "core")} classify differently, ${
      moved.filter((c) => c.naiveTranche === "N").length
    } of them into the naive instrument's`,
    `  no-caller bucket although a caller exists. ${
      inFence.filter((c) => c.callerFiles.length && !c.naiveFiles.length).length
    } have EVERY caller reachable`,
    `  only through a barrel or a same-module sibling.`,
    ``,
    `DELEGATING CORES — ${data.delegating.length} declarations hold neither DML nor writeTx and hand`,
    `  their own profile id to something that does; ${openDelegating.length} are in G's fence. This is`,
    `  the manifest's UNMEASURED bucket, and it is NOT added to the counts above:`,
    `  a core whose write is a delegate's is a different predicate, and the`,
    `  transitive form of it is the unusable set counted in the ambiguities.`,
    ...openDelegating.map((d) => `  ${line(d, 36)}→ ${d.via}`),
    ...(data.delegating.length > openDelegating.length
      ? [
          `  (${data.delegating.length - openDelegating.length} behind an ownership fence, --json for them)`,
        ]
      : []),
    ``,
    `WRITES THROUGH A MODULE-LEVEL PREPARED STATEMENT — ${data.hoisted.length} declarations. The DML`,
    `  sits in a file-level \`const S = hoistedStatement("UPDATE …")\`, so it is not`,
    `  in the declaration's OWN body and the predicate as written does not reach`,
    `  it. Reported rather than counted: folding them in would move the headline`,
    `  off the predicate the programme agreed, which is not this script's call.`,
    ...data.hoisted.map((h) => `  ${line(h, 36)}${h.fence ?? ""}`),
    ``,
    `PER-ROW MEMBERSHIP — a row is the app/(app) directory of its action callers.`,
    `  A core called from two domains appears in both; a core with no action caller`,
    `  is listed first. The manifest's 13 PR rows are these domains grouped, with`,
    `  two of them split again by lib file — that grouping is a SIZING decision and`,
    `  this script does not recompute it.`,
    ``,
    ...rowSection(inFence),
  ].join("\n");
}

function rowSection(cores, only = null) {
  const out = [];
  const byRow = new Map();
  for (const c of cores) {
    const keys = c.domains.length ? c.domains : ["(no action caller)"];
    for (const k of keys) byRow.set(k, [...(byRow.get(k) ?? []), c]);
  }
  for (const row of [...byRow.keys()].sort()) {
    if (only && row !== only) continue;
    const slice = byRow.get(row);
    const actionFiles = uniq(slice.flatMap((c) => c.actionFiles))
      .filter((f) => row !== "(no action caller)" && actionDomain(f) === row)
      .sort();
    out.push(
      `── ${row}  —  ${plural(
        uniq(slice.map((c) => c.file)).length,
        "lib file"
      )}, ${plural(slice.length, "core")}, ${plural(
        actionFiles.length,
        "action file"
      )}, ${slice.reduce(
        (n, c) => n + sitesIn(c, actionFiles),
        0
      )} sites in them`
    );
    for (const f of actionFiles) out.push(`   action  ${f}`);
    let last = null;
    for (const c of slice) {
      if (c.file !== last) out.push(`   ${c.file}`);
      last = c.file;
      out.push(
        `     [${c.tranche}] ${pad(c.name, 40)}${pad(
          `:${c.line}`,
          7
        )}${c.writesBy === "dml" ? "dml    " : "writeTx"}  ${
          c.tranche === "B" ? `blocked by ${c.blockers.join(", ")}` : ""
        }`
      );
    }
    out.push("");
  }
  return out;
}

// ─── command line ────────────────────────────────────────────────────────────

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage: node scripts/write-core-census.mjs [--row <domain>] [--core <file::name>] [--json]",
        "",
        "With no flag it prints the predicate, the funnel, the tranche split, the",
        "delegating-core bucket and per-row membership. --row prints one domain row's",
        "membership; --core explains where one symbol landed and why; --json prints",
        "the same facts as data.",
      ].join("\n")
    );
  }
  const data = argv.includes("--help") || argv.includes("-h") ? null : census();
  if (!data) {
    // fall through to nothing: --help already said everything.
  } else
    // NEVER `process.exit` here: the report is far larger than a pipe buffer and a
    // write to a pipe is asynchronous, so exiting drops whatever had not drained
    // and hands the caller status 0 over half a document (#5804).
    if (argv.includes("--json")) console.log(JSON.stringify(data, null, 2));
    else if (flag("--core")) {
      const key = flag("--core");
      const c = data.cores.find((c) => `${c.file}::${c.name}` === key);
      const d = data.delegating.find((d) => `${d.file}::${d.name}` === key);
      if (c)
        console.log(
          [
            `${key}  line ${c.line}`,
            `  writes by      ${c.writesBy}`,
            `  fence          ${c.fence ?? "G (in scope)"}`,
            `  tranche        ${c.tranche}  (naive resolution: ${c.naiveTranche})`,
            `  rows           ${c.domains.join(", ") || "(no action caller)"}`,
            `  sites          ${Object.entries(c.sitesByFile)
              .map(([f, n]) => `${n} ${f}`)
              .join("\n                 ")}`,
            `  callers        ${c.callerFiles.join("\n                 ") || "(none in app/ components/ lib/)"}`,
            `  of those, reachable by a direct named import called bare:`,
            `                 ${c.naiveFiles.join("\n                 ") || "(none)"}`,
          ].join("\n")
        );
      else if (d)
        console.log(
          `${key}  line ${d.line}\n  delegating core: no DML, no writeTx; hands its profile id to ${d.via}`
        );
      else console.log(`${key} is not a write core at this head.`);
    } else if (flag("--row")) {
      const rows = rowSection(
        data.cores.filter((c) => !c.fence),
        flag("--row")
      );
      console.log(
        rows.length ? rows.join("\n") : `No row named ${flag("--row")}.`
      );
    } else console.log(report(data));
}
