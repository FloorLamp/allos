// Curated-dataset framework — the reusable test harness (issue #860 Track B).
//
// Three assertions every framework dataset should be able to pass, factored so a
// per-dataset test and the cross-cutting linter share ONE definition of "correct":
//
//   - citationPresent  — the dataset carries ≥1 citation each with a source.
//   - identityResolves — every entry is found by its OWN identity key via a matcher
//                        (the dataset can actually be looked up).
//   - refusalGate      — a subject the dataset does NOT contain resolves to null,
//                        never a guess (the safety property).
//   - noKeyCollisions  — no two entries index under the same normalized key. For a
//                        single-value strategy this is implied by identityResolves; for
//                        a MULTI-VALUE one (synonyms/aliases/pairs, #860 wave 2) it's the
//                        distinct safety check that a shared alias/pair doesn't silently
//                        make one entry shadow another. Same coverage, more keys.
//
// These return a { ok, problems } result rather than calling a test framework's
// expect(), so they're pure and usable both from vitest (assert ok === true) and from
// the linter's aggregate scan. No DB, no network.

import { createMatcher, expand } from "./matcher";
import type { LoadedDataset, MatchStrategy } from "./types";

export interface HarnessResult {
  ok: boolean;
  problems: string[];
}

function result(problems: string[]): HarnessResult {
  return { ok: problems.length === 0, problems };
}

// Every citation has a non-empty `source`. (loadDataset already enforces ≥1 citation;
// this is the harness-level restatement so a test can assert it directly and the
// linter can report it uniformly across the registry.)
export function citationPresent<E, M>(
  dataset: LoadedDataset<E, M>
): HarnessResult {
  const problems: string[] = [];
  if (dataset.citation.length === 0) {
    problems.push(`${dataset.id}: no citations`);
  }
  dataset.citation.forEach((c, i) => {
    if (!c.source || c.source.trim() === "") {
      problems.push(`${dataset.id}: citation[${i}] has empty source`);
    }
  });
  return result(problems);
}

// Every entry resolves to ITSELF when looked up by its own identity value under the
// given strategy. Catches an entry whose key normalizes to "" (unindexable) or whose
// key collides with an earlier entry (looks up to the wrong row). Pass the strategy
// the dataset's consumers actually use.
export function identityResolves<E, M>(
  dataset: LoadedDataset<E, M>,
  strategy: MatchStrategy
): HarnessResult {
  const problems: string[] = [];
  const matcher = createMatcher(dataset, strategy);
  dataset.entries.forEach((entry, i) => {
    const raw = (entry as Record<string, unknown>)[strategy.key];
    const found = matcher.match(raw);
    if (found === null) {
      problems.push(
        `${dataset.id}: entry[${i}] (${strategy.key}=${JSON.stringify(
          raw
        )}) does not resolve by its own identity`
      );
    } else if (found !== entry) {
      problems.push(
        `${dataset.id}: entry[${i}] (${strategy.key}=${JSON.stringify(
          raw
        )}) resolves to a DIFFERENT entry (identity collision)`
      );
    }
  });
  return result(problems);
}

// A query the dataset does not contain must resolve to null. `absentQueries` should
// be values that don't match any entry; the default sentinel is a string no curated
// key would ever equal. This pins the refusal gate — the framework never guesses.
export function refusalGate<E, M>(
  dataset: LoadedDataset<E, M>,
  strategy: MatchStrategy,
  absentQueries: unknown[] = ["__no_such_entry_should_ever_match__"]
): HarnessResult {
  const problems: string[] = [];
  const matcher = createMatcher(dataset, strategy);
  for (const q of absentQueries) {
    if (matcher.match(q) !== null) {
      problems.push(
        `${dataset.id}: absent query ${JSON.stringify(
          q
        )} unexpectedly resolved (refusal gate breached)`
      );
    }
  }
  return result(problems);
}

// No two entries index under the same normalized key. `identityResolves` catches a
// collision on an entry's FIRST-hit key; for a multi-value strategy a shared alias/pair
// on a NON-first key can still resolve each entry to itself while silently shadowing the
// other — this walks every expanded key across the whole dataset and flags any key two
// entries produce (the FIRST owner is reported, mirroring the matcher's first-wins). For
// single-value strategies it's equivalent to the identityResolves collision check.
export function noKeyCollisions<E, M>(
  dataset: LoadedDataset<E, M>,
  strategy: MatchStrategy
): HarnessResult {
  const problems: string[] = [];
  const owner = new Map<string, number>();
  dataset.entries.forEach((entry, i) => {
    for (const k of expand(
      strategy,
      (entry as Record<string, unknown>)[strategy.key]
    )) {
      const prev = owner.get(k);
      if (prev === undefined) {
        owner.set(k, i);
      } else {
        problems.push(
          `${dataset.id}: entry[${prev}] and entry[${i}] both index key ${JSON.stringify(
            k
          )} (identity collision)`
        );
      }
    }
  });
  return result(problems);
}

// Run all four over a dataset + its primary strategy; aggregate the problems. Used by
// the linter to check the whole registry in one pass.
export function runHarness<E, M>(
  dataset: LoadedDataset<E, M>,
  strategy: MatchStrategy
): HarnessResult {
  const problems = [
    ...citationPresent(dataset).problems,
    ...identityResolves(dataset, strategy).problems,
    ...refusalGate(dataset, strategy).problems,
    ...noKeyCollisions(dataset, strategy).problems,
  ];
  return result(problems);
}
