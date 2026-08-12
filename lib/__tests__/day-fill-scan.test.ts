import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  METRIC_GAP,
  gapFillValue,
  seriesGapForSeriesKey,
  MACROS_SERIES_KEY,
  OURA_SCORE_SERIES_KEY,
  SLEEP_DURATION_SERIES_KEY,
  SLEEP_REGULARITY_SERIES_KEY,
  SLEEP_STAGES_SERIES_KEY,
} from "../trend-sparkline";
import {
  TREND_METRIC_SLUGS,
  savedMetricIdForTrendSlug,
} from "../trend-metrics";
import { metricSeriesKey } from "../saved-items";

// The DAY-GRAIN GAP chokepoint (issue #2258), in the repo's source-scan idiom
// (`chart-scaffold-scan.test.ts`, `chart-colors-scan.test.ts`): read the app's own
// TSX as TEXT — no DB, no network, so it stays "pure" in the vitest sense — and
// fail the build when a day-precision series reaches a chart card without saying
// what its gaps mean.
//
// The scaffold scan cannot see this. It guards the recharts IMPORT boundary and the
// styling primitives; the fill is a pure lib decision applied INSIDE the card, so a
// new call site can compose a perfectly blessed `<LineChartCard>` and still hand it
// a sparse series that compresses a four-day outage into four adjacent points. The
// only durable guard is at the call site: every chart card either declares
// `gapFill` (and the per-series registry answers the rest) or says, on the spot,
// why its x is not a calendar day.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// The day-grain chart cards. A `<Card` opening tag in app/ or components/ must
// carry `gapFill=` or a `gap-exempt:` justification on the spot.
const DAY_GRAIN_CARDS = ["LineChartCard", "StackedBarCard", "BarSparkline"];

// The code-split wrappers themselves: they forward `{...props}` and only MENTION
// their card's name in prose, so they have no call site to judge.
const CARD_WRAPPERS = new Set([
  "components/LineChartCard.tsx",
  "components/StackedBarCard.tsx",
  "components/BarSparkline.tsx",
]);

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

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (CARD_WRAPPERS.has(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Each `<Card` opening tag with the text of its props, up to the tag's own close.
// A crude but sufficient scan: the props of a JSX element run from the tag name to
// the first `>` that is not inside braces, and every call site in this repo is
// Prettier-formatted, one prop per line.
function cardCallSites(
  text: string
): { card: string; line: number; body: string }[] {
  const out: { card: string; line: number; body: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(
      new RegExp(`^\\s*<(${DAY_GRAIN_CARDS.join("|")})(\\s|/|>|$)`)
    );
    if (!opening) continue;
    const body: string[] = [];
    let depth = 0;
    for (let j = i; j < lines.length && j < i + 120; j++) {
      body.push(lines[j]);
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0 && /(\/>|^\s*>)\s*$/.test(lines[j]) && j > i) break;
      if (depth <= 0 && /^\s*<\w+\s*\/>\s*$/.test(lines[j])) break;
    }
    out.push({ card: opening[1], line: i + 1, body: body.join("\n") });
  }
  return out;
}

describe("day-grain gap chokepoint (issue #2258)", () => {
  it("every day-grain chart card declares its gap policy or its exemption", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      for (const site of cardCallSites(text)) {
        if (/\bgapFill\b/.test(site.body)) continue;
        if (/gap-exempt:/.test(site.body)) continue;
        offenders.push(`${rel}:${site.line} <${site.card}>`);
      }
    }
    expect(
      offenders,
      `A day-precision series on a recharts CATEGORY axis positions x by array ` +
        `INDEX, so a missing day is not on the axis at all and a multi-day outage ` +
        `COMPRESSES AWAY — four missed nights render identically to four ` +
        `consecutive ones (#2258). Pass \`gapFill={{ seriesKey, from, to }}\` so ` +
        `the card densifies to the calendar under the series' own declared policy ` +
        `(lib/trend-sparkline.ts), or, if this chart's x is genuinely not a ` +
        `calendar day (a per-event progression, an intraday clock axis, a ` +
        `week-grain bar already filled by lib/weekly-fill.ts), write a ` +
        `\`// gap-exempt: <reason>\` comment inside the tag:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the scan actually finds the call sites it is meant to guard", () => {
    // A guard on the guard: a regex that silently stops matching would turn this
    // whole file into a no-op that passes forever.
    const found = sourceFiles().flatMap(({ text }) => cardCallSites(text));
    expect(found.length).toBeGreaterThan(20);
    expect(found.some((s) => s.card === "StackedBarCard")).toBe(true);
    expect(found.some((s) => s.card === "BarSparkline")).toBe(true);
  });
});

describe("gap registry completeness (issue #2258)", () => {
  it("every registered trend metric carries a declared gap", () => {
    const missing = TREND_METRIC_SLUGS.filter(
      (slug) => METRIC_GAP[savedMetricIdForTrendSlug(slug)] == null
    );
    expect(
      missing,
      `These trend metrics reach a chart with no declared gap policy. Add them to ` +
        `METRIC_GAP in lib/trend-sparkline.ts with their reason — is a missing ` +
        `day an unsampled LEVEL, an absent READING, or a total that is a real ` +
        `zero?:\n${missing.join(", ")}`
    ).toEqual([]);
  });

  it("training volume and every render-only series are declared", () => {
    for (const key of [
      metricSeriesKey("volume"),
      SLEEP_DURATION_SERIES_KEY,
      SLEEP_STAGES_SERIES_KEY,
      SLEEP_REGULARITY_SERIES_KEY,
      OURA_SCORE_SERIES_KEY,
      MACROS_SERIES_KEY,
    ]) {
      expect(seriesGapForSeriesKey(key), `${key} is undeclared`).not.toBe(
        "exempt"
      );
    }
  });

  it("every declared id is still a real series (no stale entries)", () => {
    const live = new Set<string>([
      ...TREND_METRIC_SLUGS.map(savedMetricIdForTrendSlug),
      "volume",
      SLEEP_DURATION_SERIES_KEY.slice("metric:".length),
      SLEEP_STAGES_SERIES_KEY.slice("metric:".length),
      SLEEP_REGULARITY_SERIES_KEY.slice("metric:".length),
      OURA_SCORE_SERIES_KEY.slice("metric:".length),
      MACROS_SERIES_KEY.slice("metric:".length),
    ]);
    const stale = Object.keys(METRIC_GAP).filter((id) => !live.has(id));
    expect(
      stale,
      `These METRIC_GAP entries name no live series and should be removed:\n${stale.join(", ")}`
    ).toEqual([]);
  });

  it("bio: series are exempt from densification, with the reason on the record", () => {
    expect(seriesGapForSeriesKey("bio:ApoB")).toBe("exempt");
    expect(seriesGapForSeriesKey("bio:LDL Cholesterol")).toBe("exempt");
    expect(gapFillValue("exempt")).toBeNull();
    const src = fs.readFileSync(
      path.join(REPO, "lib/trend-sparkline.ts"),
      "utf8"
    );
    expect(
      /sparse BY NATURE/.test(src),
      "the bio: exemption must keep its stated reason in lib/trend-sparkline.ts"
    ).toBe(true);
  });

  it("an unknown namespace is exempt rather than silently densified", () => {
    expect(seriesGapForSeriesKey("cycle:length")).toBe("exempt");
    expect(seriesGapForSeriesKey("")).toBe("exempt");
  });
});
