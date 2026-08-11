import { describe, it, expect } from "vitest";
import {
  isPanelReachableInBrowser,
  reachablePanelIds,
  unreachablePanelIds,
} from "../biomarker-panel-reach";
import {
  OTHER_PANEL,
  orderedPanelIds,
  panelForCanonicalName,
  PANEL_IDS,
  type PanelId,
} from "../biomarker-panels";
import { CANONICAL_BIOMARKERS } from "../datasets/canonical-biomarkers";
import { DERIVED_NAMES } from "../derived-biomarkers";
import { BIOMARKER_CATEGORIES } from "../medical-categories";
import { hasTrendMetricHome } from "../trend-metric-analytes";

// #1581 section D — the panel facet must not offer an option that can never return a
// row. The derivation is over the controlled vocabulary, so these assertions are
// about the TAXONOMY, not about any profile's data.

describe("reachablePanelIds (#1581 section D)", () => {
  it("partitions the taxonomy, in PANEL_LABELS order", () => {
    const reachable = reachablePanelIds();
    const unreachable = unreachablePanelIds();
    expect([...reachable, ...unreachable].sort()).toEqual(
      [...PANEL_IDS].sort()
    );
    // Each side keeps the curated order the facet renders in.
    const order = orderedPanelIds();
    for (const list of [reachable, unreachable]) {
      const positions = list.map((id) => order.indexOf(id));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("strands exactly the panels whose analytes are all re-homed out of the browser", () => {
    // The #1076 re-homed classes, one panel each:
    //   mental-health  → category `instrument` (PHQ-9 / GAD-7 / AUDIT). Removing it
    //                    is the SENSITIVITY fix: the browser refuses to show these,
    //                    so offering the facet advertised data it will not render.
    //   blood-type     → category `reference` (the passport's immutable facts).
    // And since #2365, one panel emptied ANALYTE by analyte rather than by class:
    //   vital-signs    → all six members (blood pressure ×2, oxygen saturation,
    //                    respiratory rate, resting heart rate, body temperature) are
    //                    body metrics with a `/trends/metric/<slug>` chart, so the
    //                    browser lists none of them and the facet option can only
    //                    return "No readings match these filters".
    expect(unreachablePanelIds()).toEqual([
      "blood-type",
      "vital-signs",
      "mental-health",
    ]);
  });

  it("keeps biological-age, because PhenoAge still renders here as a derived row", () => {
    // The issue flagged this one "verify before removing". A read-time derived index
    // is synthesized with category 'lab' whatever its canonical entry says, so
    // `?panel=biological-age` does return the PhenoAge row the hero also headlines.
    expect(panelForCanonicalName("PhenoAge")).toBe("biological-age");
    expect(isPanelReachableInBrowser("biological-age")).toBe(true);
  });

  it("keeps the non-lab panels #1076 deliberately left browsable", () => {
    // vitals: audiogram thresholds (#713), IOP / visual acuity (#697), periodontal
    // depth (#705) — none has another chart surface. scan: numeric DEXA. #2365 does
    // not touch these: its rule removes an analyte only when a home EXISTS, and none
    // of these analytes has one.
    for (const id of [
      "vision",
      "hearing",
      "dental",
      "fitness",
      "body-composition",
    ] as PanelId[])
      expect(isPanelReachableInBrowser(id)).toBe(true);
    // Respiratory function is the mixed panel and the sharpest case: peak expiratory
    // flow leaves (it has a metric page), the three spirometry analytes stay, so the
    // panel is still reachable — the rule is per analyte, never per panel.
    expect(isPanelReachableInBrowser("respiratory")).toBe(true);
  });

  it("keeps the reserved Other bucket, whose rows are un-canonicalized", () => {
    // It has no curated members by construction, so a members-only derivation would
    // have dropped the one panel that always has rows to show.
    expect(isPanelReachableInBrowser(OTHER_PANEL)).toBe(true);
    expect(reachablePanelIds().at(-1)).toBe(OTHER_PANEL);
  });

  it("agrees with a from-scratch walk of the vocabulary", () => {
    // The independent oracle: a panel is reachable iff some canonical entry in it
    // carries a listed category AND is not an analyte the browser drops for having a
    // body-metric home (#2365), or a derived index resolves to it, or it is `other`.
    const listed = new Set<string>(BIOMARKER_CATEGORIES as readonly string[]);
    const expected = new Set<PanelId>([OTHER_PANEL]);
    for (const e of CANONICAL_BIOMARKERS) {
      if (!listed.has(e.category)) continue;
      if (e.category === "vitals" && hasTrendMetricHome(e.name)) continue;
      expected.add(panelForCanonicalName(e.name));
    }
    for (const n of DERIVED_NAMES) expected.add(panelForCanonicalName(n));
    expect(reachablePanelIds().sort()).toEqual([...expected].sort());
  });
});
