import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  ["lib", "queries", "upcoming.ts"],
  ["lib", "preventive-upcoming.ts"],
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
    const missing = navHrefs().filter((h) => !resolves(h));
    expect(
      missing,
      `nav hrefs with no matching page under app/: ${missing.join(", ")}`
    ).toEqual([]);
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
});
