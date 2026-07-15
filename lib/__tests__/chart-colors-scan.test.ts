import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static palette guard for chart series colors (issue #794, cluster 3). Chart
// marks (recharts strokes/fills, SVG, canvas) take literal color strings, so
// every chart used to hand-pick its own hex — ~40 raw literals across the TSX,
// leaking off-palette hue families (sky/indigo/teal/cyan) that clashed with the
// brand (the #780 sky-vs-brand chip clash). The fix routes every chart series /
// band color through the ONE shared module `lib/chart-colors.ts`, the single
// place a series hex is allowed to live. This test reads the app's own TSX as
// TEXT (no DB, no network, so it stays "pure" in the vitest sense) and fails the
// build if any component/page TSX reintroduces a raw hex literal outside the
// small allowlist of genuinely non-chart one-offs below.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Only the rendered app surface is scanned — chart series colors live here.
// `lib/` is intentionally NOT scanned: the shared palette module keeps its hex
// there, alongside a few deliberately-designed lib palettes (CVD-validated
// source colors, the semantic HR-zone cold→hot ramp, the theme-scaffolding
// light/dark pairs) that are out of this cluster's scope.
const SCAN_DIRS = ["app", "components"];

// Files permitted to carry a raw hex literal because it is NOT a chart series
// color, with the justification for each. These are structural/semantic one-offs
// that can't reach for a Tailwind class or the palette module.
const ALLOWLIST = new Map<string, string>([
  // Browser-tab theme-color <meta> values — must mirror the CSS page
  // backgrounds exactly (globals.css), and metadata takes literal colors.
  [
    "app/layout.tsx",
    "theme-color <meta> tags (mirror globals.css backgrounds)",
  ],
  // The root error boundary replaces <html>, so Tailwind isn't available; it
  // styles itself with inline literal colors.
  ["app/global-error.tsx", "pre-Tailwind root error page, inline styles only"],
  // next/og icon generation background — image metadata, literal color.
  ["app/apple-icon.tsx", "generated app icon background"],
  // Real-world IPF/Olympic barbell plate color code (red/blue/yellow/green/…)
  // plus metallic 3D-shading gradient stops — physical object colors, not a
  // data series.
  [
    "components/PlateBuilderModal.tsx",
    "IPF/Olympic plate color code + metallic gradient stops",
  ],
  // Semantic anatomy heat-ramp tint for the muscle figure (a single intensity
  // color scaled by fill opacity), not a categorical chart series.
  ["components/MuscleAnatomy.tsx", "semantic muscle heat-ramp tint"],
]);

// A hex COLOR literal: '#' + exactly 6 or 8 hex digits. (3-digit shorthands and
// issue references like `#794` are intentionally not matched — the codebase uses
// full 6-digit hex for colors, and shorthands would collide with issue refs.)
const HEX_COLOR = /#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function tsxFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.endsWith(".test.tsx")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("chart color palette boundary (issue #794)", () => {
  it("no component/page TSX carries a raw hex color — chart series use @/lib/chart-colors", () => {
    const offenders: string[] = [];
    for (const { rel, text } of tsxFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      if (HEX_COLOR.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `These TSX files carry a raw hex color literal. A chart series/band color ` +
        `must come from the shared palette in @/lib/chart-colors (chartSeries / ` +
        `chartBand); a genuinely non-chart one-off gets an entry (with ` +
        `justification) in this test's ALLOWLIST:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlisted file still exists and still contains a hex literal (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST.keys()) {
      const abs = path.join(REPO, rel);
      if (
        !fs.existsSync(abs) ||
        !HEX_COLOR.test(fs.readFileSync(abs, "utf8"))
      ) {
        stale.push(rel);
      }
    }
    expect(
      stale,
      `These ALLOWLIST entries no longer carry a hex literal (or were removed) ` +
        `and should be deleted from the allowlist:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("the shared palette module exports chartSeries and chartBand", () => {
    const src = fs.readFileSync(path.join(REPO, "lib/chart-colors.ts"), "utf8");
    expect(/export const chartSeries\b/.test(src)).toBe(true);
    expect(/export const chartBand\b/.test(src)).toBe(true);
  });
});
