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
// A FOURTH reader survived that convergence: pm-digest.sh carried its own
// last-row-wins fold, so an `update` row would have dropped its branch out of
// the in-flight set and offered that lane's issues back as pickable — the same
// defect this file's header describes, in the one place that decides what gets
// dispatched next. No `update` row had ever been written when it was found
// (47 active / 43 done / 21 promotion across 111 rows), so it was LATENT: armed
// by `dispatch-brief.mjs update`, and never yet fired. The `issues` mode below
// exists so that caller can ask instead of re-implementing (#4473).
//
// `issues` answers WHICH issues are in flight, not WHO holds one, because no
// caller has needed the second yet. When one does: that question is the
// issue-shaped twin of `dispatch-brief.mjs claims <path>`, and laneIssues()
// already returns the number -> branch map it needs. Follow that vocabulary
// rather than inventing a third — a mode designed by the thing that needs it
// beats a general one designed by nobody.
//
// Usage:
//   node scripts/orchestration/ledger.mjs branches [file]   # active branches
//   node scripts/orchestration/ledger.mjs e2e-count [file]  # active e2e lanes
//   node scripts/orchestration/ledger.mjs issues [file]     # issues in flight

import fs from "node:fs";
import path from "node:path";
import { helpGuard, isMain } from "./usage.mjs";
import { LEDGER_FILE, resolveStateDir } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

/** Where the ledger lives — the roster is derived from this directory. */
export const ledgerPath = () =>
  process.env.ALLOS_DISPATCH_LEDGER ??
  path.join(resolveStateDir(), LEDGER_FILE);

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

// CLI for orchestrator-checkin.sh, which cannot import a function. It answers
// or it EXITS; it never answers 0 for a question it could not ask. A MISSING
// ledger is UNKNOWN, not zero — the check-in prints UNMEASURED and names the
// failure, which sends the orchestrator to look. Printed as 0 it reads "no
// lanes are running", and an empty roster is a DISPATCH ORDER, so a wrong
// STATE_DIR or a restart would dispatch on top of live lanes nobody can see. A
// present-but-EMPTY ledger really is zero and prints 0: the two refusals share
// unknown, not none.
if (isMain(process.argv, import.meta.url)) {
  const [mode, file] = process.argv.slice(2);
  const from = file || ledgerPath();
  const known =
    ["branches", "e2e-count", "issues"].includes(mode) && fs.existsSync(from);
  if (!known) {
    console.error(
      `ledger.mjs: no answer for \`${mode}\` at ${from} — see --help`
    );
    process.exit(2);
  }
  const rows = readLedger(from);
  const active = activeDispatches(rows);
  if (mode === "branches")
    console.log(
      active
        .map((d) => d.branch)
        .sort()
        .join("\n")
    );
  else if (mode === "issues")
    console.log([...laneIssues(rows).keys()].sort((a, b) => a - b).join("\n"));
  else console.log(active.filter((d) => d.e2e).length);
}
