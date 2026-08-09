# Curated-dataset framework

Status: **partial** · framework + harness + linter shipped; **21 datasets
migrated** onto the framework (#860 Track B, waves 1–3 + the deferred
canonical-biomarkers): `allergen-cross-reactivity`, `biomarker-descriptions`,
`bp-percentiles`, `canonical-biomarkers`, `contrast-safety`, `dri`,
`drug-interactions`, `fitness-norms`, `food-drug-interactions`, `food-groups`,
`growth-charts`, `icd10-common`, `illness-thresholds`,
`medication-descriptions`, `mets`, `nutrient-food-map`, `pgx`, `prn-defaults`,
`screenings`, `strength-standards`, `temperature-red-flags`.
`canonical-biomarkers` is the one **external-source** dataset (below);
`symptoms` and `exercise-guides` are documented non-candidates (no honest
external provenance). Curated-dataset migration is effectively complete — issue
\#860 Track B

Allos bakes ~two dozen curated, human-reviewable reference datasets — MET
values, DRIs, drug interactions, biomarker reference ranges, screening
schedules, growth charts, and more. Historically each shipped its own
hand-rolled JSON shape, loader, matcher, citation convention, and drift test.
That is exactly the per-domain drift this framework removes: one envelope shape,
one loader, one matcher layer, one test harness, and one enforcement linter, so
a new dataset is a **thin adoption, not a redesign**.

This page is the framework spec and the migration recipe. The binding one-liner
lives in AGENTS.md's conventions; the teeth live in
`lib/__tests__/datasets-framework.test.ts`.

---

## The shape

A framework dataset is an **envelope** (`lib/datasets/types.ts` →
`DatasetEnvelope`) stored as a single JSON file under `lib/datasets/data/`:

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

- **Entries** are the rows. Each carries every declared **identity key** (a
  present, non-null value) so it can be resolved and cited-to.
- **Citations** are dataset-level and **required** — a curated clinical/fitness
  value with no provenance is precisely what the framework forbids. (Datasets
  that already carry richer per-entry `source` fields keep them as ordinary
  entry fields; the framework only mandates the dataset-level minimum.)
- **`meta`** holds config that conditions lookups but isn't a row — mets uses it
  for its `defaultTier` and per-activity-type fallback tiers.
- **Age/sex/status bands**, when a dataset needs them, live **on the entries**
  (an entry is then one band). The framework deliberately does not privilege a
  single band schema, because the existing datasets band differently — half-open
  `[min,max)` year ranges (canonical-biomarkers), month gates (prn/illness),
  discrete age rows (bp-percentiles/growth-charts). A migration models its bands
  as entry fields and adds a band-aware accessor in its per-dataset module.

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

A `MatchStrategy` is `{ key, normalize(raw) }`: it canonicalizes both an entry's
stored identity value and an incoming query so they compare equal.
`createMatcher` builds a normalized index once; `match(query)` returns the entry
or **null**. That null is the **refusal gate** — an absent subject yields no
result, never a nearest-neighbour guess; a curated dataset must not fabricate an
answer for a subject it doesn't cover.

`name` and `slug` strategies ship today. **Family** (identity-family collapse,
the `biomarkerFamily()` pattern) stays a documented **future seam**: a dataset
that resolves by it supplies its own `MatchStrategy` — the matcher and harness
consume it unchanged. `rxcuiStrategyStub` pins the digit-fold shape. A
finite-preimage SQL realization (the \#394 pattern), if a dataset needs one, is
that dataset's concern, not the framework's.

### Multi-value + composite identity (#860 wave 2)

Some subjects carry **more than one** identity key. A strategy expresses that
with the optional `normalizeMany(raw): string[]` — the SET of keys a raw value
expands to. When present it is authoritative: `createMatcher` indexes an entry
under **every** key, and `match` resolves a query if **any** of its keys hits.
`expand(strategy, raw)` is the one place that honours it (falling back to
`[normalize(raw)]` otherwise), so single- and multi-value strategies share one
path and the refusal gate is unchanged (an expansion with no non-empty key
resolves to null). The reusable pieces:

- **`multiValueStrategy(key, normalizeOne?)`** — one field holds several aliases
  (drug synonyms + brand names, an RxCUI set). Pass a custom `normalizeOne`
  (e.g. the `rxcuiStrategyStub` digit fold) when the members aren't plain names.
- **`sortedPairKey(a, b)` / `pairStrategy(key)`** — an **unordered** pair
  identity (drug-drug interactions are symmetric: `(a,b)` and `(b,a)` are the
  same rule).
- **`compositeKey(parts)` / `compositeStrategy(key)`** — an **ordered**
  composite (`gene|allele`, `gene|drug` — slot order matters, unlike a pair).
- **`pairKeysAcross(setA, setB)`** — the sorted cross-product of two concept
  SETS, for the drug-drug case where each side is a set of equivalent concepts
  (RxCUIs + synonyms).

The harness gains **`noKeyCollisions`** (folded into `runHarness`):
`identityResolves` catches a collision on an entry's first-hit key, but a shared
alias/pair on a non-first key can still resolve each entry to itself while
silently shadowing the other — this walks every expanded key and flags any two
entries that produce the same one.

## The linter (`lib/__tests__/datasets-framework.test.ts`)

Mirrors the source-scan guard precedents (telegram-chokepoint / profile-scoping
/ immediate-tx): the extraction lands **with** its enforcement test. It fails CI
when:

- a JSON file under `lib/datasets/data/` isn't a valid envelope (no `$schema`
  marker, no citation, no identity key, an entry missing its identity), OR
- a registered dataset can't pass the harness (citation / identity-resolves /
  refusal), OR
- the `data/` files and the registry drift out of lockstep.

**Honest scope:** the linter enforces the contract **only** for the registry and
its sources — the JSON files under `lib/datasets/data/` **plus** the one
external-source entry (below). It does **not** retroactively scan the two
documented non-candidates (`symptoms`, `exercise-guides`) that still live under
`lib/*.json` with no honest external provenance.

## External-source datasets (the canonical-biomarkers exception)

The framework's default is one envelope JSON per dataset under
`lib/datasets/data/`. One dataset — **`canonical-biomarkers`** — is registered
but keeps its committed JSON at its historical path
`lib/canonical-biomarkers.json`, because it is unlike the read-only datasets in
two structural ways:

- **Boot-seeded.** Its ranges are UPSERTed into the `canonical_biomarkers`
  SQLite table on every boot (`seedCanonicalBiomarkers`) and drive a flag
  reconcile gated by `canonicalFlagsSignature()`
  (`lib/canonical-flags-version.ts`). The committed file is the shared source
  for both the boot seed and the framework read layer, so they can never
  diverge.
- **Generator-owned, human-curated order.**
  `scripts/gen-canonical-biomarkers.ts` writes it (an Anthropic call per
  category) and it is then hand-curated into a reviewed grouping — its order is
  **not** a deterministic name sort, so the "regenerate → byte-compare" fixed
  point the other datasets use does not hold offline. Eight modules + the boot
  seed import the file directly; moving/reshaping it would churn the boot path
  for no behavioral gain.

So it adopts the framework as a pure **read layer**:
`lib/datasets/canonical-biomarkers.ts` imports the byte-identical committed
JSON, wraps it in the envelope **in memory** (adding the required citations +
`identity.keys`, entries = the file's `biomarkers`), validates it with
`loadDataset()`, and exposes the entries + a name matcher. It is listed in
`EXTERNAL_SOURCE_DATASETS` in the linter, which scopes it OUT of the "every JSON
under `data/` is an envelope" check (the file isn't an on-disk envelope) and
INTO the registry harness + lockstep (so it still must carry a citation, resolve
identity, and refuse absent queries). The behavior-preservation proof — a fresh
boot seeds the SAME rows the read layer exposes, and the flag-version gate still
recomputes on a range change — is the DB-tier
`lib/__db_tests__/canonical-biomarkers-dataset.test.ts`, plus a flag-signature
fixed-point in `lib/__tests__/datasets-canonical-biomarkers.test.ts`. **Identity
(#482):** the dataset's framework identity is the exact canonical `name` (which
curated row); that does not fight `biomarkerFamily()`, which collapses ACROSS
names for dedup/series/dismissal — different layers. New datasets should still
prefer a `data/` file; the external-source hatch is for a generator-owned,
boot-seeded file only.

### Superseded spellings: a curated alias must not be inert (#2306)

The `canonical_biomarkers` table holds two kinds of row: the curated dataset
entries (`source = 'seed'`, re-UPSERTed by `seedCanonicalBiomarkers` on every
boot) and the spellings an extraction coined (`source = 'ai'`, registered by
`addCanonicalNames` as documents arrive). `buildCanonicalIndex`
(`lib/canonical-name.ts`) fills its index from the whole vocabulary first and
only then lays the alias routes down, so **a real entry always wins a key
collision** — which is what stops an alias hijacking a distinct analyte.

The cost of that precedence is that an **ai-coined row counts as a real entry**.
Since importing a lab's own spelling is _how you discover an alias is needed_,
every `CANONICAL_ALIASES` route added in response to a real document used to be
dead on arrival on the database that motivated it, and re-importing could not
clear it (the route is blocked at the moment the import snaps). The same shape
one step over: a reading stored **before** a curated entry existed keeps the
losing spelling forever even though `snapCanonicalName` resolves it for every
fresh import.

`mergeSupersededCanonicalNames` (`lib/canonical-alias-merge-db.ts`, deciding
through the pure `lib/canonical-alias-merge.ts`) closes both. An `ai` row is
**superseded** when the vocabulary would resolve its key to a different
spelling — either _shadowed_ (another entry already wins the key) or _blocked_
(it wins its own key but an alias route wants that key elsewhere) — and the pass
deletes it, re-points every stored reading of it, and carries the state keyed on
its name: the ★ save, the retest snooze and flagged-result acknowledgment, a
biomarker-linked goal, a tracked coverage gap, and a protocol's outcome key. A
`seed` row is never deleted, and a route with no target in the vocabulary is
never followed — the same guarantee `buildCanonicalIndex` already makes.

It runs in **two places, for two different reasons**:

- **migration 174** — the one-shot data move for the drift already on disk, so
  the retroactive rename has a version, a transaction, and a replay test;
- **`bootTasks`**, right after `seedCanonicalBiomarkers` and before the flag
  reconcile — the recurring guard, because `CANONICAL_ALIASES` and the dataset
  grow in releases with **no schema change**, and any import between two boots
  can mint a fresh blocking row. Exactly why the seed itself is a boot task.

Cheap when there is nothing to do: the plan is computed read-only and the write
transaction is opened only when it is non-empty. When it _does_ move something
it clears `settings.canonical_flags_sig`, so the flag reconcile that follows
re-derives once — a reading that just landed on a curated entry can finally
carry a band. `FLAG_LOGIC_VERSION` is deliberately **not** bumped for this: no
range and no derivation logic changed, and a bump would force a full re-scan on
every database that has no drift to repair.

### Deliberately uncurated analytes (#2313)

`CANONICAL_ALIASES` declares the spellings we DO route. `UNCURATED_ANALYTES`
(same module, keyed the same way by `normalizeCanonicalKey`) declares the other
half: the analytes this repo has decided **not** to curate, and why. That
decision already existed as a source comment, which meant every surface meeting
one of these names had to guess — and the import debugger guessed that a settled
question was outstanding work, counting it toward "Unresolved analytes (N)" and
offering a link that files a public duplicate of a decision already made.

Two shapes, mirroring `MetricKnowledge`'s union, because they say materially
different things to a reader:

- `{ kind: "covered-elsewhere"; instead; reason }` — the quantity IS tracked,
  under a different identity, and `instead` names the curated entry that carries
  it so a surface can link to the real series. The race/ethnicity-branched eGFR
  equations are the motivating case: they return different values for the same
  draw and cannot share one series, and Allos derives the race-free CKD-EPI 2021
  value from creatinine instead.
- `{ kind: "out-of-scope"; reason }` — not a thing this app models as a
  biomarker at all (a toxicology screen has no reference band to curate).

Like `MetricKnowledge`'s `{ source: "none"; reason }`, the **reason is
mandatory**: it is what a user reads instead of "unresolved", and a declaration
without one silently regresses to the state the registry replaced. A
deliberately-uncurated analyte is `FreshnessState`'s `not-applicable`, and
folding it into `due` is the same error one surface over.

`uncuratedAnalyte(name)` is the lookup, and it answers a question about the
ANALYTE rather than about any one surface: anything that would otherwise present
one of these names as an open gap reads it, with no per-surface copy of the list
and no per-surface opinion about what the decision means. Its completeness guard
(`lib/__tests__/canonical-name.test.ts`) pins three rules: every entry has a
non-empty reason; every `covered-elsewhere` target resolves to a real curated
entry (a dangling `instead` promises a series that doesn't exist); and no
declared name is also a curated entry or a `CANONICAL_ALIASES` source, since
declaring and curating the same analyte would otherwise resolve by whichever
path ran last.

The import debugger applies it in `parseImportReport`, on **read** — never in
`lib/import-shape.ts` at write time. That is what makes it cheap: every
already-stored `import_report` splits into `unresolvedNames` / `declinedNames`
correctly the moment a declaration ships, with no migration and nothing to
reprocess, and a future declaration takes effect everywhere at once.
`serializeImportReport` folds the declined half back into the stored unresolved
list so a re-persist cannot freeze today's registry into the blob and cost that
retroactivity.

#### The second consumer: Coverage candidacy (#2319)

Data → Coverage → **Uncatalogued items** asks a different question of a
different set — `detectBiomarkerGaps` compares the profile's used canonical
names as `biomarkerCoverageKey` **families** against the curated
(`source = 'seed'`) vocabulary, where the debugger compares `isSeededCanonical`
on the exact name — and it reached the same wrong conclusion: a settled decision
rendered as an open invitation to track the item or ask for it to be catalogued.

It consults `uncuratedAnalyte` **unchanged**. That was the point of shaping the
registry as a question about the analyte rather than about the debugger: a
second consumer imports it as-is, and neither surface owns a list or an opinion.
`detectBiomarkerGaps` now returns `{ candidates, declined }` — a partition of
the same uncovered set on the same family key — and `getCoverageCandidacy`
(`lib/queries/coverage.ts`) serves both from one read of the used names.
`getCoverageGapCandidates` remains as the candidate-only reader.

Declined items render in their own **"Not catalogued, on purpose"** section with
the declaration's reason (and its `instead` link where there is one), never with
a Track button and never with the catalog-request link. Hiding them outright
would read as data we lost; offering them is what the declaration exists to
stop. A declared analyte a user had **already** opted to track stays in their
tracked list — the system may stop offering something without deleting a choice
somebody made.

This is **disjoint from `NON_IDENTITY_CATEGORIES`** (#2318), and the two must
not be conflated. That rule withholds biomarker identity from a whole *class* of
stored observation and is applied upstream inside `getUsedCanonicalNames`, so
such a name never reaches detection at all. This is a per-*name* decision about
a row that genuinely does carry identity. Do not re-filter by category in
`lib/coverage-gaps.ts`; that guard already ran.

The family that carries the volume is a **DEXA scan's regional decomposition**:
per-region fat percentage, per-site bone mineral density and content, the
compartment-mass grid (with and without the `(g)` a report prints inside the
name — `normalizeCanonicalKey` keeps it as a token, so the two spellings are two
keys), and the derived depot ratios and mass indices. Around ninety declared
names, expanded from a cross product rather than hand-listed, all sharing **one**
`out-of-scope` declaration: they are the outputs of a single scan rather than
independent analytes, and no population reference band exists for left-arm fat
percentage. `out-of-scope` and not `covered-elsewhere` — the whole-body totals
(`Body Fat Percentage`, `Bone Mineral Density T-Score`) *are* curated, but a
region is not its total, and pointing a reader at the total would claim their
left arm is tracked when it isn't. Those totals stay curated; the completeness
guard fails the day a declaration blurs that line.

### What a canonical name must carry (#2335)

The rule the curated dataset is held to, written down beside `CANONICAL_ALIASES`
in `lib/canonical-name.ts` and **enforced** by
`lib/__tests__/canonical-naming-rule.test.ts`:

- A bare name is permitted **only** where a single universal convention fixes its
  meaning. In practice that is the **serum specimen**: `Albumin`, `Creatinine`,
  `Magnesium` and `Folate` beside their `, Urine` / `, RBC` siblings are
  unambiguous to every clinician and stay bare.
- Where two members of one family differ by **measure** (relative/absolute),
  **specimen**, **fraction** (free/total) or **side** (left/right), **every**
  member states its qualifier — including the one that feels like the default.

The second half is what the CBC differential taught. It held both conventions at
once: bare `Neutrophils` was the percentage while bare `Monocytes` was the cell
count, so within one panel a bare name meant opposite things. Picking a
convention and fixing the outliers would not have held — a bare name keeps
attracting mis-mapped imports whatever we declare it to mean. Qualifying every
member makes the ambiguity **unrepresentable** rather than merely resolved, and
`unitAwareCanonical` (which resolved exactly this %-versus-count collision on a
real import) arbitrates anything that still arrives bare.

The scan pairs entries by their **comma-qualifier** — an entry `X` sitting beside
an entry `X, <qualifier>` — rather than by a general token-subset test, which
drowns in coincidences (`Insulin` is a sub-name of `Insulin-Like Growth Factor 1`)
and would need exactly the long allowlist that makes a half-scan worthless. Every
qualifier that actually sits beside a bare sibling is declared with its **axis**,
and the axis decides whether a bare form may exist, so the scan fails two ways:
on an undeclared qualifier (a new axis nobody thought about) and on a declared one
whose axis forbids a bare sibling.

The same pass finished the **`Long Name (ABBR)`** convention. That form is not
cosmetic: `buildCanonicalIndex` auto-derives BOTH the bare abbreviation and the
bare long name from such an entry (`FULL_ABBR_RE`), so a hand-written alias row
for either is redundant — the `FEV1`, `FVC` and `eGFR` routes were deleted when
those entries took the long form. A parenthetical containing a **space** is not
treated as an acronym (`looksLikeAbbreviation`), so the thyroid fractions and the
ANA screen keep load-bearing curated routes.

**Migration 177** carries the 20 renamed entries, reusing #2306's
`applyCanonicalRename` rather than duplicating its checklist of what a canonical
name is keyed by. It also **deletes** the retired vocabulary rows, which #2306's
pass deliberately never does: there the retired row is `ai`-coined and a curated
row is the authority, whereas here the retired name IS the curated one the dataset
just dropped, and `seedCanonicalBiomarkers` has no delete pass — so left in place
it would win its own key forever and block the alias route added to rescue it.
Because `name` is a `FLAG_RELEVANT_FIELD`, `canonicalFlagsSignature()` moves on
its own and the boot reconcile re-derives once; `FLAG_LOGIC_VERSION` is
deliberately **not** bumped, since no range, unit or direction changed.

## Migrating the next dataset (a thin PR)

1. Reshape its `scripts/gen-*.ts` (or hand-authored JSON) to emit a framework
   envelope into `lib/datasets/data/<id>.json` — `id`, `title`, `citation[]`
   (promote the provenance from the old `$comment`/header into a structured
   citation), `identity.keys`, `entries[]`, optional `meta`. Model any age/sex
   bands as entry fields.
2. Add a per-dataset module `lib/datasets/<id>.ts` — copy `mets.ts`:
   `loadDataset` the JSON, `createMatcher` on the identity strategy (reuse
   `nameStrategy`/`slugStrategy`/ `fieldStrategy`, or supply a new strategy for
   RxCUI/family), export typed accessors.
3. Point the domain consumer at the new module (behavior-identical — pin with
   the dataset's existing tests).
4. Register it in `lib/datasets/registry.ts` and add a `datasets-<id>.test.ts`
   using the harness assertions.

The framework's public API is intentionally small so this stays an adoption, not
a redesign. `mets` (issue #151, migrated in #860 Track B) is the worked example.
