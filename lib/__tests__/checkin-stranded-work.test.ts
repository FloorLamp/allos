import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE FLIGHT RECORDER'S TWO BLIND SPOTS, EXECUTED RATHER THAN PINNED.
//
// #5305: eight shells sat spinning `sleep` for up to 8h55m waiting for gate
// runs that had ended hours before, and nothing in the check-in could see them.
// #5281: a killed falsifying pass left `lib/notifications/telegram-callbacks.ts`
// modified in a detached, commitless worktree, and the recorder called that
// worktree scratch — so the next reader's baseline would have been taken
// against mutated source, where the mutation it was about to make is already
// present and reds nothing.
//
// Both are one defect: a reporter answering a question it never asked. So these
// run the real script against a fixture checkout rather than pinning its text —
// a text pin cannot tell a classifier that runs from one written below an early
// `continue`, and it certainly cannot tell an honest count from a suppressed
// failure that fell back to zero.
//
// The fixture is offline BY CONSTRUCTION: a repo with no `origin` (the script
// announces the failed fetch and carries on) and a pre-written `.queue` inside
// the 4h cadence, so no snapshot sweep reaches for the network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CHECKIN = path.join(REPO, "scripts/orchestrator-checkin.sh");
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).stdout.trim();

/** A `ps -eo pid=,etimes=,args=` row: elapsed SECONDS in the middle column. */
const PS_ROWS = {
  strandedPgrep:
    '  537   32117 /bin/bash -c until ! pgrep -f "agent-gates.sh" >/dev/null; do sleep 15; done',
  strandedBracket:
    "  1581   10593 /bin/bash -c until ! ps -eo args | grep -q '[a]gent-gates.sh'; do sleep 15; done",
  // The self-match this probe must be STRUCTURALLY immune to: a process born
  // inside the probe's own pipeline carries the search text and is seconds old.
  freshWaiter:
    '  4242      12 /bin/bash -c until ! pgrep -f "agent-gates.sh"; do sleep 15; done',
  // An old process that is not a wait loop — including a gate run genuinely
  // taking hours, which must never be reported as a stranded waiter.
  oldGateRun: "  9001   99999 bash scripts/orchestration/agent-gates.sh",
} as const;

// BOTH SPELLINGS OF THE ALL-CLEAR, because which one prints depends on the
// restart verdict and a fixture only ever reaches one of them. Keyed on the
// half that is unique to the all-clear: `nothing to rescue` alone also appears
// in the per-tree "clean — nothing to rescue" note.
const ALL_CLEAR = /every tree was clean and pushed|no rescue targets/;

type Shape = "mutated" | "probes" | "clean" | "unreadable";

function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout;
}

/**
 * A checkout plus one detached, commitless worktree per requested shape — the
 * population #5281 is about, with every member's position relative to the new
 * tracked-vs-untracked boundary chosen deliberately.
 */
function buildFixture(shapes: readonly Shape[]) {
  const root = makeTmpDir("checkin-fixture");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main", ".");
  git(repo, "config", "user.email", "fixture@example.test");
  git(repo, "config", "user.name", "fixture");
  fs.writeFileSync(path.join(repo, "callbacks.ts"), "const REGISTRY = 1;\n");
  git(repo, "add", "callbacks.ts");
  git(repo, "commit", "-qm", "base");
  for (const shape of shapes) {
    const wt = path.join(root, `wt-${shape}`);
    git(repo, "worktree", "add", "-q", "--detach", wt);
    if (shape === "mutated") {
      // A pass lane's working method: the tracked file edited in place, beside
      // the untracked probes that made the old classifier call it scratch.
      fs.writeFileSync(path.join(wt, "callbacks.ts"), "const REGISTRY = 2;\n");
      fs.writeFileSync(path.join(wt, "probe.test.ts"), "");
    }
    if (shape === "probes") fs.writeFileSync(path.join(wt, "probe.test.ts"), "");
  }
  return { root, repo };
}

/** Runs the real check-in against a fixture, with `ps` — and optionally one
 *  worktree's `git status` — replaced by stubs on PATH. */
function checkin(opts: {
  repo: string;
  ps?: string[] | "fails";
  breakStatusIn?: string;
}) {
  const bin = makeTmpDir("checkin-stub-bin");
  const rows = opts.ps ?? [];
  fs.writeFileSync(
    path.join(bin, "ps"),
    rows === "fails"
      ? "#!/bin/sh\necho 'ps: cannot read /proc' >&2\nexit 1\n"
      : `#!/bin/sh\ncat <<'ROWS'\n${rows.join("\n")}\nROWS\n`,
    { mode: 0o755 }
  );
  if (opts.breakStatusIn) {
    // A probe that CANNOT RUN, simulated at the one call site under test.
    // Every other git read passes straight through, so the run is otherwise real.
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n  *" -C ${opts.breakStatusIn} status "*)\n` +
        "    echo 'fatal: index file corrupt' >&2; exit 128;;\nesac\n" +
        `exec ${REAL_GIT} "$@"\n`,
      { mode: 0o755 }
    );
  }
  const state = makeTmpDir("checkin-state");
  fs.writeFileSync(
    path.join(state, ".queue"),
    "0 candidates as of 2026-09-05T00:00Z (0 under dispatch)\n"
  );
  const run = spawnSync("bash", [CHECKIN], {
    cwd: opts.repo,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, SCRATCH: state, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(run.status).toBe(0);
  return run.stdout;
}

/** The recorder's line for one worktree, by directory name. */
const lineFor = (out: string, name: string) =>
  out.split("\n").find((l) => l.trim().startsWith(name)) ?? "";

describe("a detached commitless worktree is classified by what it changed", () => {
  const all = buildFixture(["mutated", "probes", "clean"]);
  const out = checkin({ repo: all.repo });

  it.each([
    [
      "wt-mutated",
      "MUTATED, NOT SCRATCH: 1 TRACKED file(s) modified",
      "so this is scratch",
    ],
    ["wt-probes", "1 untracked probe file(s)", "MUTATED"],
    ["wt-clean", "clean — nothing to rescue", "MUTATED"],
  ])("%s says %s", (name, says, saysNot) => {
    expect(lineFor(out, name)).toContain(says);
    expect(lineFor(out, name)).not.toContain(saysNot);
  });

  it("names the modified path, and only the tracked one", () => {
    // A reader must tell a source file from a fixture without opening the tree;
    // accepting the summary instead is how #5281 happened.
    expect(out).toContain("modified:  M callbacks.ts");
    // The untracked file in the SAME tree is not a rescue subject, so the count
    // above and the paths below are both the TRACKED set, not the dirty set.
    expect(out).not.toContain("probe.test.ts");
  });

  it("withholds the all-clear, which this fixture can otherwise print", () => {
    expect(out).not.toMatch(ALL_CLEAR);
    // THE POSITIVE CONTROL, through the same regex and the same runner: drop
    // the mutated tree and the very same fixture prints it. Without this the
    // assertion above passes on any output that merely words it differently.
    const benign = buildFixture(["probes", "clean"]);
    expect(checkin({ repo: benign.repo })).toMatch(ALL_CLEAR);
  });
});

describe("wait loops older than any gate run are counted", () => {
  const { repo } = buildFixture(["clean"]);

  it.each([
    [
      "both stranded shapes, self-matching and bracketed",
      [PS_ROWS.strandedPgrep, PS_ROWS.strandedBracket],
      "waiters: 2 shell wait loop(s) older than 60 min",
    ],
    [
      "a fresh waiter and a long real gate run are both excluded",
      [PS_ROWS.freshWaiter, PS_ROWS.oldGateRun],
      "waiters: 0 shell wait loop(s) older than 60 min",
    ],
    [
      "the probe's own pipeline cannot inflate the count",
      [PS_ROWS.strandedPgrep, PS_ROWS.freshWaiter, PS_ROWS.oldGateRun],
      "waiters: 1 shell wait loop(s) older than 60 min",
    ],
  ])("%s", (_case, ps, expected) => {
    expect(checkin({ repo, ps })).toContain(expected);
  });

  it("names the stranded PIDs and their age", () => {
    const out = checkin({
      repo,
      ps: [PS_ROWS.strandedPgrep, PS_ROWS.strandedBracket],
    });
    expect(out).toContain("537(535m) 1581(176m)");
    expect(out).toContain("never pkill -f");
  });

  it("says how many the four-PID cap hid", () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      PS_ROWS.strandedPgrep.replace("537", `${601 + i}`)
    );
    const out = checkin({ repo, ps: five });
    expect(out).toContain("waiters: 5 shell wait loop(s)");
    expect(out).toContain("+1 more");
  });
});

// #5241 IS WHY THIS BLOCK EXISTS. Five check-in helper calls named a directory
// that had been renamed, every one `2>/dev/null`-suppressed into a plausible
// wrong answer, and one of them printed a divergence alarm naming every live
// lane. A new probe that cannot run must therefore say so — the failure to fear
// is not a wrong number, it is a confident zero.
describe("a probe that cannot run says so instead of answering", () => {
  it("reports UNMEASURED when ps fails, never a count of zero", () => {
    const { repo } = buildFixture(["clean"]);
    const out = checkin({ repo, ps: "fails" });
    expect(out).toContain("waiters: *** UNMEASURED");
    expect(out).not.toMatch(/waiters: \d/);
  });

  it("reports UNREAD when a worktree's status fails, never clean", () => {
    const fx = buildFixture(["probes", "unreadable"]);
    const out = checkin({
      repo: fx.repo,
      breakStatusIn: path.join(fx.root, "wt-unreadable"),
    });
    const line = lineFor(out, "wt-unreadable");
    expect(line).toContain("STATUS UNREAD");
    expect(line).not.toContain("clean — nothing to rescue");
    // And the all-clear cannot print over a tree nobody could read. The control
    // for this one is the sibling test above: the same two benign shapes DO
    // print it once no read has failed.
    expect(out).not.toMatch(ALL_CLEAR);
  });
});
