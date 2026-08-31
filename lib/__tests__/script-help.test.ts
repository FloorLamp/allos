import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// EVERY ENTRY SCRIPT ANSWERS --help, AND ANSWERING IT DOES NOTHING ELSE.
//
// Orchestrators probe unfamiliar scripts with `--help`, and before 2026-08-30
// the flag was silently ignored: the DEFAULT action ran instead. Mostly that
// wasted a network round-trip; for the stateful scripts (the check-in flight
// recorder, the dispatch ledger) it performed a real state transition the
// caller never asked for. The fix is `helpGuard` (usage.mjs) plus an inline
// sed guard in the shell scripts: print the header — the documentation IS the
// usage — and exit 0 before anything else runs.
//
// The spawn below runs each script for real with NO stub environment and NO
// token, which is itself the assertion: if a guard is missing or placed after
// side-effectful code, the script reaches for the network or its state files
// and this test gets slow, noisy, or red. Exit 0 plus a substantial stdout
// proves the guard fired first.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TSX = path.join(REPO, "node_modules/.bin/tsx");

const ENTRY_SCRIPTS = [
  "scripts/orchestrator-checkin.sh",
  "scripts/orchestration/adversarial-review-brief.mjs",
  "scripts/orchestration/agent-gates.sh",
  "scripts/orchestration/catchup-digest.sh",
  "scripts/orchestration/ci-watch.mjs",
  "scripts/orchestration/closing-keywords.mjs",
  "scripts/orchestration/delete-unknown-labels.ts",
  "scripts/orchestration/dependabot-eval-brief.mjs",
  "scripts/orchestration/dispatch-brief.mjs",
  "scripts/orchestration/host.mjs",
  "scripts/orchestration/ledger.mjs",
  "scripts/orchestration/merge-gate.mjs",
  "scripts/orchestration/post-merge-census.mjs",
  "scripts/orchestration/pr-board.mjs",
  "scripts/orchestration/queue-snapshot.mjs",
  "scripts/orchestration/reconcile-apply.ts",
  "scripts/orchestration/reconcile-labels.ts",
  "scripts/orchestration/reconcile-tracker.ts",
  "scripts/orchestration/reconcile-watermark.ts",
  "scripts/orchestration/release-notes-gather.mjs",
  "scripts/orchestration/session-metrics.mjs",
] as const;

function runHelp(rel: string) {
  const abs = path.join(REPO, rel);
  const [cmd, args] = rel.endsWith(".sh")
    ? ["bash", [abs, "--help"]]
    : [TSX, [abs, "--help"]];
  return spawnSync(cmd, args, {
    cwd: REPO,
    encoding: "utf8",
    timeout: 30_000,
    // No GH_TOKEN, no stub curl: a script that gets past its guard has
    // nothing to lean on and fails loudly rather than quietly doing work.
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
  });
}

describe("--help is always safe", () => {
  it.each(ENTRY_SCRIPTS)("%s prints its header and exits 0", (rel) => {
    const run = runHelp(rel);
    expect(run.status).toBe(0);
    // The header is the usage, and headers here are substantial by house
    // style — a couple of characters would mean the guard printed nothing.
    expect(run.stdout.trim().length).toBeGreaterThan(80);
  });
});

// AND IT ANSWERS FOR THE SCRIPT THAT WAS RUN, NOT FOR ONE IT IMPORTS (#4460).
// helpGuard read `argv` alone, so the FIRST module-scope guard to run won: an
// importer printed its import's header and exited 0. That is not a nicety —
// it is why the dispatch ledger grew a third parser instead of an import, and
// it would have blocked the next convergence in this directory too. Each pair
// below is a real import edge, asserted in both directions: the importer's own
// first header line present, and the import's absent.
describe("--help belongs to the invoked script, not to its imports", () => {
  it.each([
    [
      "scripts/orchestration/queue-snapshot.mjs",
      "Queue snapshot —",
      "ledger.mjs",
    ],
    [
      "scripts/orchestration/dispatch-brief.mjs",
      "Dispatch-brief generator",
      "ledger.mjs",
    ],
    [
      "scripts/orchestration/ledger.mjs",
      "The dispatch ledger, folded",
      "Host resolution",
    ],
  ])("%s prints its OWN header", (rel, own, imported) => {
    const run = runHelp(rel);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(own);
    expect(run.stdout).not.toContain(imported);
  });
});
