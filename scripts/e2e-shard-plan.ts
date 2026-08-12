// Emit the Playwright arguments for ONE duration-balanced shard, ONE PER LINE.
//
//   PLAN=$(npx tsx scripts/e2e-shard-plan.ts 7 12)
//   mapfile -t ARGS <<< "$PLAN"
//   npx playwright test "${ARGS[@]}"
//
// Prints either an explicit spec-file list (balanced by e2e/spec-durations.json)
// or, when the manifest is missing, `--shard=N/M` so the caller falls back to
// Playwright's own count-based split. Either way the caller's command line is
// well-formed, so a missing manifest degrades to today's behaviour instead of
// running nothing.
//
// One arg per LINE, not space-separated, so the caller reads them into an array
// instead of relying on the shell to split them. Two reasons that matters: word
// splitting is a bash behaviour that zsh does NOT share (a `$ARGS` that works in
// CI silently passes one long argument when a developer reproduces it locally),
// and an unquoted expansion is also glob-expanded.
//
// Each shard runs this INDEPENDENTLY and they must agree, which is why the plan
// is a pure deterministic function of (file list, manifest, shard count) with no
// coordinating job and no state — see lib/e2e-shard-plan.ts.
//
// The file list comes from Playwright itself (`--list`), not a glob, so project
// filters (`testIgnore`, the mobile project's `testMatch`) decide what exists —
// the same authority that decides what runs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { planShards, type DurationMap } from "../lib/e2e-shard-plan";

const MANIFEST = path.join("e2e", "spec-durations.json");

/**
 * Every spec file Playwright would run, via its own resolution.
 *
 * `--list` reports each file relative to `testDir` ("smoke.spec.ts"), while the
 * manifest and the command line both want it repo-relative ("e2e/smoke.spec.ts"),
 * so normalize here — the one place the two conventions meet.
 */
function listSpecFiles(): string[] {
  const out = execFileSync(
    "npx",
    ["playwright", "test", "--list", "--reporter=json"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  const report = JSON.parse(out) as {
    suites?: { file?: string; suites?: unknown[] }[];
  };
  const files = new Set<string>();
  const walk = (n: { file?: string; suites?: unknown[] }): void => {
    if (n.file) {
      files.add(n.file.startsWith("e2e/") ? n.file : path.join("e2e", n.file));
    }
    for (const c of (n.suites ?? []) as {
      file?: string;
      suites?: unknown[];
    }[]) {
      walk(c);
    }
  };
  for (const s of report.suites ?? []) walk(s);
  return [...files];
}

function main(): void {
  const shard = Number(process.argv[2]);
  const total = Number(process.argv[3]);
  if (
    !Number.isInteger(shard) ||
    !Number.isInteger(total) ||
    shard < 1 ||
    shard > total
  ) {
    console.error("usage: tsx scripts/e2e-shard-plan.ts <shard> <total>");
    process.exit(2);
  }

  if (!fs.existsSync(MANIFEST)) {
    console.error(`${MANIFEST} missing — falling back to count-based --shard`);
    process.stdout.write(`--shard=${shard}/${total}`);
    return;
  }
  const durations = JSON.parse(
    fs.readFileSync(MANIFEST, "utf8")
  ) as DurationMap;

  const files = listSpecFiles();
  if (files.length === 0) {
    console.error("playwright --list returned no spec files — falling back");
    process.stdout.write(`--shard=${shard}/${total}`);
    return;
  }

  // Throws when the plan is not an exact partition of the suite. Failing the
  // shard is the point: a dropped spec runs nowhere while every shard reports
  // green, so this must be louder than an unbalanced run, not quieter.
  const plan = planShards(files, durations, total);

  const pct = Math.round(plan.coverage * 100);
  console.error(
    `shard ${shard}/${total}: ${plan.buckets[shard - 1].length} spec files, ` +
      `~${plan.loads[shard - 1].toFixed(0)}s predicted ` +
      `(manifest covers ${pct}% of ${files.length} files; ` +
      `slowest bucket ~${Math.max(...plan.loads).toFixed(0)}s)`
  );
  if (plan.unknown.length > 0) {
    console.error(
      `  ${plan.unknown.length} file(s) not in ${MANIFEST}, estimated: ` +
        plan.unknown.slice(0, 10).join(" ") +
        (plan.unknown.length > 10 ? " …" : "") +
        `\n  refresh with: npx tsx scripts/gen-e2e-durations.ts <report.json>`
    );
  }

  // An EMPTY bucket must not emit an empty argument list: `playwright test` with
  // no file filter runs the WHOLE suite, so the one shard with nothing to do
  // would silently run everything. Emit a filter that matches no test instead.
  const bucket = plan.buckets[shard - 1];
  process.stdout.write(bucket.length > 0 ? bucket.join("\n") : "--grep=$a^");
}

main();
