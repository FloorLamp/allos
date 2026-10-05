#!/usr/bin/env node
// Product-owned recurring checks. Each Sortie shard gets a source-only checkout,
// production build and isolated test servers; the fleet supplies UTC cadences.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function run(command, argv, { env = process.env, capture = false } = {}) {
  const result = spawnSync(command, argv, {
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `${command} exited ${result.status ?? result.signal}`
    );
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result.stdout?.trim() ?? "";
}

export function censusArgs(mode, shard) {
  if (!Number.isInteger(shard) || shard < 1 || shard > 4)
    throw new Error("shard must be 1 through 4");
  if (mode === "nightly") {
    const plan = run(
      process.execPath,
      ["--import", "tsx", "scripts/e2e-shard-plan.ts", String(shard), "4"],
      { capture: true }
    );
    if (!plan) throw new Error("empty shard plan");
    return plan.split("\n");
  }
  if (mode !== "weekly" && mode !== "forward-3" && mode !== "forward-6")
    throw new Error(`unknown census: ${mode}`);
  return [
    `--shard=${shard}/4`,
    "--retries=0",
    `--repeat-each=${mode === "weekly" ? 2 : 1}`,
  ];
}

export async function census(mode, shard) {
  if (
    mode !== "source-oracle" &&
    (!Number.isInteger(shard) || shard < 1 || shard > 4)
  )
    throw new Error("shard must be 1 through 4");
  if (
    !["nightly", "weekly", "forward-3", "forward-6", "source-oracle"].includes(
      mode
    )
  )
    throw new Error(`unknown census: ${mode}`);
  const env = { ...process.env, CI: "1", E2E_NO_SEED: "1", PW_WORKERS: "2" };
  // These jobs use synthetic test databases, never production providers.
  run(process.execPath, ["scripts/orchestration/host.mjs", "node-check"], {
    env,
  });
  run("npm", ["ci", "--no-audit", "--no-fund"], { env });
  if (mode === "source-oracle") {
    run(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "lib/__tests__/strip-comments.test.ts",
      ],
      {
        env: { ...env, ALLOS_RUN_STRIP_COMMENTS_ORACLE: "1" },
      }
    );
    return;
  }
  run(
    process.execPath,
    ["node_modules/playwright/cli.js", "install", "--only-shell", "chromium"],
    { env }
  );
  run("npm", ["run", "build"], { env: { ...env, NEXT_SKIP_TYPECHECK: "1" } });
  // Preserve the setup action's bounded real-midnight backstop.
  const remaining = Math.floor((86400000 - (Date.now() % 86400000)) / 60000);
  if (remaining <= 12) {
    console.log(`Waiting ${remaining + 1} minutes to clear UTC midnight`);
    await new Promise((resolve) =>
      setTimeout(resolve, (remaining + 1) * 60000)
    );
  }
  if (mode.startsWith("forward-")) {
    const months = mode.slice("forward-".length);
    env.ALLOS_TEST_NOW = run(
      "date",
      ["-u", "-d", `+${months} months`, "+%Y-%m-%dT%H:%M:%SZ"],
      { capture: true }
    );
    console.log(
      `Forward-clock census: ${env.ALLOS_TEST_NOW} (+${months} months)`
    );
  }
  try {
    run("npm", ["run", "test:e2e", "--", ...censusArgs(mode, shard)], { env });
  } finally {
    // Reporting must not turn a red suite green or replace its failure.
    spawnSync(
      process.execPath,
      ["scripts/e2e-flake-report.mjs", "test-results/e2e-results.json"],
      { env, stdio: "inherit" }
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  census(process.argv[2], Number(process.argv[3])).catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
