// "The rest of this panel" (#1502), gathered once for both reading detail surfaces.
//
// A single-analyte page used to be a dead end: you could see your LDL, but nothing
// told you it arrived with an HDL and a triglycerides, or offered a way across. The
// normalized taxonomy makes that answerable — panelForCanonicalName places the
// analyte, and the siblings are the profile's OWN current readings in the same panel
// (the shared getMedicalRecords `current` facet, deduped and latest-per-#482-family
// like every other biomarker surface), so it never advertises a marker never measured.
//
// Shared since #1932: the vital-signs panel's members now render on two different
// surfaces by cadence, and the cross-reference is the one thing that has to keep
// working across that split — an SpO2 page must still say it arrived with a blood
// pressure. One gather, one card (components/PanelSiblingsCard), so the two pages
// cannot list different siblings for the same panel.
//
// Auth-blind and profile-scoped: `profileId` first, no lib/auth import.

import { getMedicalRecords } from "@/lib/queries/medical";
import { biomarkerFamily } from "@/lib/canonical-name";
import { OTHER_PANEL, panelForCanonicalName } from "@/lib/biomarker-panels";
import { NON_BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import { tableNameKey } from "@/lib/derived-table";
import type { PanelId } from "@/lib/biomarker-panels";

// How many sibling analytes the panel strip lists. A wayfinding affordance, not a
// second table — the "see the whole panel" link carries the rest.
export const PANEL_SIBLING_CAP = 12;

export interface PanelSiblings {
  panelId: PanelId;
  // Display names of the profile's other current readings in this panel, sorted and
  // capped. Empty when nothing else in the panel has been measured.
  names: string[];
}

/**
 * The analyte's normalized panel and the profile's other current readings in it, or
 * `null` when the taxonomy can't place the analyte (the catch-all panel has no
 * cross-reference worth making). The analyte itself is excluded by FAMILY identity,
 * not by raw name, so a "Vitamin D" page doesn't list "Vitamin D, 25-Hydroxy" as its
 * own sibling.
 */
export function getPanelSiblings(
  profileId: number,
  canonicalName: string
): PanelSiblings | null {
  const panelId = panelForCanonicalName(canonicalName);
  if (panelId === OTHER_PANEL) return null;
  const ownFamily = biomarkerFamily(canonicalName).toLowerCase();
  const names = [
    // Deduped case-insensitively, keeping the first spelling seen — two documents
    // that capitalize the same analyte differently are one sibling chip.
    ...new Map(
      getMedicalRecords(profileId, {
        panel: panelId,
        current: true,
        excludeCategories: NON_BIOMARKER_CATEGORIES,
      })
        .map((r) => tableNameKey(r))
        .filter((n) => biomarkerFamily(n).toLowerCase() !== ownFamily)
        .map((n) => [n.toLowerCase(), n] as const)
    ).values(),
  ]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, PANEL_SIBLING_CAP);
  return names.length > 0 ? { panelId, names } : null;
}
