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

// ── the hex scan's blind spot: Tailwind-CLASS ramps (issue #1445, Part 4d) ───
//
// The scan above sees hex literals. A calendar heatmap does not use hex — its
// cells are Tailwind classes — so `WorkoutHeatmap`, `ActiveDaysStrip` and
// `AdherenceCalendar` each carried their own hand-rolled `bg-emerald-200 …
// dark:bg-emerald-900` ladder, three copies, entirely invisible to the guard
// that exists to stop exactly that. They now consume the blessed ramp exports
// (`chartActivityRamp` / `chartAdherenceState`), which ship the class ladder AND
// its hexes so the palette test can validate the thing that actually renders.
//
// The rule is deliberately narrow, because a broad "3+ bg-* classes" heuristic
// lights up ~85 files of ordinary chip/button/badge styling. What it matches is
// the RAMP SHAPE specifically: an ARRAY of bg-classes drawn from ONE hue family,
// i.e. a ladder indexed by level. Categorical status maps (keyed objects, mixed
// hues) are a different job and are not touched.

// A class string containing a `bg-<hue>-<step>` utility (a `dark:` twin counts).
const BG_CLASS = String.raw`"[^"\n]*(?<![\w-])(?:dark:)?bg-[a-z]+-\d{2,3}(?![\w-])[^"\n]*"`;
// Three or more of them in an array literal.
const CLASS_RAMP = new RegExp(
  String.raw`\[\s*(?:${BG_CLASS}\s*,\s*){2,}${BG_CLASS}\s*,?\s*\]`,
  "s"
);
const HUE = /(?<![\w-])(?:dark:)?bg-([a-z]+)-(\d{2,3})(?![\w-])/g;

// Neutral families. A cell ramp's EMPTY square is deliberately a neutral, and it
// carries a different neutral per theme (`bg-slate-100 dark:bg-ink-800`), so a
// naive "how many hue families?" count reads a perfectly ordinary one-hue ramp
// as three-hue and lets it through. Excluding neutrals is what makes the rule
// actually catch the shape it exists for.
const NEUTRAL_HUES = new Set([
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "ink",
  "white",
  "black",
]);

// A ladder needs at least this many distinct steps of its one hue; below that
// it is a pair of states, not a ramp.
const MIN_RAMP_STEPS = 3;

// Files allowed to declare a same-hue bg ladder, with the reason.
const RAMP_ALLOWLIST = new Map<string, string>([
  [
    "lib/chart-colors.ts",
    "the blessed ramp itself (chartActivityRamp) — this is where a cell ramp lives",
  ],
]);

// The ramp rule scans lib/ too: the ramp is DECLARED there (a .ts module), and a
// second one appearing beside it would evade a .tsx-only walk.
function rampScanFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [...tsxFiles()];
  for (const d of ["lib"]) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walkAll(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

function walkAll(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walkAll(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Array literals of bg-classes that read as a SEQUENTIAL RAMP: several steps of
 * ONE non-neutral hue. A categorical status array (Avatar's per-initial tints,
 * a good/warn/bad set) draws from several hues and is a different job entirely.
 */
function sameHueLadders(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(new RegExp(CLASS_RAMP.source, "gs")) ?? [];
  for (const block of matches) {
    const pairs = [...block.matchAll(HUE)];
    const hues = new Set(
      pairs.map((m) => m[1]).filter((h) => !NEUTRAL_HUES.has(h))
    );
    const steps = new Set(
      pairs.filter((m) => !NEUTRAL_HUES.has(m[1])).map((m) => m[2])
    );
    if (hues.size === 1 && steps.size >= MIN_RAMP_STEPS) {
      out.push(block.replace(/\s+/g, " ").slice(0, 120));
    }
  }
  return out;
}

describe("Tailwind-class cell ramps (issue #1445, Part 4d)", () => {
  it("no surface hand-rolls a same-hue bg ramp — consume the blessed ramp from @/lib/chart-colors", () => {
    const offenders: string[] = [];
    for (const { rel, text } of rampScanFiles()) {
      if (RAMP_ALLOWLIST.has(rel)) continue;
      for (const block of sameHueLadders(text)) {
        offenders.push(`${rel}: ${block}`);
      }
    }
    expect(
      offenders,
      `A light->dark ladder of Tailwind bg-classes is a SEQUENTIAL CELL RAMP — ` +
        `the same kind of palette decision chartSeries makes, just expressed in ` +
        `classes instead of hex, and therefore invisible to the hex scan above. ` +
        `Import chartActivityRamp (or add a new named ramp beside it, with its ` +
        `hexes, so lib/__tests__/chart-palette.test.ts can validate it):\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the palette module still ships both halves of every ramp (classes AND hexes)", () => {
    const src = fs.readFileSync(path.join(REPO, "lib/chart-colors.ts"), "utf8");
    expect(/export const chartActivityRamp\b/.test(src)).toBe(true);
    expect(/export const chartAdherenceState\b/.test(src)).toBe(true);
    // The class ladder without its hexes would leave the validator checking a
    // fiction; the hexes without the ladder would leave the DOM unvalidated.
    expect(/stepClasses:/.test(src)).toBe(true);
    expect(/light: \{ empty:/.test(src)).toBe(true);
  });

  it("every ramp-allowlist entry still declares a ladder (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of RAMP_ALLOWLIST.keys()) {
      const abs = path.join(REPO, rel);
      if (
        !fs.existsSync(abs) ||
        sameHueLadders(fs.readFileSync(abs, "utf8")).length === 0
      ) {
        stale.push(rel);
      }
    }
    expect(
      stale,
      `These RAMP_ALLOWLIST entries no longer declare a bg-class ladder:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});
