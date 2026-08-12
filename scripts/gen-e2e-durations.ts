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
// ONLY RELATIVE WEIGHT MATTERS. The planner balances buckets against each other,
// so a manifest measured on a developer's machine plans the same split as one
// measured on a runner — the absolute seconds differ by a constant factor and
// every bucket scales with it. Refresh it when the SHAPE changes (a heavy spec
// added, split, or deleted), not to chase runner drift.
//
// A stale manifest degrades balance, never correctness: an unlisted file is still
// planned (estimated, see UNKNOWN_WEIGHT_FACTOR) and the planner refuses any plan
// that is not an exact partition of the suite.
import fs from "node:fs";
import path from "node:path";

const MANIFEST = path.join("e2e", "spec-durations.json");

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

  fs.writeFileSync(MANIFEST, JSON.stringify(rounded, null, 2) + "\n");
  const total = Object.values(rounded).reduce((a, b) => a + b, 0);
  console.log(
    `${MANIFEST}: ${Object.keys(rounded).length} spec files, ${total.toFixed(0)}s total`
  );
}

main();
