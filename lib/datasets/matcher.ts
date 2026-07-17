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
//
// MULTI-VALUE + COMPOSITE (issue #860 wave 2). Some datasets identify an entry by MORE
// than one key: a medication carries synonyms + brand aliases, a drug-drug interaction
// is keyed by an unordered PAIR of concepts, a PGx rule by a `gene|allele` composite.
// A strategy expresses this with the optional `normalizeMany(raw): string[]` (the SET
// of keys a raw value expands to). The matcher indexes an entry under every key it
// yields and resolves a query if ANY of the query's keys hits. `expand()` is the one
// place that honours it (falling back to `[normalize(raw)]` for single-key strategies),
// and `multiValueStrategy` / `pairStrategy` / `compositeStrategy` + the `sortedPairKey`
// / `compositeKey` / `pairKeysAcross` key builders below are the reusable pieces the
// drug/PGx/medication datasets adopt. All pure.

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

// Expand a raw value to the SET of non-empty normalized keys it indexes/resolves under.
// The ONE place a strategy's optional `normalizeMany` is honoured: with it, its keys
// (empties filtered); without it, the single `[normalize(raw)]` (empty filtered). Every
// matcher/harness path goes through here so single- and multi-value strategies share
// one code path. Pure.
export function expand(strategy: MatchStrategy, raw: unknown): string[] {
  if (strategy.normalizeMany) {
    return strategy.normalizeMany(raw).filter((k) => k !== "");
  }
  const norm = strategy.normalize(raw);
  return norm === "" ? [] : [norm];
}

// Build a matcher over a loaded dataset with a given strategy. `strategy.key` must be
// one of the dataset's declared identity keys (the loader already guaranteed every
// entry carries it). Each entry is indexed under EVERY key `expand()` yields for its
// identity value (one key for a single-value strategy, several for a multi-value one).
// On a normalized-key COLLISION (two entries yield the same key) the FIRST entry wins
// and the later one is dropped for that key — deterministic and order-stable; a dataset
// that can't tolerate collisions asserts uniqueness in its own test (the harness's
// `noKeyCollisions` does exactly that).
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
    for (const norm of expand(
      strategy,
      (entry as Record<string, unknown>)[strategy.key]
    )) {
      if (!index.has(norm)) index.set(norm, entry);
    }
  }
  return {
    strategy,
    match(query) {
      for (const norm of expand(strategy, query)) {
        const hit = index.get(norm);
        if (hit !== undefined) return hit;
      }
      return null;
    },
    has(query) {
      for (const norm of expand(strategy, query)) {
        if (index.has(norm)) return true;
      }
      return false;
    },
    keys() {
      return [...index.keys()];
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-value + composite key builders and strategy factories (issue #860 wave 2).
// ---------------------------------------------------------------------------

// The default per-element fold: trim + lowercase (the nameStrategy fold). Datasets pass
// their own (e.g. the rxcui digit-extract) when the members aren't plain names.
const foldName = nameStrategy.normalize;

// A multi-value strategy: one entry field holds SEVERAL identity values — an array
// (synonyms, brand names, an RxCUI set) or a scalar (indexed as one). `normalizeMany`
// folds each element with `normalizeOne` (default: name-fold), dropping empties and
// de-duplicating. One entry is then found under any of its aliases; an alias no entry
// carries still refuses (null). `normalizeOne` lets a CUI-set strategy pass the digit
// extractor, a synonym strategy the name fold.
export function multiValueStrategy(
  key: string,
  normalizeOne: (raw: unknown) => string = foldName
): MatchStrategy {
  const many = (raw: unknown): string[] => {
    const values = Array.isArray(raw) ? raw : [raw];
    const out: string[] = [];
    for (const v of values) {
      const n = normalizeOne(v);
      if (n !== "" && !out.includes(n)) out.push(n);
    }
    return out;
  };
  return {
    key,
    normalize: (raw) => many(raw)[0] ?? "",
    normalizeMany: many,
  };
}

// An ORDERED composite key: fold each part and join with "|" in the GIVEN order (slot
// order matters — `gene|allele`, `gene|drug`). Any part that folds to "" makes the
// whole key "" (refuse — a composite is only valid with all parts present). Pure.
export function compositeKey(
  parts: unknown[],
  normalizeOne: (raw: unknown) => string = foldName
): string {
  const norm = parts.map((p) => normalizeOne(p));
  if (norm.some((n) => n === "")) return "";
  return norm.join("|");
}

// An UNORDERED pair key: fold both members and join the two SORTED, so `(a,b)` and
// `(b,a)` produce the same key (drug-drug interactions are symmetric). Either member
// folding to "" makes the key "" (refuse). Pure.
export function sortedPairKey(
  a: unknown,
  b: unknown,
  normalizeOne: (raw: unknown) => string = foldName
): string {
  const na = normalizeOne(a);
  const nb = normalizeOne(b);
  if (na === "" || nb === "") return "";
  return [na, nb].sort().join("|");
}

// The CROSS-PRODUCT of two concept SETS as sorted pair keys — the drug-drug case where
// each side is a set of equivalent concepts (an ingredient's RxCUI set + synonyms). All
// sorted pairs across the two sets, de-duplicated, empties dropped. A query drug's
// concept set matches the rule if any of its cross keys hits. Pure.
export function pairKeysAcross(
  setA: unknown[],
  setB: unknown[],
  normalizeOne: (raw: unknown) => string = foldName
): string[] {
  const out: string[] = [];
  for (const a of setA) {
    for (const b of setB) {
      const k = sortedPairKey(a, b, normalizeOne);
      if (k !== "" && !out.includes(k)) out.push(k);
    }
  }
  return out;
}

// A strategy whose entry field is a 2-element `[a, b]` array identified by an unordered
// sorted pair key. A query is likewise a 2-element array (either order). Non-pair /
// short arrays refuse (empty expansion). For SET-vs-SET pairs use a custom strategy
// over `pairKeysAcross`; this covers the scalar-member case.
export function pairStrategy(
  key: string,
  normalizeOne: (raw: unknown) => string = foldName
): MatchStrategy {
  const many = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.length < 2) return [];
    const k = sortedPairKey(raw[0], raw[1], normalizeOne);
    return k === "" ? [] : [k];
  };
  return {
    key,
    normalize: (raw) => many(raw)[0] ?? "",
    normalizeMany: many,
  };
}

// A strategy whose entry field is an ORDERED N-element array identified by one composite
// key (`gene|allele`, `gene|drug`). A query is the same ordered array. Empty arrays or a
// part that folds to "" refuse. Slot order is preserved (NOT sorted — unlike pairs).
export function compositeStrategy(
  key: string,
  normalizeOne: (raw: unknown) => string = foldName
): MatchStrategy {
  const many = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const k = compositeKey(raw, normalizeOne);
    return k === "" ? [] : [k];
  };
  return {
    key,
    normalize: (raw) => many(raw)[0] ?? "",
    normalizeMany: many,
  };
}
