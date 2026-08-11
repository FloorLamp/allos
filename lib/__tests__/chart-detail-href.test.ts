import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TREND_METRIC_SLUGS } from "@/lib/trend-metrics";

// The tap-through guard (issue #1488), in the repo's source-scan idiom
// (`chart-scaffold-scan.test.ts`, `telegram-chokepoint.test.ts`, `e2e-hygiene.test.ts`):
// read the app's own TSX as TEXT — no DB, no network, so it stays "pure" in the vitest
// sense — and fail the build when a chart ships as a dead end.
//
// WHY A SCAN AND NOT JUST THE TYPE. `ChartCard`'s `detailHref` is a REQUIRED prop, so
// `tsc` already stops a card that forgets it. What the compiler cannot see is the two
// ways the rule actually erodes:
//
//   1. A new chart is hand-assembled as `<div className="card"><h2/>…<LineChartCard/>`
//      — bypassing the card, and with it the whole contract. That is exactly how every
//      full-size Trends chart came to be a dead end while the Overview tiles linked
//      out. Rule 1 below fails a Trends chart rendered outside `ChartCard`.
//   2. `detailHref={null}` is written to make the type error go away. Null is legal —
//      some charts genuinely have no destination — but only as a DECLARED decision, so
//      rule 2 requires a same-line `detail-none: <why>` comment (the `first-ok`
//      pattern from the e2e hygiene guard).
//
// Rule 3 pins the registry side of the promise: `/trends/metric/[kind]` is the
// destination every registered metric taps through to, so every declared slug must
// actually resolve to a series there — a slug added to the registry without a case in
// the shared `fullTrendMetricSeries` reader would render a detail page that silently
// charts nothing.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const CHART_CARD = "components/ChartCard.tsx";
const METRIC_PAGE = "app/(app)/trends/metric/[kind]/page.tsx";
const METRIC_SERIES = "lib/trend-metric-series.ts";

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

const RE_DETAIL_NULL = /detailHref=\{null\}/;
const RE_DETAIL_JUSTIFIED = /detailHref=\{null\}.*(?:\/\/|\/\*)\s*detail-none:/;

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

/** Every file in the repo that mentions ChartCard's null escape hatch. */
function nullSites(): { rel: string; line: number; text: string }[] {
  const out: { rel: string; line: number; text: string }[] = [];
  for (const dir of ["app", "components", "lib"]) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const r = rel(full);
      if (r.includes("__tests__")) continue;
      fs.readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (RE_DETAIL_NULL.test(line))
            out.push({ rel: r, line: i + 1, text: line });
        });
    }
  }
  return out;
}

describe("chart tap-through guard (issue #1488)", () => {
  it("ChartCard exists and takes detailHref as a REQUIRED prop", () => {
    const src = fs.readFileSync(path.join(REPO, CHART_CARD), "utf8");
    // `detailHref: AppRoute | null;` — required (no `?`), and nullable only through
    // the declared escape hatch below.
    expect(
      /\n\s*detailHref: AppRoute \| null;/.test(src),
      `${CHART_CARD} must declare \`detailHref: AppRoute | null\` as a REQUIRED prop — ` +
        `making it optional would let a new chart ship as a dead end without so much ` +
        `as a type error.`
    ).toBe(true);
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

  it("every detailHref={null} carries a same-line detail-none justification", () => {
    const offenders = nullSites()
      .filter((s) => !RE_DETAIL_JUSTIFIED.test(s.text))
      .map((s) => `${s.rel}:${s.line}`);
    expect(
      offenders,
      `A chart with no destination is a DECISION, not a default. Keep the null and ` +
        `add a same-line justification comment — ` +
        `\`detailHref={null} // detail-none: <why>\` — so the next reader can tell a ` +
        `considered dead end from an unfinished one:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the metric detail page resolves every kind the registry declares", () => {
    const pageSrc = fs.readFileSync(path.join(REPO, METRIC_PAGE), "utf8");
    const seriesSrc = fs.readFileSync(path.join(REPO, METRIC_SERIES), "utf8");
    expect(
      pageSrc.includes("trendMetricSeriesFold("),
      `${METRIC_PAGE} must read through ${METRIC_SERIES}, so Overview and metric ` +
        `details cannot drift into two implementations of the same series — and it ` +
        `must take the FOLD, whose second half is the observation set its readings ` +
        `table lists, so chart and table cannot disagree about a day (#2029).`
    ).toBe(true);
    const missing = TREND_METRIC_SLUGS.filter(
      (slug) => !seriesSrc.includes(`case "${slug}":`)
    );
    expect(
      missing,
      `/trends/metric/[kind] is the tap-through destination for every registered ` +
        `metric, so a slug in TREND_METRIC_SLUGS with no case in the page's ` +
        `shared streamMetricSeries() renders a detail page that charts nothing. ` +
        `Add the series read for:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("the metric detail page renders the readings table under its chart (#1397)", () => {
    const src = fs.readFileSync(path.join(REPO, METRIC_PAGE), "utf8");
    expect(
      src.includes("MetricReadingsTable"),
      `#1488 absorbed #1397: the detail page's readings table — with its per-row ⋯ ` +
        `Edit/Delete — is where a mis-typed manual reading gets fixed. Without it the ` +
        `upsert-only dead end is back.`
    ).toBe(true);
  });
});
