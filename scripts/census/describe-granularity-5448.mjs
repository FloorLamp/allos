// #5448 — describe-granularity census of the source-text guards.
//
// The old defining command matched a FILE containing a read call. This one asks
// two narrower questions: (a) does the read resolve INSIDE the tracked tree, and
// (b) which `describe` block does it sit in. Population and line counts follow
// from those, instead of from the file's total length.
import { createRequire } from "node:module";
const require_ = createRequire(process.cwd() + "/package.json");
const ts = require_("typescript");
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const g = (args) =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

const tracked = new Set(g(["ls-files"]).trim().split("\n"));
const trackedDirs = new Set();
for (const f of tracked) {
  const p = f.split("/");
  for (let i = 1; i < p.length; i++) trackedDirs.add(p.slice(0, i).join("/"));
}

const POPULATION_GREP = [
  "grep",
  "-l",
  "-E",
  "readFileSync|readdirSync|globSync|fast-glob|sourceFiles\\(",
  "--",
  "*__tests__*",
  "*__db_tests__*",
  "*.test.ts",
  "*.test.tsx",
];
const files = g(POPULATION_GREP).trim().split("\n");

const READ = /^(readFileSync|readdirSync|globSync|sourceFiles|glob|sync)$/;
const DESCRIBE = new Set(["describe", "fdescribe", "xdescribe"]);
const OUTSIDE = /os\.tmpdir\(\)|mkdtemp/;
const FROM_DATA =
  /\.prepare\(|SELECT |INSERT |listProfileMediaFiles\(|seedPhoto\(|seedLegacyFile\(|writeFixtureFile\(|templateKeyPath\(|asidePath|stored_path|storedPath/;
const REPO_ROOT = /import\.meta\.url|import\.meta\.dirname|process\.cwd\(\)/;

const parse = (file) => {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  return {
    text,
    sf: ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    ),
  };
};
const moduleCache = new Map();
function moduleDefs(spec, fromFile) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return new Map();
  const base = spec.startsWith("@/")
    ? spec.slice(2)
    : path.join(path.dirname(fromFile), spec);
  const cand = [base + ".ts", base + ".tsx", base + "/index.ts", base];
  const hit = cand.find((c) => tracked.has(c));
  if (!hit) return new Map();
  if (moduleCache.has(hit)) return moduleCache.get(hit);
  const m = new Map();
  moduleCache.set(hit, m); // set before recursing, cycles
  try {
    const { sf } = parse(hit);
    (function w(n) {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        !m.has(n.name.text)
      )
        m.set(n.name.text, n.initializer.getText(sf));
      if (
        ts.isFunctionDeclaration(n) &&
        n.name &&
        n.body &&
        !m.has(n.name.text)
      )
        m.set(n.name.text, n.body.getText(sf).slice(0, 600));
      n.forEachChild(w);
    })(sf);
  } catch {}
  moduleCache.set(hit, m);
  return m;
}

// Five files the static resolver decides wrongly, each verified by reading the
// cited line. Printed by the command so the population stays re-derivable and
// the corrections stay auditable, rather than being pruned out of a list by hand.
const READ_VERIFIED = new Map([
  [
    "lib/__db_tests__/fixture-profile-isolation.test.ts",
    [
      false,
      "L134 reads writeFixtureFile(mine) — a file the test wrote, not tracked source",
    ],
  ],
  [
    "lib/__db_tests__/photo-metadata-backfill.test.ts",
    [
      false,
      "L367/386 target = abs(file.storedPath) — photo bytes; a same-named const shadows the def the resolver expands",
    ],
  ],
  [
    "lib/__db_tests__/seed-auth-state.test.ts",
    [
      false,
      "L44/56 beside = dirname(dbFilePath())+AUTH_BASENAME — runtime auth state beside the DB",
    ],
  ],
  [
    "lib/__tests__/ai-log-redaction.test.ts",
    [
      false,
      "L23 reads AI_LOG_PATH = process.cwd()/data/logs/ai.jsonl (lib/ai-log.ts:26) — an untracked runtime log",
    ],
  ],
  [
    "lib/__action_tests__/notify-log-clear.actions.test.ts",
    [
      false,
      "L51 reads NOTIFY_LOG_PATH (lib/notify-log.ts:50) — an untracked runtime log",
    ],
  ],
  [
    "lib/__tests__/notify-log-sink.test.ts",
    [false, "L47/65 logPath = sink.NOTIFY_LOG_PATH — an untracked runtime log"],
  ],
  [
    "lib/__tests__/vitest-isolation-budget.test.ts",
    [
      true,
      'L164/168 reads the spec sources returned by specsNeedingIsolation(process.cwd()+"/", …)',
    ],
  ],
  [
    "lib/__tests__/migration-immutability.test.ts",
    [
      true,
      "L87 reads MANIFEST_PATH = join(REPO, MANIFEST_IN_REPO) — the tracked lib/migrations/manifest.json",
    ],
  ],
]);

const out = [];
for (const file of files) {
  const { text, sf } = parse(file);
  const lineOf = (p) => sf.getLineAndCharacterOfPosition(p).line + 1;
  const fileLines = (text.match(/\n/g) || []).length;

  // ---- definitions visible in this file, plus one level of imported ones ----
  const defs = new Map();
  (function w(n) {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      !defs.has(n.name.text)
    )
      defs.set(n.name.text, n.initializer.getText(sf));
    if (ts.isForOfStatement(n)) {
      const d = n.initializer;
      if (
        ts.isVariableDeclarationList(d) &&
        d.declarations[0] &&
        ts.isIdentifier(d.declarations[0].name) &&
        !defs.has(d.declarations[0].name.text)
      )
        defs.set(d.declarations[0].name.text, n.expression.getText(sf));
    }
    if (
      ts.isFunctionDeclaration(n) &&
      n.name &&
      n.body &&
      !defs.has(n.name.text)
    )
      defs.set(n.name.text, n.body.getText(sf).slice(0, 400));
    // an arrow param passed to .filter/.map/... binds to elements of the receiver
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      /^(filter|map|forEach|flatMap|some|every|find)$/.test(
        n.expression.name.text
      )
    ) {
      const cb = n.arguments[0];
      if (
        cb &&
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        cb.parameters[0] &&
        ts.isIdentifier(cb.parameters[0].name)
      ) {
        const pn = cb.parameters[0].name.text;
        if (!defs.has(pn)) defs.set(pn, n.expression.expression.getText(sf));
      }
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const md = moduleDefs(n.moduleSpecifier.text, file);
      const nb = n.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) {
          const src = (el.propertyName ?? el.name).text;
          if (md.has(src) && !defs.has(el.name.text))
            defs.set(el.name.text, md.get(src));
        }
    }
    n.forEachChild(w);
  })(sf);

  const MAXLEN = 6000;
  const expand = (txt, depth = 0, seen = new Set()) => {
    if (depth > 4 || txt.length > MAXLEN) return txt.slice(0, MAXLEN);
    const r = txt.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g, (id) => {
      if (!defs.has(id) || seen.has(id)) return id;
      const next = new Set(seen);
      next.add(id);
      return expand(defs.get(id), depth + 1, next);
    });
    return r.length > MAXLEN ? r.slice(0, MAXLEN) : r;
  };

  // ---- top-level describes ----
  const describes = [];
  (function w(n, inside) {
    let now = inside;
    if (ts.isCallExpression(n)) {
      let e = n.expression;
      if (ts.isCallExpression(e)) e = e.expression;
      if (ts.isPropertyAccessExpression(e)) e = e.expression;
      if (ts.isIdentifier(e) && DESCRIBE.has(e.text)) {
        if (!inside) {
          const t = n.arguments[0];
          const s = lineOf(n.getStart(sf)),
            en = lineOf(n.getEnd());
          describes.push({
            title: t && ts.isStringLiteralLike(t) ? t.text : "(dynamic)",
            start: s,
            end: en,
            lines: en - s + 1,
          });
        }
        now = true;
      }
    }
    n.forEachChild((c) => w(c, now));
  })(sf, false);

  // ---- call-site propagation: enclosing function's args, resolved in-file ----
  const callArgs = new Map(); // fn name -> expanded arg texts
  (function w(n) {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.arguments.length
    ) {
      const k = n.expression.text;
      if (!callArgs.has(k)) callArgs.set(k, []);
      callArgs
        .get(k)
        .push(expand(n.arguments.map((a) => a.getText(sf)).join(" , ")));
    }
    n.forEachChild(w);
  })(sf);
  const enclosingFn = (node) => {
    let p = node.parent;
    while (p) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
        return p.name.text;
      p = p.parent;
    }
    return null;
  };

  // ---- hits ----
  const hits = [];
  (function w(n) {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)
          ? e.name.text
          : null;
      if (name && READ.test(name)) {
        const arg = n.arguments[0];
        const raw = arg ? arg.getText(sf).replace(/\s+/g, " ") : "";
        let ex = expand(raw).replace(/\s+/g, " ");
        let via = "direct";
        const undecided = (t) =>
          !OUTSIDE.test(t) &&
          !FROM_DATA.test(t) &&
          !REPO_ROOT.test(t) &&
          !/ls-files/.test(t) &&
          !literalsHitTracked(t);
        if (name !== "sourceFiles" && undecided(ex)) {
          const fn = enclosingFn(n);
          const cs = (fn && callArgs.get(fn)) || [];
          if (cs.length) {
            ex = ex + " /*<-callsite*/ " + cs.join(" ; ").slice(0, 400);
            via = "callsite";
          }
        }
        hits.push({
          name,
          line: lineOf(n.getStart(sf)),
          raw,
          expanded: ex.slice(0, 500),
          via,
        });
      }
    }
    n.forEachChild(w);
  })(sf);

  // concrete path-shaped literals in an expression, joined as they would be
  function concretePaths(t) {
    const lits = [];
    for (const m of t.matchAll(
      /"([^"]{1,120})"|'([^']{1,120})'|`([^`$]{1,120})`/g
    ))
      lits.push(m[1] ?? m[2] ?? m[3]);
    const out = [];
    for (let i = 0; i < lits.length; i++)
      for (let j = i + 1; j <= Math.min(lits.length, i + 6); j++) {
        const p = lits
          .slice(i, j)
          .join("/")
          .replace(/\/+/g, "/")
          .replace(/^\.?\//, "");
        if (/\//.test(p) || /\.\w{2,4}$/.test(p)) out.push(p);
      }
    return out;
  }

  function literalsHitTracked(t) {
    const lits = [];
    for (const m of t.matchAll(
      /"([^"]{1,120})"|'([^']{1,120})'|`([^`$]{1,120})`/g
    ))
      lits.push(m[1] ?? m[2] ?? m[3]);
    for (const l of lits) {
      const c = l.replace(/^\.\//, "").replace(/\/$/, "");
      if (tracked.has(c) || trackedDirs.has(c)) return true;
    }
    for (let i = 0; i < lits.length; i++)
      for (let j = i + 1; j <= Math.min(lits.length, i + 5); j++) {
        const p = lits
          .slice(i, j)
          .join("/")
          .replace(/\/+/g, "/")
          .replace(/^\//, "");
        if (tracked.has(p) || trackedDirs.has(p)) return true;
      }
    return false;
  }

  for (const h of hits) {
    const e = h.raw + " || " + h.expanded;
    if (h.name === "sourceFiles") {
      h.verdict = "SOURCE";
      h.why = "the shared sourceFiles() tree walk";
    } else if (OUTSIDE.test(e)) {
      h.verdict = "RUNTIME";
      h.why = "rooted outside the working tree";
    } else if (FROM_DATA.test(e)) {
      h.verdict = "RUNTIME";
      h.why = "path comes from runtime data";
    } else if (/ls-files/.test(e)) {
      h.verdict = "SOURCE";
      h.why = "enumerates the tracked set via git ls-files";
    } else if (literalsHitTracked(e)) {
      h.verdict = "SOURCE";
      h.why = "resolves to a tracked path";
    } else if (REPO_ROOT.test(e)) {
      h.verdict = "SOURCE";
      h.why = "anchored at the repo root";
    } else {
      h.verdict = "UNRESOLVED";
      h.why = "unresolved";
    }
  }

  // Fallback for abstentions: a file that anchors at the repo root and shows no
  // runtime rooting anywhere is reading its own tree.
  if (
    !hits.some((h) => h.verdict === "SOURCE") &&
    hits.some((h) => h.verdict === "UNRESOLVED")
  ) {
    const whole = text;
    if (REPO_ROOT.test(whole) && !OUTSIDE.test(whole) && !FROM_DATA.test(whole))
      for (const h of hits)
        if (h.verdict === "UNRESOLVED") {
          h.verdict = "SOURCE";
          h.why = "file anchors at the repo root, no runtime rooting present";
        }
  }

  const at = (line) =>
    describes.find((d) => line >= d.start && line <= d.end) ?? null;
  const src = hits.filter((h) => h.verdict === "SOURCE");
  const fileScope = src.filter((h) => at(h.line) === null);

  // A file-scope read is nearly always a module-level helper or constant the
  // tests call. Name those, so a describe that CALLS one counts as scanning:
  // attributing only describe-internal read calls undercounts the real reach.
  const readerNames = new Set();
  for (const h of fileScope) {
    let n = null,
      p2 = null;
    (function find(node) {
      if (n) return;
      if (ts.isCallExpression(node) && lineOf(node.getStart(sf)) === h.line) {
        p2 = node;
        return;
      }
      node.forEachChild(find);
    })(sf);
    let cur = p2?.parent;
    while (cur) {
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
        n = cur.name.text;
        break;
      }
      if (ts.isFunctionDeclaration(cur) && cur.name) {
        n = cur.name.text;
        break;
      }
      cur = cur.parent;
    }
    if (n) readerNames.add(n);
  }
  const directTitles = new Set(
    src.map((h) => at(h.line)?.title).filter((t) => t != null)
  );
  const scanTitles = new Set(directTitles);
  if (readerNames.size)
    for (const d of describes) {
      const body = text
        .split("\n")
        .slice(d.start - 1, d.end)
        .join("\n");
      for (const rn of readerNames)
        if (new RegExp("\\b" + rn.replace(/[$]/g, "\\$") + "\\b").test(body)) {
          scanTitles.add(d.title);
          break;
        }
    }
  const scanning = describes.filter((d) => scanTitles.has(d.title));
  // Strict lower bound: only describes whose OWN body contains a read call.
  // The wider figure charges a whole describe for calling a file-scope helper,
  // which over-counts (hc-overlap-supersede: a 12-line helper, a 509-line block).
  const strictScanLines = describes
    .filter((d) => directTitles.has(d.title))
    .reduce((a, d) => a + d.lines, 0);
  const describeSpan = describes.reduce((a, d) => a + d.lines, 0);
  const preambleLines = Math.max(0, fileLines - describeSpan);

  const rv = READ_VERIFIED.get(file);
  out.push({
    file,
    fileLines,
    readVerified: rv ? rv[1] : null,
    describeCount: describes.length,
    scanningDescribeCount: scanning.length,
    describeScanLines: scanning.reduce((a, d) => a + d.lines, 0),
    fileScopeSourceHits: fileScope.length,
    readerNames: [...readerNames],
    preambleLines,
    strictScanLines,
    verdicts: {
      SOURCE: src.length,
      RUNTIME: hits.filter((h) => h.verdict === "RUNTIME").length,
      UNRESOLVED: hits.filter((h) => h.verdict === "UNRESOLVED").length,
    },
    isGuard: rv ? rv[0] : src.length > 0,
    hits,
    describes: describes.map((d) => ({ ...d, scans: scanTitles.has(d.title) })),
  });
}
console.log(JSON.stringify(out, null, 1));
