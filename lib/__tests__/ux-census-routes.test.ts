import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCLOSURE_EXPANSIONS,
  DYNAMIC_ROUTES,
  HOVER_CAPTURES,
  HUB_VARIANTS,
  routeSlug,
} from "../../scripts/ux-census-routes.mjs";
import { NUTRITION_TABS } from "../hrefs";
import { TRAINING_TABS } from "../training-tabs";
import { TREND_METRIC_SLUGS } from "../trend-metrics";
import { TRENDS_TABS } from "../trends-tabs";
import { vaccineByCode } from "../immunization-catalog";

// Guard for the UX census's dynamic-route registry (#1544), in the repo's
// source-scan idiom — filesystem only, no DB, no network, so it stays pure.
//
// The census (`scripts/ux-walkthrough.mjs`, `pages` journey) enumerates
// app/(app)/**/page.tsx off the filesystem. Static routes therefore self-maintain;
// a `[param]` route cannot, because it needs an id. Before #1544 the walker just
// skipped them, so the all-pages audit covered zero detail pages and the #1510
// metrics probe recorded no detail-page rows at all.
//
// scripts/ux-census-routes.mjs closes that by naming ONE resolvable instance per
// pattern. This test is what keeps the registry honest between census runs: the
// census is a manual seeing tool that may not run for weeks, so a pattern added
// (or a literal slug renamed) in the meantime would otherwise silently un-census
// a route and nobody would notice until someone read a run's BLIND SPOT lines.
// The failures here are cheap and immediate instead.

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app", "(app)");

function walk(dir: string, route: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      if (e.name === "page.tsx") out.push(route || "/");
      continue;
    }
    walk(path.join(dir, e.name), `${route}/${e.name}`, out);
  }
}

const allRoutes: string[] = [];
walk(appDir, "", allRoutes);
const dynamicRoutes = allRoutes.filter((r) => r.includes("["));
const staticRoutes = new Set(allRoutes.filter((r) => !r.includes("[")));

describe("ux census dynamic-route registry", () => {
  it("covers every dynamic app/(app) route", () => {
    const registered = new Set(DYNAMIC_ROUTES.map((d) => d.pattern));
    const missing = dynamicRoutes.filter((r) => !registered.has(r));
    expect(
      missing,
      `add a DYNAMIC_ROUTES entry in scripts/ux-census-routes.mjs, or the census cannot reach: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("registers no route that no longer exists", () => {
    const present = new Set(dynamicRoutes);
    const stale = DYNAMIC_ROUTES.map((d) => d.pattern).filter(
      (p) => !present.has(p)
    );
    expect(stale, `stale DYNAMIC_ROUTES entries: ${stale.join(", ")}`).toEqual(
      []
    );
  });

  it("gives each pattern exactly one entry", () => {
    const seen = new Set<string>();
    for (const d of DYNAMIC_ROUTES) {
      expect(seen.has(d.pattern), `duplicate entry for ${d.pattern}`).toBe(
        false
      );
      seen.add(d.pattern);
    }
  });

  it("resolves each instance to its own pattern", () => {
    for (const d of DYNAMIC_ROUTES) {
      if (d.strategy !== "literal") continue;
      // "/trends/metric/[kind]" + "/trends/metric/weight" — same shape, one
      // concrete segment where the param is.
      const patternParts = d.pattern.split("/");
      const instanceParts = d.instance!.split("/");
      expect(instanceParts.length, d.pattern).toBe(patternParts.length);
      for (const [i, part] of patternParts.entries()) {
        if (part.startsWith("[")) expect(instanceParts[i]).toBeTruthy();
        else expect(instanceParts[i]).toBe(part);
      }
    }
  });

  it("pins literal slugs to the enums they claim to come from", () => {
    const byPattern = new Map(DYNAMIC_ROUTES.map((d) => [d.pattern, d]));
    const metric = byPattern.get("/trends/metric/[kind]");
    expect(metric?.slug).toBeTruthy();
    expect(
      (TREND_METRIC_SLUGS as readonly string[]).includes(metric!.slug!),
      `${metric!.slug} is no longer a TREND_METRIC_SLUGS member`
    ).toBe(true);

    const vaccine = byPattern.get("/immunizations/[vaccine]");
    expect(vaccine?.slug).toBeTruthy();
    expect(
      vaccineByCode(vaccine!.slug!),
      `${vaccine!.slug} is no longer a vaccine catalog code`
    ).toBeDefined();
  });

  it("follows only index routes that still exist", () => {
    for (const d of DYNAMIC_ROUTES) {
      if (d.strategy !== "follow") continue;
      expect(
        d.from!.length,
        `${d.pattern} has no index candidates`
      ).toBeGreaterThan(0);
      // A candidate may carry a query (a hub's list can live on a tab), so the
      // existence check is on the pathname.
      for (const from of d.from!)
        expect(
          staticRoutes.has(from.split("?")[0]),
          `${d.pattern} follows ${from}, which is not an app/(app) route`
        ).toBe(true);
    }
  });

  it("matches a plausible detail href with each follow pattern", () => {
    for (const d of DYNAMIC_ROUTES) {
      if (d.strategy !== "follow") continue;
      const sample = d.pattern.replace(/\[[^\]]+\]/, "7");
      expect(
        d.match!.test(sample),
        `${d.pattern}: match regex rejects ${sample}`
      ).toBe(true);
      // …and does not swallow the index route it follows, which would make the
      // census screenshot the list instead of the detail page.
      for (const from of d.from!)
        expect(
          d.match!.test(from.split("?")[0]),
          `${d.pattern}: match regex accepts ${from}`
        ).toBe(false);
    }
  });

  it("keys captures by pattern, filesystem-safely", () => {
    expect(routeSlug("/")).toBe("home");
    expect(routeSlug("/medications/[id]")).toBe("medications-id");
    expect(routeSlug("/trends/metric/[kind]")).toBe("trends-metric-kind");
    const slugs = allRoutes.map(routeSlug);
    expect(new Set(slugs).size, "two routes share a capture slug").toBe(
      slugs.length
    );
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
});

// #2616: the disclosure-expansion registry. The route registry stays honest here;
// the manual census itself exercises the selectors against the rendered page.
describe("ux census disclosure-expansion registry", () => {
  it("registers only live static routes, once each", () => {
    const seen = new Set<string>();
    for (const e of DISCLOSURE_EXPANSIONS) {
      expect(
        staticRoutes.has(e.route),
        `${e.route} is not an app/(app) route`
      ).toBe(true);
      expect(seen.has(e.route), `duplicate entry for ${e.route}`).toBe(false);
      seen.add(e.route);
      expect(e.label, `${e.route} has no label`).toBeTruthy();
    }
  });
});

// #3489 deliverable 4: the hover-capture registry. Same job as the disclosure
// registry above — the census is a manual seeing tool that may not run for weeks,
// so a selector that stopped matching would otherwise cost a BLIND SPOT line
// nobody reads until the next run. The failure here is cheap and immediate.
//
// AND ONE MORE THING THIS PINS THAT THE DISCLOSURE GUARD DOES NOT: the markers the
// registry names must still EXIST in the tree. A hover registry is unusually
// exposed to a silent rename, because its whole subject is a state no other
// screenshot shows: if `standing-door` is renamed, every other check in this repo
// stays green, the census keeps running, and the only symptom is a shot that
// quietly stops being taken.
describe("ux census hover-capture registry", () => {
  // The marker corpus: every data-testid literal and every className token the
  // app renders. Built from source rather than from a list, so it cannot drift.
  const sourceDirs = [
    path.join(here, "..", "..", "app"),
    path.join(here, "..", "..", "components"),
  ];
  let corpus = "";
  const collect = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        collect(full);
        continue;
      }
      if (/\.(tsx|ts|css)$/.test(e.name))
        corpus += fs.readFileSync(full, "utf8");
    }
  };
  for (const d of sourceDirs) collect(d);

  /**
   * The identifying tokens a selector depends on: testid values and class names.
   * Element names, combinators and pseudo-classes are deliberately NOT checked —
   * `tbody td` renaming is not a thing, and a check that matched on them would be
   * noise. What is checked is the part somebody can rename in one commit.
   */
  const markersIn = (selector: string): string[] => [
    ...[...selector.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]),
    ...[...selector.matchAll(/(?:^|[\s,>+~])\.?[a-z]*\.([a-zA-Z][\w-]*)/g)].map(
      (m) => m[1]
    ),
  ];

  it("registers only live static routes, once each, with a ruling named", () => {
    const seen = new Set<string>();
    for (const e of HOVER_CAPTURES) {
      expect(
        staticRoutes.has(e.route),
        `${e.route} is not an app/(app) route`
      ).toBe(true);
      expect(seen.has(e.route), `duplicate entry for ${e.route}`).toBe(false);
      seen.add(e.route);
      expect(e.label, `${e.route} has no label`).toBeTruthy();
      expect(e.target, `${e.route} has no hover target`).toBeTruthy();
      // The ruling is not decoration: a hover capture only earns its place in the
      // contact sheet if a reader can see WHY this surface's information lives on
      // hover at all. #3253 decision 2 and #3375 are the two today.
      expect(
        e.ruling,
        `${e.route} does not name the ruling it captures`
      ).toMatch(/#\d+/);
    }
  });

  it("keys each hover shot to a distinct capture slug", () => {
    const slugs = HOVER_CAPTURES.map((e) => `${routeSlug(e.route)}-hover`);
    expect(new Set(slugs).size, "two hover entries share a shot filename").toBe(
      slugs.length
    );
  });

  it("names markers that still exist in the tree", () => {
    for (const e of HOVER_CAPTURES) {
      const selectors = [e.target, e.reveals, e.openFirst].filter(
        Boolean
      ) as string[];
      for (const sel of selectors) {
        const markers = markersIn(sel);
        expect(
          markers.length,
          `${e.route}: \`${sel}\` names no testid or class this guard can pin. ` +
            `A selector built only from element names cannot be checked for a ` +
            `rename, which is the failure this registry is most exposed to.`
        ).toBeGreaterThan(0);
        for (const marker of markers)
          expect(
            corpus.includes(marker),
            `${e.route}: \`${marker}\` (from \`${sel}\`) is no longer rendered ` +
              `anywhere under app/ or components/. The hover capture for ` +
              `"${e.label}" would stop being taken and only a BLIND SPOT line in a ` +
              `census run nobody has done yet would say so.`
          ).toBe(true);
      }
    }
  });
});

describe("ux census hub variants", () => {
  it("registers live hubs with unique targets and slugs", () => {
    expect(new Set(HUB_VARIANTS.map((entry) => entry.target)).size).toBe(
      HUB_VARIANTS.length
    );
    expect(new Set(HUB_VARIANTS.map((entry) => entry.slug)).size).toBe(
      HUB_VARIANTS.length
    );
    for (const entry of HUB_VARIANTS) {
      expect(staticRoutes.has(entry.route), entry.route).toBe(true);
      expect(entry.target).toMatch(
        new RegExp(`^${entry.route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?`)
      );
      expect(entry.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("covers every non-default tab on the tab-first hubs", () => {
    const values = (route: string, key: string) =>
      HUB_VARIANTS.filter((entry) => entry.route === route).map((entry) =>
        new URL(entry.target, "https://allos.test").searchParams.get(key)
      );

    expect(values("/training", "tab")).toEqual(TRAINING_TABS.slice(1));
    expect(values("/trends", "tab")).toEqual(TRENDS_TABS.slice(1));
    expect(values("/nutrition", "tab")).toEqual(NUTRITION_TABS.slice(1));
    expect(values("/data", "section")).toEqual([
      "review",
      "coverage",
      "manage",
      "trash",
    ]);
  });
});
