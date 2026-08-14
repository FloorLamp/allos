#!/usr/bin/env node
// CLI over the worktree build seeding in e2e/build-seed.mjs (#2605), for the two
// jobs the e2e harness cannot do for itself: seeding a worktree by hand before any
// suite runs, and recording the build inputs of a `.next` that `npm run build`
// produced outside the harness.
//
//   node scripts/orchestration/seed-next-build.mjs                # seed cwd from any sibling
//   node scripts/orchestration/seed-next-build.mjs --from <dir>   # ...from one named checkout
//   node scripts/orchestration/seed-next-build.mjs record         # record cwd's build inputs
//
// The ordinary path needs none of this: `ensureBuild` seeds automatically when it
// finds no build, which is the only moment at which a sibling is likely to have one.
//
// Exit codes are the interface: 0 seeded, 3 REFUSED, 1 error. A refusal is a normal
// outcome — the worktree simply builds — and must stay cheap to accept. What must
// never happen is a SILENT one, because the failure this guard prevents is green
// tests against a bundle that is not the code.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { BUILD_RECORD_BASENAME, writeBuildRecord } from "../../e2e/build-inputs.mjs";
import { seedNextBuild } from "../../e2e/build-seed.mjs";

export const EXIT_SEEDED = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 3;

function parseArgs(argv) {
  const opts = { mode: "seed", from: null, to: process.cwd(), dist: ".next" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "record") opts.mode = "record";
    else if (a === "seed") opts.mode = "seed";
    else if (a === "--from") opts.from = path.resolve(argv[++i]);
    else if (a === "--to" || a === "--root") opts.to = path.resolve(argv[++i]);
    else if (a === "--dist") opts.dist = argv[++i];
    else if (a === "-h" || a === "--help") opts.mode = "help";
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[seed-next] ${err.message}`);
    return EXIT_ERROR;
  }

  if (opts.mode === "help") {
    console.log(
      "usage: seed-next-build.mjs [--from <checkout>] [--to <worktree>] [--dist .next]\n" +
        "       seed-next-build.mjs record [--root <checkout>] [--dist .next]\n" +
        "exit: 0 seeded, 3 refused (the worktree builds instead — safe), 1 error"
    );
    return EXIT_SEEDED;
  }

  if (opts.mode === "record") {
    try {
      const record = writeBuildRecord(opts.to, path.join(opts.to, opts.dist));
      console.log(
        `[seed-next] recorded ${record.fileCount} build inputs for build ${record.buildId} ` +
          `-> ${opts.dist}/${BUILD_RECORD_BASENAME}`
      );
      return EXIT_SEEDED;
    } catch (err) {
      console.error(`[seed-next] could not record build inputs: ${err.message}`);
      return EXIT_ERROR;
    }
  }

  let result;
  try {
    result = seedNextBuild({ to: opts.to, from: opts.from, distName: opts.dist });
  } catch (err) {
    console.error(`[seed-next] ${err.message}`);
    return EXIT_ERROR;
  }

  if (result.seed) {
    console.log(
      `[seed-next] SEEDED ${opts.dist} from ${result.from} in ${result.ms}ms ` +
        `(proof: ${result.proof})`
    );
    return EXIT_SEEDED;
  }
  if (!result.attempts.length) {
    console.log("[seed-next] REFUSED: no other checkout has a production build");
  }
  for (const attempt of result.attempts) {
    console.log(`[seed-next] REFUSED ${attempt.from}: ${attempt.reason}`);
  }
  console.log(
    "[seed-next] nothing was seeded — this worktree builds its own, which is correct."
  );
  return EXIT_REFUSED;
}

// Run as a script, importable as a module (the CLI's exit codes are asserted).
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exit(main(process.argv.slice(2)));
}
