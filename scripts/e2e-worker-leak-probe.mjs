// Reproduce the two different fixture questions hidden behind "CI parity" (#3653).
//
// Run from the repository root:
//
//   node scripts/e2e-worker-leak-probe.mjs
//
// This creates a throwaway Playwright spec outside e2e/, imports THIS checkout's
// playwright.config.ts, and gives it a worker-scoped counter. The first test poisons
// the counter; the second expects the clean value. The probe then measures the same
// file in the two configurations whose distinction matters:
//
//   --workers=2 --repeat-each=3   each fully-parallel repetition gets clean workers
//   --workers=1                   both tests share one worker and the reader sees poison
//
// The expected one-worker failure is evidence, not a broken probe: this script checks
// its exact worker/state trace and exits 0 only when both sides remain discriminating.
// It does not boot Allos, seed a database, or leave files in the checkout.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repo = process.cwd();
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");
const playwrightTest = require.resolve("@playwright/test");
const repoConfig = path.join(repo, "playwright.config.ts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "allos-worker-leak-"));
const configPath = path.join(scratch, "playwright.config.ts");
const specPath = path.join(scratch, "worker-leak.spec.ts");
const marker = "ALLOS_WORKER_LEAK_PROBE ";

fs.writeFileSync(
  configPath,
  `import repoConfig from ${JSON.stringify(repoConfig)};

export default {
  ...repoConfig,
  testDir: ${JSON.stringify(scratch)},
  testMatch: /worker-leak\\.spec\\.ts$/,
  globalSetup: undefined,
  globalTeardown: undefined,
  outputDir: ${JSON.stringify(path.join(scratch, "results"))},
  reporter: "list",
  projects: [{ name: "probe" }],
};
`
);

fs.writeFileSync(
  specPath,
  `import { expect, test as base } from ${JSON.stringify(playwrightTest)};

type Counter = { value: number };
const test = base.extend<{}, { counter: Counter }>({
  counter: [
    async ({}, use) => {
      await use({ value: 0 });
    },
    { scope: "worker" },
  ],
});

function record(testInfo, stateBefore: number) {
  console.log(
    ${JSON.stringify(marker)} +
      JSON.stringify({
        title: testInfo.title,
        repeat: testInfo.repeatEachIndex,
        worker: testInfo.workerIndex,
        slot: testInfo.parallelIndex,
        pid: process.pid,
        stateBefore,
      })
  );
}

test("01 poison the worker fixture", async ({ counter }, testInfo) => {
  record(testInfo, counter.value);
  counter.value = 1;
});

test("02 reader requires a clean fixture", async ({ counter }, testInfo) => {
  record(testInfo, counter.value);
  expect(counter.value).toBe(0);
});
`
);

function run(args) {
  const result = spawnSync(
    process.execPath,
    [playwrightCli, "test", "--config", configPath, ...args],
    { cwd: repo, encoding: "utf8", env: process.env }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const records = output
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) =>
      JSON.parse(line.slice(line.indexOf(marker) + marker.length))
    );
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    output,
    records,
  };
}

function byTitle(records, prefix) {
  return records.filter((record) => record.title.startsWith(prefix));
}

try {
  const repeated = run(["--workers=2", "--repeat-each=3", "--retries=0"]);
  assert.equal(
    repeated.status,
    0,
    `repeat-each control unexpectedly failed:\n${JSON.stringify(
      {
        status: repeated.status,
        signal: repeated.signal,
        error: repeated.error,
      },
      null,
      2
    )}\n${repeated.output}`
  );
  assert.equal(
    repeated.records.length,
    6,
    "repeat-each did not run 2 tests x 3"
  );
  assert.ok(
    repeated.records.every((record) => record.stateBefore === 0),
    `repeat-each shared worker state:\n${JSON.stringify(repeated.records, null, 2)}`
  );
  assert.equal(
    new Set(repeated.records.map((record) => record.worker)).size,
    6,
    `repeat-each reused a worker process:\n${JSON.stringify(repeated.records, null, 2)}`
  );
  for (const repeat of [0, 1, 2]) {
    const allocation = repeated.records.filter(
      (record) => record.repeat === repeat
    );
    assert.equal(allocation.length, 2);
    assert.equal(new Set(allocation.map((record) => record.worker)).size, 2);
  }

  const oneWorker = run(["--workers=1", "--repeat-each=1", "--retries=0"]);
  assert.notEqual(
    oneWorker.status,
    0,
    "one-worker leak control unexpectedly passed"
  );
  assert.equal(
    oneWorker.records.length,
    2,
    "one-worker control did not run both tests"
  );
  const [poison] = byTitle(oneWorker.records, "01 ");
  const [reader] = byTitle(oneWorker.records, "02 ");
  assert.ok(poison && reader, "one-worker trace is missing poison or reader");
  assert.equal(
    poison.worker,
    reader.worker,
    "one-worker control changed workers"
  );
  assert.equal(poison.pid, reader.pid, "one-worker control changed processes");
  assert.equal(poison.stateBefore, 0, "poison did not start clean");
  assert.equal(
    reader.stateBefore,
    1,
    "reader did not observe the fixture leak"
  );

  console.log("Playwright worker-fixture leak probe (#3653)");
  console.table([
    {
      command: "--workers=2 --repeat-each=3",
      result: "6 passed",
      workers: new Set(repeated.records.map((record) => record.worker)).size,
      "reader state": byTitle(repeated.records, "02 ")
        .map((record) => record.stateBefore)
        .join(","),
    },
    {
      command: "--workers=1 --repeat-each=1",
      result: "expected reader failure",
      workers: new Set(oneWorker.records.map((record) => record.worker)).size,
      "reader state": reader.stateBefore,
    },
  ]);
  console.log(
    "PASS: repeat-each measured clean worker fixtures; one worker exposed the inter-test leak."
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
