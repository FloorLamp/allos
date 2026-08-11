import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DYNAMIC_ROUTES, routeSlug } from "../../scripts/ux-census-routes.mjs";
import { TREND_METRIC_SLUGS } from "../trend-metrics";
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
