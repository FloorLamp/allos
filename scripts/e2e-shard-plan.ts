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
// The file list is a WALK of the Playwright testDir, not `playwright --list`.
// That started as the authority argument — let project filters decide what
// exists — and it cost 8.4s per shard in CI, on the critical path, twelve times
// a run, because `--list` loads all ~400 spec files through Playwright's
// transform pipeline just to learn their names, and the run then collects them
// again. The walk is 2ms.
//
// It is sound because the safety property needs a SUPERSET, not the exact set:
// buckets that partition a superset still put every file Playwright runs in
// exactly one bucket, and a file Playwright ignores costs one empty entry on a
// command line. Exactness only ever bought balance precision. See SPEC_FILE_RE
// in lib/e2e-shard-plan.ts — and `--verify` below, which is where the superset
// claim is actually checked against Playwright.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  isSpecFile,
  planShards,
  type DurationMap,
} from "../lib/e2e-shard-plan";

const MANIFEST = path.join("e2e", "spec-durations.json");
const TEST_DIR = "e2e";

/**
 * Every spec file under the Playwright testDir, repo-relative and sorted.
 *
 * Dot-directories are skipped because `e2e/.data` holds the per-worker template
 * and worker databases a PREVIOUS run left behind — walking it would be slow and
 * could only ever yield non-spec files.
 */
function walkSpecFiles(dir = TEST_DIR, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSpecFiles(p, out);
    else if (isSpecFile(entry.name)) out.push(p);
  }
  return out.sort();
}

/**
 * Every spec file Playwright would run, via its own resolution — the EXPENSIVE
 * authority, used only by `--verify`.
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

/**
 * Prove the cheap walk is a SUPERSET of what Playwright actually resolves.
 *
 * This is the authority the per-shard path gave up, kept whole and moved to
 * where it is free: CI runs it in `check`, which has ~130s of slack against the
 * browser matrix, so the ~8s `--list` costs the critical path nothing.
 *
 * A file `--list` reports that the walk missed is a REAL defect — it would land
 * in no bucket and run on no shard while every shard reported green. The other
 * direction is reported but tolerated: a walked file Playwright ignores only
 * adds an empty entry to one command line, and it is worth seeing because a spec
 * no project admits is usually a naming mistake.
 */
function verify(): void {
  const walked = walkSpecFiles();
  const listed = listSpecFiles();
  const walkedSet = new Set(walked);
  const listedSet = new Set(listed);
  const missing = listed.filter((f) => !walkedSet.has(f));
  const extra = walked.filter((f) => !listedSet.has(f));

  if (extra.length > 0) {
    console.error(
      `note: ${extra.length} file(s) match the spec naming but no Playwright ` +
        `project admits them — they are planned into a shard and run nothing:\n  ` +
        extra.join("\n  ")
    );
  }
  if (missing.length > 0) {
    console.error(
      `e2e shard plan universe is NOT a superset of Playwright's resolution — ` +
        `${missing.length} file(s) would be planned into no shard and run ` +
        `nowhere:\n  ` +
        missing.join("\n  ") +
        `\n\nThe walk in scripts/e2e-shard-plan.ts (SPEC_FILE_RE + testDir) has ` +
        `drifted from playwright.config.ts. Widen the walk — do NOT widen this check.`
    );
    process.exit(1);
  }
  console.error(
    `e2e shard plan universe verified: ${walked.length} walked file(s) cover ` +
      `all ${listed.length} Playwright resolves.`
  );
}

function main(): void {
  if (process.argv[2] === "--verify") {
    verify();
    return;
  }

  const shard = Number(process.argv[2]);
  const total = Number(process.argv[3]);
  if (
    !Number.isInteger(shard) ||
    !Number.isInteger(total) ||
    shard < 1 ||
    shard > total
  ) {
    console.error(
      "usage: tsx scripts/e2e-shard-plan.ts <shard> <total>\n" +
        "       tsx scripts/e2e-shard-plan.ts --verify"
    );
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

  const files = walkSpecFiles();
  if (files.length === 0) {
    console.error(`no spec files found under ${TEST_DIR}/ — falling back`);
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
