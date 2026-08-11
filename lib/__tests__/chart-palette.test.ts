import { describe, expect, it } from "vitest";
import {
  chartActivityRamp,
  chartAdherenceState,
  chartBand,
  chartNeutral,
  chartObservationRamp,
  chartSeries,
} from "@/lib/chart-colors";
import {
  CHART_SURFACE,
  CHROMA_FLOOR,
  CONTRAST_MIN,
  CVD_FLOOR,
  CVD_TARGET,
  NORMAL_FLOOR,
  contrastRatio,
  deltaE,
  formatReport,
  oklch,
  validateCategoricalPalette,
  validateCellRamp,
  type ChartTheme,
} from "@/lib/chart-palette-validate";

// Palette validity is COMPUTED, not pinned (issue #1445, Part 4a). The sibling
// `chart-colors-scan.test.ts` guards WHERE a chart color may live; this file
// judges whether the palette is any good, by running the real checks over the
// real exports against both real chart surfaces.
//
// It exists because the #794 palette passed every guard the repo had and was
// still broken: `brand #16a34a` and `emerald #10b981` sat at OKLab ΔE 8.1 — the
// two most-used series colors in the app, below the 15 floor where readers with
// FULL color vision separate a pair — and the warm 500-steps were at 2.5:1 and
// 2.2:1 on white. Nothing could have caught that except arithmetic. So: edit the
// palette back into two near-identical greens and this test fails, naming the
// pair and its ΔE.

const THEMES: ChartTheme[] = ["light", "dark"];

// The categorical set, in its fixed slot order. Adjacent-pair checks assume this
// order, so it is spelled out rather than derived from Object.values() — a
// reordering is a deliberate change that should re-run the checks.
const SERIES_ORDER = [
  chartSeries.brand,
  chartSeries.sky,
  chartSeries.amber,
  chartSeries.rose,
  chartSeries.violet,
];

describe("chart series palette (issue #1445)", () => {
  it("has exactly the five blessed slots, in fixed order", () => {
    expect(Object.keys(chartSeries)).toEqual([
      "brand",
      "sky",
      "amber",
      "rose",
      "violet",
    ]);
    expect(Object.values(chartSeries)).toEqual(SERIES_ORDER);
  });

  for (const theme of THEMES) {
    it(`clears every categorical check on the ${theme} chart surface`, () => {
      const report = validateCategoricalPalette(SERIES_ORDER, { theme });
      expect(
        report.failures.map((f) => f.name),
        formatReport(
          `chartSeries FAILED palette validation on the ${theme} surface ` +
            `(${CHART_SURFACE[theme]}). Re-step the offending slot(s) against ` +
            `lib/chart-palette-validate.ts before editing lib/chart-colors.ts:`,
          report
        )
      ).toEqual([]);
      expect(report.ok).toBe(true);
    });
  }

  // ALL pairs — not just adjacent slots — under normal vision. Adjacent-pair
  // checking is the right gate for lines/bars/stacks (the app's forms), but a
  // reader comparing slot 1 against slot 4 across two cards deserves the same
  // separation, and it costs nothing here.
  //
  // Deliberately NOT asserted all-pairs: CVD separation. `brand` (green) against
  // `rose` (red) is ΔE 2.7 under deuteranopia and no re-stepping fixes that — it
  // is red-vs-green, the pair dichromats cannot see, and both slots are load-
  // bearing (the brand's own hue; the "out of range / missed" hue). The palette
  // earns those two slots the way the standard permits: mandatory secondary
  // encoding. Every >= 2-series chart carries a legend (Part 2, enforced by the
  // scaffold + e2e), status is never color-alone (#1220), and the adherence grid
  // ships per-cell titles, `data-state`, and a counted text legend.
  it("keeps ALL pairs — not just adjacent slots — above the normal-vision floor", () => {
    for (const theme of THEMES) {
      const report = validateCategoricalPalette(SERIES_ORDER, {
        theme,
        pairs: "all",
      });
      const normal = report.checks.find(
        (c) => c.name === "Normal-vision floor"
      );
      expect(
        normal?.state,
        formatReport(`chartSeries all-pairs FAILED on ${theme}:`, report)
      ).toBe("pass");
    }
  });

  // The specific regression #1445 fixed, pinned as its own assertion so the
  // failure message says "two greens" rather than "a check failed".
  it("keeps no two series colors within the normal-vision floor of each other", () => {
    const worst = { d: Infinity, a: "", b: "" };
    for (let i = 0; i < SERIES_ORDER.length; i++) {
      for (let j = i + 1; j < SERIES_ORDER.length; j++) {
        const d = deltaE(SERIES_ORDER[i], SERIES_ORDER[j]);
        if (d < worst.d)
          Object.assign(worst, { d, a: SERIES_ORDER[i], b: SERIES_ORDER[j] });
      }
    }
    expect(
      worst.d,
      `${worst.a} and ${worst.b} are ΔE ${worst.d.toFixed(1)} apart under normal ` +
        `vision — below the ${NORMAL_FLOOR} floor. This is the #794 defect ` +
        `(brand vs emerald, ΔE 8.1): two slots that look like one series.`
    ).toBeGreaterThanOrEqual(NORMAL_FLOOR);
  });

  it("keeps every adjacent pair separable under simulated protanopia/deuteranopia", () => {
    for (let i = 0; i < SERIES_ORDER.length - 1; i++) {
      for (const kind of ["protan", "deutan"] as const) {
        const d = deltaE(SERIES_ORDER[i], SERIES_ORDER[i + 1], kind);
        expect(
          d,
          `${SERIES_ORDER[i]} vs ${SERIES_ORDER[i + 1]} is ΔE ${d.toFixed(1)} ` +
            `under ${kind} — below the ${CVD_TARGET} target.`
        ).toBeGreaterThanOrEqual(CVD_TARGET);
      }
    }
  });

  it("keeps every series color above the chroma floor (a gray series reads as chrome)", () => {
    for (const hex of SERIES_ORDER) {
      expect(oklch(hex).c, `${hex} chroma`).toBeGreaterThanOrEqual(
        CHROMA_FLOOR
      );
    }
  });

  it("keeps every series color at 3:1 or better on both chart surfaces", () => {
    for (const theme of THEMES) {
      for (const hex of SERIES_ORDER) {
        const r = contrastRatio(hex, CHART_SURFACE[theme]);
        expect(
          r,
          `${hex} is ${r.toFixed(2)}:1 on the ${theme} surface ${CHART_SURFACE[theme]}`
        ).toBeGreaterThanOrEqual(CONTRAST_MIN);
      }
    }
  });
});

describe("chart neutral + bands (issue #1445)", () => {
  it("keeps the neutral OUT of the categorical set — it is below the chroma floor", () => {
    expect(Object.values(chartSeries)).not.toContain(chartNeutral);
    expect(
      oklch(chartNeutral).c,
      `chartNeutral ${chartNeutral} is above the chroma floor, so it no longer ` +
        `needs to be quarantined out of chartSeries — or it was edited to a real hue.`
    ).toBeLessThan(CHROMA_FLOOR);
  });

  it("keeps the optimal band's LABEL legible on both surfaces (it paints text, not just a tint)", () => {
    for (const theme of THEMES) {
      const r = contrastRatio(chartBand.optimal, CHART_SURFACE[theme]);
      expect(
        r,
        `chartBand.optimal ${chartBand.optimal} is ${r.toFixed(2)}:1 on ${theme}`
      ).toBeGreaterThanOrEqual(CONTRAST_MIN);
    }
  });
});

describe("sequential cell ramps (issue #1445, Part 3a)", () => {
  const TEXT_CONTRAST_MIN = 4.5;
  const ramps = {
    activity: chartActivityRamp,
    observation: chartObservationRamp,
  };

  for (const [name, ramp] of Object.entries(ramps)) {
    it(`${name} declares the same number of class and hex steps`, () => {
      expect(ramp.stepClasses.length).toBe(ramp.light.steps.length);
      expect(ramp.stepClasses.length).toBe(ramp.dark.steps.length);
      expect(ramp.labelClasses).toHaveLength(ramp.stepClasses.length + 1);
      expect(ramp.light.labelText).toHaveLength(ramp.stepClasses.length + 1);
      expect(ramp.dark.labelText).toHaveLength(ramp.stepClasses.length + 1);
    });

    for (const theme of THEMES) {
      it(`${name} ramp reads as a ramp on the ${theme} surface`, () => {
        const { steps, empty } = ramp[theme];
        const report = validateCellRamp(steps, { theme, empty });
        expect(
          report.failures.map((f) => f.name),
          formatReport(
            `${name} cell ramp FAILED on the ${theme} surface. A density ramp is ` +
              `one hue, monotone in lightness, with every neighbouring cell ` +
              `(including the empty one) visibly apart:`,
            report
          )
        ).toEqual([]);
      });

      it(`${name} labels clear text contrast on every ${theme} ramp step`, () => {
        const palette = ramp[theme];
        const backgrounds = [palette.empty, ...palette.steps];
        backgrounds.forEach((background, level) => {
          const ratio = contrastRatio(palette.labelText[level], background);
          expect(
            ratio,
            `${name} level ${level} label is only ${ratio.toFixed(2)}:1 on ${theme}`
          ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
        });
      });
    }
  }

  // The class ladder and the hex ladder are two halves of one export; if a Tailwind
  // step is edited without its hex the validator would be checking a fiction.
  it("keeps each ramp step's class and hex on the same Tailwind step", () => {
    const BRAND: Record<string, string> = {
      "300": "#86efac",
      "400": "#4ade80",
      "500": "#22c55e",
      "600": "#16a34a",
      "700": "#15803d",
      "800": "#166534",
    };
    chartActivityRamp.stepClasses.forEach((cls, i) => {
      const light = /(?:^|\s)bg-brand-(\d{3})(?:\s|$)/.exec(cls);
      const dark = /dark:bg-brand-(\d{3})/.exec(cls);
      expect(
        light,
        `step ${i + 1} class "${cls}" has no light bg-brand-* step`
      ).not.toBeNull();
      expect(
        dark,
        `step ${i + 1} class "${cls}" has no dark:bg-brand-* step`
      ).not.toBeNull();
      expect(
        BRAND[light![1]],
        `step ${i + 1} light class ${light![0].trim()}`
      ).toBe(chartActivityRamp.light.steps[i]);
      expect(BRAND[dark![1]], `step ${i + 1} dark class ${dark![0]}`).toBe(
        chartActivityRamp.dark.steps[i]
      );
    });

    const BLUE: Record<string, string> = {
      "100": "#dbeafe",
      "200": "#bfdbfe",
      "300": "#93c5fd",
      "400": "#60a5fa",
      "500": "#3b82f6",
      "600": "#2563eb",
      "700": "#1d4ed8",
    };
    chartObservationRamp.stepClasses.forEach((cls, i) => {
      const light = /(?:^|\s)bg-blue-(\d{3})(?:\s|$)/.exec(cls);
      const dark = /dark:bg-blue-(\d{3})/.exec(cls);
      expect(light).not.toBeNull();
      expect(dark).not.toBeNull();
      expect(BLUE[light![1]]).toBe(chartObservationRamp.light.steps[i]);
      expect(BLUE[dark![1]]).toBe(chartObservationRamp.dark.steps[i]);
    });
  });
});

describe("adherence state colors (issue #1445, Part 3a)", () => {
  const STATES = ["taken", "partial", "skipped", "missed"] as const;

  for (const theme of THEMES) {
    it(`keeps every adherence state tellable apart on the ${theme} surface`, () => {
      for (let i = 0; i < STATES.length; i++) {
        for (let j = i + 1; j < STATES.length; j++) {
          const a = chartAdherenceState[STATES[i]][theme];
          const b = chartAdherenceState[STATES[j]][theme];
          const d = deltaE(a, b);
          expect(
            d,
            `${STATES[i]} (${a}) vs ${STATES[j]} (${b}) is ΔE ${d.toFixed(1)} ` +
              `under normal vision on ${theme} — below the ${NORMAL_FLOOR} floor.`
          ).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        }
      }
    });

    // Red/green adherence is the classic dichromat trap. The calendar earns the
    // relief band with mandatory secondary encoding (per-cell title, `data-state`,
    // and a text legend listing every state with its count) — but only the RELIEF
    // band, never below it.
    it(`keeps taken vs missed inside the CVD relief band on ${theme}, never below it`, () => {
      for (const kind of ["protan", "deutan"] as const) {
        const d = deltaE(
          chartAdherenceState.taken[theme],
          chartAdherenceState.missed[theme],
          kind
        );
        expect(
          d,
          `taken vs missed is ΔE ${d.toFixed(1)} under ${kind} on ${theme} — ` +
            `below the ${CVD_FLOOR} relief floor, which no amount of labelling excuses.`
        ).toBeGreaterThanOrEqual(CVD_FLOOR);
      }
    });

    it(`keeps the taken/partial pair reading as one ramp on ${theme}`, () => {
      const report = validateCellRamp(
        theme === "light"
          ? [chartAdherenceState.partial.light, chartAdherenceState.taken.light]
          : [chartAdherenceState.partial.dark, chartAdherenceState.taken.dark],
        { theme }
      );
      expect(
        report.failures.map((f) => f.name),
        formatReport(`adherence partial→taken FAILED on ${theme}:`, report)
      ).toEqual([]);
    });
  }
});
