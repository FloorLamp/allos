// The Longevity page's section model (#1042 phase 4). PURE — no DB, no network.
//
// The page (/longevity) is the EXPANDED formatter over the SAME pillar model the
// dashboard HealthspanPillarsWidget compact-renders (the digest-data/weekly-recap
// one-model-two-formatters precedent, #221): buildPillars (lib/healthspan-pillars)
// stays the ONE computation, the widget shows each pillar as a stat card, and
// this module groups those SAME Pillar objects into the page's anchored sections.
// A test (lib/__tests__/longevity-sections.test.ts) pins that the two surfaces
// carry identical facts for the same fixture — the sections re-derive NOTHING.
//
// Stances (issue #1042, restated where they bind):
//   • PILLARS, not a composite score — no invented single number here either.
//   • Absent pillars don't render: a section exists only when at least one of its
//     pillars is in the model (longevitySections drops empty groups), so an
//     empty-data profile gets no ghost sections. The one deliberate widening is
//     the #bio-age section, which also renders its missing-inputs CHECKLIST state
//     (bioAgeSurface, lib/bio-age.ts) — the spec'd CTA for a partial panel.
//   • Membership test: a section belongs iff it's a pillar in the model or an
//     INTERVENTION against one — which is why #protocols (N-of-1 experiments, the
//     absorbed /protocols hub) is the only non-pillar section and always renders
//     (it is also the creation surface for a first experiment).

import { PILLAR_ANCHOR, type Pillar } from "./healthspan-pillars";

// The interventions section's anchor — the permanent /protocols redirect target
// (next.config.js: /protocols → /longevity#protocols).
export const PROTOCOLS_ANCHOR = "protocols";

export interface LongevitySection {
  // Stable in-page anchor id (the widget deep-links land on these).
  anchor: string;
  title: string;
  // The pillars this section expands — the SAME objects the widget renders.
  pillars: Pillar[];
}

// Stable section order: the bio-age hero first (the headline "how am I aging"),
// then fitness, sleep, and the biomarker share. Anchors must agree with
// PILLAR_ANCHOR (guarded by the test) so pillarHref deep-links resolve.
const SECTION_ORDER: { anchor: string; title: string }[] = [
  { anchor: "bio-age", title: "Biological age" },
  { anchor: "fitness", title: "Fitness percentiles" },
  { anchor: "sleep", title: "Sleep regularity" },
  { anchor: "biomarkers", title: "Biomarkers in range" },
];

// Group the visible pillars into page sections. A section with no pillar in the
// model is DROPPED (absent pillars don't render); the protocols section is not
// pillar-backed and is rendered unconditionally by the page itself.
export function longevitySections(pillars: Pillar[]): LongevitySection[] {
  return SECTION_ORDER.map((s) => ({
    ...s,
    pillars: pillars.filter((p) => PILLAR_ANCHOR[p.key] === s.anchor),
  })).filter((s) => s.pillars.length > 0);
}
