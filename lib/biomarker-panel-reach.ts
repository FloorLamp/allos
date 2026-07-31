// Which #1502 panels the Results › Biomarkers browser can actually RETURN a row
// for (issue #1581 section D). Pure — no DB, no auth, no React.
//
// WHY. The panel facet offered the whole 35-entry taxonomy "rather than only the
// panels present in the current view", which is the right instinct: a facet whose
// options appear and vanish as you filter is unusable. But the browser lists only
// BIOMARKER_CATEGORIES (`lab | vitals | genomics | scan`), and #1076 re-homed three
// classes OUT of it — `instrument` (screening scores), `derived` (bio-age
// composites), `reference` (immutable facts). A panel whose analytes ALL carry a
// re-homed category is therefore a dead option: choosing it can only ever produce
// "No records match these filters".
//
// The mental-health case is not merely useless, it is a SENSITIVITY regression:
// #1076's stated reason for excluding `instrument` is that "a depression/alcohol
// score must never surface in a general health catalog", and offering a
// "Mental health screens" facet in that catalog advertises exactly the data the
// browser deliberately refuses to show.
//
// STATIC, NOT PER-VIEW. The derivation is over the CONTROLLED VOCABULARY, not over
// the rows a profile happens to have, so the control's contents stay stable while
// filters change — which is what the original "offer the full set" comment was
// protecting. It only removes options that can never work for ANY profile.
//
// ONE COMPUTATION. Panel membership is resolved through panelForCanonicalName() —
// the same resolver the Panel cell, the `?panel=` facet, the panel groups and the
// `biomarker_panel()` SQL function use. There is no second realization of "which
// panel is this analyte in?" here; this module only asks "can a row in that panel
// carry a category the browser lists?".

import { CANONICAL_BIOMARKERS } from "./datasets/canonical-biomarkers";
import { DERIVED_NAMES } from "./derived-biomarkers";
import {
  OTHER_PANEL,
  orderedPanelIds,
  panelForCanonicalName,
  type PanelId,
} from "./biomarker-panels";
import { BIOMARKER_CATEGORIES } from "./medical-categories";
import type { MedicalCategory } from "./types";

// The medical categories the browser lists, as a lookup.
const LISTED = new Set<string>(BIOMARKER_CATEGORIES as readonly string[]);

// The panels a browser row can land in, computed once at module load.
//
// Three sources, all of them rows the browser can actually render:
//
//  1. A canonical entry whose curated `category` is one the browser lists. This is
//     the bulk of the taxonomy, and it is why `vital-signs`, `vision`, `hearing`,
//     `dental`, `fitness` (all `vitals`) and `body-composition` (`scan`) STAY —
//     #1076 kept those browsable on purpose because they have no other home.
//  2. A read-time DERIVED index (#40). Those are virtual rows synthesized with
//     category `lab` regardless of what their canonical entry says, so PhenoAge —
//     canonically `derived`, and re-homed to the bio-age hero — still renders here
//     as a derived row and `?panel=biological-age` still returns it. (Issue #1581
//     flagged this as "verify before removing"; this is the verification, and the
//     answer is that the panel is reachable.)
//  3. `other`, the reserved bucket for un-canonicalized readings. It has no
//     curated members by construction, but its rows are whatever the extractor
//     coined — routinely `lab` — so it is always reachable.
const REACHABLE: ReadonlySet<PanelId> = (() => {
  const reachable = new Set<PanelId>([OTHER_PANEL]);
  for (const entry of CANONICAL_BIOMARKERS) {
    if (!LISTED.has(entry.category as MedicalCategory)) continue;
    reachable.add(panelForCanonicalName(entry.name));
  }
  for (const name of DERIVED_NAMES) reachable.add(panelForCanonicalName(name));
  return reachable;
})();

// True when the Biomarkers browser can return at least one row for this panel.
export function isPanelReachableInBrowser(id: PanelId): boolean {
  return REACHABLE.has(id);
}

// The panels the browser's facet offers, in PANEL_LABELS order (`other` last) —
// the taxonomy intersected with what the category scope can actually surface.
export function reachablePanelIds(): PanelId[] {
  return orderedPanelIds().filter(isPanelReachableInBrowser);
}

// The complement, kept as a derived value so the two can't drift. Exported for the
// tests that pin WHICH panels the category scope strands (and why), and for any
// future surface that wants to explain the omission rather than repeat it.
export function unreachablePanelIds(): PanelId[] {
  return orderedPanelIds().filter((id) => !isPanelReachableInBrowser(id));
}
