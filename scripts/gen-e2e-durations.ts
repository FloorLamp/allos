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
// Refresh when the SHAPE changes (a heavy spec added, split, or deleted), not to
// chase drift.
//
// TWO WAYS TO GET RUNNER NUMBERS, because the obvious one is not always available.
// The `e2e-results-shard-*` artifacts are the richer source, but downloading a
// GitHub artifact means reaching `*.blob.core.windows.net`, which an agent sandbox
// behind a filtering proxy cannot do — the artifact LIST returns 200 and the
// download returns 403 CONNECT, so the failure looks like a permissions problem
// and is not. Job LOGS are plain API reads and stay reachable, so each e2e shard
// also PRINTS its per-file durations:
//
//   e2e-durations<TAB>e2e/some.spec.ts<TAB>12345
//
// Collect those lines from the twelve shard logs and feed them back:
//
//   npx tsx scripts/gen-e2e-durations.ts --from-log shard1.log [...more]
//
// Same arithmetic, same manifest — a log line is the JSON report's one number per
// file, and this script only ever summed to that. `--emit-log` is what CI runs to
// produce them.
//
// A stale manifest degrades balance, never correctness: an unlisted file is still
// planned (estimated, see UNKNOWN_WEIGHT_FACTOR) and the planner refuses any plan
// that is not an exact partition of the suite.
import fs from "node:fs";
import path from "node:path";
import {
  DURATION_LOG_TAG,
  formatDurationLog,
  parseDurationLog,
} from "../lib/e2e-durations-log";
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

/** Sum one Playwright JSON report into `totals`. */
function collectReport(file: string, totals: Map<string, number>): void {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    suites?: JsonSpec[];
  };
  for (const suite of raw.suites ?? []) collect(suite, undefined, totals);
}

/**
 * Sum the tagged lines out of a saved CI log. A file that yields NONE is an
 * error rather than an empty contribution — see `parseDurationLog`.
 */
function collectLog(file: string, totals: Map<string, number>): void {
  const found = parseDurationLog(fs.readFileSync(file, "utf8"), totals);
  if (found === 0) {
    console.error(
      `${file}: no \`${DURATION_LOG_TAG}\` lines — is that an e2e shard log from ` +
        `a run AFTER the emit step shipped? An older run has no such lines and ` +
        `would silently contribute nothing.`
    );
    process.exit(1);
  }
}

/** Print this report's per-file totals for a log reader to recover later. */
function emitLog(reports: string[]): void {
  const totals = new Map<string, number>();
  for (const file of reports) collectReport(file, totals);
  for (const line of formatDurationLog(totals)) console.log(line);
}

function main(): void {
  const args = process.argv.slice(2);
  const fromLog = args.includes("--from-log");
  const emit = args.includes("--emit-log");
  const inputs = args.filter((a) => !a.startsWith("--"));
  if (inputs.length === 0) {
    console.error(
      "usage: tsx scripts/gen-e2e-durations.ts <playwright-report.json> [...]\n" +
        "       tsx scripts/gen-e2e-durations.ts --from-log <shard.log> [...]\n" +
        "       tsx scripts/gen-e2e-durations.ts --emit-log <playwright-report.json>"
    );
    process.exit(2);
  }
  if (emit) {
    emitLog(inputs);
    return;
  }

  const totals = new Map<string, number>();
  for (const file of inputs) {
    if (fromLog) collectLog(file, totals);
    else collectReport(file, totals);
  }

  if (totals.size === 0) {
    console.error(
      fromLog
        ? "no test durations found — are those e2e shard logs?"
        : "no test durations found — is that a Playwright JSON report?"
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
    `  Expect a large share: greedy LPT assigns in descending-weight order, so ANY ` +
      `weight change swaps two files in that order and cascades through every ` +
      `later assignment. Measured on this manifest at 12 shards — a plain ` +
      `re-measure, no spec added or removed: 86%. A single spec +1% is anywhere ` +
      `from 0% to 62% depending on WHERE that spec sits in the weight order ` +
      `(median 22% across all 394), which is the same cascade seen from its ` +
      `smallest end. So this number is not a warning sign, it is the shape of the ` +
      `algorithm; what it tells you is that after this refresh every spec's ` +
      `neighbourhood is new, and a red shard is a co-residency suspect before it ` +
      `is a regression.`
  );
}

main();
