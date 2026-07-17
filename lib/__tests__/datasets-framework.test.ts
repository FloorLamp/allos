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
// for the datasets listed in lib/datasets/registry.ts, whose committed JSON is EITHER
// (a) a file under lib/datasets/data/ (the common case — the 20 migrated in #860 Track
// B waves 1–3) OR (b) an EXTERNAL source file registered in EXTERNAL_SOURCE_DATASETS
// below (canonical-biomarkers, whose generator-owned + boot-seeded JSON stays at its
// historical path; see lib/datasets/canonical-biomarkers.ts for why). It DELIBERATELY
// does NOT scan the remaining not-yet-migrated curated datasets still under lib/*.json
// (symptoms/exercise-guides are documented non-candidates): those keep their bespoke
// shape until each is migrated in its own small PR. So: dropping a NEW dataset JSON
// under lib/datasets/data/ without a citation/identity fails here; a registered dataset
// with no data-dir file AND no external-source entry fails the lockstep; the legacy
// files elsewhere are out of scope by design.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DATA_DIR = path.join(REPO, "lib/datasets/data");

// Registered datasets whose committed JSON does NOT live under lib/datasets/data/ but
// at an external, generator-owned path. Each is wrapped into the framework envelope by
// its read-layer module (which runs loadDataset at import, so the registry harness
// below fully covers it) — the file itself is not an on-disk envelope, so it is scoped
// OUT of the "every JSON under data/ is a valid envelope" check and INTO the lockstep
// via this map. Keep it tiny and justified: the framework's default is a data-dir file.
//   canonical-biomarkers — seeded into the canonical_biomarkers table on boot and read
//   by eight other modules directly; its human-curated order isn't a generator fixed
//   point, so it stays at lib/canonical-biomarkers.json. (#860 Track B)
const EXTERNAL_SOURCE_DATASETS: Record<string, string> = {
  "canonical-biomarkers": "lib/canonical-biomarkers.json",
};

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

  it("every external-source dataset file exists and is registered", () => {
    // The escape hatch has teeth: a mistyped external path (or an entry left in the map
    // after the dataset moved under data/) fails here, and every external id must be in
    // the registry (its harness coverage above is what actually validates the envelope).
    const registryIds = new Set(DATASETS.map((d) => d.dataset.id));
    for (const [id, rel] of Object.entries(EXTERNAL_SOURCE_DATASETS)) {
      expect(
        fs.existsSync(path.join(REPO, rel)),
        `${id}: external source ${rel} does not exist`
      ).toBe(true);
      // It must NOT also live under data/ (that would be two sources of truth).
      expect(
        fs.existsSync(path.join(DATA_DIR, `${id}.json`)),
        `${id}: registered as external but also present under lib/datasets/data/`
      ).toBe(false);
      expect(registryIds.has(id), `${id}: external but not registered`).toBe(
        true
      );
    }
  });

  it("data-dir files + external sources and the registry are in lockstep (no orphan on either side)", () => {
    // Bind the source-of-truth lists so a dataset can't be dropped in data/ (or the
    // external map) but forgotten in the registry, or vice versa — the #201/#212
    // footprint discipline, widened to cover the external-source escape hatch.
    const fileIds = dataFiles()
      .map((f) => {
        const raw = JSON.parse(
          fs.readFileSync(path.join(DATA_DIR, f), "utf8")
        ) as { id?: string };
        return raw.id;
      })
      .filter((id): id is string => typeof id === "string");
    const expectedIds = [
      ...fileIds,
      ...Object.keys(EXTERNAL_SOURCE_DATASETS),
    ].sort();
    const registryIds = DATASETS.map((d) => d.dataset.id).sort();
    expect(registryIds).toEqual(expectedIds);
  });
});
