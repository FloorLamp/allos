// Shared biomarker relevance rank (#1675). Pure tenant of rank-core: the query
// boundary supplies bucketed facts, while this module owns stable base order,
// boosts, and the three picker groups. No item is filtered.

import { normalizeCanonicalKey } from "./canonical-name";
import { CURATED_LABS } from "./curated-biomarkers";
import { defineRankTable, itemsFromLayout, rankItems } from "./rank-core";

export type BiomarkerPickerGroup =
  "due-relevant" | "your-markers" | "all-biomarkers";

export interface BiomarkerRankFacts {
  due: ReadonlySet<string>;
  dueSoon: ReadonlySet<string>;
  flagged: ReadonlySet<string>;
  measured: ReadonlySet<string>;
  starred: ReadonlySet<string>;
  pillar: ReadonlySet<string>;
}

export interface RankedBiomarker {
  name: string;
  group: BiomarkerPickerGroup;
}

export function biomarkerRankKey(name: string): string {
  return normalizeCanonicalKey(name);
}

export function emptyBiomarkerRankFacts(): BiomarkerRankFacts {
  return {
    due: new Set(),
    dueSoon: new Set(),
    flagged: new Set(),
    measured: new Set(),
    starred: new Set(),
    pillar: new Set(),
  };
}

const BIOMARKER_RANK = defineRankTable<string, BiomarkerRankFacts>({
  tenant: "biomarker-picker",
  signals: [
    {
      key: "retest-due",
      boost: (item, facts) => (facts.due.has(item.id) ? 6_000 : 0),
    },
    {
      key: "latest-flagged",
      boost: (item, facts) => (facts.flagged.has(item.id) ? 5_000 : 0),
    },
    {
      key: "retest-due-soon",
      boost: (item, facts) => (facts.dueSoon.has(item.id) ? 4_000 : 0),
    },
    {
      key: "starred",
      boost: (item, facts) => (facts.starred.has(item.id) ? 600 : 0),
    },
    {
      key: "measured-before",
      boost: (item, facts) => (facts.measured.has(item.id) ? 400 : 0),
    },
    {
      key: "pillar-input",
      boost: (item, facts) => (facts.pillar.has(item.id) ? 200 : 0),
    },
  ],
});

function baseLayout(names: readonly string[]): string[] {
  const displayByKey = new Map<string, string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = biomarkerRankKey(trimmed);
    if (!displayByKey.has(key)) displayByKey.set(key, trimmed);
  }

  const ordered: string[] = [];
  for (const lab of CURATED_LABS) {
    const key = biomarkerRankKey(lab.name);
    if (displayByKey.has(key)) {
      ordered.push(key);
      displayByKey.delete(key);
    }
  }
  ordered.push(
    ...[...displayByKey.entries()]
      .sort((a, b) =>
        a[1].localeCompare(b[1], undefined, { sensitivity: "base" })
      )
      .map(([key]) => key)
  );
  return ordered;
}

function groupFor(id: string, facts: BiomarkerRankFacts): BiomarkerPickerGroup {
  if (facts.due.has(id) || facts.dueSoon.has(id) || facts.flagged.has(id)) {
    return "due-relevant";
  }
  if (facts.measured.has(id) || facts.starred.has(id)) return "your-markers";
  return "all-biomarkers";
}

export function rankBiomarkers(
  names: readonly string[],
  facts: BiomarkerRankFacts
): RankedBiomarker[] {
  const displayByKey = new Map<string, string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed && !displayByKey.has(biomarkerRankKey(trimmed))) {
      displayByKey.set(biomarkerRankKey(trimmed), trimmed);
    }
  }
  const ranked = rankItems(
    itemsFromLayout(baseLayout(names)),
    BIOMARKER_RANK,
    facts
  ).map((item) => ({
    name: displayByKey.get(item.id) ?? item.id,
    group: groupFor(item.id, facts),
  }));

  const groups: BiomarkerPickerGroup[] = [
    "due-relevant",
    "your-markers",
    "all-biomarkers",
  ];
  return groups.flatMap((group) =>
    ranked.filter((item) => item.group === group)
  );
}
