// PURE TIER — the fiber × GI-symptom read-together panel (#2788). No DB, no clock.
//
// Two halves: the assembly arithmetic (alignment, GI filtering, the null-vs-zero day
// distinction, the bar scale), and the DOCTRINE constraint — the panel is a VIEW that
// computes no correlation and can hand a renderer nothing to build one from. A wording
// rule is not enforceable; a structure is (the food-habit-observation idiom).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIBER_SYMPTOM_PANEL_DAYS,
  GI_PANEL_SYMPTOMS,
  buildFiberSymptomPanel,
  fiberSymptomPanelDates,
  fiberSymptomPanelHasSignal,
  type FiberSymptomPanelInput,
} from "@/lib/fiber-symptom-panel";
import { symptomBySlug } from "@/lib/symptoms";

const DATES = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

function input(
  over: Partial<FiberSymptomPanelInput> = {}
): FiberSymptomPanelInput {
  return {
    dates: DATES,
    gramsByDate: new Map(),
    symptoms: [],
    ...over,
  };
}

describe("the GI vocabulary", () => {
  it("every member resolves to a curated symptom slug (a rename cannot silently drop one)", () => {
    for (const slug of GI_PANEL_SYMPTOMS) {
      expect(symptomBySlug(slug), slug).toBeTruthy();
    }
    expect(GI_PANEL_SYMPTOMS.length).toBeGreaterThan(0);
  });
});

describe("the window", () => {
  it("spans four whole weeks ending on the given today, oldest → newest", () => {
    const dates = fiberSymptomPanelDates("2026-08-15");
    expect(dates).toHaveLength(FIBER_SYMPTOM_PANEL_DAYS);
    expect(FIBER_SYMPTOM_PANEL_DAYS % 7).toBe(0);
    expect(dates[0]).toBe("2026-07-19");
    expect(dates[dates.length - 1]).toBe("2026-08-15");
  });
});

describe("assembly", () => {
  it("emits one entry per window date, oldest → newest, with absent days as null grams", () => {
    const panel = buildFiberSymptomPanel(
      input({
        gramsByDate: new Map([
          ["2026-08-01", 12],
          ["2026-08-03", 0],
        ]),
      })
    );
    expect(panel.days.map((d) => d.date)).toEqual(DATES);
    // A day the gather saw no signal for is null; a LOGGED zero-fiber day stays 0 —
    // "didn't log" and "logged only zero-fiber groups" are different facts.
    expect(panel.days.map((d) => d.grams)).toEqual([12, null, 0, null]);
  });

  it("keeps only GI symptoms, worst-first within a day", () => {
    const panel = buildFiberSymptomPanel(
      input({
        symptoms: [
          { date: "2026-08-02", symptom: "bloating", severity: 1 },
          { date: "2026-08-02", symptom: "diarrhea", severity: 3 },
          // Non-GI rows pass through the gather and are filtered HERE, so the
          // vocabulary has one owner.
          { date: "2026-08-02", symptom: "headache", severity: 4 },
          { date: "2026-08-04", symptom: "abdominal_pain", severity: 2 },
        ],
      })
    );
    expect(panel.days[1].symptoms).toEqual([
      { symptom: "diarrhea", severity: 3 },
      { symptom: "bloating", severity: 1 },
    ]);
    expect(panel.days[3].symptoms).toEqual([
      { symptom: "abdominal_pain", severity: 2 },
    ]);
    expect(panel.days[0].symptoms).toEqual([]);
  });

  it("carries the unknown-gram supplement flag per day — a psyllium-capsule day is never a flat zero", () => {
    const panel = buildFiberSymptomPanel(
      input({
        gramsByDate: new Map([["2026-08-02", 0]]),
        unknownSupplementDates: new Set(["2026-08-02"]),
      })
    );
    expect(panel.days[1].unknownSupplement).toBe(true);
    expect(panel.days[0].unknownSupplement).toBe(false);
  });

  it("scales bars to the window's peak, floored so a low week reads as low", () => {
    expect(buildFiberSymptomPanel(input()).maxGrams).toBe(20);
    expect(
      buildFiberSymptomPanel(
        input({ gramsByDate: new Map([["2026-08-01", 6]]) })
      ).maxGrams
    ).toBe(20);
    expect(
      buildFiberSymptomPanel(
        input({ gramsByDate: new Map([["2026-08-01", 41]]) })
      ).maxGrams
    ).toBe(41);
  });
});

describe("the render gate", () => {
  it("needs BOTH series — fiber alone or symptoms alone is nothing to co-read", () => {
    const fiberOnly = buildFiberSymptomPanel(
      input({ gramsByDate: new Map([["2026-08-01", 12]]) })
    );
    const symptomsOnly = buildFiberSymptomPanel(
      input({
        symptoms: [{ date: "2026-08-02", symptom: "bloating", severity: 2 }],
      })
    );
    const both = buildFiberSymptomPanel(
      input({
        gramsByDate: new Map([["2026-08-01", 12]]),
        symptoms: [{ date: "2026-08-02", symptom: "bloating", severity: 2 }],
      })
    );
    expect(fiberSymptomPanelHasSignal(fiberOnly)).toBe(false);
    expect(fiberSymptomPanelHasSignal(symptomsOnly)).toBe(false);
    expect(fiberSymptomPanelHasSignal(both)).toBe(true);
  });
});

// ── The doctrine constraint, held structurally ────────────────────────────────
describe("a view, never a correlation engine (#2788)", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "lib/fiber-symptom-panel.ts"),
    "utf8"
  );
  // Comments discuss the rule at length; only CODE is under test.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("imports only the calendar — no findings bus, no dismissal keys, no send path to reach", () => {
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./date"]);
  });

  it("mints no finding and no dedupe key", () => {
    expect(code).not.toMatch(/dedupeKey|Finding\b/);
  });

  it("computes no correlation — no shared-axis verdict leaves this module", () => {
    // The panel's outputs are the two series and a scale; nothing here relates one
    // series to the other (no correlation, share, rate, or trend across them).
    expect(code).not.toMatch(/correlat/i);
  });
});
