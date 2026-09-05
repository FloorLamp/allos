import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  activeDispatches,
  laneIssues,
  readLedger,
} from "../../scripts/orchestration/ledger.mjs";

// ONE READER FOR THE DISPATCH LEDGER (#4460). It had three — dispatch-brief,
// queue-snapshot, and a python block in orchestrator-checkin.sh — and they
// disagreed about the same file: the shell's let ANY row win per branch, so
// an `update` row (a re-prioritised lane) erased that branch's issues and
// dropped it out of the live set, while queue-snapshot deliberately kept it.
// A re-prioritised lane is still live. That is the answer pinned here, and
// the shell now reaches it through this module's CLI rather than its own
// parse — so the `branches` drive below is the check-in's actual answer.
//
// WHY THE FIXTURE IS A REAL LEDGER: every row kind below is one the live
// `allos-dispatch-ledger.jsonl` holds, in its own spelling, and each is a way
// a plausible parse REACHES NOTHING. Issue numbers are STRINGS there and
// numbers on the GitHub issue, so a reader comparing them raw marks zero rows
// while looking entirely correct.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/ledger.mjs");

const row = (entry: Record<string, unknown>) => JSON.stringify(entry);
const LEDGER = [
  row({
    at: "2026-08-31T09:16Z",
    status: "active",
    branch: "write-3276",
    issues: ["3276"],
  }),
  row({
    at: "2026-08-31T09:43Z",
    status: "active",
    branch: "nut-4118",
    issues: ["4118", "3987"],
    e2e: true,
  }),
  // an `update` carries a branch and NO issues: it must not erase the lane
  row({
    at: "2026-08-31T09:50Z",
    status: "update",
    branch: "nut-4118",
    priority: "P1",
  }),
  // a `promotion` carries no branch at all
  row({
    at: "2026-08-31T09:55Z",
    status: "promotion",
    target: "write-3276",
    displaced: null,
  }),
  row({
    at: "2026-08-31T10:00Z",
    status: "active",
    branch: "rail-4280",
    issues: ["4280"],
  }),
  row({ at: "2026-08-31T10:24Z", status: "done", branch: "rail-4280" }),
  "{ this line is a torn append",
  "",
].join("\n");

const ROWS = LEDGER.split("\n").flatMap((line) => {
  try {
    return line.trim() ? [JSON.parse(line)] : [];
  } catch {
    return [];
  }
});

describe("activeDispatches", () => {
  const live = activeDispatches(ROWS).map((d) => d.branch);

  it.each([
    ["write-3276", true, "a plain active dispatch"],
    ["nut-4118", true, "re-prioritised by a later `update` — STILL LIVE"],
    ["rail-4280", false, "closed by a `done` row"],
  ])("%s live=%s (%s)", (branch, expected, _why) => {
    expect(live.includes(branch as string)).toBe(expected);
  });

  it("carries the update's new fields without losing the dispatch's own", () => {
    const nut = activeDispatches(ROWS).find((d) => d.branch === "nut-4118");
    expect(nut.priority).toBe("P1");
    expect(nut.issues).toEqual(["4118", "3987"]);
    expect(nut.at).toBe("2026-08-31T09:43Z");
  });

  it("flags the promotion target without a branch of its own on the row", () => {
    const promoted = activeDispatches(ROWS).filter((d) => d.candidate);
    expect(promoted.map((d) => d.branch)).toEqual(["write-3276"]);
  });
});

describe("laneIssues, keyed the way the GitHub API spells a number", () => {
  const lanes = laneIssues(ROWS);

  it.each([
    [3276, "write-3276", "a plain active dispatch"],
    [4118, "nut-4118", "an active dispatch a later `update` re-prioritised"],
    [3987, "nut-4118", "the second issue of a two-issue cluster"],
    [4280, null, "closed by a `done` row — no longer a lane"],
    [9999, null, "never dispatched"],
  ])("#%s -> %s (%s)", (number, branch, _why) => {
    expect(lanes.get(number as number) ?? null).toBe(branch);
  });

  it("reaches every dispatch the ledger still holds — the count is the point", () => {
    // A reach count, not a pattern restatement: three issues across two live
    // branches, and a parse that mishandles ANY row kind above returns fewer.
    expect(lanes.size).toBe(3);
  });
});

describe("readLedger", () => {
  it("returns [] for a ledger that does not exist yet", () => {
    expect(readLedger(path.join(REPO, "no-such-ledger.jsonl"))).toEqual([]);
  });
});

describe("ledger.mjs, driven the way orchestrator-checkin.sh drives it", () => {
  // Same bytes as the fixture above, on disk, through the same CLI the shell
  // calls — so what is asserted here is the check-in's actual answer.
  const dir = makeTmpDir("dispatch-ledger");
  const file = path.join(dir, "ledger.jsonl");
  const empty = path.join(dir, "empty.jsonl");
  fs.writeFileSync(file, LEDGER + "\n");
  fs.writeFileSync(empty, "");
  const cli = (args: string[], at = file) =>
    spawnSync(process.execPath, [SCRIPT, ...args, at], {
      cwd: REPO,
      encoding: "utf8",
    });

  it("lists a re-prioritised lane as live — the disagreement, resolved", () => {
    const run = cli(["branches"]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n")).toEqual(["nut-4118", "write-3276"]);
  });

  it("counts only the e2e lanes among them", () => {
    const run = cli(["e2e-count"]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("1");
  });

  // AND UNKNOWN IS NOT 0 (owner, 2026-08-31). The shell prints UNMEASURED when
  // this exits non-zero, and that sends the orchestrator to LOOK. A missing
  // ledger printed as 0 reads "no lanes are running", and an empty roster is a
  // dispatch order — so a wrong STATE_DIR or a restart would dispatch on top of
  // live lanes nobody can see. Only a present-but-EMPTY ledger is genuinely
  // zero. Each row asserts stdout too: a refusal that PRINTS would leave the
  // shell holding a number it would then read as the answer.
  it.each([
    [["branchez"], file, "an unknown mode"],
    [
      ["e2e-count"],
      path.join(dir, "gone.jsonl"),
      "a MISSING ledger is UNKNOWN",
    ],
    [["branches"], path.join(dir, "gone.jsonl"), "same, for the branch list"],
  ])("refuses %s (%s)", (args, at, _why) => {
    const run = cli(args as string[], at as string);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("see --help");
  });

  it.each([
    [["e2e-count"], "0"],
    [["branches"], ""],
  ])(
    "answers %s over a present-but-EMPTY ledger — that IS zero",
    (args, out) => {
      const run = cli(args as string[], empty);
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(out);
    }
  );
});

// THE FOURTH READER, finished (#4473). #4460 converged dispatch-brief,
// queue-snapshot and orchestrator-checkin, and pm-digest.sh kept its own
// inline `live.set(branch, row)` fold — last row per branch wins, the exact
// read this file's header was written about. Its consequence is worse than the
// others: the digest decides WHAT TO DISPATCH NEXT, so an `update` row on a
// running lane would have put that lane's issues back on the pickable list.
// Latent when found — no `update` row had ever been written (47 active,
// 43 done, 21 promotion across 111 live rows) — and armed by `update` itself.
// The fixture above HAS one, on `nut-4118`, which is why these two rows differ.
describe("issues in flight, the answer pm-digest.sh now asks for", () => {
  const dir = makeTmpDir("dispatch-ledger-issues");
  const file = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(file, LEDGER + "\n");
  const run = spawnSync(process.execPath, [SCRIPT, "issues", file], {
    cwd: REPO,
    encoding: "utf8",
  });

  it("keeps a re-prioritised lane's issues in flight", () => {
    // 4118 and 3987 belong to `nut-4118`, whose last row is the `update`. The
    // fold the digest used to run drops them here, and the digest then offers
    // them as pickable while an agent is mid-flight on them.
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n")).toEqual(["3276", "3987", "4118"]);
  });

  it("omits a lane that is done", () => {
    // 4280 is `rail-4280`, closed by a `done` row — the converse, without which
    // the row above passes for a command that returns every issue it ever saw.
    expect(run.stdout).not.toContain("4280");
  });

  it("refuses a missing ledger rather than printing an empty set", () => {
    // What makes the shell write `?`. An empty in-flight set reads as "nothing
    // is running", and the digest turns that into a dispatch order.
    const gone = spawnSync(
      process.execPath,
      [SCRIPT, "issues", path.join(dir, "gone.jsonl")],
      { cwd: REPO, encoding: "utf8" }
    );
    expect(gone.status).toBe(2);
    expect(gone.stdout).toBe("");
  });
});
