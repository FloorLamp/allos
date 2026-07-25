import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Chart chokepoint guards (issue #1445, Parts 4b + 4c), in the repo's
// established source-scan idiom (`telegram-chokepoint.test.ts`,
// `chart-colors-scan.test.ts`): read the app's own TSX as TEXT — no DB, no
// network, so it stays "pure" in the vitest sense — and fail the build when a
// chart convention is hand-rolled instead of consumed.
//
// Two drift vectors, both of which #1445 found wide open:
//
//   4b. Eight `*Inner.tsx` cards each hand-copied `<CartesianGrid
//       strokeDasharray="3 3">` and the same 8-line tooltip `contentStyle` block.
//       That is why the mark-level conventions could not be fixed once — five
//       call sites regress independently. Those decisions now live in
//       `components/chart-scaffold.tsx`; a raw dash literal or tooltip surface
//       anywhere else fails here.
//
//   4c. Nothing stopped a page importing recharts directly and hand-styling a
//       one-off chart, which would bypass the palette, the scaffold, and every
//       convention in `docs/internals/charts.md` at once. A new chart surface
//       either composes an existing card or registers below with a reason.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib"];

/** The scaffold itself — the ONE place the raw recharts styling primitives live. */
const SCAFFOLD = "components/chart-scaffold.tsx";

/**
 * The blessed recharts importers (4c). Every entry is a chart CARD: a
 * self-contained, code-split renderer for one chart form, consuming the shared
 * palette and the shared scaffold. Adding a row here is the deliberate act of
 * declaring a new chart FORM — if the answer is "a line chart, but for my page",
 * compose `LineChartCard` instead.
 */
const RECHARTS_MODULES = new Map<string, string>([
  [
    SCAFFOLD,
    "the scaffold itself — owns the shared grid/axis/tooltip/mark props",
  ],
  [
    "components/LineChartCardInner.tsx",
    "form: time series (the default chart)",
  ],
  [
    "components/CompareChartInner.tsx",
    "form: two-series overlay on one time axis",
  ],
  [
    "components/BiomarkerChartInner.tsx",
    "form: one analyte over time with reference bands",
  ],
  ["components/ScatterChartCardInner.tsx", "form: two-variable relationship"],
  [
    "components/SourceCompareChartInner.tsx",
    "form: one metric, one line per reporting source",
  ],
  [
    "components/GrowthChartInner.tsx",
    "form: pediatric percentile bands + trajectory",
  ],
  ["components/StackedBarCardInner.tsx", "form: composition over time"],
  [
    "components/ZoneMinutesCardInner.tsx",
    "form: weekly HR-zone composition + target line",
  ],
]);

/**
 * Hand-drawn SVG panels with a FIXED viewBox scaled to their container. Their
 * lengths and font sizes are in viewBox USER UNITS, not CSS pixels — a `7` in a
 * 720-unit-wide box that renders 700px wide is ~7px, and the same `7` in a
 * 320-unit box rendered at 640px is 14px. The scaffold's vocabulary is
 * px-denominated, so it genuinely does not transfer; these panels are exempt
 * from the dash and micro-size rules (they are still bound by the palette).
 */
export const VIEWBOX_SVG = new Map<string, string>([
  [
    "components/IntradayPanel.tsx",
    "fixed 720-unit viewBox scaled to container — lengths are user units, not px",
  ],
  [
    "components/illness/FeverChart.tsx",
    "fixed 320-unit viewBox scaled to container — lengths are user units, not px",
  ],
]);

// A dash pattern written as a literal, in JSX (`strokeDasharray="3 3"`) or in an
// object (`strokeDasharray: "3 3"`). Passing `chartDash.annotation` is the point
// and does not match.
const RAW_DASH = /strokeDasharray\s*(?:=\s*"|:\s*")/;

// A hand-built recharts tooltip surface.
const RAW_TOOLTIP = /contentStyle\s*=\s*\{\{/;

// An import of recharts, in any of its spellings.
const RECHARTS_IMPORT =
  /(?:^|\n)\s*import[^;]*from\s*["']recharts["']|require\(\s*["']recharts["']\s*\)|import\(\s*["']recharts["']\s*\)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      // The scan reads the app, not its own tests (which quote the patterns).
      if (rel.includes("__tests__") || rel.includes("__db_tests__")) continue;
      if (rel.includes("__action_tests__")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("chart scaffold chokepoint (issue #1445, Part 4b)", () => {
  it("the scaffold module exists and owns the shared prop bags", () => {
    const src = fs.readFileSync(path.join(REPO, SCAFFOLD), "utf8");
    for (const symbol of [
      "chartGridProps",
      "chartAxisProps",
      "chartTooltipProps",
      "chartDash",
      "chartLineDot",
      "chartActiveDot",
      "chartAnnotationLabel",
      "chartStackSegmentProps",
      "useChartMotion",
      "ChartLegend",
    ]) {
      expect(
        new RegExp(`export (?:const|function|type) ${symbol}\\b`).test(src),
        `${SCAFFOLD} no longer exports ${symbol} — the cards consume it`
      ).toBe(true);
    }
  });

  it("no chart hand-rolls a dash pattern — use chartDash from the scaffold", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === SCAFFOLD || VIEWBOX_SVG.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        if (RAW_DASH.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `A dash pattern is a piece of chart VOCABULARY (annotation / reference / ` +
        `target / now / cursor), not a per-chart styling choice. Import the ` +
        `named pattern from components/chart-scaffold.tsx (chartDash.*) instead ` +
        `of a literal:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every fixed-viewBox exemption still exists and still draws its own SVG (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of VIEWBOX_SVG.keys()) {
      const abs = path.join(REPO, rel);
      if (
        !fs.existsSync(abs) ||
        !/viewBox=/.test(fs.readFileSync(abs, "utf8"))
      ) {
        stale.push(rel);
      }
    }
    expect(
      stale,
      `These VIEWBOX_SVG exemptions no longer hand-draw a viewBox SVG and ` +
        `should be removed:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("no chart hand-builds a tooltip surface — use chartTooltipProps", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === SCAFFOLD) continue;
      text.split("\n").forEach((line, i) => {
        if (RAW_TOOLTIP.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `The tooltip surface (background, border, radius, type size, hover ` +
        `motion) is decided once in components/chart-scaffold.tsx. Spread ` +
        `{...chartTooltipProps(c, motion)} onto <Tooltip>, or ` +
        `chartTooltipSurfaceStyle(c) for a custom tooltip body:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});

describe("recharts import chokepoint (issue #1445, Part 4c)", () => {
  it("only the blessed chart-card modules import recharts", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (RECHARTS_MODULES.has(rel)) continue;
      if (RECHARTS_IMPORT.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `recharts is imported outside the blessed chart cards. A new chart ` +
        `surface COMPOSES an existing card (LineChartCard, StackedBarCard, …) — ` +
        `that is what keeps the palette, grid/axis/tooltip conventions, motion ` +
        `policy and legend rule applying to it. If it is genuinely a new chart ` +
        `FORM, add it to RECHARTS_MODULES with a one-line justification and give ` +
        `it a section in docs/internals/charts.md:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every blessed recharts module still exists and still imports recharts (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of RECHARTS_MODULES.keys()) {
      const abs = path.join(REPO, rel);
      if (
        !fs.existsSync(abs) ||
        !RECHARTS_IMPORT.test(fs.readFileSync(abs, "utf8"))
      ) {
        stale.push(rel);
      }
    }
    expect(
      stale,
      `These RECHARTS_MODULES entries no longer import recharts (or were ` +
        `removed) and should be deleted from the list:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("every blessed chart card consumes the scaffold rather than restyling recharts", () => {
    const offenders: string[] = [];
    for (const [rel] of RECHARTS_MODULES) {
      if (rel === SCAFFOLD) continue;
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      if (!/from "\.\/chart-scaffold"/.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      `These chart cards import recharts but not the scaffold, so they are ` +
        `styling recharts by hand again:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
