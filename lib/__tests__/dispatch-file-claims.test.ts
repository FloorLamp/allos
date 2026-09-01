// IS ANYONE ELSE IN THIS FILE? (#4473)
//
// A brief names the other live lanes ONCE, at dispatch. Lanes run one to two
// hours, so the sentence is stale before it is read: `history-clock-brand-4452`
// checked the three lanes its brief named before extending a type brand into
// `app/(app)/nutrition/DayLedger.tsx`, saw no conflict, and `write-pipeline-3276`
// had been dispatched into that exact file since. It was stopped by ASKING the
// orchestrator, which is not a control.
//
// So the fixture below is a REAL one — a git repo, real linked worktrees, a real
// uncommitted edit — because the question is entirely about what is on disk, and
// a mocked `git` would only ever confirm the shape this file already believes.
//
// THREE ANSWERS, AND THE THIRD IS THE POINT. `claimed` and `clear` are the pair
// anyone would write; an absence check that answered "clear" for everything
// passes the first of them. `unknown` is the one the issue is about: a dispatch
// whose worktree is not on disk (a container restart, a `done --keep` later
// cleaned, a `git worktree add` that was denied) can hold uncommitted work
// NOBODY CAN SEE, and reporting that as clear is the same false confidence the
// stale sentence produced, arriving through the tool meant to replace it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  claimsVerdict,
  pathOverlaps,
} from "../../scripts/orchestration/dispatch-brief.mjs";
import { makeTmpDir } from "./tmp-dir";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/dispatch-brief.mjs");

/** The file the near-miss was about, one held by a COMMITTED edit, and one
 * nobody is touching at all. */
const CONTESTED = "app/(app)/nutrition/DayLedger.tsx";
const COMMITTED = "lib/queries/nutrition-day.ts";
const UNADDED = "lib/queries/day-brand.ts";
const UNTOUCHED = "lib/queries/other.ts";

function git(cwd: string, args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

function seed(dir: string, rel: string, body: string): void {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

const root = makeTmpDir("dispatch-claims");
const bare = path.join(root, "repo");
fs.mkdirSync(bare);
git(bare, ["init", "-q", "-b", "main"]);
git(bare, ["config", "user.email", "lane@example.test"]);
git(bare, ["config", "user.name", "Lane Fixture"]);
seed(bare, CONTESTED, "export const DayLedger = 1;\n");
seed(bare, COMMITTED, "export const day = 3;\n");
seed(bare, UNTOUCHED, "export const other = 2;\n");
git(bare, ["add", "-A"]);
git(bare, ["commit", "-qm", "base"]);
// The tool asks "what is not in main", so main has to exist as a remote ref
// exactly as it does in the live repo.
git(bare, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
const repo = git(bare, ["rev-parse", "--show-toplevel"]);

// The lane that IS in the file: an uncommitted edit in its own worktree.
const holding = path.join(root, "wt-write");
git(repo, ["worktree", "add", "-q", "-b", "write-pipeline-3276", holding]);
fs.appendFileSync(path.join(holding, CONTESTED), "// branded\n");
// …and a file it has created but not yet `git add`ed. Two lanes adding the same
// new module is the collision nobody sees coming, and it is untracked on both
// sides, so neither `git diff` nor `git status --porcelain` without `--others`
// would report it.
seed(holding, UNADDED, "export const brand = 4;\n");

// A lane holding a file through a COMMIT, with a spotless working tree. Its
// branch may even be pushed; nothing is in main, so it collides at merge exactly
// as a dirty tree does, and a check that only reads `git status` calls it clear.
const committed = path.join(root, "wt-commit");
git(repo, ["worktree", "add", "-q", "-b", "day-rollup-4500", committed]);
fs.appendFileSync(path.join(committed, COMMITTED), "// rolled up\n");
git(committed, ["commit", "-qam", "day rollup"]);

// A lane with a worktree and nothing in it.
const idle = path.join(root, "wt-brand");
git(repo, ["worktree", "add", "-q", "-b", "history-clock-brand-4452", idle]);

// AND THE OTHER UNREADABLE SHAPE, which is the one that nearly slipped through
// here: a worktree git STILL LISTS (`prunable`, gitdir points nowhere) because
// its directory was removed without a prune — a container restart, or a
// `done --keep` later cleaned up. `git worktree list` hands back a path, so a
// check that only asks "did git name a worktree for this branch" walks straight
// into `fs.existsSync` returning false and must not read that as an empty diff.
const wiped = path.join(root, "wt-restart");
git(repo, ["worktree", "add", "-q", "-b", "restart-4460", wiped]);
fs.rmSync(wiped, { recursive: true, force: true });

// And the shape where the DIRECTORY survives and git cannot read it — a
// half-finished cleanup. `fs.existsSync` says yes and every git call fails, so
// this is the one route to unknown that an existence check alone cannot take.
const broken = path.join(root, "wt-broken");
git(repo, ["worktree", "add", "-q", "-b", "half-cleaned-4470", broken]);
fs.rmSync(path.join(broken, ".git"), { recursive: true, force: true });

const ledger = (branches: string[]): string => {
  const file = path.join(root, `${branches.join("+")}.jsonl`);
  fs.writeFileSync(
    file,
    branches
      .map((branch) =>
        JSON.stringify({
          at: "2026-08-31T12:11Z",
          status: "active",
          branch,
          worktree: `wt-${branch}`,
          issues: [],
        })
      )
      .join("\n") + "\n"
  );
  return file;
};

const READABLE = [
  "write-pipeline-3276",
  "day-rollup-4500",
  "history-clock-brand-4452",
];
const LIVE = ledger(READABLE);
// `ghost-4400` never got as far as `git worktree add`, so git names no worktree
// for it at all; `restart-4460` has one git still lists and disk no longer has.
const UNREADABLE: [string, string, string][] = [
  [
    "ghost-4400",
    "no worktree was ever created",
    ledger([...READABLE, "ghost-4400"]),
  ],
  [
    "half-cleaned-4470",
    "its directory is there and git cannot read it",
    ledger([...READABLE, "half-cleaned-4470"]),
  ],
];
const GONE = ledger([...READABLE, "restart-4460"]);

/** The two ways a lane holds a path, both invisible to the other one's check. */
const HELD: [string, string, string][] = [
  [
    path.dirname(CONTESTED),
    "write-pipeline-3276",
    "an uncommitted edit beneath the directory",
  ],
  [COMMITTED, "day-rollup-4500", "a commit that is not in main"],
  [UNADDED, "write-pipeline-3276", "a new file it has not added yet"],
];

const claims = (target: string, at: string, cwd: string = repo) =>
  spawnSync(process.execPath, [SCRIPT, "claims", target], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ALLOS_DISPATCH_LEDGER: at, SCRATCH: root },
  });

describe("dispatch-brief.mjs claims <path>", () => {
  it.each(HELD)("names %s as held by %s (%s)", (target, branch, _why) => {
    const run = claims(target, LIVE);
    expect(run.stdout).toContain("CLAIMED");
    expect(run.stdout).toContain(branch);
    expect(run.status).toBe(1);
  });

  it("reports a file nobody is holding as clear", () => {
    // The converse, without which the test above passes for a command that
    // answers CLAIMED unconditionally.
    const run = claims(UNTOUCHED, LIVE);
    expect(run.stdout).toContain("CLEAR");
    expect(run.stdout).not.toContain("CLAIMED");
    expect(run.status).toBe(0);
  });

  it.each(UNREADABLE)("says CANNOT TELL for %s — %s", (branch, _why, at) => {
    const run = claims(UNTOUCHED, at);
    expect(run.stdout).toContain("CANNOT TELL");
    expect(run.stdout).toContain(branch);
    // The whole issue in one assertion: an unreadable worktree must not be
    // folded into the reassuring answer.
    expect(run.stdout).not.toContain("CLEAR");
    expect(run.status).toBe(3);
  });

  it("still names a real claim when another dispatch is unreadable", () => {
    // A claim outranks an unknown, and the unknown is still printed — an
    // answer that reported only one of the two would send the lane away
    // believing it had the whole picture.
    const run = claims(CONTESTED, GONE);
    expect(run.stdout).toContain("CLAIMED");
    expect(run.stdout).toContain("write-pipeline-3276");
    expect(run.stdout).toContain("CANNOT TELL");
    expect(run.status).toBe(1);
  });

  it("does not report a lane's own worktree back to it", () => {
    // Run from the holding lane's tree: its own edit is not a collision, and a
    // command that flagged it would be ignored within a day.
    const run = claims(CONTESTED, LIVE, holding);
    expect(run.stdout).toContain("CLEAR");
    expect(run.status).toBe(0);
  });
});

// AND THE COMMAND IS HALF THE FIX. A check nobody is told to run is not a
// control either — the issue says so in as many words — so the brief every lane
// receives has to carry both the instruction and the reason the list above it
// cannot be trusted. Driven through the real `brief` reprint, not by grepping
// the template, so what is pinned is what a lane is actually handed.
describe("the brief a lane receives", () => {
  const printed = spawnSync(
    process.execPath,
    [SCRIPT, "brief", "write-pipeline-3276"],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ALLOS_DISPATCH_LEDGER: LIVE, SCRATCH: root },
    }
  ).stdout;

  it.each([
    ["WENT STALE THE MOMENT IT WAS WRITTEN", "the list is not to be trusted"],
    ["dispatch-brief.mjs claims <path>", "and here is what to run instead"],
    ["CANNOT TELL, not clear", "with the answer that is not an answer named"],
    // A NUMBER IN PROSE, same reason this file exists: a rule that reaches lanes
    // only because someone pasted it into a brief by hand is not a control. Four
    // such bullets were in the brief this lane was handed and in NO template —
    // found by diffing the handed brief against `dispatch-brief.mjs brief`.
    ["A NUMBER IN PROSE MUST COME FROM A COMMAND YOU RAN", "the rule"],
    [
      "THIS CLONE IS SHALLOW",
      "with the receipt that cannot be recalled instead",
    ],
    ["RE-ASK IT NARROWLY", "and the same lesson pointed at greps"],
  ])("says %s (%s)", (fragment, _why) => {
    expect(printed).toContain(fragment);
  });
});

describe("the verdict rules", () => {
  it.each([
    [["clear", "clear"], "clear", "nobody is in it and everyone answered"],
    [["clear", "claimed"], "claimed", "one lane holds it"],
    [["clear", "unknown"], "unknown", "an unreadable worktree is not clear"],
    [["unknown", "claimed"], "claimed", "a named claim outranks an unknown"],
    [[], "clear", "no other active dispatches at all"],
  ])("%s -> %s (%s)", (verdicts, expected, _why) => {
    expect(
      claimsVerdict((verdicts as string[]).map((v) => ({ verdict: v })))
    ).toBe(expected);
  });

  it.each([
    ["app/x/DayLedger.tsx", "app/x/DayLedger.tsx", true],
    ["app/x/DayLedger.tsx", "app/x", true],
    ["app/x", "app/x/DayLedger.tsx", true],
    ["app/x/DayLedger.tsx", "app/x/Day", false],
    ["app/xy/DayLedger.tsx", "app/x", false],
  ])("%s overlaps %s = %s", (a, b, expected) => {
    expect(pathOverlaps(a as string, b as string)).toBe(expected);
  });
});
