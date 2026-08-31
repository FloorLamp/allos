// The dispatch ledger, folded in ONE place (#4460).
//
// The append-only JSONL had three readers — dispatch-brief.mjs,
// queue-snapshot.mjs and a python block in orchestrator-checkin.sh — and they
// DISAGREED. The shell's let any row win per branch, so an `update` row (a
// re-prioritised lane) erased that branch's issues and dropped it out of the
// live set. A re-prioritised lane is still live, so the fold below is the one
// that wins and the shell asks it instead of re-implementing it.
//
// Two row kinds make a naive "last row per branch" read wrong and the live
// ledger holds both: a `promotion` carries NO branch, an `update` carries a
// branch with NO issues. And issue numbers are STRINGS here, numbers in the
// GitHub API — laneIssues() coerces, and a reader comparing them raw matches
// nothing while looking entirely correct.
//
// Usage:
//   node scripts/orchestration/ledger.mjs branches [file]   # active branches
//   node scripts/orchestration/ledger.mjs e2e-count [file]  # active e2e lanes

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpGuard } from "./usage.mjs";
import { resolveStateDir } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

/** Where the ledger lives — the roster is derived from this directory. */
export const ledgerPath = () =>
  process.env.ALLOS_DISPATCH_LEDGER ??
  path.join(resolveStateDir(), "allos-dispatch-ledger.jsonl");

/** Rows oldest-first. A torn append is skipped, never thrown on. */
export function readLedger(file = ledgerPath()) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  return lines.flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return []; // a torn append must not shorten the ledger
    }
  });
}

/** Fold to current state: `done` closes, `update` merges, `promotion` re-flags. */
export function activeDispatches(rows) {
  const byBranch = new Map();
  for (const row of rows) {
    if (row.status === "active") byBranch.set(row.branch, row);
    if (row.status === "update" && byBranch.has(row.branch)) {
      const current = byBranch.get(row.branch);
      byBranch.set(row.branch, {
        ...current,
        ...row,
        at: current.at,
        status: "active",
        updatedAt: row.at,
      });
    }
    if (row.status === "promotion") {
      for (const [branch, current] of byBranch) {
        byBranch.set(branch, {
          ...current,
          candidate: branch === row.target,
          ...(branch === row.displaced ? { displacedBy: row.target } : {}),
          ...(branch === row.target
            ? { promotedFrom: row.displaced ?? null }
            : {}),
          updatedAt: row.at,
        });
      }
    }
    if (row.status === "done" && byBranch.has(row.branch)) {
      byBranch.get(row.branch).doneAt = row.at;
      byBranch.delete(row.branch);
    }
  }
  return [...byBranch.values()];
}

/** Issue number, as the GitHub API spells it, -> the branch holding it. */
export function laneIssues(rows) {
  const lanes = new Map();
  for (const d of activeDispatches(rows)) {
    for (const number of d.issues ?? []) lanes.set(Number(number), d.branch);
  }
  return lanes;
}

// CLI for orchestrator-checkin.sh, which cannot import a function.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, file] = process.argv.slice(2);
  const active = activeDispatches(readLedger(file || undefined));
  const branches = active.map((d) => d.branch).sort();
  if (mode === "branches") console.log(branches.join("\n"));
  else if (mode === "e2e-count")
    console.log(active.filter((d) => d.e2e).length);
  else {
    console.error("ledger.mjs: expected `branches` or `e2e-count`, see --help");
    process.exit(2);
  }
}
