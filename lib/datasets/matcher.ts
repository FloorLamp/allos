// Curated-dataset framework — the matcher layer (issue #860 Track B).
//
// A matcher turns a loaded dataset + a MatchStrategy into a resolve-or-refuse
// lookup. It builds a normalized index once, then `match(query)` returns the entry or
// null. The REFUSAL GATE is the whole point: an absent subject yields null, never a
// nearest-neighbour guess — a curated clinical/fitness dataset must not fabricate an
// answer for a subject it doesn't cover. Pure — no DB, no network.
//
// Strategies are pluggable so a dataset picks how identity is compared. name + slug
// ship today (they cover mets and the slug-keyed datasets — prn/illness/food-groups).
// RxCUI and family strategies are a DOCUMENTED FUTURE SEAM: a dataset that resolves by
// drug CUI or by an identity-family collapse supplies its own MatchStrategy (its
// `normalize` doing the digit-extraction or family fold); the matcher and harness need
// no change. See rxcuiStrategyStub below for the seam's shape.

import type { DatasetMatcher, LoadedDataset, MatchStrategy } from "./types";

// Case-folding name strategy: trim + lowercase. Covers display-name identity
// (mets activities, canonical-biomarker names, medication descriptions).
export const nameStrategy: MatchStrategy = {
  key: "name",
  normalize(raw) {
    return typeof raw === "string" ? raw.trim().toLowerCase() : "";
  },
};

// Slug strategy: trim + lowercase + collapse any run of non-alphanumerics to a single
// underscore. Covers slug identity (prn-defaults, illness-thresholds, food-groups,
// symptoms) and tolerates a display string ("Fatty Fish" → "fatty_fish").
export const slugStrategy: MatchStrategy = {
  key: "slug",
  normalize(raw) {
    if (typeof raw !== "string") return "";
    return raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  },
};

// A named strategy factory for any single string-keyed field with case-folding, so a
// dataset whose identity field isn't literally "name"/"slug" (e.g. "class", "key")
// reuses the name-fold without redefining it.
export function fieldStrategy(key: string): MatchStrategy {
  return {
    key,
    normalize(raw) {
      return typeof raw === "string" ? raw.trim().toLowerCase() : "";
    },
  };
}

// FUTURE SEAM (not wired to any shipped dataset). An RxCUI is a numeric drug-concept
// code; a dataset resolving by CUI would index the digits and match a query's digits.
// Shown here to pin the seam's shape — the matcher/harness consume it unchanged. The
// finite-preimage SQL realization such a dataset may also need (the #394 pattern) is
// that future dataset's concern, out of scope for the framework.
export function rxcuiStrategyStub(key = "rxcui"): MatchStrategy {
  return {
    key,
    normalize(raw) {
      const s = typeof raw === "number" ? String(raw) : String(raw ?? "");
      const digits = s.replace(/\D+/g, "");
      return digits;
    },
  };
}

// Build a matcher over a loaded dataset with a given strategy. `strategy.key` must be
// one of the dataset's declared identity keys (the loader already guaranteed every
// entry carries it). On a normalized-key COLLISION (two entries fold to the same key)
// the FIRST entry wins and later ones are dropped from the index — deterministic and
// order-stable; a dataset that can't tolerate collisions asserts uniqueness in its own
// test (the harness exposes the raw keys for that).
export function createMatcher<E, M = undefined>(
  dataset: LoadedDataset<E, M>,
  strategy: MatchStrategy
): DatasetMatcher<E> {
  if (!dataset.identity.keys.includes(strategy.key)) {
    throw new Error(
      `matcher strategy key "${strategy.key}" is not one of dataset ` +
        `"${dataset.id}" identity keys [${dataset.identity.keys.join(", ")}]`
    );
  }
  const index = new Map<string, E>();
  for (const entry of dataset.entries) {
    const norm = strategy.normalize(
      (entry as Record<string, unknown>)[strategy.key]
    );
    if (norm === "") continue;
    if (!index.has(norm)) index.set(norm, entry);
  }
  return {
    strategy,
    match(query) {
      const norm = strategy.normalize(query);
      if (norm === "") return null;
      return index.get(norm) ?? null;
    },
    has(query) {
      const norm = strategy.normalize(query);
      return norm !== "" && index.has(norm);
    },
    keys() {
      return [...index.keys()];
    },
  };
}
