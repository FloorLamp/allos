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
import type { ChartXAxis } from "@/components/chart-spec";

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

interface SourceFile {
  rel: string;
  text: string;
  sites?: ReturnType<typeof cardCallSites>;
}

let sourceFilesCache: SourceFile[] | undefined;
function sourceFiles(): SourceFile[] {
  if (sourceFilesCache) return sourceFilesCache;
  const files: SourceFile[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (CARD_WRAPPERS.has(rel)) continue;
      // A TEST FIXTURE IS NOT A SURFACE. This scan's subject is a call site a
      // reader ends up looking at: "four missed nights render identically to
      // four consecutive ones" is a sentence about a page. A fixture mounting a
      // card to assert what it draws is neither, and asking it to declare a gap
      // policy would put a false `gap-exempt:` reason in the tree — the exact
      // shape of decay #3260 records, where an opt-out outlived its stated why.
      //
      // Safe in the direction that matters: a test file can only ever ADD sites
      // to this sweep, never satisfy one, so skipping them cannot hide an app
      // call site. The sweep's own floor below is what proves it still reaches
      // the ones it is for.
      if (rel.includes("/__tests__/")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  sourceFilesCache = files;
  return sourceFilesCache;
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

function sitesFor(file: SourceFile): ReturnType<typeof cardCallSites> {
  return (file.sites ??= cardCallSites(file.text));
}

describe("day-grain gap chokepoint (issue #2258)", () => {
  it("every day-grain chart card declares its gap policy or its exemption", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const site of sitesFor(file)) {
        if (/\bgapFill\b/.test(site.body)) continue;
        if (/gap-exempt:/.test(site.body)) continue;
        offenders.push(`${file.rel}:${site.line} <${site.card}>`);
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
    const found = sourceFiles().flatMap(sitesFor);
    expect(found.length).toBeGreaterThan(20);
    expect(found.some((s) => s.card === "StackedBarCard")).toBe(true);
    expect(found.some((s) => s.card === "BarSparkline")).toBe(true);
    // And that it reaches the app, not only components/ — the skip above is a
    // narrowing, so what survives it has to be asserted rather than assumed.
    expect(sourceFiles().some((f) => f.rel.startsWith("app/"))).toBe(true);
    expect(
      found.some((s) => s.card === "LineChartCard"),
      "the sweep no longer finds a single LineChartCard call site"
    ).toBe(true);
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

  it("result: series are exempt from densification, with the reason on the record", () => {
    expect(seriesGapForSeriesKey("result:ApoB")).toBe("exempt");
    expect(seriesGapForSeriesKey("result:LDL Cholesterol")).toBe("exempt");
    expect(gapFillValue("exempt")).toBeNull();
    const src = fs.readFileSync(
      path.join(REPO, "lib/trend-sparkline.ts"),
      "utf8"
    );
    expect(
      /sparse BY NATURE/.test(src),
      "the result: exemption must keep its stated reason in lib/trend-sparkline.ts"
    ).toBe(true);
  });

  it("an unknown namespace is exempt rather than silently densified", () => {
    expect(seriesGapForSeriesKey("cycle:length")).toBe("exempt");
    expect(seriesGapForSeriesKey("")).toBe("exempt");
  });
});

// THE OTHER HALF OF THIS CHOKEPOINT IS A TYPE (#4925).
//
// The scan above guards the CALL SITE: a page handing a card a day-grain series
// has to say what its gaps mean. It cannot guard the SPEC, and since #4925 the
// spec is where a chart's x axis declares its kind — so a day-kind axis that
// simply omitted its gap declaration would be a chart unable to say a day is
// missing, with nothing to notice.
//
// That one is a TYPE, not a second scan. `gap` is required on the day arm and
// has no default, so the wrong state cannot be written down: an author writes
// `{ none: true }` and means it, or names the runs.
//
// THIS BLOCK IS CHECKED BY `npm run typecheck`, NOT BY RUNNING IT. A
// `@ts-expect-error` that stops being an error becomes "Unused '@ts-expect-error'
// directive" and fails the typecheck — so if the union ever loosened, this file
// reds without anyone re-deriving anything. That is also why the negatives sit
// beside positives: an assertion that only ever forbids passes just as happily
// on a type nothing can satisfy.
describe("a day-kind x axis cannot be silent about its gaps (#4925)", () => {
  it("compiles only with a declaration, and this file fails typecheck if not", () => {
    // @ts-expect-error a day axis with no `gap` is the state the type forbids
    const silent: ChartXAxis = { kind: "day", dates: ["2026-01-01"] };
    // Naming the runs, and declaring there are none, are both spellable.
    const named: ChartXAxis = {
      kind: "day",
      dates: ["2026-01-01"],
      gap: { seriesKey: "metric:mood", holes: [] },
    };
    const none: ChartXAxis = {
      kind: "day",
      dates: ["2026-01-01"],
      gap: { none: true },
    };
    // The other three kinds are not day-grain and take no gap declaration —
    // proving the requirement is attached to the arm that has calendar days,
    // not to every axis.
    const instant: ChartXAxis = {
      kind: "instant",
      dates: [],
      // @ts-expect-error an instant axis has no gap declaration to make
      gap: { none: true },
    };
    expect([silent, named, none, instant]).toHaveLength(4);
  });
});
