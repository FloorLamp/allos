import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments";

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
// intentionally unlinked detail/new/API pages (e.g. /results/clinical-results/view,
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
// don't contribute a URL segment, so `app/(app)/results/page.tsx` serves
// `/results`. Dynamic (`[id]`), catch-all (`[...x]`), parallel (`@slot`),
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
// These are the sources feeding Upcoming and the preventive adapter. Dashboard
// attention targets go through typed href helpers, so they need no literal scan.
// Static targets only: a template
// literal contributes its static path prefix (e.g. `/results/clinical-results/view?name=${…}`
// → /results/clinical-results/view).
const DUE_SIGNAL_SOURCES = [
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
  // ── the episodic group's membership (#3079) ────────────────────────────────
  //
  // Six surfaces the 2026-08-17 usage review measured at zero deliberate visits
  // moved from top-level rows to children of one collapsed "Plan & review" group.
  // The pull back the other way is a ONE-LINE edit — cut a leaf out of
  // PLAN_REVIEW.children, paste it into `entries` — and every other check in this
  // file would stay green through it, because the href still resolves and the
  // route still exists. Nothing about a route's EXISTENCE can see a demotion being
  // undone, so the placement is pinned as text here, where it is cheap, in addition
  // to being pinned behaviorally in e2e/nav-consolidation.spec.ts.
  //
  // Text, not behavior, on purpose: this tier is DB- and JSX-free, and the
  // registry it guards is a literal array in a client component.
  //
  // "/trends", not "/history": #4965 swapped the two — the day view's #4918
  // promotion earned History a top-level row, and Trends took the vacated
  // group slot. Six members either way.
  const GROUPED_HREFS = [
    "/upcoming",
    "/trends",
    "/wellness",
    "/longevity",
    "/household",
    "/progress",
  ];

  // The source text of one top-level `const <name> ... <close>;` declaration in
  // Nav.tsx, comments stripped so a route named in prose never counts as a
  // placement. Anchored on the closing brace/bracket at column 0, which is where
  // Prettier puts it for a module-level declaration.
  function navDeclaration(name: string, close: string): string {
    const src = stripComments(fs.readFileSync(NAV_SRC, "utf8"));
    const start = src.indexOf(`const ${name}`);
    expect(start, `Nav.tsx no longer declares ${name}`).toBeGreaterThan(-1);
    const end = src.indexOf(`\n${close};`, start);
    expect(end, `could not find the end of ${name}`).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("the six demoted surfaces are group children, not top-level rows (#3079)", () => {
    const group = navDeclaration("PLAN_REVIEW", "}");
    const topLevel = navDeclaration("entries", "]");

    // Sanity anchors, so a renamed declaration or a broken slice fails loudly
    // instead of passing vacuously against two empty strings.
    expect(group).toContain('group: "Plan & review"');
    expect(topLevel).toContain('href: "/settings"');
    expect(topLevel).not.toContain('group: "Plan & review"');

    const missing = GROUPED_HREFS.filter(
      (h) => !group.includes(`href: "${h}"`)
    );
    expect(
      missing,
      `these left the "Plan & review" group: ${missing.join(", ")}`
    ).toEqual([]);

    // The direction that actually regresses: a child promoted back up.
    const promoted = GROUPED_HREFS.filter((h) =>
      topLevel.includes(`href: "${h}"`)
    );
    expect(
      promoted,
      `these are top-level rows again — #3079 demoted them to "Plan & review" children, and a promotion needs its own reasoning: ${promoted.join(", ")}`
    ).toEqual([]);
  });
});
