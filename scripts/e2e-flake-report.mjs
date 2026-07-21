// Flake telemetry for the e2e suite (plain Node, no deps — CI runs it even when
// the run failed and before any build tooling is guaranteed warm).
//
// The CI full suite runs with `retries: 1`, which means a pass-on-retry ships a
// GREEN run — every such pass is a confirmed flake detection that used to be
// thrown away. Playwright's json reporter records those tests with status
// "flaky"; this script extracts them and prints a Markdown fragment for
// $GITHUB_STEP_SUMMARY, so each CI run shows its flake catch and the backlog is
// measured instead of masked (the precondition for ever dropping full-suite
// retries — see docs/internals/e2e-hygiene.md).
//
// Usage: node scripts/e2e-flake-report.mjs [path/to/e2e-results.json]
// Always exits 0 — this is telemetry, not a gate; the suite result gates.

import fs from "node:fs";

const reportPath = process.argv[2] ?? "test-results/e2e-results.json";

function collectFlaky(suite, file, out) {
  for (const child of suite.suites ?? []) {
    collectFlaky(child, child.file ?? file, out);
  }
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === "flaky") {
        out.push({
          file: spec.file ?? file ?? "unknown",
          title: spec.title,
          retries: (test.results?.length ?? 1) - 1,
        });
      }
    }
  }
}

if (!fs.existsSync(reportPath)) {
  console.log(`_No e2e JSON report at ${reportPath} — flake report skipped._`);
  process.exit(0);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (err) {
  console.log(
    `_Unreadable e2e JSON report (${String(err)}) — flake report skipped._`
  );
  process.exit(0);
}

const flaky = [];
for (const suite of report.suites ?? []) {
  collectFlaky(suite, suite.file, flaky);
}

if (flaky.length === 0) {
  console.log("### E2E flake report\n\nNo pass-on-retry tests in this run. ✅");
} else {
  console.log("### E2E flake report\n");
  console.log(
    `**${flaky.length} test(s) passed only on retry** — each is a confirmed flake ` +
      `the green run would otherwise hide. File or fix them (fixture ownership / ` +
      `settled interactions — docs/internals/e2e-hygiene.md):\n`
  );
  for (const f of flaky) {
    console.log(`- \`${f.file}\` — ${f.title}`);
  }
}
