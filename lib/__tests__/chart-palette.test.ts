import { describe, expect, it } from "vitest";
import {
  adherenceHexes,
  APPEARANCE_PALETTES,
  cellRampHexes,
  chartActivityRamp,
  chartActivityRampTokens,
  chartAdherenceState,
  chartBand,
  chartMuscleRamp,
  chartNeutral,
  chartObservationRamp,
  chartObservationRampTokens,
  chartSeries,
  paletteHex,
  PALETTES,
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

// ── The 3-palette × 2-mode matrix (#2701) ────────────────────────────────────
//
// The appearance palettes re-point the brand/slate/ink ramps under
// `[data-palette]`, so the SAME cell classes paint different hexes per palette.
// The full one-hue rigor above pins the BASE palette (that is where the #1445
// calibration happened); each selectable palette additionally asserts, on ITS
// OWN surfaces:
//   - every categorical series ≥ 3:1 (theme-neutral hexes, palette surfaces)
//   - the band label stays legible
//   - the muscle ramp's accent ≥ 3:1
//   - each cell ramp still ORDERS (monotone lightness) with a separation floor
//   - adherence states stay tellable apart
// The separation floors for the selectable palettes are the RELIEF-band story:
// the calendar surfaces carry mandatory secondary encoding (per-cell titles,
// data-state, counted legends), and warm ramps (Floodlight's amber) compress
// lightness in a way green does not — so the floors below are deliberately
// looser than the base gate, never absent.
const PALETTE_RAMP_MIN_DELTA_L = 0.035;
const PALETTE_ADHERENCE_MIN_DELTA_E = 10;

describe("appearance palette matrix (#2701)", () => {
  const MODES = ["light", "dark"] as const;

  for (const palette of APPEARANCE_PALETTES) {
    for (const mode of MODES) {
      const surface = PALETTES[palette].chartSurface[mode];

      it(`keeps every series color at 3:1 on the ${palette} ${mode} surface`, () => {
        for (const hex of Object.values(chartSeries)) {
          const r = contrastRatio(hex, surface);
          expect(
            r,
            `${hex} is ${r.toFixed(2)}:1 on ${palette}/${mode} (${surface})`
          ).toBeGreaterThanOrEqual(CONTRAST_MIN);
        }
      });

      it(`keeps the optimal band label legible on ${palette} ${mode}`, () => {
        const r = contrastRatio(chartBand.optimal, surface);
        expect(
          r,
          `chartBand.optimal is ${r.toFixed(2)}:1 on ${palette}/${mode}`
        ).toBeGreaterThanOrEqual(CONTRAST_MIN);
      });

      it(`keeps the muscle ramp's accent at 3:1 on ${palette} ${mode}`, () => {
        const hex = paletteHex(palette, chartMuscleRamp.token);
        const r = contrastRatio(hex, surface);
        expect(
          r,
          `muscle ramp ${hex} is ${r.toFixed(2)}:1 on ${palette}/${mode}`
        ).toBeGreaterThanOrEqual(CONTRAST_MIN);
      });

      it(`keeps the cell ramps ordered and separated on ${palette} ${mode}`, () => {
        for (const [name, tokens] of Object.entries({
          activity: chartActivityRampTokens,
          observation: chartObservationRampTokens,
        })) {
          const side = cellRampHexes(tokens, palette)[mode];
          const ladder = [side.empty, ...side.steps].map((hex) => oklch(hex).l);
          for (let i = 0; i < ladder.length - 1; i++) {
            const gap =
              mode === "light"
                ? ladder[i] - ladder[i + 1]
                : ladder[i + 1] - ladder[i];
            expect(
              gap,
              `${name} ramp level ${i}→${i + 1} on ${palette}/${mode} moves ` +
                `ΔL ${gap.toFixed(3)} — under the ${PALETTE_RAMP_MIN_DELTA_L} ` +
                `floor (or the wrong direction: a ramp must stay monotone).`
            ).toBeGreaterThanOrEqual(PALETTE_RAMP_MIN_DELTA_L);
          }
        }
      });

      it(`keeps adherence states tellable apart on ${palette} ${mode}`, () => {
        const states = adherenceHexes(palette);
        const NAMES = ["taken", "partial", "skipped", "missed"] as const;
        for (let i = 0; i < NAMES.length; i++) {
          for (let j = i + 1; j < NAMES.length; j++) {
            const a = states[NAMES[i]][mode];
            const b = states[NAMES[j]][mode];
            const d = deltaE(a, b);
            expect(
              d,
              `${NAMES[i]} (${a}) vs ${NAMES[j]} (${b}) is ΔE ${d.toFixed(1)} ` +
                `on ${palette}/${mode} — under the ${PALETTE_ADHERENCE_MIN_DELTA_E} floor.`
            ).toBeGreaterThanOrEqual(PALETTE_ADHERENCE_MIN_DELTA_E);
          }
        }
      });
    }
  }

  it("keeps the base tables derived from the botanical token column", () => {
    // The exported base hex tables are BUILT from PALETTES.botanical, so this is
    // a tripwire against someone re-literalizing them and letting the map drift.
    expect(chartActivityRamp.light).toEqual(
      cellRampHexes(chartActivityRampTokens, "botanical").light
    );
    expect(chartObservationRamp.dark).toEqual(
      cellRampHexes(chartObservationRampTokens, "botanical").dark
    );
    expect(chartAdherenceState.taken.light).toBe(
      paletteHex("botanical", "brand-700")
    );
  });

  // Floodlight's declared risk (#2701): its ACCENT is amber, and the chart
  // series set contains an amber. The accent everywhere (brand-400 #fbbf24)
  // must stay clearly apart from the Energy/warn series hue — if an edit walks
  // them into identity, a data line starts reading as UI chrome.
  it("keeps the Floodlight accent apart from the amber series hue", () => {
    const accent = paletteHex("floodlight", "brand-400");
    const d = deltaE(chartSeries.amber, accent);
    expect(
      d,
      `chartSeries.amber ${chartSeries.amber} vs Floodlight accent ${accent} ` +
        `is ΔE ${d.toFixed(1)} — the declared adjacency has collapsed.`
    ).toBeGreaterThanOrEqual(NORMAL_FLOOR);
  });
});
