import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PULL_INTEGRATIONS } from "@/lib/integrations/registry";

// Static consistency guard for the sidebar ↔ App-Router routes, in the same
// "pure" spirit as profile-scoping.test.ts: it reads the repo's own source as
// TEXT (no DB, no network) and fails the build when navigation points at a page
// that doesn't exist on disk. The app has repeatedly moved pages around
// (sidebar consolidation, the Data hub, the Medical group, dropped legacy
// redirects), and a stale nav href is a recurring bug the human-facing docs
// call out — this test catches it automatically.
//
// Direction that matters: every nav destination (and every remaining
// next.config redirect target) MUST resolve to a real route. We deliberately do
// NOT assert the reverse (every route has a nav entry) — many routes are
// intentionally unlinked detail/new/API pages (e.g. /biomarkers/[id],
// /goals, /import, /integrations) reached by deep links, not the sidebar.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NAV_SRC = path.join(REPO, "components", "Nav.tsx");
const APP_DIR = path.join(REPO, "app");
const NEXT_CONFIG = path.join(REPO, "next.config.js");

const PAGE_FILES = new Set([
  "page.tsx",
  "page.ts",
  "page.jsx",
  "page.js",
  "route.ts",
  "route.js",
]);

// Walk the app/ tree and collect every *static* URL path that is backed by a
// page (or route handler). Next.js route groups — directories named `(name)` —
// don't contribute a URL segment, so `app/(app)/biomarkers/page.tsx` serves
// `/biomarkers`. Dynamic (`[id]`), catch-all (`[...x]`), parallel (`@slot`),
// and intercepting (`(.)`) segments are skipped: nav hrefs are all static, so
// they never need those, and including them would only add noise.
function collectRoutePaths(dir: string, urlSegments: string[]): Set<string> {
  const routes = new Set<string>();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && PAGE_FILES.has(entry.name)) {
      routes.add("/" + urlSegments.join("/"));
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // Skip dynamic / catch-all / parallel segments — not addressable by a
    // static nav href.
    if (name.startsWith("[") || name.startsWith("@")) continue;
    const isRouteGroup = name.startsWith("(") && name.endsWith(")");
    const nextSegments = isRouteGroup ? urlSegments : [...urlSegments, name];
    for (const r of collectRoutePaths(path.join(dir, name), nextSegments)) {
      routes.add(r);
    }
  }
  return routes;
}

// Normalize a collected route path: the root becomes "/", everything else has
// no trailing slash.
function normalize(route: string): string {
  return route === "" ? "/" : route.replace(/\/+$/, "") || "/";
}

const ROUTES = new Set([...collectRoutePaths(APP_DIR, [])].map(normalize));

// Extract every `href: "..."` literal from Nav.tsx. Both shapes in the current
// nav model expose the destination through the same `href` key — a top-level
// Leaf `{ href, label, icon }` and a Group's `children: Leaf[]` — so one regex
// captures top-level entries AND every group child. If Nav.tsx ever moves the
// link target off a string-literal `href` (e.g. a computed URL), this regex
// would silently miss it; the presence assertion below guards against the
// extractor going quietly empty.
function navHrefs(): string[] {
  const src = fs.readFileSync(NAV_SRC, "utf8");
  const hrefs = new Set<string>();
  const re = /href:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    hrefs.add(m[1]);
  }
  return [...hrefs];
}

// The due-signal builders whose href literals must point at real pages (issue
// #283: goal items linked the removed /goals route and screenings the removed
// /medical route for months — nothing guarded item links the way nav links are).
// These are the sources feeding the Upcoming page, the dashboard "Needs
// attention" hero, and the preventive adapter. Static targets only: a template
// literal contributes its static path prefix (e.g. `/biomarkers/view?name=${…}`
// → /biomarkers/view).
const DUE_SIGNAL_SOURCES = [
  ["lib", "attention.ts"],
  // The Upcoming item builders (their href literals) live in the generators
  // submodule since the #316 barrel split of lib/queries/upcoming.ts.
  ["lib", "queries", "upcoming", "generators.ts"],
  ["lib", "preventive-upcoming.ts"],
  // The preventive concept map holds the instrument-page deep-link targets
  // (`satisfiedBy.page`) that preventiveHref builds a `?screen=` link onto (#1083),
  // so a removed instrument page would fail here, not just in preventive-upcoming.ts.
  ["lib", "preventive-concept-map.ts"],
  ["lib", "care-plan-upcoming.ts"],
].map((parts) => path.join(REPO, ...parts));

// Strip comments so a route mentioned in prose (e.g. "the old `/medical` target
// was removed") doesn't register as a link target. Coarse but sufficient here:
// none of the scanned sources embed `//` or `/*` inside string literals.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Every `/`-rooted string literal (double-quoted or template) in a due-signal
// source, reduced to its static path: query/hash and template expressions are
// cut. This deliberately over-collects rather than keying on `href:` — the
// builders also hold route strings in maps and helper returns (HREF_BY_KIND's
// successor, preventiveHref), and a missed literal is exactly how the dead
// links survived.
function dueSignalPaths(file: string): string[] {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  const out = new Set<string>();
  const re = /"(\/[^"\n]*)"|`(\/[^`\n]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const raw = m[1] ?? m[2];
    const staticPath = raw.split(/[?#]|\$\{/)[0];
    if (staticPath) out.add(staticPath);
  }
  return [...out];
}

// ── revalidatePath targets (issue #1636) ────────────────────────────────────────
//
// `revalidatePath` takes a PLAIN STRING, so `typedRoutes` can never catch a dead
// one: after the #1042/#1079 route merges several Server Actions kept revalidating
// URLs that no longer serve anything (`/encounters`, `/journal`, `/body`), which
// made the refresh a silent no-op and left the moved surface stale. This guard
// closes that gap the same way the nav/due-signal guards close theirs.
//
// The target set is the FULL route tree — dynamic segments included, kept as their
// literal `[param]` form — because a dynamic route is a legitimate revalidation
// target both as a written literal (`revalidatePath("/medical/episodes/[id]",
// "page")`) and as an interpolated one (`revalidatePath(`/providers/${id}`)`),
// which normalizes to `/providers/*` below.
function collectAllRoutePaths(dir: string, urlSegments: string[]): Set<string> {
  const routes = new Set<string>();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && PAGE_FILES.has(entry.name)) {
      routes.add("/" + urlSegments.join("/"));
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith("@")) continue;
    const isRouteGroup = name.startsWith("(") && name.endsWith(")");
    const nextSegments = isRouteGroup ? urlSegments : [...urlSegments, name];
    for (const r of collectAllRoutePaths(path.join(dir, name), nextSegments)) {
      routes.add(r);
    }
  }
  return routes;
}

const ALL_ROUTES = [...collectAllRoutePaths(APP_DIR, [])].map(normalize);

// Every `.ts`/`.tsx` under app/ (the only place Server Actions and route handlers
// live), so the sweep can never miss a file by being enumerated by hand.
function appSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...appSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Path literals handed to `revalidatePath` in one file: the direct call form
// (quoted or template), plus every ARRAY LITERAL whose elements are ALL `/`-rooted
// strings — the `for (const p of [...]) revalidatePath(p)` and
// `EDIT_LOCK_REVALIDATE`-style fan-outs that carry most of the targets and that a
// call-site-only regex would miss. Template expressions collapse to `*`, which the
// matcher below accepts against a `[param]` segment.
function revalidateTargets(file: string): string[] {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  if (!src.includes("revalidatePath")) return [];
  const out = new Set<string>();
  const call = /revalidatePath\(\s*(["`])([^"`]*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src)) !== null) out.add(m[2]);
  const arrays = /\[\s*((?:["`][^"`]*["`]\s*,\s*)*["`][^"`]*["`]\s*,?)\s*\]/g;
  while ((m = arrays.exec(src)) !== null) {
    const items = [...m[1].matchAll(/["`]([^"`]*)["`]/g)].map((x) => x[1]);
    if (items.length > 0 && items.every((i) => i.startsWith("/"))) {
      for (const i of items) out.add(i);
    }
  }
  return [...out].filter((p) => p.startsWith("/"));
}

// A revalidation target resolves when some real route matches it segment for
// segment, where an interpolated segment (`*`) matches a dynamic one (`[id]`).
// EXACT segment count — unlike a nav href, a revalidation path is the page being
// refreshed, not a section root, so `/encounters` must NOT pass on the strength of
// `/encounters/[id]` existing (that was the #1636 bug).
function revalidateResolves(target: string): boolean {
  const clean = target.split(/[?#]/)[0].replace(/\$\{[^}]*\}/g, "*");
  const want = clean === "/" ? [] : clean.replace(/^\/|\/$/g, "").split("/");
  return ALL_ROUTES.some((route) => {
    const have = route === "/" ? [] : route.replace(/^\//, "").split("/");
    if (have.length !== want.length) return false;
    return have.every(
      (seg, i) => seg === want[i] || (seg.startsWith("[") && want[i] === "*")
    );
  });
}

// Extract internal redirect destinations from next.config.js. Source-scanned
// (not executed) to keep this test pure and side-effect-free. We dropped the
// legacy redirects, so today there are none — the empty case is expected and
// must pass. Only `/`-rooted (internal) destinations are checked; any external
// (http/https) destination is skipped.
function redirectDestinations(): string[] {
  const src = fs.readFileSync(NEXT_CONFIG, "utf8");
  const dests = new Set<string>();
  const re = /destination:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const dest = m[1];
    if (dest.startsWith("/")) dests.add(dest);
  }
  return [...dests];
}

// Whether `href` resolves to a real route. Since nav highlighting matches by
// prefix (isRouteActive), a nav href is valid if it is itself a route OR a
// prefix of one (e.g. a section index). We require an exact route match here —
// every current nav href is a real page — but the fallback keeps the test from
// false-failing on a legitimate section root that only has child pages.
function resolves(href: string): boolean {
  const target = normalize(href.split(/[?#]/)[0]);
  if (ROUTES.has(target)) return true;
  const prefix = target === "/" ? "/" : target + "/";
  for (const r of ROUTES) {
    if (r.startsWith(prefix)) return true;
  }
  return false;
}

describe("nav ↔ route consistency", () => {
  it("discovers app routes and nav hrefs (extractors aren't silently empty)", () => {
    // Sanity anchors so a broken parser/walker fails loudly instead of passing
    // vacuously.
    expect(ROUTES.has("/")).toBe(true);
    expect(ROUTES.has("/settings")).toBe(true);
    expect(navHrefs().length).toBeGreaterThan(5);
  });

  it("every nav href resolves to a real App-Router page", () => {
    const hrefs = navHrefs();
    const missing = hrefs.filter((h) => !resolves(h));
    expect(
      missing,
      `nav hrefs with no matching page under app/: ${missing.join(", ")}`
    ).toEqual([]);
    expect(hrefs).toContain("/wellness");
  });

  it("every internal next.config redirect destination resolves to a real page", () => {
    const dests = redirectDestinations();
    const missing = dests.filter((d) => !resolves(d));
    expect(
      missing,
      `redirect destinations with no matching page: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every due-signal href literal (Upcoming / attention / preventive) resolves to a real page (issue #283)", () => {
    for (const file of DUE_SIGNAL_SOURCES) {
      const paths = dueSignalPaths(file);
      // Sanity anchor per file: the extractor must not go quietly empty (every
      // scanned source links at least one route today).
      expect(
        paths.length,
        `no route literals found in ${file} — extractor broken?`
      ).toBeGreaterThan(0);
      const missing = paths.filter((p) => !resolves(p));
      expect(
        missing,
        `${path.relative(REPO, file)} links routes with no matching page under app/: ${missing.join(", ")}`
      ).toEqual([]);
    }
  });
  it("every revalidatePath target under app/ resolves to a real route (issue #1636)", () => {
    const files = appSourceFiles(APP_DIR);
    const bad: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const target of revalidateTargets(file)) {
        seen++;
        if (!revalidateResolves(target)) {
          bad.push(`${path.relative(REPO, file)} → ${target}`);
        }
      }
    }
    // Sanity anchor: the sweep must not go quietly empty.
    expect(
      seen,
      "no revalidatePath targets found — extractor broken?"
    ).toBeGreaterThan(50);
    expect(
      bad,
      `revalidatePath targets with no matching route under app/ (the refresh is a silent no-op):\n${bad.join("\n")}`
    ).toEqual([]);
  });
  it("every registry pull `revalidates` route resolves (issue #2040)", () => {
    // The four per-provider sync actions each carried their own hand-written
    // revalidate fan-out under app/, where the sweep above found them. #2040 moved
    // those lists into the registry's pull facet — outside app/ — so the same
    // guarantee needs the same sweep here, or a retired route would go quietly
    // un-revalidated on every manual sync.
    const bad: string[] = [];
    let seen = 0;
    for (const def of PULL_INTEGRATIONS) {
      for (const target of def.pull.revalidates) {
        seen++;
        if (!revalidateResolves(target)) bad.push(`${def.id} → ${target}`);
      }
    }
    expect(
      seen,
      "no pull providers registered — extractor broken?"
    ).toBeGreaterThan(0);
    expect(
      bad,
      `registry pull revalidates with no matching route under app/:\n${bad.join("\n")}`
    ).toEqual([]);
  });
});
