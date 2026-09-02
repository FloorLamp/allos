// The dispatch stall detector (#2988).
//
// What is pinned here is a FALSE-ALARM FLOOR, not a feature. `dispatch-brief.mjs
// list` used to flag a dispatch on elapsed time since its ledger entry, which
// cannot tell one wedged agent from four agents in sequence on one branch across
// restarts and review rounds — so on 2026-08-16 it branded the two hardest
// dispatches in the session STALL, twice, while both trees were being written to
// by the minute. An alarm that fires when nothing is wrong teaches its reader to
// skim it, and the one time it is right it gets skimmed too.
//
// So both directions are asserted, and the first matters more:
//
//   1. A dispatch whose branch or worktree MOVED recently does not warn, however
//      old it is. This is the regression that was actually observed.
//   2. A dispatch with nothing moving for the threshold DOES warn, however young
//      it is — age must stop being what trips the warning in both directions, not
//      just the noisy one.
//   3. A dispatch that has left NO TRACE warns once it is past its grace period.
//      Both signals #2988 proposes are absent in the only stall this runbook has
//      actually measured (the 12.9-hour denied-and-idle agent of 2026-08-10,
//      whose `git worktree add` was refused and
//      which therefore had neither a worktree nor a branch), so a detector built
//      on those two signals alone would be blind exactly where the noisy one was
//      merely loud.
//
// Importing the script must not RUN it: `new` is its default command and would
// write to the live ledger and the live roster. The CLI entry is guarded, and
// the guard is asserted below rather than trusted.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  NO_TRACE_GRACE_MS,
  branchGitArgs,
  commitIdleMs,
  idleMsFrom,
  resumeState,
  stallVerdict,
  worktreeIdleMs,
} from "../../scripts/work/dispatch-brief.mjs";
import { makeTmpDir } from "./tmp-dir";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/work/dispatch-brief.mjs");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The live session's shape: median dispatch ~85m, so the threshold is ~4h15m. */
const THRESHOLD = 3 * 85 * MINUTE;

const temps: string[] = [];

function tempDir(): string {
  const dir = makeTmpDir("stall");
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

const iso = (ms: number): string => new Date(ms).toISOString();

describe("branchGitArgs", () => {
  it("keeps a hostile branch literal in one argv element", () => {
    const branch = "x/$(printf injected); echo still-data";
    const args = branchGitArgs(branch);
    expect([
      args.localLog.at(-1),
      args.remoteLog.at(-1),
      args.remoteExists.at(-1),
      args.localExists.at(-1),
      args.deleteLocal.at(-1),
    ]).toEqual([
      `refs/heads/${branch}`,
      `refs/remotes/origin/${branch}`,
      `refs/remotes/origin/${branch}`,
      `refs/heads/${branch}`,
      branch,
    ]);
  });
});

/**
 * A ledger file in `dir`, and its path.
 *
 * The roster is derived from the ledger's directory, so pointing
 * `ALLOS_DISPATCH_LEDGER` at a temp dir keeps a test out of the LIVE roster —
 * testing the arrival warning once put three fake dispatches into the real one
 * and the next check-in reported eight clusters for five agents.
 */
function ledgerIn(dir: string, rows: Record<string, unknown>[]): string {
  const file = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

describe("stallVerdict", () => {
  it("does not warn about an old dispatch whose work is still moving", () => {
    // The 2026-08-16 false alarm, as measured: claude/db-substrate-truth at
    // age 4h59m with 18 files written in the preceding fifteen minutes.
    expect(
      stallVerdict({
        ageMs: 4 * HOUR + 59 * MINUTE,
        idleMs: 2 * MINUTE,
        thresholdMs: THRESHOLD,
      })
    ).toEqual({ kind: "moving", alarm: false });
  });

  it("does not warn however old the dispatch gets, while it keeps moving", () => {
    // A branch that changes hands across two restarts and three review rounds
    // outlives its original agent by design. Age is displayed, never decisive.
    for (const ageMs of [6 * HOUR, 13 * HOUR, 48 * HOUR]) {
      expect(
        stallVerdict({ ageMs, idleMs: 9 * MINUTE, thresholdMs: THRESHOLD })
      ).toEqual({ kind: "moving", alarm: false });
    }
  });

  it("warns about a dispatch with nothing moving, however young it is", () => {
    // `adopt` on an abandoned tree makes this reachable in minutes: the ledger
    // entry is two minutes old and the work it points at died hours ago.
    expect(
      stallVerdict({
        ageMs: 2 * MINUTE,
        idleMs: THRESHOLD + MINUTE,
        thresholdMs: THRESHOLD,
      })
    ).toEqual({ kind: "stalled", alarm: true });
  });

  it("holds fire exactly at the threshold, and fires past it", () => {
    expect(
      stallVerdict({
        ageMs: 9 * HOUR,
        idleMs: THRESHOLD,
        thresholdMs: THRESHOLD,
      })
    ).toEqual({ kind: "moving", alarm: false });
    expect(
      stallVerdict({
        ageMs: 9 * HOUR,
        idleMs: THRESHOLD + 1,
        thresholdMs: THRESHOLD,
      })
    ).toEqual({ kind: "stalled", alarm: true });
  });

  it("never warns on idleness when the ledger has no median to judge it by", () => {
    // A degenerate sample is a false-alarm generator — the guard that already
    // exists for the median must not be routed around by the new signal.
    expect(
      stallVerdict({ ageMs: 20 * HOUR, idleMs: 19 * HOUR, thresholdMs: null })
    ).toEqual({ kind: "moving", alarm: false });
  });

  it("warns about a dispatch that has left no trace at all, past its grace", () => {
    // The denied-and-idle stall: no worktree, no branch, nothing to measure.
    expect(
      stallVerdict({
        ageMs: NO_TRACE_GRACE_MS,
        idleMs: null,
        thresholdMs: THRESHOLD,
      })
    ).toEqual({ kind: "no-trace", alarm: true });
    // And with no median either — this alarm does not depend on the ledger
    // having a distribution, because the absence of a trace is self-evident.
    expect(
      stallVerdict({ ageMs: 13 * HOUR, idleMs: null, thresholdMs: null })
    ).toEqual({ kind: "no-trace", alarm: true });
  });

  it("stays silent while a fresh dispatch is still building its worktree", () => {
    expect(
      stallVerdict({
        ageMs: NO_TRACE_GRACE_MS - MINUTE,
        idleMs: null,
        thresholdMs: THRESHOLD,
      })
    ).toEqual({ kind: "starting", alarm: false });
  });
});

describe("idleMsFrom", () => {
  it("takes the most recent movement, so either witness silences the alarm", () => {
    // Fresh commit, quiet tree: an agent that just banked and is now reading.
    expect(
      idleMsFrom({ worktreeIdleMs: 40 * MINUTE, branchIdleMs: MINUTE })
    ).toBe(MINUTE);
    // Fresh writes, old tip: an agent mid-edit that has not committed yet.
    expect(
      idleMsFrom({ worktreeIdleMs: MINUTE, branchIdleMs: 40 * MINUTE })
    ).toBe(MINUTE);
  });

  it("does not call a brand-new worktree idle because main's tip is old", () => {
    // A dispatch branched from an origin/main whose last commit landed three
    // hours ago starts life with a three-hour-old tip and a second-old tree.
    expect(idleMsFrom({ worktreeIdleMs: 1_000, branchIdleMs: 3 * HOUR })).toBe(
      1_000
    );
  });

  it("uses whichever signal exists when the other does not", () => {
    expect(idleMsFrom({ worktreeIdleMs: null, branchIdleMs: 5 * MINUTE })).toBe(
      5 * MINUTE
    );
    expect(idleMsFrom({ worktreeIdleMs: 5 * MINUTE, branchIdleMs: null })).toBe(
      5 * MINUTE
    );
  });

  it("reports no signal rather than zero when neither exists", () => {
    // `0` would read as "moving right now" — the most dangerous possible answer
    // to "we cannot see this dispatch at all".
    expect(idleMsFrom({ worktreeIdleMs: null, branchIdleMs: null })).toBeNull();
  });
});

describe("commitIdleMs", () => {
  it("measures back from a git committer timestamp", () => {
    const now = Date.parse("2026-08-16T07:12:00Z");
    expect(commitIdleMs("2026-08-16T06:57:00Z", now)).toBe(15 * MINUTE);
  });

  it("reports no signal — never zero — for anything git could not answer", () => {
    for (const answer of [null, "", "not a date"]) {
      expect(commitIdleMs(answer, Date.now())).toBeNull();
    }
  });

  it("never reports negative idleness from a clock skewed into the future", () => {
    const now = Date.parse("2026-08-16T07:12:00Z");
    expect(commitIdleMs("2026-08-16T07:30:00Z", now)).toBe(0);
  });
});

describe("worktreeIdleMs", () => {
  it("sees a file written in the tree", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "lib"));
    fs.writeFileSync(
      path.join(dir, "lib", "edit.ts"),
      "export const one = 1;\n"
    );
    const idle = worktreeIdleMs(dir);
    expect(idle).not.toBeNull();
    expect(idle!).toBeLessThan(30_000);
  });

  it("ignores node_modules and .git", () => {
    // Both are shared with the parent checkout — node_modules by hardlink, .git
    // by every OTHER worktree's commits — so counting them would make every tree
    // look permanently busy, which is the false alarm one level down.
    const dir = tempDir();
    for (const shared of ["node_modules", ".git"]) {
      fs.mkdirSync(path.join(dir, shared));
      fs.writeFileSync(path.join(dir, shared, "busy"), "written just now\n");
    }
    fs.mkdirSync(path.join(dir, "lib"));
    const old = path.join(dir, "lib", "quiet.ts");
    fs.writeFileSync(old, "export const one = 1;\n");
    const longAgo = new Date(Date.now() - 6 * HOUR);
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(path.join(dir, "lib"), longAgo, longAgo);
    fs.utimesSync(dir, longAgo, longAgo);

    const idle = worktreeIdleMs(dir);
    expect(idle).not.toBeNull();
    expect(idle!).toBeGreaterThan(5 * HOUR);
  });

  it("reports no signal for a tree that is not there", () => {
    expect(worktreeIdleMs(path.join(tempDir(), "never-created"))).toBeNull();
  });
});

describe("resumeState", () => {
  it("restores the last promotion unless another candidate is active", () => {
    const old = {
      at: iso(Date.now() - 5 * HOUR),
      status: "active",
      branch: "x/old",
      candidate: true,
    };
    const next = {
      at: iso(Date.now() - 4 * HOUR),
      status: "active",
      branch: "x/next",
      candidate: false,
    };
    const promoted = [
      old,
      next,
      {
        at: iso(Date.now() - 3 * HOUR),
        status: "promotion",
        target: "x/next",
        displaced: "x/old",
      },
      { at: iso(Date.now() - 2 * HOUR), status: "done", branch: "x/old" },
      { at: iso(Date.now() - HOUR), status: "done", branch: "x/next" },
    ];

    expect(resumeState(promoted, "x/old").candidate).toBe(false);
    expect(resumeState(promoted, "x/next").candidate).toBe(true);

    const collision = [
      old,
      { at: iso(Date.now() - 2 * HOUR), status: "done", branch: "x/old" },
      { ...next, branch: "x/current", candidate: true },
    ];
    expect(resumeState(collision, "x/old").candidate).toBe(false);
  });
});

describe("the dispatch-brief CLI", () => {
  it("still answers every subcommand it is the only tooling for", () => {
    // A rename or a dropped branch in the dispatcher strands the worker
    // and every agent at once, so the command surface is asserted rather than
    // assumed. These commands are each
    // named somewhere in a live runbook.
    const run = spawnSync(process.execPath, [SCRIPT, "no-such-command"], {
      encoding: "utf8",
      env: { ...process.env, ALLOS_DISPATCH_LEDGER: ledgerIn(tempDir(), []) },
    });
    expect(run.status).toBe(2);
    for (const cmd of [
      "new",
      "list",
      "brief",
      "promote",
      "update",
      "done",
      "resume",
      "adopt",
    ]) {
      expect(run.stderr).toContain(cmd);
    }
  });

  it("prints idle beside age, and flags only the dispatch with no trace", () => {
    // End to end over cmdList's real output. Neither branch exists in any
    // checkout, so both measure as no-trace and the ONLY thing separating them
    // is how long they have had to leave one.
    const now = Date.now();
    const hostile = "$(printf main)";
    const ledger = ledgerIn(tempDir(), [
      { at: iso(now - 2 * MINUTE), status: "active", branch: "x/just-started" },
      { at: iso(now - 13 * HOUR), status: "active", branch: "x/never-started" },
      { at: iso(now - 2 * MINUTE), status: "active", branch: hostile },
    ]);
    const run = spawnSync(process.execPath, [SCRIPT, "list"], {
      encoding: "utf8",
      env: { ...process.env, ALLOS_DISPATCH_LEDGER: ledger },
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.split("\n");
    const started = lines.find((l) => l.includes("x/just-started"))!;
    const never = lines.find((l) => l.includes("x/never-started"))!;

    expect(started).toContain("age=0h02m");
    expect(started).toContain("idle=(no trace)");
    expect(started).not.toContain("<<");

    expect(never).toContain("age=13h00m");
    expect(never).toContain("NO WORKTREE AND NO BRANCH");
    expect(lines.find((line) => line.includes(hostile))).toContain(
      "idle=(no trace)"
    );
  });

  it("persists candidate promotion and prints distinct candidate and banked briefs", () => {
    const dir = tempDir();
    const ledger = ledgerIn(dir, []);
    const env = { ...process.env, ALLOS_DISPATCH_LEDGER: ledger };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        env,
      });

    const first = run(
      "new",
      "--branch",
      "x/first",
      "--candidate",
      "--priority",
      "P1",
      "--lane",
      "user-data"
    );
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("LANDING STATE: CANDIDATE");
    expect(first.stdout).toContain("Open or refresh the PR READY");
    expect(first.stdout).toContain("BASE_SHA=$(git rev-parse FETCH_HEAD)");
    expect(first.stdout).toContain('echo "PINNED_BASE_SHA=$BASE_SHA"');
    expect(first.stdout).toContain("reset or rewrite against the printed SHA");

    const second = run(
      "new",
      "--branch",
      "x/second",
      "--priority",
      "P2",
      "--lane",
      "operator"
    );
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("LANDING STATE: BANKED");
    expect(second.stdout).toContain(
      "Do not open a PR while this branch is banked"
    );

    const promoted = run("promote", "x/second");
    expect(promoted.status).toBe(0);
    expect(promoted.stdout).toContain("displaced x/first to banked");
    expect(promoted.stdout).toContain("ROLE UPDATE for x/second: CANDIDATE");
    expect(promoted.stdout).toContain("ROLE UPDATE for x/first: BANKED");
    const promotionRows = fs
      .readFileSync(ledger, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.status === "promotion");
    expect(promotionRows).toEqual([
      expect.objectContaining({
        status: "promotion",
        target: "x/second",
        displaced: "x/first",
      }),
    ]);
    expect(
      fs
        .readFileSync(ledger, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.status === "update" && "candidate" in row)
    ).toEqual([]);

    const firstBrief = run("brief", "x/first");
    const secondBrief = run("brief", "x/second");
    expect(firstBrief.stdout).toContain("LANDING STATE: BANKED");
    expect(firstBrief.stdout).toContain(
      "Defer them until promotion; the landing candidate's CI runs them."
    );
    expect(firstBrief.stdout).not.toContain("Push, and read candidate CI.");
    expect(secondBrief.stdout).toContain("LANDING STATE: CANDIDATE");

    const listed = run("list");
    expect(listed.stdout).toContain("x/first");
    expect(listed.stdout).toContain("[banked]");
    expect(listed.stdout).toContain("x/second");
    expect(listed.stdout).toContain("[candidate]");
    expect(listed.stdout).toContain("priority=P2  lane=operator");

    const updated = run(
      "update",
      "x/first",
      "--priority",
      "P3",
      "--lane",
      "presentation-guard"
    );
    expect(updated.status).toBe(0);
    expect(updated.stdout).toContain("priority=P3 lane=presentation-guard");
    const recovered = run("list");
    expect(recovered.stdout).toContain("priority=P3  lane=presentation-guard");

    const invalid = run("update", "x/first", "--priority", "P9");
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("invalid priority P9");
  });
});
