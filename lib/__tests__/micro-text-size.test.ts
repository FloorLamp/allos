import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_LABEL_PX,
  MOBILE_CHART_CONTENT_PX,
  effectiveFontPx,
  scanScaledFontSizes,
  type ViewBoxScale,
} from "@/lib/chart-svg";
import { INTRADAY_VARIANTS } from "@/lib/intraday-layout";

// Static guard for arbitrary micro text sizes (issue #794 cluster 5). The app had
// ~23 `text-[10px]` / `text-[11px]` / `text-[0.65rem]` / `text-[0.7rem]` one-offs
// where the `text-xs` utility (or the `.section-label` primitive, which is itself
// text-xs) should serve. They were swept to text-xs / section-label. This test
// reads the repo's own TSX as TEXT (no DB, no network, so it stays "pure" in the
// vitest sense) and fails the build if a new arbitrary micro `text-[…px|rem]`
// appears — the exact drift #794 removed.
//
// A handful of genuinely intentional survivors are ALLOWLISTED by file: places
// where 10px is a deliberate density decision (chart/heatmap tick labels, a
// gauge-scale axis) or a proportional-to-container size (avatar initials). Each
// carries its justification, plus a staleness check so a stale entry fails.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Deliberate survivors — arbitrary micro sizes kept on purpose.
const ALLOWLIST = new Map<string, string>([
  [
    "components/DayHistory.tsx",
    "day-history calendar month/weekday/legend tick labels — deliberate 10px density aligned to the 3px-gap cell grid",
  ],
  [
    "components/BiomarkerScale.tsx",
    "gauge-scale numeric axis labels (low/high/band) — chart tick density",
  ],
  [
    "components/Avatar.tsx",
    "avatar initials sized proportionally to the avatar diameter (0.65rem in the 28px sm circle)",
  ],
  [
    "app/(app)/timeline/TimelineScrubber.tsx",
    "timeline jump-rail year labels (#2657 item 4) — the same tick-label density call " +
      "DayHistory makes, and here it is forced: the owner ruling of 2026-08-14 puts the " +
      "year's digits on the rail while the 44px hit area may not grow to fit them, and " +
      "four text-xs digits do not clear the dot column inside 44px",
  ],
]);

// text-[<number>px] or text-[<number>rem] — an arbitrary font SIZE (not a color,
// which would be text-[#…]/text-[rgb…]). Word-boundaried so it's a real utility.
const MICRO = /(?<![\w-])text-\[[0-9.]+(?:px|rem)\]/;

// ── the second blind spot: numeric fontSize props (issue #1445, Part 4d) ─────
//
// The Tailwind rule above never saw a chart. recharts takes its type size as a
// NUMBER — `fontSize: 9` on a ReferenceArea label, `fontSize={9}` on an SVG
// <text> — so the 9px annotation labels #1445 found sat below legibility for as
// long as the guard has existed, in the surfaces the guard most wanted to cover.
// Those literals are gone (`components/chart-scaffold.tsx` now decides chart type
// size once, at CHART_LABEL_FONT_SIZE), and this closes the door behind them.
const MIN_NUMERIC_FONT_SIZE = 10;
// `fontSize={9}` / `fontSize: 9` / `fontSize={7.5}` — captures the number.
const NUMERIC_FONT_SIZE =
  /(?<![\w-])fontSize\s*(?:=\s*\{|:)\s*([0-9]+(?:\.[0-9]+)?)/g;

// ── the third blind spot: the viewBox EXEMPTION itself (issue #1518) ────────
//
// Files whose font sizes are in viewBox USER UNITS, not CSS pixels, used to be
// exempt from the rule above OUTRIGHT. The premise was right — a `fontSize={7}` in
// a 720-unit box is not 7px — but the conclusion removed the only guard on exactly
// the charts whose type size is hardest to reason about, and the intraday panel
// shipped ~3.5px labels behind it: 720 units scaled into a 358px phone column is a
// factor of 0.497, and 7 × 0.497 = 3.5.
//
// The ratio is the whole difference, and the ratio is COMPUTABLE. So each panel
// declares its scale contract — its viewBox width and the narrowest container it
// renders into — and the floor becomes
//
//     fontSize × (minContainerPx ÷ viewBoxWidth) ≥ MIN_LABEL_PX
//
// A panel satisfies it either by raising its sizes or, better, by taking them from
// `viewBoxFontSize()` so the number in the source IS the floor (which is what
// IntradayChart, FeverChart and MuscleAnatomy now do — none of them carries a
// numeric fontSize literal any more, and this scan therefore has nothing to flag
// unless someone types one back in).
interface ViewBoxPanel extends ViewBoxScale {
  rel: string;
  why: string;
}

const VIEWBOX_PANELS: ViewBoxPanel[] = [
  {
    rel: "components/IntradayChart.tsx",
    // The WIDE variant is the worse of the two scales; the compact variant's box
    // is closer to its container. Both come from INTRADAY_VARIANTS, cross-checked
    // against this declaration below so the two cannot drift apart.
    viewBoxWidth: INTRADAY_VARIANTS.wide.viewBoxWidth,
    minContainerPx: INTRADAY_VARIANTS.wide.minContainerPx,
    why: "Timeline day chart — geometry from lib/intraday-layout.ts (#1512 F)",
  },
  {
    rel: "components/illness/FeverChart.tsx",
    viewBoxWidth: 320,
    minContainerPx: MOBILE_CHART_CONTENT_PX,
    why: "illness episode chart — fills the mobile content column",
  },
  {
    rel: "components/MuscleAnatomy.tsx",
    viewBoxWidth: 212,
    minContainerPx: 208,
    why: "anatomy figure — narrowest render is the sm:w-52 training-overview box",
  },
];

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
      files.push({
        rel: path.relative(REPO, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return files;
}

describe("micro text-size guard (issue #794 cluster 5)", () => {
  it("no component hand-rolls an arbitrary micro text-[…px|rem] size", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        if (MICRO.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Use text-xs (or the .section-label primitive) instead of an arbitrary ` +
        `micro text-[…px|rem]. A genuinely intentional survivor (chart/heatmap ` +
        `tick, proportional sizing) gets an ALLOWLIST entry with justification:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("no chart sets a sub-10 numeric fontSize — chart type size comes from the scaffold", () => {
    const registered = new Set(VIEWBOX_PANELS.map((p) => p.rel));
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (registered.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(NUMERIC_FONT_SIZE)) {
          if (Number(m[1]) < MIN_NUMERIC_FONT_SIZE) {
            offenders.push(`${rel}:${i + 1} (fontSize ${m[1]})`);
          }
        }
      });
    }
    expect(
      offenders,
      `A chart label below ${MIN_NUMERIC_FONT_SIZE}px is not readable. Chart type ` +
        `size is decided once in components/chart-scaffold.tsx — use ` +
        `CHART_LABEL_FONT_SIZE (annotations, band labels, axis titles) or ` +
        `CHART_TICK_FONT_SIZE (axis ticks), via chartAnnotationLabel() / ` +
        `chartAxisProps() / chartAxisLabelProps():\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  // The #1518 rule itself: a registered panel's font sizes are measured at its own
  // scale, not waved through.
  it("every fixed-viewBox panel's labels clear the floor at its narrowest container", () => {
    const offenders: string[] = [];
    for (const panel of VIEWBOX_PANELS) {
      const abs = path.join(REPO, panel.rel);
      if (!fs.existsSync(abs)) continue; // reported by the staleness check below
      const scan = scanScaledFontSizes(fs.readFileSync(abs, "utf8"), panel);
      for (const hit of scan) {
        offenders.push(
          `${panel.rel}:${hit.line} — fontSize ${hit.fontSize} × ` +
            `${(panel.minContainerPx / panel.viewBoxWidth).toFixed(3)} = ` +
            `${hit.effectivePx.toFixed(1)}px effective at a ` +
            `${panel.minContainerPx}px container, floor ${MIN_LABEL_PX}px`
        );
      }
    }
    expect(
      offenders,
      `A viewBox font size is NOT a px size: it paints at ` +
        `fontSize × (container ÷ viewBox). Take the size from ` +
        `viewBoxFontSize({ viewBoxWidth, minContainerPx }) in lib/chart-svg.ts ` +
        `so the source number IS the floor, or raise it past the computed ` +
        `effective size below:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the intraday declaration matches the shipped variant geometry", () => {
    // The panel's scale lives in lib/intraday-layout.ts, so the registry above
    // reads it rather than restating it — and every variant, not only the one the
    // registry measures, has to clear the floor.
    const entry = VIEWBOX_PANELS.find(
      (p) => p.rel === "components/IntradayChart.tsx"
    )!;
    expect(entry.viewBoxWidth).toBe(INTRADAY_VARIANTS.wide.viewBoxWidth);
    for (const spec of Object.values(INTRADAY_VARIANTS)) {
      expect(
        effectiveFontPx(spec.labelSize, spec),
        `${spec.variant} labels at a ${spec.minContainerPx}px container`
      ).toBeGreaterThanOrEqual(MIN_LABEL_PX);
    }
  });

  it("every fixed-viewBox panel still exists and still draws its own viewBox (no stale entries)", () => {
    const stale: string[] = [];
    for (const panel of VIEWBOX_PANELS) {
      const abs = path.join(REPO, panel.rel);
      if (!fs.existsSync(abs) || !/viewBox=/.test(fs.readFileSync(abs, "utf8")))
        stale.push(panel.rel);
    }
    expect(
      stale,
      `These VIEWBOX_PANELS entries no longer hand-draw a viewBox SVG and ` +
        `should be removed:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlisted file still exists and still carries a micro size (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST.keys()) {
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) {
        stale.push(rel);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      if (!text.split("\n").some((line) => MICRO.test(line))) stale.push(rel);
    }
    expect(
      stale,
      `These ALLOWLIST entries no longer carry a micro text size and should be ` +
        `removed from the allowlist:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});
