// Duration-balanced Playwright sharding (the #2568 follow-up).
//
// `--shard` splits the suite by TEST COUNT, and test count is a poor proxy for
// duration here: patient-portals-setup is 17 tests / 54s (3.2s each), food-log is
// 21 tests / 13s (0.6s each), and profile-switch-toasts is ONE test that takes
// 21s. The result is stable, not noisy — shards 7 and 10 were the two slowest in
// every CI run sampled, at 1.22–1.32× the mean — and since the browser matrix is
// the whole critical path, the slowest shard IS the wait.
//
// This plans the split by measured duration instead. The pure part lives here so
// its ONE safety property is unit-testable: every spec file lands in exactly one
// bucket. A balancer that drops a file does not fail — it silently stops running
// those tests while every shard still reports green, which is strictly worse than
// an unbalanced suite. `planShards` therefore validates the partition it just
// built and throws rather than returning a lossy plan.
//
// Balance is best-effort and degrades gracefully: a file with no recorded duration
// is estimated (see UNKNOWN_WEIGHT_FACTOR), which can only misplace it, never drop
// it.

/**
 * Playwright's DEFAULT test-file naming, which is what decides the plan's
 * universe (`scripts/e2e-shard-plan.ts` walks `testDir` with this).
 *
 * The universe only has to be a SUPERSET of what Playwright would run — the
 * safety property is "every file Playwright runs is in exactly one bucket", and
 * a file in a bucket that Playwright ignores contributes an empty file to one
 * command line, not a dropped spec. Exactness buys BALANCE precision only, which
 * is why enumerating the suite no longer costs a `playwright --list` per shard.
 *
 * A superset is guaranteed while every project either takes the default
 * `testMatch` or narrows it, which is the case today (chromium takes the
 * default; `mobile` and `demo` narrow it to named `.spec.ts` files) — but that
 * is an assumption about a config this module cannot see, so it is CHECKED
 * rather than trusted: `scripts/e2e-shard-plan.ts --verify` diffs this walk
 * against Playwright's own `--list`, and CI runs it in the `check` job, off the
 * browser tier's critical path.
 */
export const SPEC_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;

/** Whether `name` is a file Playwright's default `testMatch` would admit. */
export function isSpecFile(name: string): boolean {
  return SPEC_FILE_RE.test(name);
}

/** A spec file's measured wall-clock cost, in seconds. */
export type DurationMap = Readonly<Record<string, number>>;

export interface ShardPlan {
  /** buckets[i] is the spec-file list for shard i+1, sorted for stable logs. */
  buckets: string[][];
  /** Predicted seconds per bucket, same order. */
  loads: number[];
  /** Files that had no recorded duration and were estimated. */
  unknown: string[];
  /** Share of files carrying a real measurement, 0–1. Low means a stale manifest. */
  coverage: number;
}

// An unmeasured file is assumed slightly WORSE than the average measured one.
// Erring high makes a new spec land in a lighter bucket, so the cost of being
// wrong is a mildly uneven run rather than a shard that overruns every peer. It
// is deliberately not enormous: a big number would herd every unknown file into
// its own bucket and unbalance the run the manifest is meant to balance.
const UNKNOWN_WEIGHT_FACTOR = 1.25;

/** Mean of the recorded durations for `files`, or 0 when none are recorded. */
function meanKnown(files: readonly string[], durations: DurationMap): number {
  const known = files
    .map((f) => durations[f])
    .filter((d) => d != null && d > 0);
  if (known.length === 0) return 0;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

/**
 * Split `files` across `shardCount` buckets, balancing predicted duration.
 *
 * Greedy longest-processing-time: heaviest file first, always into the lightest
 * bucket so far. LPT is within 4/3 of optimal for this shape and needs no search.
 * A spec FILE is the atom — Playwright runs a file's tests together and they share
 * per-file setup — so the achievable floor is the largest single file.
 *
 * Ties break on the filename so two runners planning independently from the same
 * inputs produce byte-identical buckets. That determinism is load-bearing: each
 * shard plans for itself, with no coordinating job, and they must agree.
 */
export function planShards(
  files: readonly string[],
  durations: DurationMap,
  shardCount: number
): ShardPlan {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shardCount must be a positive integer, got ${shardCount}`);
  }
  const unique = [...new Set(files)].sort();
  if (unique.length !== files.length) {
    throw new Error("planShards: duplicate spec files in input");
  }

  const fallback = meanKnown(unique, durations) * UNKNOWN_WEIGHT_FACTOR;
  const unknown: string[] = [];
  const weight = new Map<string, number>();
  for (const f of unique) {
    const d = durations[f];
    if (d != null && d > 0) weight.set(f, d);
    else {
      unknown.push(f);
      // With no manifest at all every file weighs the same, so LPT degrades to a
      // round-robin by count — the current behaviour, not something worse.
      weight.set(f, fallback || 1);
    }
  }

  const buckets: string[][] = Array.from({ length: shardCount }, () => []);
  const loads = new Array<number>(shardCount).fill(0);
  const heaviestFirst = [...unique].sort((a, b) => {
    const d = weight.get(b)! - weight.get(a)!;
    return d !== 0 ? d : a.localeCompare(b);
  });
  for (const f of heaviestFirst) {
    let target = 0;
    for (let i = 1; i < shardCount; i++) {
      // Strictly-less keeps the lowest index on a tie, which is what makes the
      // whole plan deterministic.
      if (loads[i] < loads[target]) target = i;
    }
    buckets[target].push(f);
    loads[target] += weight.get(f)!;
  }

  assertPartition(unique, buckets);

  return {
    buckets: buckets.map((b) => [...b].sort()),
    loads,
    unknown,
    coverage: unique.length === 0 ? 1 : 1 - unknown.length / unique.length,
  };
}

/**
 * The safety gate: the buckets must be a PARTITION of the input.
 *
 * Checked rather than assumed because the failure it guards is invisible at
 * runtime — a spec present in no bucket is never run, by any shard, and the
 * matrix still goes green. Exported so the CLI can re-check a plan it received
 * from anywhere.
 */
export function assertPartition(
  files: readonly string[],
  buckets: readonly (readonly string[])[]
): void {
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (const f of bucket) {
      if (seen.has(f)) {
        throw new Error(
          `e2e shard plan: "${f}" assigned to more than one shard`
        );
      }
      seen.add(f);
    }
  }
  const expected = new Set(files);
  const missing = [...expected].filter((f) => !seen.has(f));
  const extra = [...seen].filter((f) => !expected.has(f));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `e2e shard plan is not a partition of the suite — ` +
        `${missing.length} file(s) would never run` +
        (missing.length ? ` (${missing.slice(0, 5).join(", ")}…)` : "") +
        `, ${extra.length} unknown file(s) planned` +
        (extra.length ? ` (${extra.slice(0, 5).join(", ")}…)` : "")
    );
  }
}
