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
// (a) a file under lib/datasets/data/ (the common case) OR (b) an EXTERNAL source
// file registered in EXTERNAL_SOURCE_DATASETS
// below (canonical-biomarkers, whose generator-owned + boot-seeded JSON stays at its
// historical path; see lib/datasets/canonical-biomarkers.ts for why). It DELIBERATELY
// does NOT apply the envelope contract to root-level JSON assets. Instead, the small
// root inventory is classified explicitly in docs/internals/datasets.md and checked
// below, so a new curated dataset cannot evade citations by landing there. Thus:
// dropping a NEW dataset JSON under lib/datasets/data/ without a citation/identity
// fails here; a registered dataset with no data-dir file AND no external-source entry
// fails the lockstep; and an unclassified root JSON file fails the doc guard.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DATA_DIR = path.join(REPO, "lib/datasets/data");
const DATASETS_DOC = path.join(REPO, "docs/internals/datasets.md");

const ROOT_JSON_FILES = [
  "canonical-biomarkers.json",
  "exercise-guides.json",
  "release-notes.json",
  "symptoms.json",
  "zip-centroids.json",
] as const;

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

function documentedDatasetIds(): string[] {
  const doc = fs.readFileSync(DATASETS_DOC, "utf8");
  const section = doc.match(
    /### Registry census \(guarded\)\n\n([\s\S]*?)\n### /
  )?.[1];
  expect(
    section,
    "datasets.md must retain its guarded registry census"
  ).toBeDefined();
  return [...section!.matchAll(/^- `([^`]+)`$/gm)]
    .map((match) => match[1])
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

  it("keeps the documented dataset census in lockstep with the registry", () => {
    const registryIds = DATASETS.map(({ dataset }) => dataset.id).sort();
    const doc = fs.readFileSync(DATASETS_DOC, "utf8");
    expect(documentedDatasetIds()).toEqual(registryIds);
    expect(doc).toContain(`**${registryIds.length} registered datasets**`);
    expect(doc).toContain(`**${dataFiles().length}** use envelope JSON`);
  });

  it("classifies every root-level JSON asset in the framework doc", () => {
    const rootJsonFiles = fs
      .readdirSync(path.join(REPO, "lib"))
      .filter((file) => file.endsWith(".json"))
      .sort();
    expect(rootJsonFiles).toEqual([...ROOT_JSON_FILES].sort());

    const doc = fs.readFileSync(DATASETS_DOC, "utf8");
    for (const file of ROOT_JSON_FILES) {
      expect(doc, `datasets.md must classify lib/${file}`).toContain(
        `\`${file}\``
      );
    }
    expect(doc).toMatch(
      /`exercise-guides\.json` and `symptoms\.json` — documented framework\s+non-candidates/
    );
  });
});
