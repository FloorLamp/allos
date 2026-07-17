import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDrugInteractionsDataset,
  normalizeTerm,
} from "@/scripts/gen-drug-interactions";
import dataset from "@/lib/datasets/data/drug-interactions.json";
import {
  drugInteractionsDataset,
  drugInteractionPairStrategy,
} from "@/lib/datasets/drug-interactions";
import { runHarness, sortedPairKey } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked drug-interaction dataset (issue
// #144, migrated onto the curated-dataset framework in #860 wave 2): the committed
// lib/datasets/data/drug-interactions.json must be a FIXED POINT of the generator,
// concept keys unique, every interaction reference valid + non-self + non-duplicate,
// severities legal, pairs stored in canonical (sorted) order, and the envelope must
// pass the framework harness (citation / identity-resolves / refusal / no-collisions).
// Pure — reads the generator constants + the committed JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/drug-interactions.json");

const SEVERITIES = new Set(["major", "moderate", "minor"]);

describe("drug-interactions.json dataset", () => {
  it("is a fixed point of buildDrugInteractionsDataset() (regenerate with `npm run gen:interactions`)", () => {
    const generated =
      JSON.stringify(buildDrugInteractionsDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity pair / refusal / no collisions)", () => {
    const r = runHarness(drugInteractionsDataset, drugInteractionPairStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("resolves a rule by its unordered pair in either order (sorted-pair identity)", () => {
    const matcher = drugInteractionPairStrategy;
    // The framework pair identity is order-independent.
    expect(sortedPairKey("warfarin", "aspirin")).toBe(
      sortedPairKey("aspirin", "warfarin")
    );
    // Every entry carries a 2-element `pair`.
    for (const e of dataset.entries) {
      expect(Array.isArray(e.pair) && e.pair.length === 2, e.pair.join()).toBe(
        true
      );
      expect(matcher.normalizeMany!(e.pair).length).toBe(1);
    }
  });

  it("carries a curated set of concepts (meta) and interactions (entries)", () => {
    expect(dataset.meta.concepts.length).toBeGreaterThan(20);
    expect(dataset.entries.length).toBeGreaterThan(20);
  });

  it("gives every concept a unique key, a label, and something to match on", () => {
    const keys = new Set<string>();
    for (const c of dataset.meta.concepts) {
      expect(keys.has(c.key), `duplicate ${c.key}`).toBe(false);
      keys.add(c.key);
      expect(c.label.trim().length, c.key).toBeGreaterThan(0);
      expect(c.rxcuis.length + c.synonyms.length, c.key).toBeGreaterThan(0);
    }
  });

  it("keeps synonyms normalized (lowercased, punctuation collapsed) + distinct", () => {
    for (const c of dataset.meta.concepts) {
      for (const s of c.synonyms) {
        expect(s, c.key).toBe(normalizeTerm(s));
      }
      expect(new Set(c.synonyms).size, c.key).toBe(c.synonyms.length);
      expect(new Set(c.rxcuis).size, c.key).toBe(c.rxcuis.length);
    }
  });

  it("references only existing concepts, never self, never a duplicate pair, canonical order", () => {
    const keys = new Set(dataset.meta.concepts.map((c) => c.key));
    const pairs = new Set<string>();
    for (const it of dataset.entries) {
      expect(keys.has(it.a), it.a).toBe(true);
      expect(keys.has(it.b), it.b).toBe(true);
      expect(it.a, `self ${it.a}`).not.toBe(it.b);
      // Stored in sorted order for a stable diff + single-direction matching.
      expect([it.a, it.b]).toEqual([it.a, it.b].slice().sort());
      expect(it.pair).toEqual([it.a, it.b]);
      const pair = `${it.a}|${it.b}`;
      expect(pairs.has(pair), `duplicate ${pair}`).toBe(false);
      pairs.add(pair);
      expect(SEVERITIES.has(it.severity), it.severity).toBe(true);
      expect(it.mechanism.trim().length).toBeGreaterThan(0);
      expect(it.source.trim().length).toBeGreaterThan(0);
    }
  });

  it("is emitted sorted for a stable diff", () => {
    const conceptKeys = dataset.meta.concepts.map((c) => c.key);
    expect(conceptKeys).toEqual([...conceptKeys].sort());
    const pairKeys = dataset.entries.map((i) => `${i.a}|${i.b}`);
    expect(pairKeys).toEqual([...pairKeys].sort());
  });
});
