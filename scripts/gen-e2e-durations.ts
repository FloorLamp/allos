// Regenerate e2e/spec-durations.json — the per-spec-file cost manifest that
// duration-balanced sharding plans from (lib/e2e-shard-plan.ts).
//
//   npx playwright test --reporter=json > /tmp/report.json   # or several shards'
//   npx tsx scripts/gen-e2e-durations.ts /tmp/report.json [...more]
//
// Takes one or more Playwright JSON reports and sums every test's duration per
// spec FILE (a file is the sharding atom). Several reports merge additively, so
// the twelve per-shard reports from one CI run regenerate the whole manifest.
//
// MEASURE ON A RUNNER, not a laptop. "Only relative weight matters" holds for a
// constant factor, and a different machine is not one: the same suite is 1518s
// locally and 2978s in CI, and that ratio is NOT uniform per file, because specs
// are bound by different things and those scale apart. Measured — plan CI's work
// with laptop weights and the buckets come out predicted-equal while CI runs
// 127-183s (max/mean 1.16 against an independent run); with runner weights, 1.05.
// Refresh from `e2e-results-shard-*` artifacts when the SHAPE changes (a heavy
// spec added, split, or deleted), not to chase drift.
//
// A stale manifest degrades balance, never correctness: an unlisted file is still
// planned (estimated, see UNKNOWN_WEIGHT_FACTOR) and the planner refuses any plan
// that is not an exact partition of the suite.
import fs from "node:fs";
import path from "node:path";
import {
  movedFiles,
  planShards,
  type DurationMap,
} from "../lib/e2e-shard-plan";

const MANIFEST = path.join("e2e", "spec-durations.json");

// The shard count CI runs. It lives in .github/workflows/ci.yml's matrix, and is
// read here only to report the reshuffle at the granularity that actually ships —
// a wrong value makes the report describe a split nobody runs, never a bad
// manifest. Override with --shards=N.
const CI_SHARD_COUNT = 12;

interface JsonSpec {
  file?: string;
  tests?: { results?: { duration?: number }[] }[];
  specs?: JsonSpec[];
  suites?: JsonSpec[];
}

// The report nests suite → suite → spec, and `file` is carried at several levels;
// walk the whole tree and attribute each result to the nearest file it names.
function collect(
  node: JsonSpec,
  file: string | undefined,
  out: Map<string, number>
): void {
  const here = node.file ?? file;
  for (const t of node.tests ?? []) {
    for (const r of t.results ?? []) {
      if (here && r.duration) out.set(here, (out.get(here) ?? 0) + r.duration);
    }
  }
  for (const child of [...(node.specs ?? []), ...(node.suites ?? [])]) {
    collect(child, here, out);
  }
}

function main(): void {
  const reports = process.argv.slice(2);
  if (reports.length === 0) {
    console.error(
      "usage: tsx scripts/gen-e2e-durations.ts <playwright-report.json> [...]"
    );
    process.exit(2);
  }

  const totals = new Map<string, number>();
  for (const file of reports) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      suites?: JsonSpec[];
    };
    for (const suite of raw.suites ?? []) collect(suite, undefined, totals);
  }

  if (totals.size === 0) {
    console.error(
      "no test durations found — is that a Playwright JSON report?"
    );
    process.exit(1);
  }

  // Normalize to `e2e/<name>.spec.ts` and seconds (1dp): the planner keys on the
  // path Playwright itself lists, and whole milliseconds are false precision for
  // a number whose only job is ordering buckets.
  const rounded = Object.fromEntries(
    [...totals.entries()]
      .map(([f, ms]) => {
        const rel = f.startsWith("e2e/")
          ? f
          : path.join("e2e", path.basename(f));
        return [rel, Math.round(ms) / 1000] as const;
      })
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const previous = readPreviousManifest();
  fs.writeFileSync(MANIFEST, JSON.stringify(rounded, null, 2) + "\n");
  const total = Object.values(rounded).reduce((a, b) => a + b, 0);
  console.log(
    `${MANIFEST}: ${Object.keys(rounded).length} spec files, ${total.toFixed(0)}s total`
  );
  reportReshuffle(previous, rounded, shardCountArg());
}

/** The manifest as it stood BEFORE this run overwrote it, or null on first write. */
function readPreviousManifest(): DurationMap | null {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as DurationMap;
  } catch {
    return null;
  }
}

function shardCountArg(): number {
  const flag = process.argv.find((a) => a.startsWith("--shards="));
  const n = flag ? Number(flag.slice("--shards=".length)) : CI_SHARD_COUNT;
  return Number.isInteger(n) && n > 0 ? n : CI_SHARD_COUNT;
}

/**
 * Print what this refresh does to CO-RESIDENCY — see lib/e2e-shard-plan.ts.
 *
 * Planned over the UNION of both manifests' files so the two plans describe the
 * same suite: a file only one side knows about would otherwise register as a
 * bucket change that is really just an appearance. Both plans are built from the
 * same file list, so every difference between them is the weights' doing, which
 * is exactly what a manifest refresh changes.
 */
function reportReshuffle(
  previous: DurationMap | null,
  next: DurationMap,
  shards: number
): void {
  if (!previous) {
    console.log("co-residency: no previous manifest — nothing to compare.");
    return;
  }
  const files = [
    ...new Set([...Object.keys(previous), ...Object.keys(next)]),
  ].sort();
  const before = planShards(files, previous, shards).buckets;
  const after = planShards(files, next, shards).buckets;
  const moved = movedFiles(before, after);
  if (moved.length === 0) {
    console.log(
      `co-residency: unchanged at ${shards} shards — no spec changed bucket.`
    );
    return;
  }
  const share = Math.round((moved.length / files.length) * 100);
  console.log(
    `\nco-residency: ${moved.length} of ${files.length} spec(s) (${share}%) ` +
      `change bucket at ${shards} shards. A spec that moves can share a worker — ` +
      `and so a DATABASE — with specs it never has before, which is how a latent ` +
      `absence-precondition collision surfaces as one red shard ` +
      `(docs/internals/e2e-hygiene.md).`
  );
  console.log(
    `  Expect roughly half the suite or more: greedy LPT assigns in descending-` +
      `weight order, so ANY weight change swaps two files in that order and ` +
      `cascades through every later assignment. Measured on this manifest — one ` +
      `spec +1%: 48%. One spec deleted: 56%. One spec added: 66%. A plain ` +
      `re-measure with no shape change at all: 86%. So this number is not a ` +
      `warning sign, it is the shape of the algorithm; what it tells you is that ` +
      `after this refresh every spec's neighbourhood is new, and a red shard is a ` +
      `co-residency suspect before it is a regression.`
  );
}

main();
