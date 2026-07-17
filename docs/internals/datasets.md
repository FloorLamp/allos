# Curated-dataset framework

Status: **partial** · framework + harness + linter shipped; **16 datasets migrated** onto the framework (#860 Track B, waves 1–3): `allergen-cross-reactivity`, `biomarker-descriptions`, `contrast-safety`, `dri`, `drug-interactions`, `food-drug-interactions`, `food-groups`, `icd10-common`, `illness-thresholds`, `medication-descriptions`, `mets`, `nutrient-food-map`, `pgx`, `prn-defaults`, `screenings`, `temperature-red-flags`. Remaining curated datasets migrate one thin PR each; `canonical-biomarkers` is deferred and `symptoms` is a documented non-candidate — issue #860 Track B

Allos bakes ~two dozen curated, human-reviewable reference datasets — MET values, DRIs,
drug interactions, biomarker reference ranges, screening schedules, growth charts, and
more. Historically each shipped its own hand-rolled JSON shape, loader, matcher,
citation convention, and drift test. That is exactly the per-domain drift this
framework removes: one envelope shape, one loader, one matcher layer, one test harness,
and one enforcement linter, so a new dataset is a **thin adoption, not a redesign**.

This page is the framework spec and the migration recipe. The binding one-liner lives in
AGENTS.md's conventions; the teeth live in `lib/__tests__/datasets-framework.test.ts`.

---

## The shape

A framework dataset is an **envelope** (`lib/datasets/types.ts` → `DatasetEnvelope`)
stored as a single JSON file under `lib/datasets/data/`:

```jsonc
{
  "$schema": "allos-dataset/v1", // the marker the linter scans for
  "id": "mets",
  "title": "…",
  "description": "…", // optional
  "citation": [{ "source": "…", "url": "…", "note": "…" }], // ≥1, each with a source
  "identity": { "keys": ["name"] }, // ≥1 entry field that names the subject
  "meta": {/* optional dataset-level config that isn't per-entry */},
  "entries": [{ "name": "Running", "easy": 6, "moderate": 9.8, "hard": 11.8 }],
}
```

- **Entries** are the rows. Each carries every declared **identity key** (a present,
  non-null value) so it can be resolved and cited-to.
- **Citations** are dataset-level and **required** — a curated clinical/fitness value
  with no provenance is precisely what the framework forbids. (Datasets that already
  carry richer per-entry `source` fields keep them as ordinary entry fields; the
  framework only mandates the dataset-level minimum.)
- **`meta`** holds config that conditions lookups but isn't a row — mets uses it for
  its `defaultTier` and per-activity-type fallback tiers.
- **Age/sex/status bands**, when a dataset needs them, live **on the entries** (an
  entry is then one band). The framework deliberately does not privilege a single band
  schema, because the existing datasets band differently — half-open `[min,max)` year
  ranges (canonical-biomarkers), month gates (prn/illness), discrete age rows
  (bp-percentiles/growth-charts). A migration models its bands as entry fields and adds
  a band-aware accessor in its per-dataset module.

## The pieces (`lib/datasets/`)

| File          | Role                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`    | `DatasetEnvelope` / `Citation` / `IdentityDescriptor` / `MatchStrategy` / `DatasetMatcher`, the `DATASET_SCHEMA` marker, `DatasetError`.                                                                                                                                                                                                                                        |
| `loader.ts`   | `loadDataset(raw)` — the ONE validator. Enforces the whole contract and throws `DatasetError` otherwise (missing citation, no identity key, an entry lacking its identity, …).                                                                                                                                                                                                  |
| `matcher.ts`  | `createMatcher(dataset, strategy)` + shipped strategies `nameStrategy` / `slugStrategy` / `fieldStrategy(key)`, plus the multi-value/composite factories `multiValueStrategy` / `pairStrategy` / `compositeStrategy` and the `sortedPairKey` / `compositeKey` / `pairKeysAcross` / `expand` builders (#860 wave 2), plus `rxcuiStrategyStub`. Builds a resolve-or-refuse index. |
| `harness.ts`  | Reusable assertions `citationPresent` / `identityResolves` / `refusalGate` / `runHarness`, returning `{ ok, problems }` so both per-dataset tests and the linter share one definition of "correct".                                                                                                                                                                             |
| `registry.ts` | `DATASETS` — the list of framework-migrated datasets (dataset + primary strategy).                                                                                                                                                                                                                                                                                              |
| `index.ts`    | The public barrel — what a migration imports.                                                                                                                                                                                                                                                                                                                                   |
| `mets.ts`     | The proof dataset's per-dataset module — **the reference to copy** for the next migration.                                                                                                                                                                                                                                                                                      |
| `data/*.json` | The committed envelope JSONs.                                                                                                                                                                                                                                                                                                                                                   |

## The matcher + the refusal gate

A `MatchStrategy` is `{ key, normalize(raw) }`: it canonicalizes both an entry's stored
identity value and an incoming query so they compare equal. `createMatcher` builds a
normalized index once; `match(query)` returns the entry or **null**. That null is the
**refusal gate** — an absent subject yields no result, never a nearest-neighbour guess;
a curated dataset must not fabricate an answer for a subject it doesn't cover.

`name` and `slug` strategies ship today. **Family** (identity-family collapse, the
`biomarkerFamily()` pattern) stays a documented **future seam**: a dataset that resolves
by it supplies its own `MatchStrategy` — the matcher and harness consume it unchanged.
`rxcuiStrategyStub` pins the digit-fold shape. A finite-preimage SQL realization (the
#394 pattern), if a dataset needs one, is that dataset's concern, not the framework's.

### Multi-value + composite identity (#860 wave 2)

Some subjects carry **more than one** identity key. A strategy expresses that with the
optional `normalizeMany(raw): string[]` — the SET of keys a raw value expands to. When
present it is authoritative: `createMatcher` indexes an entry under **every** key, and
`match` resolves a query if **any** of its keys hits. `expand(strategy, raw)` is the one
place that honours it (falling back to `[normalize(raw)]` otherwise), so single- and
multi-value strategies share one path and the refusal gate is unchanged (an expansion
with no non-empty key resolves to null). The reusable pieces:

- **`multiValueStrategy(key, normalizeOne?)`** — one field holds several aliases (drug
  synonyms + brand names, an RxCUI set). Pass a custom `normalizeOne` (e.g. the
  `rxcuiStrategyStub` digit fold) when the members aren't plain names.
- **`sortedPairKey(a, b)` / `pairStrategy(key)`** — an **unordered** pair identity
  (drug-drug interactions are symmetric: `(a,b)` and `(b,a)` are the same rule).
- **`compositeKey(parts)` / `compositeStrategy(key)`** — an **ordered** composite
  (`gene|allele`, `gene|drug` — slot order matters, unlike a pair).
- **`pairKeysAcross(setA, setB)`** — the sorted cross-product of two concept SETS, for
  the drug-drug case where each side is a set of equivalent concepts (RxCUIs + synonyms).

The harness gains **`noKeyCollisions`** (folded into `runHarness`): `identityResolves`
catches a collision on an entry's first-hit key, but a shared alias/pair on a non-first
key can still resolve each entry to itself while silently shadowing the other — this
walks every expanded key and flags any two entries that produce the same one.

## The linter (`lib/__tests__/datasets-framework.test.ts`)

Mirrors the source-scan guard precedents (telegram-chokepoint / profile-scoping /
immediate-tx): the extraction lands **with** its enforcement test. It fails CI when:

- a JSON file under `lib/datasets/data/` isn't a valid envelope (no `$schema` marker,
  no citation, no identity key, an entry missing its identity), OR
- a registered dataset can't pass the harness (citation / identity-resolves / refusal),
  OR
- the `data/` files and the registry drift out of lockstep.

**Honest scope:** the linter enforces the contract **only** for `lib/datasets/data/` and
the registry — today that's the **16 migrated datasets** listed in the Status line above.
It does **not** retroactively scan the not-yet-migrated curated datasets that still live
under `lib/*.json`; each of those keeps its bespoke shape until its own migration PR moves
it under `lib/datasets/data/` and into the registry, at which point the linter starts
covering it.

## Migrating the next dataset (a thin PR)

1. Reshape its `scripts/gen-*.ts` (or hand-authored JSON) to emit a framework envelope
   into `lib/datasets/data/<id>.json` — `id`, `title`, `citation[]` (promote the
   provenance from the old `$comment`/header into a structured citation), `identity.keys`,
   `entries[]`, optional `meta`. Model any age/sex bands as entry fields.
2. Add a per-dataset module `lib/datasets/<id>.ts` — copy `mets.ts`: `loadDataset` the
   JSON, `createMatcher` on the identity strategy (reuse `nameStrategy`/`slugStrategy`/
   `fieldStrategy`, or supply a new strategy for RxCUI/family), export typed accessors.
3. Point the domain consumer at the new module (behavior-identical — pin with the
   dataset's existing tests).
4. Register it in `lib/datasets/registry.ts` and add a `datasets-<id>.test.ts` using the
   harness assertions.

The framework's public API is intentionally small so this stays an adoption, not a
redesign. `mets` (issue #151, migrated in #860 Track B) is the worked example.
