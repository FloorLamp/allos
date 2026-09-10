import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The tap-through guard (issue #1488), in the repo's source-scan idiom
// (`chart-scaffold-scan.test.ts`, `telegram-chokepoint.test.ts`, `e2e-hygiene.test.ts`):
// read the app's own TSX as TEXT — no DB, no network, so it stays "pure" in the vitest
// sense — and fail the build when a chart ships as a dead end.
//
// WHY A SCAN AND NOT JUST THE TYPE. `ChartCard`'s `detailHref` is REQUIRED and, since
// #5351, states its own reason for having no destination — `AppRoute | { none: string }`
// — so `tsc` stops both a card that forgets it and a dead end that never says why. What
// the compiler cannot see is the one way the rule still erodes: a new chart is
// hand-assembled as `<div className="card"><h2/>…<LineChartCard/>`, bypassing the card
// and with it the whole contract. That is exactly how every full-size Trends chart came
// to be a dead end while the Overview tiles linked out, and it is what the scan below
// fails.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const CHART_CARD = "components/ChartCard.tsx";
const METRIC_PAGE = "app/(app)/trends/metric/[kind]/page.tsx";

/**
 * Where the tap-through rule is ENFORCED. The Trends hub is the surface #1488 is
 * about; `components/TrendMetricCharts.tsx` is in because it is the body census chart
 * grid living under components/.
 *
 * Deliberately NOT the whole app: a chart on /sleep, /training or /medical is a
 * different surface with its own navigation story, and sweeping them in would turn
 * this guard into a mass-migration blocker rather than a rule the next Trends chart
 * has to satisfy. Those surfaces converge as they're touched (the ProfileScope /
 * ResponsiveTable adoption posture).
 */
const SCAN_ROOTS = ["app/(app)/trends", "components/TrendMetricCharts.tsx"];

/** JSX elements that ARE a chart plot — the blessed cards from the #1445 scaffold. */
const CHART_ELEMENTS = [
  "LineChartCard",
  "StackedBarCard",
  "ZoneMinutesCard",
  "ScatterChartCard",
  "CompareChart",
  "SourceCompareChart",
  "BiomarkerChart",
  "BiomarkerTrendChart",
];

/**
 * Files inside the scan roots that render a chart WITHOUT `ChartCard`, each with the
 * reason it is not a tap-through card. Every entry is a chart that is already inside
 * something navigable, or is not a "card with a header" at all — never "I didn't get
 * to it".
 */
const NOT_A_CARD = new Map<string, string>([
  [
    "app/(app)/trends/CompareSection.tsx",
    "the compare overlay's own plot — the section IS the detail view, driven by its own two-series picker",
  ],
  [
    "app/(app)/trends/SourceComparison.tsx",
    "a per-source diagnostic inside the source-picker card; its 'detail' is the source picker it sits in",
  ],
  [
    "app/(app)/trends/metric/[kind]/page.tsx",
    "the detail page itself — its chart is rendered through TrendMetricCharts with an explicit detail-none",
  ],
]);

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

function rel(abs: string): string {
  return path.relative(REPO, abs).split(path.sep).join("/");
}

function scanFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root);
    if (!fs.existsSync(abs)) continue;
    const list = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const full of list)
      files.push({ rel: rel(full), text: fs.readFileSync(full, "utf8") });
  }
  return files;
}

describe("chart tap-through guard (issue #1488)", () => {
  it("ChartCard keeps the plot outside its header link", () => {
    const src = fs.readFileSync(path.join(REPO, CHART_CARD), "utf8");
    // The plot must not be inside the header link: tapping the plot is tooltip
    // inspection on touch, and must never navigate.
    const plotIdx = src.indexOf('data-testid="chart-card-plot"');
    const headerLinkIdx = src.indexOf('data-testid="chart-card-header-link"');
    expect(plotIdx, "ChartCard lost its plot slot").toBeGreaterThan(0);
    expect(
      headerLinkIdx,
      "ChartCard lost its header link — the header row IS the tap target"
    ).toBeGreaterThan(0);
    expect(
      /<Link[^>]*data-testid="chart-card-expand"/.test(src) &&
        /aria-label=\{`Open /.test(src) &&
        /data-testid="chart-card-expand"[\s\S]*?sm:hidden/.test(src),
      "ChartCard's phone-only expand icon must stay a link WITH an accessible name (#794 7a)"
    ).toBe(true);
  });

  it("every Trends chart renders through ChartCard", () => {
    const offenders: string[] = [];
    for (const { rel: r, text } of scanFiles()) {
      const draws = CHART_ELEMENTS.some((el) =>
        new RegExp(`<${el}[\\s/>]`).test(text)
      );
      if (!draws) continue;
      if (text.includes('from "@/components/ChartCard"')) continue;
      if (text.includes('from "./ChartCard"')) continue;
      if (NOT_A_CARD.has(r)) continue;
      offenders.push(r);
    }
    expect(
      offenders,
      `These Trends surfaces draw a chart without components/ChartCard, so the ` +
        `chart has no tap-through to its full-depth view (issue #1488). Wrap the plot ` +
        `in <ChartCard title=… detailHref=…>, or — if it genuinely isn't a tappable ` +
        `card — add it to NOT_A_CARD here with the reason:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every stale NOT_A_CARD exemption is removed", () => {
    const live = new Set(scanFiles().map((f) => f.rel));
    const stale = [...NOT_A_CARD.keys()].filter((r) => !live.has(r));
    expect(
      stale,
      `These NOT_A_CARD exemptions no longer exist in the scan roots and should be ` +
        `deleted:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("the metric detail page reads the shared series fold", () => {
    const pageSrc = fs.readFileSync(path.join(REPO, METRIC_PAGE), "utf8");
    expect(
      pageSrc.includes("trendMetricSeriesFold("),
      `${METRIC_PAGE} must read through lib/trend-metric-series.ts, so Overview and ` +
        `metric details cannot drift into two implementations of the same series — ` +
        `and it must take the FOLD, whose second half is the observation set its ` +
        `readings table lists, so chart and table cannot disagree about a day ` +
        `(#2029). WHICH slugs resolve to a series is no longer asked here: ` +
        `STREAM_SERIES is a Record<TrendMetricSlug, StreamRead>, so a registered ` +
        `metric with no series read fails tsc (#5351).`
    ).toBe(true);
  });
});
