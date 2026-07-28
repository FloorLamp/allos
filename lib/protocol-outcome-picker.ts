// Pure option preparation for the protocol outcome picker (#1586). The DB seam
// supplies the profile's available outcomes; this module owns the two UI questions:
// which aliases should match a query, and which clinical panels are most relevant
// to the intervention currently being described.

import { canonicalAliases, normalizeCanonicalKey } from "./canonical-name";
import { tablePanelId } from "./derived-table";
import type { PanelId } from "./biomarker-panels";
import { fuzzyScore } from "./fuzzy";

export interface OutcomeOption {
  key: string;
  label: string;
  group: "Body & indices" | "Biomarkers";
  panel: PanelId | null;
  searchTerms: string[];
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

// Search aliases come from the SAME canonical-name registry used during ingest.
// This makes "A1c" find "Hemoglobin A1c" without growing a second synonym list in
// the picker. The visible canonical label is kept separate from these hidden terms.
export function outcomeSearchTerms(label: string): string[] {
  const key = normalizeCanonicalKey(label);
  return unique(
    canonicalAliases()
      .filter(([, canonical]) => normalizeCanonicalKey(canonical) === key)
      .map(([alias]) => alias)
  );
}

export function biomarkerOutcomeOption(name: string): OutcomeOption {
  return {
    key: `biomarker:${name}`,
    label: name,
    group: "Biomarkers",
    panel: tablePanelId({ name, canonical_name: name }),
    searchTerms: outcomeSearchTerms(name),
  };
}

// Pure matcher exported for the boundary tests. Substring matches are the common
// path; fuzzy subsequence matching retains the app-wide Combobox behavior.
export function outcomeOptionMatches(
  option: OutcomeOption,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [option.label, ...option.searchTerms].some(
    (term) => term.toLowerCase().includes(q) || fuzzyScore(term, query) !== null
  );
}

export function rankProtocolOutcomeOptions(
  options: readonly OutcomeOption[],
  relevantPanels: ReadonlySet<PanelId>
): OutcomeOption[] {
  if (relevantPanels.size === 0) return [...options];
  return options
    .map((option, index) => ({
      option,
      index,
      relevant: option.panel != null && relevantPanels.has(option.panel),
    }))
    .sort(
      (a, b) => Number(b.relevant) - Number(a.relevant) || a.index - b.index
    )
    .map(({ option }) => option);
}

export interface ProtocolOutcomeSignals {
  templateOutcomeKeys?: readonly string[];
  practice?: string | null;
  intakeItemName?: string | null;
}

type PanelRule = readonly [RegExp, readonly PanelId[]];

// Conservative intervention → panel hints. These rank; they never filter. The
// normalized panel taxonomy still decides which analytes belong to each panel.
const INTERVENTION_PANEL_RULES: readonly PanelRule[] = [
  [
    /\b(strength|cardio|sport|exercise|training|run|walk|cycling|swim)\b/i,
    ["fitness", "vital-signs", "body-composition"],
  ],
  [/\b(sun|daylight|light exposure|vitamin d|d3)\b/i, ["vitamins"]],
  [
    /\b(sauna|heat|cold plunge|red light|photobiomodulation)\b/i,
    ["vital-signs", "inflammation"],
  ],
  [
    /\b(meditation|breathwork|breathing|yoga|journaling|wind-down)\b/i,
    ["mental-health", "vital-signs"],
  ],
  [/\b(creatine)\b/i, ["fitness", "kidney", "body-composition"]],
  [/\b(omega|fish oil)\b/i, ["omega-fatty-acids", "lipids", "inflammation"]],
  [/\b(cholesterol|statin)\b/i, ["lipids"]],
  [/\b(glucose|insulin|metformin|berberine)\b/i, ["glycemic"]],
  [/\b(thyroid|levothyroxine)\b/i, ["thyroid"]],
  [/\b(iron|ferritin)\b/i, ["iron", "cbc"]],
  [/\b(magnesium|zinc|selenium|copper)\b/i, ["minerals"]],
];

export function protocolRelevantPanels(
  signals: ProtocolOutcomeSignals
): Set<PanelId> {
  const panels = new Set<PanelId>();
  for (const key of signals.templateOutcomeKeys ?? []) {
    if (!key.startsWith("biomarker:")) continue;
    const name = key.slice("biomarker:".length);
    panels.add(tablePanelId({ name, canonical_name: name }));
  }
  const intervention =
    `${signals.practice ?? ""} ${signals.intakeItemName ?? ""}`.trim();
  for (const [pattern, matches] of INTERVENTION_PANEL_RULES) {
    if (!pattern.test(intervention)) continue;
    for (const panel of matches) panels.add(panel);
  }
  return panels;
}
