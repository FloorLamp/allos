import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE WEB-SURFACE WIRING CENSUS (#3087).
//
// `parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page")` is a Server Action asking
// "which of my mountings posted this?". The answer only exists if a mounting actually
// declares it, and NOTHING IN THE TYPE SYSTEM CONNECTS THE TWO: an action that reads
// the field compiles perfectly with no client ever setting it, takes its fallback on
// every request, and records `page` for the dashboard, the quick-log sheet and the
// command palette alike. That is not hypothetical — it is the state this guard was
// written to end. The mechanism was wired at three components against seventeen read
// sites, so `dashboard-widget` was produced by exactly one control in the whole app.
//
// WHY THIS ASSERTS THE MECHANISM AND NOT A LIST. A list of wired components is a
// snapshot: it goes stale the moment a new action starts reading the field, and it
// says nothing when a component stops declaring. This walks the UNION instead — every
// `parseWebOrigin` read site, resolved to its exported action, resolved to the client
// files that import that action — and fails when any of those clients has no way to
// say where it is. Add a read site with no declaring mounting and this goes red.
//
// A CLIENT DECLARES in one of two ways, and both are the same mechanism: it stamps a
// FormData through `useLoggedViaStamp()` / `LOGGED_VIA_FIELD`, or it renders
// `<LoggedViaField />` inside a plain `<form action={…}>`. A file that is itself a
// REGION ROOT (`<LoggedViaSurface value=…>`) counts too: declaring the region is what
// the controls inside it read.
//
// READS BYTES rather than shelling out to a grep, for the #3206 reason the sibling
// census states: a source file carrying a deliberate NUL separator is BINARY to grep
// and would be skipped, so a shelled-out sweep would report a pass it never took.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** A `parseWebOrigin(` read, wherever it sits. */
const READ_RE = /parseWebOrigin\s*\(/g;
/** `export async function name(` / `export function name(` — the action boundary. */
const EXPORT_RE = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;

/** The spellings of "this file declares a surface". */
const DECLARES_RE =
  /useLoggedViaStamp|LoggedViaField|LoggedViaSurface|LOGGED_VIA_FIELD/;

function dirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(root: string, sub: string): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const entry of dirents(dir)) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        rec(p);
        continue;
      }
      if (!p.endsWith(".ts") && !p.endsWith(".tsx")) continue;
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (/__(?:db_|action_)?tests__/.test(rel)) continue;
      if (p.endsWith(".test.ts") || p.endsWith(".test.tsx")) continue;
      out.push(p);
    }
  };
  rec(path.join(root, sub));
  return out.sort();
}

/** Every exported action in `app/` that READS a posted surface. */
export function readingActions(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of walk(root, "app")) {
    const src = fs.readFileSync(file, "utf8");
    // Where each exported function starts, so a read can be attributed to the last
    // one that opened before it.
    const bounds: { name: string; at: number }[] = [];
    for (const m of src.matchAll(EXPORT_RE))
      bounds.push({ name: m[1], at: m.index ?? 0 });
    for (const m of src.matchAll(READ_RE)) {
      const at = m.index ?? 0;
      let owner: string | null = null;
      for (const b of bounds) if (b.at < at) owner = b.name;
      if (owner) {
        out.set(owner, path.relative(root, file).split(path.sep).join("/"));
      }
    }
  }
  return out;
}

/** Every "use client" file, with the source that decides whether it declares. */
function clientFiles(root: string): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  for (const sub of ["app", "components"]) {
    for (const file of walk(root, sub)) {
      const src = fs.readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/.test(src)) continue;
      out.push({
        rel: path.relative(root, file).split(path.sep).join("/"),
        src,
      });
    }
  }
  return out;
}

/**
 * Does this client file IMPORT the named action?
 *
 * Matching on the IMPORT — not on a bare `name(` — is what keeps the census from
 * over-matching a comment that mentions the symbol: a client cannot post a Server
 * Action it has not imported.
 */
function importsSymbol(src: string, name: string): boolean {
  for (const m of src.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g
  )) {
    const named = m[1]
      .split(",")
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)[0]
          .trim()
      )
      .filter(Boolean);
    if (named.includes(name)) return true;
  }
  return false;
}

/** Every (client file, action) pair where a poster declares no surface. */
export function unwiredPosters(root: string): string[] {
  const actions = readingActions(root);
  const clients = clientFiles(root);
  const out: string[] = [];
  for (const { rel, src } of clients) {
    if (DECLARES_RE.test(src)) continue;
    for (const [action, file] of actions) {
      if (importsSymbol(src, action))
        out.push(`${rel} posts ${action} (${file})`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Which client files DECLARE a region, and which surface each declares.
 *
 * Accepts both spellings the tree uses: the literal (`<LoggedViaSurface value="…">`)
 * and a file-local constant (`const X: WebLoggedVia = "…"`, which the command palette
 * needs because a component is not inside the provider it renders and so has to name
 * its own surface once for both uses).
 */
export function regionRoots(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // EVERY file, not just the client ones: a region root is often a SERVER component
  // that renders the client provider around server children — the dashboard is exactly
  // that. Scoping this to `"use client"` files would have reported the dashboard's own
  // declaration as missing, which is the "fails toward a plausible correction" shape.
  for (const sub of ["app", "components"]) {
    for (const file of walk(root, sub)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
      if (!src.includes("<LoggedViaSurface")) continue;
      const values = new Set<string>();
      for (const m of src.matchAll(/<LoggedViaSurface\s+value="([a-z-]+)"/g))
        values.add(m[1]);
      for (const m of src.matchAll(/:\s*WebLoggedVia\s*=\s*"([a-z-]+)"/g))
        values.add(m[1]);
      for (const v of values) out.set(v, [...(out.get(v) ?? []), rel]);
    }
  }
  return out;
}

// ── THE UNIVERSE IS EVERY CALL SITE THAT PASSES A SURFACE, LITERAL INCLUDED ───
//
// The census above builds its universe from `parseWebOrigin` — actions that READ a
// posted surface. An action that spells a LITERAL instead is invisible in both
// directions: it is not a reading action, so no client of it is checked for
// declaring; and its literal is never compared against the mountings that reach it.
// That blind spot shipped `logUsualRoutine` recording `dashboard-hero` — the attention
// card's act-now confirm — for a control mounted on the dashboard's usual-routine atom
// and on the phone dock's raised puck, neither of which is that card.
//
// WHAT MAKES A LITERAL HONEST. It is a claim that every mounting able to reach the
// action sits on that surface, so it is true only where there is exactly one mounting.
// `markAttentionDose` and `undoAttentionDose` qualify: one importer, mounted once, on
// the attention card they name. A second mounting makes the same literal a guess about
// which one posted — and the mechanism for that question already exists, so the fix is
// never a better literal, it is `parseWebOrigin` plus a region.
//
// WHAT IT ASKS AND WHAT IT DOES NOT. It asks whether the surface is DECIDABLE from
// where the action stands — one mounting, one answer. It does not ask whether the one
// answer is the right one: `markAttentionDose` could name `quick-log` and stay green,
// because its single mounting means the literal is still a statement rather than a
// guess. Checking the value would mean matching it against the region its mounting
// sits in, and the one legitimate hardcoder is precisely the case that breaks — the
// attention card lives inside the `dashboard-widget` canvas and correctly says
// `dashboard-hero`. A guard that fired there would be deleted within a week.
//
// ONLY THE THREE NON-DEFAULT SURFACES. `page` is the context's default and every
// action's fallback, so a `page` literal claims nothing that is not already true; it is
// also the string this repo writes for `revalidateRoute(path, "page")` and for
// `aria-current="page"`, which would make a literal sweep over it mostly noise. Stated
// rather than filtered, because a census that does not say what it is not looking at
// reports on a scope it never had.

/** The surfaces a literal can make a positive claim about. */
const CLAIMING_SURFACES = [
  "dashboard-hero",
  "dashboard-widget",
  "quick-log",
] as const;
const LITERAL_RE = new RegExp(`["'](${CLAIMING_SURFACES.join("|")})["']`, "g");

/** Comments name these surfaces constantly; only source is source. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Every exported action in `app/` that NAMES a surface instead of reading one.
 *
 * `.ts` only: a Server Action is not a component, and the `.tsx` files carrying these
 * strings are the region roots themselves (`<LoggedViaSurface value="dashboard-widget">`,
 * the palette's `const PALETTE_SURFACE: WebLoggedVia = "quick-log"`), which are the
 * DECLARATION side of the same mechanism rather than a claim needing justification.
 */
export function hardcodingActions(
  root: string
): { action: string; file: string; surface: string }[] {
  const out: { action: string; file: string; surface: string }[] = [];
  for (const file of walk(root, "app")) {
    if (!file.endsWith(".ts")) continue;
    const src = code(fs.readFileSync(file, "utf8"));
    const rel = path.relative(root, file).split(path.sep).join("/");
    const bounds: { name: string; at: number }[] = [];
    for (const m of src.matchAll(EXPORT_RE))
      bounds.push({ name: m[1], at: m.index ?? 0 });
    for (const m of src.matchAll(LITERAL_RE)) {
      const at = m.index ?? 0;
      let owner: string | null = null;
      for (const b of bounds) if (b.at < at) owner = b.name;
      if (owner) out.push({ action: owner, file: rel, surface: m[1] });
    }
  }
  return out;
}

/** A route file is one mounting of itself — the router renders it. */
const ROUTE_RE = /^app\/.*(?:page|layout|template)\.tsx$/;

/** Where each file's component is rendered, as `<host> -> <Tag>`. */
function mountingsOf(
  root: string,
  rel: string,
  every: { rel: string; src: string }[]
): string[] {
  if (ROUTE_RE.test(rel)) return [`${rel} (a route)`];
  const tag = path.basename(rel).replace(/\.tsx?$/, "");
  return every
    .filter((f) => f.rel !== rel && new RegExp(`<${tag}[\\s/>]`).test(f.src))
    .map((f) => `${f.rel} -> <${tag}>`);
}

/** Every hardcoded surface that more than one mounting can reach. */
export function unjustifiedLiterals(root: string): string[] {
  const every = [...walk(root, "app"), ...walk(root, "components")].map(
    (file) => ({
      rel: path.relative(root, file).split(path.sep).join("/"),
      src: code(fs.readFileSync(file, "utf8")),
    })
  );
  const out: string[] = [];
  for (const { action, file, surface } of hardcodingActions(root)) {
    const posters = every.filter(
      (f) => f.rel !== file && importsSymbol(f.src, action)
    );
    const mounts = posters.flatMap((p) => mountingsOf(root, p.rel, every));
    if (mounts.length > 1)
      out.push(
        `${file} names \`${surface}\` in ${action}, reachable from ${mounts.length} mountings: ${mounts.sort().join(", ")}`
      );
  }
  return [...new Set(out)].sort();
}

// ── PER-REGION SURVIVAL, WITHOUT A LIST OF REGIONS ───────────────────────────
//
// The reachability assertion above says what it does not catch, and this closes it.
// `quick-log` is declared by three roots; deleting ONE of them leaves reachability
// green while every control under it silently reverts to `page`. Measured: deleting
// `<LoggedViaSurface value="quick-log">` from `components/QuickEntryProvider.tsx`
// left the whole suite green with the food bar, the measurements form, the dose list,
// the substance row and the practice list all reporting `page` from inside a sheet.
//
// THE NAIVE FIX IS A LIST OF REGIONS, which is the shape this file exists to avoid —
// it goes stale, and it says nothing about a region nobody thought to list. So ask the
// question the mechanism actually answers instead:
//
//   A control that stamps its region reports `page` when nothing above it declares
//   one. `page` means "the domain page's own form". So a stamping control whose
//   mounting chain reaches the ROUTER — a layout or a template — without passing
//   through a page or a region is claiming to be a page form from somewhere that is
//   not a page. That is exactly the state a deleted wrapper produces, and it is a
//   defect no matter which region was deleted or whether anyone listed it.
//
// The walk is over the real mount graph: each stamping control's importers that render
// it as JSX, up through `dynamic(() => import(…))` as well as static imports, until a
// path hits a region root (fine), an `app/**/page.tsx` (fine — `page` is the true
// answer there), or a router root with neither (a finding). A path that dead-ends in a
// component nothing mounts renders nowhere and is deliberately silent.
//
// WHAT IT CANNOT SEE, said plainly: a region root whose subtree contains no stamping
// control at all. Deleting the command palette's wrapper is invisible here — and
// correctly so today, because the palette sets `LOGGED_VIA_FIELD` from its own
// file-local constant rather than from the context, so nothing under it reads the
// region. Reachability above is what holds that one.

/** A control that posts whatever region it is mounted in. */
const STAMPS_RE = /useLoggedViaStamp\s*\(|<LoggedViaField/;

function resolveSpec(
  root: string,
  fromRel: string,
  spec: string,
  known: Set<string>
): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
  else if (spec.startsWith("."))
    base = path.resolve(path.join(root, path.dirname(fromRel)), spec);
  else return null;
  const rel = path.relative(root, base).split(path.sep).join("/");
  for (const cand of [
    `${rel}.tsx`,
    `${rel}.ts`,
    `${rel}/index.tsx`,
    `${rel}/index.ts`,
  ])
    if (known.has(cand)) return cand;
  return null;
}

/** Who renders whom: `file -> the files whose components it mounts as JSX`. */
export function mountGraph(root: string): {
  files: { rel: string; src: string }[];
  mountedBy: Map<string, Set<string>>;
} {
  const files = [...walk(root, "app"), ...walk(root, "components")].map(
    (file) => ({
      rel: path.relative(root, file).split(path.sep).join("/"),
      src: code(fs.readFileSync(file, "utf8")),
    })
  );
  const known = new Set(files.map((f) => f.rel));
  const mountedBy = new Map(files.map((f) => [f.rel, new Set<string>()]));
  for (const { rel, src } of files) {
    const local = new Map<string, string>();
    for (const im of src.matchAll(
      /import\s+([^;]*?)\s+from\s*["']([^"']+)["']/g
    )) {
      const target = resolveSpec(root, rel, im[2], known);
      if (!target) continue;
      const clause = im[1].trim();
      const def = /^([A-Za-z0-9_$]+)\s*(?:,|$)/.exec(
        clause.replace(/^type\s+/, "")
      );
      if (def && !clause.startsWith("{") && !clause.startsWith("*"))
        local.set(def[1], target);
      const named = /\{([^}]*)\}/.exec(clause);
      for (const part of named?.[1].split(",") ?? []) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        local.set(
          /\s+as\s+/.test(t) ? t.split(/\s+as\s+/)[1].trim() : t,
          target
        );
      }
    }
    // `next/dynamic` is how the quick-log sheet mounts four of its five bodies, so a
    // graph that saw only static imports would report them unreachable and stay quiet
    // about exactly the region this assertion exists for.
    for (const dy of src.matchAll(
      /(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*dynamic\s*\(\s*\(\)\s*=>\s*import\s*\(\s*["']([^"']+)["']/g
    )) {
      const target = resolveSpec(root, rel, dy[2], known);
      if (target) local.set(dy[1], target);
    }
    for (const j of src.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) {
      const target = local.get(j[1]);
      if (target && target !== rel) mountedBy.get(target)!.add(rel);
    }
  }
  return { files, mountedBy };
}

/** Every stamping control that can render outside any page and outside any region. */
export function stampersOutsideEveryRegion(root: string): string[] {
  const { files, mountedBy } = mountGraph(root);
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const out: string[] = [];
  for (const { rel, src } of files) {
    if (rel === "components/LoggedViaSurface.tsx") continue;
    if (!STAMPS_RE.test(src)) continue;
    const stack: [string, string[]][] = [[rel, [rel]]];
    const seen = new Set<string>();
    while (stack.length) {
      const [cur, chain] = stack.pop()!;
      if (byRel.get(cur)!.src.includes("<LoggedViaSurface")) continue;
      if (/^app\/.*page\.tsx$/.test(cur)) continue;
      const parents = [...mountedBy.get(cur)!];
      if (parents.length === 0) {
        if (ROUTE_RE.test(cur)) out.push(chain.join(" <- "));
        continue;
      }
      for (const p of parents) {
        if (seen.has(`${rel}|${p}`)) continue;
        seen.add(`${rel}|${p}`);
        stack.push([p, [...chain, p]]);
      }
    }
  }
  return [...new Set(out)].sort();
}

describe("every surface-reading action has a mounting that declares itself", () => {
  it("has a corpus to make a claim about", () => {
    // AN ABSENCE ASSERTION FAILS OPEN, so the floors come first: a broken walker
    // finds no read sites and no clients, and reports a clean sweep it never took.
    // The numbers are floors measured on 2026-08-22 (17 reads across 9 action files,
    // and well over a hundred client files), set below the real figures so ordinary
    // churn does not trip them and a collapsed scan does.
    const actions = readingActions(REPO);
    expect(actions.size).toBeGreaterThanOrEqual(12);
    // The named subject: the action #3087's own illustration turns on.
    expect([...actions.keys()]).toContain("logFoodServing");
    expect(clientFiles(REPO).length).toBeGreaterThanOrEqual(50);
  });

  it("has a REGION ROOT producing every non-default web surface", () => {
    // THE OTHER DIRECTION OF THE UNION, and the one the poster check cannot see. Every
    // control inside the quick-log sheet declares itself correctly through the hook —
    // and reports `page` for ever if the SHEET stops declaring the region, because the
    // context then answers its default and every child agrees with it. Nothing about
    // the children changes, so nothing about them can go red.
    //
    // So the vocabulary is asked to be REACHABLE: a value a browser may claim, that no
    // mounting in the whole app produces, is a value the column will never hold and a
    // sentence in `LOGGED_VIA_MEANING` that describes nothing. Deleting a value is a
    // deliberate act; losing one by deleting a wrapper is not.
    //
    // `page` is deliberately absent: it is the context's default, so it is produced by
    // every mounting that declares nothing and cannot go missing.
    //
    // WHAT THIS DOES NOT CATCH, stated so nobody reads it as more than it is: the
    // question is REACHABILITY, not per-region survival. `quick-log` is declared by
    // both the quick-log sheet and the command palette, so deleting ONE of those two
    // wrappers leaves this green while every control in that region silently reverts
    // to `page`. Measured deliberately, by deleting each in turn. Closing it needs a
    // per-region assertion, and a list of regions is the shape this file exists to
    // avoid — so the gap is named rather than papered over.
    const roots = regionRoots(REPO);
    for (const surface of ["quick-log", "dashboard-widget"] as const) {
      expect(
        roots.get(surface) ?? [],
        `No mounting in the app declares \`${surface}\` (#3087), so no web write can ` +
          "ever record it. Either a region root lost its `<LoggedViaSurface>` wrapper, " +
          "or the value should come out of the vocabulary — but a vocabulary member " +
          "nothing produces describes nothing."
      ).not.toEqual([]);
    }
    // `dashboard-hero` is the attention card, whose actions are single-surface and name
    // it themselves (app/(app)/actions.ts) rather than reading a post — so it has no
    // region root by design, and asserting one here would be asserting a fiction.
    expect(roots.get("dashboard-hero")).toBeUndefined();
  });

  it("lets no hardcoded surface outlive the single mounting that makes it true", () => {
    expect(
      unjustifiedLiterals(REPO),
      "A Server Action NAMES a web surface that more than one mounting can reach " +
        "(#3087). A literal is a claim that every mounting able to post this action " +
        "sits on that surface, so a second mounting makes it a guess about which one " +
        "did — and the two will differ in the column for ever. Read the posted " +
        'surface with `parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page")` and ' +
        "let each mounting declare its own region instead."
    ).toEqual([]);
  });

  it("keeps a region root over every control that reads one", () => {
    expect(
      stampersOutsideEveryRegion(REPO),
      "A control that stamps its surface can render from a layout with no " +
        '`<LoggedViaSurface>` above it (#3087), so it posts `page` — "the domain ' +
        "page's own form\" — from somewhere that is not a page. Either a region root " +
        "lost its wrapper, or a new always-mounted host needs one. The chain below " +
        "reads control first, host last."
    ).toEqual([]);
  });

  it("leaves no client posting a surface-reading action with no way to say where it is", () => {
    expect(
      unwiredPosters(REPO),
      "A client component posts a Server Action that reads `logged_via` off the " +
        "post, but declares no surface (#3087). Either stamp its FormData through " +
        "`useLoggedViaStamp()`, render `<LoggedViaField />` inside its form, or — " +
        "if it is a region root — wrap its subtree in `<LoggedViaSurface value=…>`. " +
        "Without one of those the action takes its `page` fallback on every request " +
        "from this mounting, whatever surface it actually is."
    ).toEqual([]);
  });
});

describe("the census's reach", () => {
  // A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN SEE, so
  // the offenders are planted on disk and the WHOLE walker runs over them — the file
  // selection, the "use client" test, the export attribution and the import match.
  function corpus(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "logged-via-wiring-"));
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return root;
  }

  const ACTION = `"use server";
export async function logThing(formData: FormData) {
  return core(parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"));
}
`;

  it("sees a client that posts a reading action and declares nothing", () => {
    const root = corpus({
      "app/(app)/x/actions.ts": ACTION,
      "components/ThingBar.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "export default function ThingBar() {\n  return logThing(new FormData());\n}\n",
    });
    expect(unwiredPosters(root)).toEqual([
      "components/ThingBar.tsx posts logThing (app/(app)/x/actions.ts)",
    ]);
  });

  it("attributes a read to the RIGHT action when a file exports several", () => {
    // The failure this rules out is an off-by-one that blames a neighbour: a file
    // with a plain action above and a reading action below must name the second.
    const root = corpus({
      "app/(app)/x/actions.ts":
        '"use server";\nexport async function plainOne(fd: FormData) { return 1; }\n' +
        ACTION.replace('"use server";\n', ""),
      "components/ThingBar.tsx":
        '"use client";\nimport { plainOne } from "@/app/(app)/x/actions";\n',
    });
    // `plainOne` reads nothing, so importing it is not a finding.
    expect(unwiredPosters(root)).toEqual([]);
    expect([...readingActions(root).keys()]).toEqual(["logThing"]);
  });

  it("STAYS SILENT on the neighbours it must not cry wolf about", () => {
    // A guard that fired on a compliant client, on a server component, or on a file
    // that merely MENTIONS the symbol would be deleted within a week, taking the real
    // guard with it.
    const root = corpus({
      "app/(app)/x/actions.ts": ACTION,
      // Compliant three ways.
      "components/Stamped.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "import { useLoggedViaStamp } from '@/components/LoggedViaSurface';\n",
      "components/Fielded.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "import { LoggedViaField } from '@/components/LoggedViaSurface';\n",
      "components/Region.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "import { LoggedViaSurface } from '@/components/LoggedViaSurface';\n",
      // A SERVER component: it posts through an inline server action on the page it
      // IS, which is what `page` means. Not a mounting that can declare anything.
      "app/(app)/x/page.tsx":
        'import { logThing } from "@/app/(app)/x/actions";\n',
      // A client that only NAMES the symbol in prose.
      "components/Mentions.tsx":
        '"use client";\n// logThing is the action the bar over there posts.\n',
    });
    expect(unwiredPosters(root)).toEqual([]);
  });

  it("SEES a literal a second mounting can reach, and stays quiet on a lone one", () => {
    const files = {
      "app/(app)/actions.ts":
        '"use server";\nexport async function logTwice(fd: FormData) {\n' +
        '  return core(fd, "dashboard-hero");\n}\n' +
        "export async function logOnce(fd: FormData) {\n" +
        '  return core(fd, "dashboard-hero");\n}\n' +
        "export async function logPage(fd: FormData) {\n" +
        // `page` claims nothing a fallback does not already say, and it is the string
        // `revalidateRoute(path, "page")` writes — deliberately outside the universe.
        '  return revalidateRoute("/x/[id]", "page");\n}\n',
      "components/Twice.tsx":
        '"use client";\nimport { logTwice } from "@/app/(app)/actions";\n',
      "components/Once.tsx":
        '"use client";\nimport { logOnce } from "@/app/(app)/actions";\n',
      "components/HostA.tsx":
        '"use client";\nexport default () => <Twice />;\n',
      "components/HostB.tsx":
        '"use client";\nexport default () => <Twice />;\n',
      "components/HostC.tsx": '"use client";\nexport default () => <Once />;\n',
      // A comment that merely names the surface must not become a finding.
      "app/(app)/notes.ts":
        "// The palette IS the quick-log surface.\nexport function note() {}\n",
    };
    const root = corpus(files);
    expect(unjustifiedLiterals(root)).toEqual([
      "app/(app)/actions.ts names `dashboard-hero` in logTwice, reachable from 2 " +
        "mountings: components/HostA.tsx -> <Twice>, components/HostB.tsx -> <Twice>",
    ]);
  });

  it("SEES a stamping control left outside every region, and stays quiet when one covers it", () => {
    // The acceptance test in miniature: one sheet mounted from a LAYOUT, one control
    // inside it that stamps. With the wrapper the walk stops at the region; without
    // it the chain runs to the router and the control posts `page` from a sheet.
    const control =
      '"use client";\nimport { useLoggedViaStamp } from "@/components/LoggedViaSurface";\n' +
      "export default function Bar() {\n  const s = useLoggedViaStamp();\n  return null;\n}\n";
    const layout =
      'import Sheet from "@/components/Sheet";\nexport default () => <Sheet />;\n';
    const wrapped =
      '"use client";\nimport { LoggedViaSurface } from "@/components/LoggedViaSurface";\n' +
      'import Bar from "@/components/Bar";\n' +
      'export default () => (<LoggedViaSurface value="quick-log"><Bar /></LoggedViaSurface>);\n';
    const bare =
      '"use client";\nimport Bar from "@/components/Bar";\nexport default () => <Bar />;\n';
    expect(
      stampersOutsideEveryRegion(
        corpus({
          "app/(app)/layout.tsx": layout,
          "components/Sheet.tsx": bare,
          "components/Bar.tsx": control,
        })
      )
    ).toEqual([
      "components/Bar.tsx <- components/Sheet.tsx <- app/(app)/layout.tsx",
    ]);
    expect(
      stampersOutsideEveryRegion(
        corpus({
          "app/(app)/layout.tsx": layout,
          "components/Sheet.tsx": wrapped,
          "components/Bar.tsx": control,
        })
      )
    ).toEqual([]);
    // …and the same control mounted by a PAGE is silent with no region at all: `page`
    // is the honest answer there, and a guard that cried wolf on every domain form
    // would be deleted within a week.
    expect(
      stampersOutsideEveryRegion(
        corpus({
          "app/(app)/x/page.tsx":
            'import Bar from "@/components/Bar";\nexport default () => <Bar />;\n',
          "components/Bar.tsx": control,
        })
      )
    ).toEqual([]);
  });

  it("follows a `dynamic(() => import(…))` mount, which is how the sheet loads its bodies", () => {
    // Four of the quick-log sheet's five bodies arrive this way. A graph blind to it
    // reports them unmounted and goes quiet about exactly the region it is here for.
    const root = corpus({
      "app/(app)/layout.tsx":
        'import Sheet from "@/components/Sheet";\nexport default () => <Sheet />;\n',
      "components/Sheet.tsx":
        '"use client";\nimport dynamic from "next/dynamic";\n' +
        'const Lazy = dynamic(() => import("./Lazy"));\nexport default () => <Lazy />;\n',
      "components/Lazy.tsx":
        '"use client";\nimport { useLoggedViaStamp } from "@/components/LoggedViaSurface";\n' +
        "export default function Lazy() {\n  const s = useLoggedViaStamp();\n  return null;\n}\n",
    });
    expect(stampersOutsideEveryRegion(root)).toEqual([
      "components/Lazy.tsx <- components/Sheet.tsx <- app/(app)/layout.tsx",
    ]);
  });

  it("scans the TRACKED set it claims to be about", () => {
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z", "app", "components"], {
        cwd: REPO,
        maxBuffer: 64 * 1024 * 1024,
      })
        .toString("utf8")
        .split("\u0000")
        .filter(Boolean)
    );
    const untracked = [...walk(REPO, "app"), ...walk(REPO, "components")]
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((rel) => !tracked.has(rel));
    expect(untracked).toEqual([]);
  });
});
