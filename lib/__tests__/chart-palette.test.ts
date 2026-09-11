import { describe, expect, it } from "vitest";
import {
  chartActivityRamp,
  chartAdherenceState,
  chartBand,
  chartNeutral,
  chartObservationRamp,
  chartSeries,
  attentionAmber,
  VERDICT_TONE_LABEL,
  VERDICT_TONES,
  verdictBadge,
  verdictFill,
  verdictText,
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

// Every Tailwind step the palette's class strings name, as the hex it compiles to
// (`app/globals.css` @theme where Botanical overrides it, Tailwind v4's own
// oklch otherwise). The class ladder and the hex ladder are two halves of one
// export — the same discipline `chartActivityRamp` keeps — so a step edited in
// a class without its hex fails here rather than silently validating a fiction.
const STEP: Record<string, string> = {
  "emerald-100": "#d0fae5",
  "emerald-300": "#aecf9f",
  "emerald-400": "#00d492",
  "emerald-600": "#009966",
  "emerald-700": "#007a55",
  "emerald-950": "#121d13",
  "amber-100": "#fef3c6",
  "amber-300": "#d9c887",
  "amber-400": "#ffb900",
  "amber-500": "#fe9a00",
  "amber-700": "#bb4d00",
  "amber-950": "#171a10",
  "rose-100": "#ffe4e6",
  "rose-300": "#d8aca8",
  "rose-400": "#ff637e",
  "rose-500": "#ff2056",
  "rose-600": "#ec003f",
  "rose-700": "#c70036",
  "rose-950": "#1c1315",
  "slate-100": "#ecf2e8",
  "slate-200": "#d9e8de",
  "slate-300": "#b2c6b9",
  "slate-400": "#86a190",
  "slate-500": "#4e6354",
  "slate-700": "#2f4237",
  "ink-800": "#141c16",
};

/** The hex a `text-*` / `bg-*` utility in `cls` renders, for one theme. */
function stepHex(cls: string, theme: ChartTheme, kind: "text" | "bg"): string {
  const re = new RegExp(
    `(?:^|\\s)${theme === "dark" ? "dark:" : ""}${kind}-([a-z]+-\\d{2,3})(?![\\w-])`,
    "g"
  );
  // In light mode a `dark:` prefix must not match, so strip those utilities first.
  const source =
    theme === "light"
      ? cls
          .split(/\s+/)
          .filter((c) => !c.startsWith("dark:"))
          .join(" ")
      : cls;
  const found = [...source.matchAll(re)].map((m) => m[1]);
  // A single-class entry (e.g. `bg-emerald-600`) applies to BOTH themes.
  if (found.length === 0 && theme === "dark")
    return stepHex(cls, "light", kind);
  expect(found, `${kind} step for ${theme} in "${cls}"`).toHaveLength(1);
  const hex = STEP[found[0]];
  expect(
    hex,
    `${found[0]} is missing from this test's STEP table`
  ).toBeTruthy();
  return hex;
}

// ── verdict tones (issue #5187) ─────────────────────────────────────────────
//
// The colour a good/warn/bad word wears used to be declared fourteen times and
// painted in ten private `Record<…Tone, string>` maps, none of which was checked
// against anything. These are the checks they never had.
//
// DELIBERATELY CONTRAST CHECKS, NOT SEPARATION CHECKS. `chartSeries` slots must
// separate under CVD because there the hue IS the identity of the line. A verdict
// always colours a word the reader is already reading — the badge's own label, the
// metric's name, `VERDICT_TONE_LABEL` beside the value (#1220) — so the question
// that decides whether the convergence is an improvement is legibility. The worst
// pair distances are printed below anyway, unasserted, so a future re-step can see
// what it is trading; on the Botanical dark ramp the four badge inks sit as close
// as ΔE 5.0 (good↔neutral) and 2.7 under deuteranopia, which is exactly why the
// label channel is mandatory rather than decorative.

describe("verdict tones (issue #5187)", () => {
  const TEXT_CONTRAST_MIN = 4.5;

  it("declares all four tones in each of the three maps", () => {
    expect(VERDICT_TONES).toEqual(["good", "warn", "bad", "neutral"]);
    for (const map of [verdictText, verdictBadge, verdictFill]) {
      expect(Object.keys(map).sort()).toEqual([...VERDICT_TONES].sort());
    }
  });

  it("keeps each entry's classes and hexes on the same Tailwind step", () => {
    for (const tone of VERDICT_TONES) {
      for (const theme of THEMES) {
        expect(
          stepHex(verdictText[tone].class, theme, "text"),
          `text ${tone} ${theme}`
        ).toBe(verdictText[tone][theme]);
        expect(
          stepHex(verdictFill[tone].class, theme, "bg"),
          `fill ${tone} ${theme}`
        ).toBe(verdictFill[tone][theme]);
        expect(
          stepHex(verdictBadge[tone].class, theme, "bg"),
          `badge bg ${tone} ${theme}`
        ).toBe(verdictBadge[tone][theme].bg);
        expect(
          stepHex(verdictBadge[tone].class, theme, "text"),
          `badge fg ${tone} ${theme}`
        ).toBe(verdictBadge[tone][theme].fg);
      }
    }
  });

  for (const theme of THEMES) {
    it(`keeps verdict TEXT at AA on the ${theme} surface`, () => {
      for (const tone of VERDICT_TONES) {
        const hex = verdictText[tone][theme];
        const r = contrastRatio(hex, CHART_SURFACE[theme]);
        expect(
          r,
          `verdictText.${tone} ${hex} is ${r.toFixed(2)}:1 on the ${theme} ` +
            `surface ${CHART_SURFACE[theme]} — under AA for body text. This is ` +
            `the defect #5187 found: the -600 step the app painted judgments in ` +
            `sat at 3.40 (emerald), 2.98 (amber) and 4.21 (rose) on light.`
        ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
      }
    });

    it(`keeps a verdict BADGE's label legible on its own tint (${theme})`, () => {
      for (const tone of VERDICT_TONES) {
        const { bg, fg } = verdictBadge[tone][theme];
        const r = contrastRatio(fg, bg);
        expect(
          r,
          `verdictBadge.${tone} label ${fg} is ${r.toFixed(2)}:1 on its own ` +
            `${bg} tint (${theme})`
        ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
      }
    });

    it(`keeps a verdict FILL readable as a mark on the ${theme} surface`, () => {
      for (const tone of VERDICT_TONES) {
        const hex = verdictFill[tone][theme];
        const r = contrastRatio(hex, CHART_SURFACE[theme]);
        expect(
          r,
          `verdictFill.${tone} ${hex} is ${r.toFixed(2)}:1 on the ${theme} ` +
            `surface — a progress bar is a graphical object and clears ${CONTRAST_MIN}:1`
        ).toBeGreaterThanOrEqual(CONTRAST_MIN);
      }
    });
  }

  it("gives every JUDGING tone a distinct word, and neutral none", () => {
    const judging = VERDICT_TONES.filter((t) => t !== "neutral");
    const labels = judging.map((t) => VERDICT_TONE_LABEL[t]);
    expect(labels.every((l) => typeof l === "string" && l.length > 0)).toBe(
      true
    );
    // Two tones sharing one word would re-collapse the judgment the badge exists
    // to distinguish — and the word is the ONLY channel a dichromat has here.
    expect(new Set(labels).size).toBe(judging.length);
    expect(VERDICT_TONE_LABEL.neutral).toBeNull();
  });

  // The exact WORDS, not just their distinctness (#1220). `e2e/tone-markers.spec.ts`
  // re-declares this map locally — a Playwright spec cannot import app code through
  // the `@/` alias — and its comment says the pure tier pins the wording. This is
  // that pin: re-word a judgment here and this fails before the browser tier does.
  it("pins the exact badge wording every verdict surface renders", () => {
    expect(VERDICT_TONE_LABEL.good).toBe("Good");
    expect(VERDICT_TONE_LABEL.warn).toBe("Fair");
    expect(VERDICT_TONE_LABEL.bad).toBe("Poor");
  });

  it("never lets two tones render the same classes", () => {
    for (const map of [verdictText, verdictBadge, verdictFill]) {
      const classes = VERDICT_TONES.map((t) => map[t].class);
      expect(new Set(classes).size).toBe(classes.length);
    }
  });
});

// ── the non-verdict attention amber (#5760) ─────────────────────────────────
//
// Nine surfaces wanted an amber that draws the eye without judging — a watch
// card's icon, the `limit` food tier, an eat-less bullet, a set that moved down
// from last session. None could take `verdictText.warn` without also taking
// `VERDICT_TONE_LABEL.warn`, so each picked a step by hand and eight picked
// `text-amber-500`: 1.99:1 on the light surface, against a 3.0 floor for a
// graphical object. One owner, checked here for the same reason the verdict
// inks are — nothing else measures it.
describe("attention amber (issue #5760)", () => {
  const TEXT_CONTRAST_MIN = 4.5;

  it("keeps its classes and its hexes on the same Tailwind step", () => {
    for (const theme of THEMES) {
      expect(stepHex(attentionAmber.class, theme, "text"), theme).toBe(
        attentionAmber[theme]
      );
    }
  });

  it("paints a ::marker in the same two steps as the text ink", () => {
    // A list marker needs the `marker:` variant written out, so the steps are
    // spelled twice; they are one colour, and this is what says so.
    const asMarker = attentionAmber.class
      .split(" ")
      .map((c) =>
        c.startsWith("dark:") ? `dark:marker:${c.slice(5)}` : `marker:${c}`
      )
      .join(" ");
    expect(attentionAmber.markerClass).toBe(asMarker);
  });

  for (const theme of THEMES) {
    it(`clears the TEXT floor on the ${theme} surface`, () => {
      const hex = attentionAmber[theme];
      const r = contrastRatio(hex, CHART_SURFACE[theme]);
      expect(
        r,
        `attentionAmber ${hex} is ${r.toFixed(2)}:1 on the ${theme} surface ` +
          `${CHART_SURFACE[theme]}. It paints icons, a list marker AND a word, ` +
          `so it clears the text floor, not just the ${CONTRAST_MIN}:1 one a ` +
          `graphical object would need.`
      ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    });
  }

  it("is not one of the four judgments — no tone renders these classes", () => {
    for (const tone of VERDICT_TONES) {
      expect(verdictText[tone].class).not.toBe(attentionAmber.class);
    }
  });
});
