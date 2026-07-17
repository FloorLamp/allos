import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPgxDataset,
  normalizeTerm,
  collapseMarker,
} from "@/scripts/gen-pgx";
import dataset from "@/lib/datasets/data/pgx.json";
import { pgxDataset, pgxGuidanceStrategy } from "@/lib/datasets/pgx";
import { runHarness, compositeKey } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked PGx dataset (issue #710, migrated
// onto the curated-dataset framework in #860 wave 2): the committed
// lib/datasets/data/pgx.json must be a FIXED POINT of the generator, drug keys unique,
// every guidance row referencing a real drug + setting EXACTLY ONE of phenotype/marker,
// legal severity/phenotype, alleles unique per gene, everything sorted, and the
// envelope must pass the framework harness (citation / gene|drug|status composite
// identity / refusal / no-collisions). Pure — reads the generator constants + the
// committed JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/pgx.json");

const SEVERITIES = new Set(["contraindicated", "high", "moderate"]);
const PHENOTYPES = new Set([
  "poor",
  "intermediate",
  "normal",
  "rapid",
  "ultrarapid",
]);
const FUNCTIONS = new Set(["none", "decreased", "normal", "increased"]);

describe("pgx.json dataset", () => {
  it("is a fixed point of buildPgxDataset() (regenerate with `npm run gen:pgx`)", () => {
    const generated = JSON.stringify(buildPgxDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / composite identity / refusal / no collisions)", () => {
    const r = runHarness(pgxDataset, pgxGuidanceStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("keys every guidance row on the ordered [gene, drug, status] composite", () => {
    for (const g of dataset.entries) {
      expect(
        Array.isArray(g.combo) && g.combo.length === 3,
        g.combo.join()
      ).toBe(true);
      const status = g.phenotype ?? `marker:${(g.marker ?? []).join("+")}`;
      expect(g.combo).toEqual([g.gene, g.drug, status]);
      // The composite is order-sensitive and resolves the entry.
      expect(pgxGuidanceStrategy.normalizeMany!(g.combo)).toEqual([
        compositeKey(g.combo),
      ]);
    }
  });

  it("carries a curated set of drugs, alleles (meta), and guidance rows (entries)", () => {
    expect(dataset.meta.drugs.length).toBeGreaterThan(10);
    expect(dataset.meta.alleles.length).toBeGreaterThan(20);
    expect(dataset.entries.length).toBeGreaterThan(20);
  });

  it("gives every drug a unique key, a label, and something to match on", () => {
    const keys = new Set<string>();
    for (const d of dataset.meta.drugs) {
      expect(keys.has(d.key), `duplicate ${d.key}`).toBe(false);
      keys.add(d.key);
      expect(d.label.trim().length, d.key).toBeGreaterThan(0);
      expect(d.rxcuis.length + d.synonyms.length, d.key).toBeGreaterThan(0);
    }
  });

  it("keeps drug synonyms normalized + distinct, rxcuis distinct", () => {
    for (const d of dataset.meta.drugs) {
      for (const s of d.synonyms) expect(s, d.key).toBe(normalizeTerm(s));
      expect(new Set(d.synonyms).size, d.key).toBe(d.synonyms.length);
      expect(new Set(d.rxcuis).size, d.key).toBe(d.rxcuis.length);
    }
  });

  it("gives every allele a legal function and is unique per (gene, allele)", () => {
    const seen = new Set<string>();
    for (const a of dataset.meta.alleles) {
      const key = `${a.gene}|${a.allele}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
      expect(FUNCTIONS.has(a.function), a.function).toBe(true);
    }
  });

  it("references only real drugs, sets exactly one of phenotype/marker, legal severity", () => {
    const drugKeys = new Set(dataset.meta.drugs.map((d) => d.key));
    for (const g of dataset.entries) {
      expect(drugKeys.has(g.drug), g.drug).toBe(true);
      const hasPheno = g.phenotype != null;
      const hasMarker = Array.isArray(g.marker) && g.marker.length > 0;
      expect(hasPheno !== hasMarker, `${g.gene}/${g.drug}`).toBe(true);
      if (hasPheno)
        expect(PHENOTYPES.has(g.phenotype!), g.phenotype).toBe(true);
      if (hasMarker)
        for (const m of g.marker!)
          expect(m, `${g.gene}`).toBe(collapseMarker(m));
      expect(SEVERITIES.has(g.severity), g.severity).toBe(true);
      expect(g.guidance.trim().length).toBeGreaterThan(0);
      expect(g.source.trim().length).toBeGreaterThan(0);
    }
  });

  it("cites CPIC (or FDA) on every guidance row (the source discipline)", () => {
    for (const g of dataset.entries) {
      expect(
        /CPIC|FDA/.test(g.source),
        `${g.gene}/${g.drug}: ${g.source}`
      ).toBe(true);
    }
  });

  it("covers the issue's flagship high-value gene–drug pairs", () => {
    const has = (gene: string, drug: string) =>
      dataset.entries.some((g) => g.gene === gene && g.drug === drug);
    expect(has("CYP2C19", "clopidogrel")).toBe(true);
    expect(has("CYP2D6", "codeine")).toBe(true);
    expect(has("TPMT", "thiopurine")).toBe(true);
    expect(has("NUDT15", "thiopurine")).toBe(true);
    expect(has("DPYD", "fluoropyrimidine")).toBe(true);
    expect(has("SLCO1B1", "simvastatin")).toBe(true);
    expect(has("CYP2C9", "warfarin")).toBe(true);
    expect(has("HLA-B", "abacavir")).toBe(true);
    expect(has("HLA-B", "carbamazepine")).toBe(true);
    expect(has("CYP2C9", "phenytoin")).toBe(true);
  });

  it("is emitted sorted for a stable diff", () => {
    const drugKeys = dataset.meta.drugs.map((d) => d.key);
    expect(drugKeys).toEqual([...drugKeys].sort());
  });
});
