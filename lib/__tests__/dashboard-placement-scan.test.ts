import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_WIDGETS } from "../dashboard-widgets";
import {
  DASHBOARD_COMPOSITE_ADAPTER_IDS,
  DASHBOARD_STATIC_SURFACE_IDS,
} from "../dashboard-relevance";

// Structural guard for the phase-1 placement seam (#3080). This deliberately
// reads source text: rendering the dashboard would pull in Next and the database,
// while these ownership rules should stay enforceable in the pure test tier.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const page = fs.readFileSync(
  path.join(root, "app", "(app)", "page.tsx"),
  "utf8"
);
const ranker = fs.readFileSync(
  path.join(root, "lib", "dashboard-relevance.ts"),
  "utf8"
);
const canvas = fs.readFileSync(
  path.join(root, "components", "dashboard", "DashboardPlacementCanvas.tsx"),
  "utf8"
);
const returnBody = page.slice(page.lastIndexOf("  return ("));
const canvasReturnBody = canvas.slice(canvas.lastIndexOf("  return ("));
const staticStart = page.indexOf(
  "const staticSurfaces: RankableDashboardSurface[]"
);
const staticEnd = page.indexOf(
  "const widgetSurfaces: RankableDashboardSurface[]"
);
const staticSurfaceBlock = page.slice(staticStart, staticEnd);

describe("dashboard placement ownership (#3080)", () => {
  it("has a unique census entry for every phase-1 render surface", () => {
    const widgetIds = DASHBOARD_WIDGETS.filter((widget) => !widget.pinned).map(
      (widget) => widget.id
    );
    const ids = [...DASHBOARD_STATIC_SURFACE_IDS, ...widgetIds];

    expect(new Set(ids).size).toBe(ids.length);
    expect(staticStart).toBeGreaterThan(-1);
    expect(staticEnd).toBeGreaterThan(staticStart);
    const declaredStaticIds = [
      ...staticSurfaceBlock.matchAll(/\bplacementId: "([^"]+)"/g),
    ].map((match) => match[1]);
    expect(declaredStaticIds).toEqual([...DASHBOARD_STATIC_SURFACE_IDS]);
    expect(page).toContain("const widgetSurfaces: RankableDashboardSurface[]");
    expect(page).toContain("placementId: widget.id");
  });

  it("labels composite phase-1 adapters without inventing atom identities", () => {
    const knownIds = new Set([
      ...DASHBOARD_STATIC_SURFACE_IDS,
      ...DASHBOARD_WIDGETS.map((widget) => widget.id),
    ]);
    for (const id of DASHBOARD_COMPOSITE_ADAPTER_IDS) {
      expect(knownIds.has(id), `unknown composite adapter ${id}`).toBe(true);
    }
    expect(ranker).not.toContain("legacy" + "WidgetId");
    expect(page).not.toContain("legacy" + "WidgetId");
    expect(ranker).not.toContain("now" + "CardId");
    expect(page).not.toContain("now" + "CardId");
  });

  it("keeps ranking pure and independent from dashboard gathering", () => {
    expect(ranker).not.toMatch(/from ["']\.\/db["']/);
    expect(ranker).not.toMatch(/from ["']\.\/queries(?:\/|["'])/);
    expect(ranker).not.toMatch(/from ["']\.\/auth(?:\/|["'])/);
    expect(ranker).not.toContain("new Date(");
    expect(ranker).not.toContain("ReactNode");
  });

  it("routes page surfaces through one manifest", () => {
    expect(page.lastIndexOf("  return (")).toBeGreaterThan(-1);
    expect(page.match(/\brankDashboard\(/g)).toHaveLength(1);
    expect(page).not.toMatch(/\brankNowCards\(/);
    expect(page).not.toMatch(/from ["']@\/lib\/now-strip["']/);
    const directComponents = [
      ...returnBody.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g),
    ].map((match) => match[1]);
    expect([...new Set(directComponents)]).toEqual([
      "DashboardPlacementCanvas",
    ]);
    expect(canvas).toContain("placementNodes.get(placement.nodeKey)");
    expect(canvas).toContain("preGridPlacements.map((placement)");
    expect(canvas).toContain("widgets={rankedGridWidgets}");
    expect(canvas).toContain("promoted={nowPlacementIds}");
    expect(canvas).not.toMatch(/\bchildren\??:/);
    // A page-level node has no prop through which it can reach the canvas, and a
    // direct JSX child such as `{rogueNode}` fails here rather than hiding behind
    // the old capitalized-component-only scan.
    expect(canvasReturnBody).not.toMatch(/>\s*\{\s*[A-Za-z_$][\w$]*\s*\}\s*</);

    const canvasComponents = [
      ...canvasReturnBody.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g),
    ].map((match) => match[1]);
    expect([...new Set(canvasComponents)].sort()).toEqual([
      "DashboardGrid",
      "Fragment",
      "NowStrip",
      "PageHeader",
    ]);
  });
});
