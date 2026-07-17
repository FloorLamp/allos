// Curated-dataset framework — shared types (issue #860 Track B).
//
// Allos bakes ~two dozen curated, human-reviewable reference datasets (MET values,
// DRIs, drug interactions, biomarker ranges, …). Historically each shipped its own
// hand-rolled JSON shape, loader, matcher, and drift test. This framework gives them
// ONE shape so a new dataset is a thin adoption, not a redesign:
//
//   a dataset = an ENVELOPE { id, citation(s), identity keys, entries[] (+ optional
//   meta) } → a LOADED dataset (validated) → a MATCHER (pluggable strategy) that
//   RESOLVES a query to an entry or REFUSES (returns null — never a guess).
//
// Everything here is PURE (no DB, no network). The framework only needs to REPRESENT
// the existing datasets' patterns; datasets migrate onto it one small PR at a time
// (mets is the first — see ./data/mets.json). Un-migrated legacy datasets under
// lib/*.json keep their bespoke shape until their turn.

// The on-disk marker every framework-wrapped dataset JSON carries in its `$schema`
// field. The linter (lib/__tests__/datasets-framework.test.ts) requires it on every
// file under lib/datasets/data/, which is how a NEW dataset dropped there without
// citation/identity fails CI.
export const DATASET_SCHEMA = "allos-dataset/v1";

// A source attribution for a dataset. At least one is REQUIRED per dataset — a
// curated clinical/fitness value with no provenance is exactly what this framework
// exists to forbid. `source` is the human-readable citation (a compendium, a
// guideline body, a peer-reviewed table); `url` and `note` are optional.
export interface Citation {
  source: string;
  url?: string;
  note?: string;
}

// The identity descriptor: which entry field(s) name the subject, so a matcher can
// resolve a query to an entry. `keys` lists the entry property names that carry
// identity (e.g. ["name"], ["slug"], ["rxcui"]). At least one key is required.
export interface IdentityDescriptor {
  keys: string[];
}

// The canonical on-disk / in-memory dataset shape. `E` is the per-entry type; `M`
// is optional dataset-level metadata that is NOT per-entry (mets uses it for its
// defaultTier + per-type fallback tiers — data that conditions lookups but isn't an
// entry). Age/sex bands, when a dataset needs them, live on the ENTRIES (an entry is
// then one band); the framework does not privilege a fixed band schema so different
// datasets can band differently.
export interface DatasetEnvelope<E, M = undefined> {
  $schema: typeof DATASET_SCHEMA;
  id: string;
  title: string;
  description?: string;
  citation: Citation[];
  identity: IdentityDescriptor;
  meta?: M;
  entries: E[];
}

// A validated, loaded dataset. Identical fields to the envelope but guaranteed by
// loadDataset() to satisfy the contract (schema marker, ≥1 citation with a source,
// ≥1 identity key, every entry carrying every identity key). Consumers read
// `.entries` / `.meta` and build a matcher over it.
export type LoadedDataset<E, M = undefined> = DatasetEnvelope<E, M>;

// Thrown by loadDataset() when an envelope violates the contract. A distinct class
// so the harness/linter can assert on it precisely.
export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetError";
  }
}

// A pluggable identity-resolution strategy. `key` is the entry field it reads;
// `normalize` canonicalizes BOTH an entry's stored key value and an incoming query
// so they compare equal (case-folding for names, slugifying, digit-only for an
// RxCUI, …). A strategy returning "" for a value means "not indexable by this
// strategy" and the matcher skips it. Name + slug ship today.
//
// MULTI-VALUE (issue #860 wave 2): a single entry can index under SEVERAL keys — a
// drug's synonyms + brand aliases, an RxCUI set, a sorted drug-drug PAIR, a
// `gene|allele` composite. A strategy expresses that by implementing the optional
// `normalizeMany(raw): string[]` — the SET of normalized keys a raw value expands to
// (an array field, a delimited scalar, a composite pair). When present it is
// authoritative: the matcher indexes an entry under EVERY key it yields and resolves a
// query if ANY of the query's expanded keys hits. `normalize` stays required (the
// single-key fallback, and what a `normalizeMany`-less strategy uses). The REFUSAL
// GATE is unchanged — an expansion that yields no non-empty key resolves to null,
// never a guess. See `multiValueStrategy` / `pairStrategy` / `compositeStrategy` and
// the `sortedPairKey` / `compositeKey` / `pairKeysAcross` key builders in matcher.ts.
export interface MatchStrategy {
  key: string;
  normalize(raw: unknown): string;
  normalizeMany?(raw: unknown): string[];
}

// The resolved-or-refused lookup surface built over a loaded dataset. `match`
// returns the entry or null (the REFUSAL GATE — an absent subject yields no result,
// never a nearest-guess); `has` is the boolean form; `keys` exposes the indexed
// normalized keys (used by the harness to assert every entry self-resolves).
export interface DatasetMatcher<E> {
  strategy: MatchStrategy;
  match(query: unknown): E | null;
  has(query: unknown): boolean;
  keys(): string[];
}
