# Curated datasets

Use the shared framework in [lib/datasets](../../lib/datasets/index.ts) for curated
reference data. It provides one validated envelope, identity matcher, registry,
and test harness. [registry.ts](../../lib/datasets/registry.ts) is the current
inventory; read a dataset's module and committed source before changing its data.

## Storage and provenance

New datasets belong in `lib/datasets/data/<id>.json`. The
[envelope types](../../lib/datasets/types.ts) define `$schema`, `id`, `title`,
`citation`, `identity`, `entries`, and optional `description`/`meta`.

- Set `$schema` to `allos-dataset/v1`.
- Supply citations with non-empty sources, at least one per dataset. Preserve per-entry
  citations when present; a dataset-level citation is the minimum.
- Declare the entry fields that identify a subject in `identity.keys`. Every
  entry must carry each key with a non-null value; string identities cannot be empty.
- Put lookup configuration in `meta` and age, sex, or status bands on entries.
  Band conventions differ by dataset; preserve the domain accessor's boundary
  rules rather than imposing one universal range shape.

[loadDataset](../../lib/datasets/loader.ts) validates committed data and throws
`DatasetError` on an invalid envelope. Per-dataset modules expose typed accessors;
consumers should use those instead of writing another loader or identity index.
[mets.ts](../../lib/datasets/mets.ts) is a small adoption example.

Root-level JSON assets under `lib/` have explicit exceptions:

- `canonical-result-definitions.json` is the registered external source described
  below. Its framework wrapper and boot seed share the same committed rows.
- `exercise-guides.json` and `symptoms.json` are framework non-candidates: they have
  no honest external provenance to promote into a reference-data citation.
- `release-notes.json` holds product changelog data.
- `zip-centroids.json` is a generated public-domain Census gazetteer; its source
  and refresh procedure live in [gen-zip-centroids.ts](../../scripts/gen-zip-centroids.ts).

The framework test checks this root inventory so new reference data cannot bypass
its citation requirements by landing outside the dataset directory.

## Matching and refusal

[createMatcher](../../lib/datasets/matcher.ts) builds an index over a loaded
dataset. A strategy names an entry field and normalizes both stored identities
and incoming queries. `match(query)` returns an entry or `null`; absent subjects
must not receive a nearest-match guess.

Use the existing strategy that describes the identity:

| Identity                          | Strategy or key builder                         |
| --------------------------------- | ----------------------------------------------- |
| Name, slug, or one field          | `nameStrategy`, `slugStrategy`, `fieldStrategy` |
| Several aliases in one field      | `multiValueStrategy`                            |
| Unordered pair                    | `pairStrategy`, `sortedPairKey`                 |
| Ordered composite                 | `compositeStrategy`, `compositeKey`             |
| All pairs across two concept sets | `pairKeysAcross`                                |

A strategy's optional `normalizeMany` supplies all keys for a value and takes
precedence over `normalize`. `expand` implements that choice. Empty expansions
refuse; multi-key queries resolve on a matching key. A custom strategy may express
an existing domain identity without adding another framework abstraction.

The [harness](../../lib/datasets/harness.ts) checks citations, self-resolution,
refusal, and collisions across every expanded key. Shared secondary aliases can
shadow entries even when each entry's first key resolves correctly; keep collision
coverage when adopting a multi-value identity.

## Canonical result definitions

[canonical-result-definitions.ts](../../lib/datasets/canonical-result-definitions.ts)
wraps `lib/canonical-result-definitions.json` in an envelope in memory. It retains
the committed entries and their reviewed order. The
[generator](../../scripts/gen-canonical-result-definitions.ts) does not establish
an offline, byte-identical regeneration contract.

[Boot tasks](../../lib/migrations/boot-tasks.ts) seed those same rows into
`canonical_result_definitions`. The framework matcher identifies an exact canonical
name; `biomarkerFamily` answers the separate cross-name grouping question. Do not
collapse distinct curated rows to a family identity in the dataset matcher.

[canonicalFlagsSignature](../../lib/canonical-flags-version.ts) determines whether
stored flags need reconciliation. Data changes to signature-relevant fields move
the signature themselves. Change `FLAG_LOGIC_VERSION` for changes to flag derivation
logic, not merely because a vocabulary repair occurred.

The framework test registers this external source explicitly and checks its
existence, registry membership, and absence from the normal data directory. Prefer
the normal envelope layout for new datasets.

## Canonical names, aliases, and renames

[canonical-name.ts](../../lib/canonical-name.ts) owns normalization, alias routes,
abbreviation forms, search terms, family identity, and deliberate non-curation.
Keep these decisions there so import, search, and coverage use the same vocabulary.

A canonical name may be bare when one convention fixes its meaning, such as the
repository's default serum-specimen convention. When siblings differ by measure,
specimen, fraction, or side, preserve the distinguishing qualifiers; relative and
absolute counts must not share an ambiguous bare name.
[unitAwareCanonical](../../lib/canonical-unit-guard.ts)
handles ambiguous incoming labels using their units.

`Long Name (ABBR)` can contribute both forms automatically. Parentheticals with
spaces are not treated as acronyms. Reuse `biomarkerSearchTerms` in biomarker
pickers: it includes abbreviation forms and reverse alias routes, which ordinary
subsequence matching on the display name alone can miss.

Vocabulary entries take precedence over aliases. An AI-created spelling can
therefore block a later curated alias. The
[alias merge](../../lib/canonical-alias-merge-db.ts) repairs superseded AI names,
repoints readings, and carries name-keyed state such as saves, dismissals, goals,
coverage gaps, and protocol outcomes. It preserves seed rows and refuses routes
without a target. Boot runs it after seeding and before flag reconciliation; a
non-empty repair invalidates the stored flag signature.

For a curated rename, reuse `applyCanonicalRename` and explicitly retire the old
curated vocabulary row in a migration when appropriate. Seeding upserts entries;
it does not delete names removed from the JSON. Do not edit a shipped migration
or write a partial rename that leaves associated state behind.

## Deliberately uncurated names and Coverage

`uncuratedAnalyte(name)` returns either `covered-elsewhere`, with an `instead`
target and reason, or `out-of-scope`, with a reason. A target must resolve to a
curated entry; a declined name must not also be curated or be an alias source.
Use the recorded per-name decision, rather than inferring one from a panel or
measurement family. Regional measurements, whole-body totals, and indexed values
can have different decisions; the declarations and report-shaped fixtures record
those distinctions.

[Import reports](../../lib/import-report.ts) apply these declarations on read. Serialization folds declined
names back into the stored unresolved list, allowing future declarations to affect
old reports without reprocessing.

[Coverage detection](../../lib/coverage-gaps.ts) partitions uncovered family keys
into candidates and declined items; [coverage queries](../../lib/queries/coverage.ts)
provide the shared read. Declined items explain the decision and any replacement
link, without offering Track or a catalog request. Preserve a user's existing
tracked item when a later declaration stops offering it.

Category-based withholding of biomarker identity runs upstream in
`getUsedCanonicalNames`. It is distinct from per-name non-curation; do not repeat
that category filter in coverage detection.

## Document readings that belong to trend metrics

[METRIC_DOCUMENT_REACH](../../lib/trend-metric-analytes.ts) declares whether and
how an imported quantity reaches its chart:

| Reach               | Imported observation                                       |
| ------------------- | ---------------------------------------------------------- |
| `observations`      | Retained as the chart point                                |
| `observation-fold`  | Retained and folded into the stream by identity            |
| `import-projection` | Removed after the corresponding stream value is captured   |
| `derived-inputs`    | Removed without a projection; the chart derives the result |

[Import shaping](../../lib/import-shape.ts) implements the corresponding removals.
A recognized printed derived result is dropped independently of whether its inputs
were captured, and reported as an `ImportDrop` with reason `derived_result`.

Recognition must preserve distinct statistics. Acronyms cannot overrule a
contradictory full label. `foreignStatisticSignifier` checks the original spelling
against the metric's names and unit, so punctuation such as `%` retains meaning.
Both catalog visibility and destructive derived-result recognition use this check;
`derivedInputsMetricFor` keeps an explicit check at the deletion boundary. Reuse
these recognizers instead of guessing from normalized stems or LOINC alone.

## Making a change

Update the committed source or its generator, load it through a typed dataset
module, register it, and switch consumers to that owner. Preserve existing identity,
refusal, band, and citation behavior unless the task changes it.

Run the existing [framework tests](../../lib/__tests__/datasets-framework.test.ts)
and relevant dataset tests. Canonical-definition changes also have boot-seed and
flag-signature coverage; alias, coverage, and import changes have their own behavior
fixtures. Add a focused case only for an uncovered failure, following the shared
[test policy](../change-policy.md).
