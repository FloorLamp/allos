import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATASET_SCHEMA,
  DATASETS,
  loadDataset,
  runHarness,
} from "@/lib/datasets";

// LINTER for the curated-dataset framework (issue #860 Track B) — mirrors the
// source-scan guard precedents (telegram-chokepoint, profile-scoping, immediate-tx):
// a dataset that adopts the framework but omits its contract fails CI.
//
// HONEST SCOPE (read before extending): this guard enforces the framework contract
// ONLY for (a) the JSON files under lib/datasets/data/ and (b) the datasets listed in
// lib/datasets/registry.ts — today the 14 datasets migrated in #860 Track B waves 1–2
// (mets, food-groups, dri, drug-interactions, pgx, contrast-safety, illness-thresholds,
// prn-defaults, medication-descriptions, biomarker-descriptions, icd10-common,
// nutrient-food-map, screenings, temperature-red-flags). It DELIBERATELY does NOT scan
// the remaining not-yet-migrated curated datasets still under lib/*.json (canonical-
// biomarkers is deferred; symptoms is a documented non-candidate): those keep their
// bespoke shape until each is migrated in its own small PR, at which point it moves
// under lib/datasets/data/ and joins the registry, and this guard starts covering it.
// So: dropping a NEW dataset JSON under lib/datasets/data/ without a citation/identity
// fails here; the legacy files elsewhere are out of scope by design.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DATA_DIR = path.join(REPO, "lib/datasets/data");

function dataFiles(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

describe("curated-dataset framework contract", () => {
  it("has at least one framework dataset registered (mets, the proof)", () => {
    const ids = DATASETS.map((d) => d.dataset.id);
    expect(ids).toContain("mets");
  });

  it("every JSON under lib/datasets/data/ is a valid framework envelope", () => {
    const files = dataFiles();
    // The proof migration guarantees the dir is non-empty; if it's ever emptied,
    // that's a regression worth catching too.
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(DATA_DIR, f), "utf8")
      ) as unknown;
      // Must declare the schema marker...
      expect(
        (raw as { $schema?: unknown }).$schema,
        `${f}: missing/incorrect $schema marker`
      ).toBe(DATASET_SCHEMA);
      // ...and satisfy the full envelope contract (throws DatasetError otherwise:
      // missing citation, missing identity keys, an entry lacking its identity).
      expect(() => loadDataset(raw), `${f}: envelope contract`).not.toThrow();
    }
  });

  it("every registered dataset carries a citation, resolves identity, and refuses absent queries", () => {
    for (const { dataset, strategy } of DATASETS) {
      const r = runHarness(dataset, strategy);
      expect(r.problems, `${dataset.id}: ${r.problems.join("; ")}`).toEqual([]);
    }
  });

  it("every registered dataset declares at least one identity key", () => {
    for (const { dataset } of DATASETS) {
      expect(
        dataset.identity.keys.length,
        `${dataset.id}: no identity keys`
      ).toBeGreaterThan(0);
    }
  });

  it("data-dir files and the registry are in lockstep (no orphan on either side)", () => {
    // Bind the two source-of-truth lists so a dataset can't be dropped in data/ but
    // forgotten in the registry (or vice versa) — the #201/#212 footprint discipline.
    const fileIds = dataFiles()
      .map((f) => {
        const raw = JSON.parse(
          fs.readFileSync(path.join(DATA_DIR, f), "utf8")
        ) as { id?: string };
        return raw.id;
      })
      .filter((id): id is string => typeof id === "string")
      .sort();
    const registryIds = DATASETS.map((d) => d.dataset.id).sort();
    expect(registryIds).toEqual(fileIds);
  });
});
