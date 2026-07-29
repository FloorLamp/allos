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
    expect(unreachablePanelIds()).toEqual(["blood-type", "mental-health"]);
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
    // depth (#705) — none has another chart surface. scan: numeric DEXA.
    for (const id of [
      "vital-signs",
      "vision",
      "hearing",
      "dental",
      "fitness",
      "body-composition",
    ] as PanelId[])
      expect(isPanelReachableInBrowser(id)).toBe(true);
  });

  it("keeps the reserved Other bucket, whose rows are un-canonicalized", () => {
    // It has no curated members by construction, so a members-only derivation would
    // have dropped the one panel that always has rows to show.
    expect(isPanelReachableInBrowser(OTHER_PANEL)).toBe(true);
    expect(reachablePanelIds().at(-1)).toBe(OTHER_PANEL);
  });

  it("agrees with a from-scratch walk of the vocabulary", () => {
    // The independent oracle: a panel is reachable iff some canonical entry in it
    // carries a listed category, or a derived index resolves to it, or it is `other`.
    const listed = new Set<string>(BIOMARKER_CATEGORIES as readonly string[]);
    const expected = new Set<PanelId>([OTHER_PANEL]);
    for (const e of CANONICAL_BIOMARKERS)
      if (listed.has(e.category)) expected.add(panelForCanonicalName(e.name));
    for (const n of DERIVED_NAMES) expected.add(panelForCanonicalName(n));
    expect(reachablePanelIds().sort()).toEqual([...expected].sort());
  });
});
