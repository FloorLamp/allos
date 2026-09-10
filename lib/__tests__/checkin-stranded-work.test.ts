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

type Shape = "mutated" | "many-mutated" | "probes" | "clean" | "unreadable";

/** The base commit's tracked files. Six, so `many-mutated` can cross the
 *  four-path display cap and the "+N more" tail is an exercised branch. */
const TRACKED = ["callbacks.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];

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
  for (const f of TRACKED) {
    fs.writeFileSync(path.join(repo, f), "const REGISTRY = 1;\n");
  }
  git(repo, "add", ...TRACKED);
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
    if (shape === "many-mutated") {
      for (const f of TRACKED) {
        fs.writeFileSync(path.join(wt, f), "const REGISTRY = 2;\n");
      }
    }
    if (shape === "probes")
      fs.writeFileSync(path.join(wt, "probe.test.ts"), "");
  }
  return { root, repo };
}

/** Runs the real check-in against a fixture, with `ps` — and optionally one
 *  worktree's `git status` — replaced by stubs on PATH. */
function checkin(opts: {
  repo: string;
  ps?: string[] | "fails";
  breakStatusIn?: string;
  /** A copy of the recorder hosted inside the fixture (see buildStaleFixture). */
  script?: string;
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
  const run = spawnSync("bash", [opts.script ?? CHECKIN], {
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

  it("caps the named paths at four and says how many it hid", () => {
    const many = buildFixture(["many-mutated"]);
    const out = checkin({ repo: many.repo });
    expect(out).toContain("MUTATED, NOT SCRATCH: 6 TRACKED file(s) modified");
    expect(out.match(/ {8}modified: {2}M /g)).toHaveLength(4);
    expect(out).toContain("modified: +2 more");
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
    // And the all-clear cannot print over a tree nobody could read. That this
    // regex can match at all is proven by the sibling test above, on a fixture
    // of benign shapes — without it, an absence assertion on a pattern nothing
    // ever produces would pass forever.
    expect(out).not.toMatch(ALL_CLEAR);
  });
});

// #4960 IS THE THIRD BLIND SPOT: THE RECORDER ANSWERED FROM WHEREVER ITS
// CHECKOUT SAT. The orchestrator's checkout is commonly detached and behind
// origin/main, and every delegate that read the tree read THAT — so a
// release-notes lag printed 52 where main had 27, and a citation was 27 lines
// off. A stale coverage read fails toward "work is missing", which is the
// answer that gets acted on. The fixture below is a checkout two commits
// behind its own origin/main; the recorder and the gatherer are copied INTO it
// because both derive their repo from their own file location, by design.
const HOSTED_HELPERS = [
  "host",
  "ledger",
  "usage",
  "release-notes-gather",
  "merge-window",
] as const;

/** A commit at a fixed instant, so merge-window's day grouping is deterministic. */
function commitAt(cwd: string, date: string, subject: string) {
  const run = spawnSync("git", ["commit", "-qam", subject], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  if (run.status !== 0) throw new Error(`git commit: ${run.stderr}`);
}

const notesJson = (days: object[]) => JSON.stringify({ days });

/**
 * HEAD (detached, clean) holds a notes file whose newest day covers nothing and
 * an .nvmrc no host has; origin/main is two merges on — one user-visible (#2,
 * which also pins the running node's major) and one notes-only batch (#3) that
 * covers #2. Read at HEAD, #1 and #2 look uncovered; read at origin/main,
 * nothing is owed.
 */
function buildStaleFixture() {
  const root = makeTmpDir("checkin-stale");
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "app"), { recursive: true });
  fs.mkdirSync(path.join(repo, "lib"));
  git(repo, "init", "-q", "-b", "main", ".");
  fs.writeFileSync(path.join(repo, "app/x.ts"), "export const x = 1;\n");
  fs.writeFileSync(
    path.join(repo, "lib/release-notes.json"),
    notesJson([{ date: "2026-09-01", entries: [] }])
  );
  fs.writeFileSync(path.join(repo, ".nvmrc"), "1\n");
  git(repo, "add", "-A");
  commitAt(repo, "2026-09-01T12:00:00Z", "Base (#1)");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "-c", "push.negotiate=false", "push", "-q", "-u", "origin", "main");
  git(repo, "checkout", "-q", "--detach");
  const author = path.join(root, "author");
  git(root, "clone", "-q", origin, author);
  fs.writeFileSync(path.join(author, "app/y.ts"), "export const y = 2;\n");
  fs.writeFileSync(
    path.join(author, ".nvmrc"),
    `${process.versions.node.split(".")[0]}\n`
  );
  git(author, "add", "-A");
  commitAt(author, "2026-09-02T12:00:00Z", "Ship a thing (#2)");
  fs.writeFileSync(
    path.join(author, "lib/release-notes.json"),
    notesJson([
      {
        date: "2026-09-02",
        entries: [
          { pr: 2, kind: "feature", category: "Interface", title: "A thing" },
        ],
      },
      { date: "2026-09-01", entries: [] },
    ])
  );
  commitAt(author, "2026-09-02T13:00:00Z", "Release notes for 2026-09-02 (#3)");
  git(author, "-c", "push.negotiate=false", "push", "-q");
  const helpers = path.join(repo, "scripts/orchestration");
  fs.mkdirSync(helpers, { recursive: true });
  const script = path.join(repo, "scripts/orchestrator-checkin.sh");
  fs.copyFileSync(CHECKIN, script);
  for (const h of HOSTED_HELPERS) {
    fs.copyFileSync(
      path.join(REPO, `scripts/orchestration/${h}.mjs`),
      path.join(helpers, `${h}.mjs`)
    );
  }
  fs.appendFileSync(path.join(repo, ".git/info/exclude"), "scripts/\n");
  const head = (cwd: string) =>
    git(cwd, "rev-parse", "--short=7", "HEAD").trim();
  return { repo, script, base: head(repo), tip: head(author) };
}

describe("a checkout behind origin/main answers from origin/main, and says so", () => {
  const fx = buildStaleFixture();
  const out = checkin({ repo: fx.repo, script: fx.script });

  it("prints the checkout's position with both SHAs, and never moves it", () => {
    expect(out).toContain(
      `checkout: ${fx.base} (detached, clean) — 2 behind origin/main ${fx.tip}`
    );
    expect(out).toContain(`tree reads below answer from origin/main ${fx.tip}`);
    expect(git(fx.repo, "rev-parse", "--short=7", "HEAD").trim()).toBe(fx.base);
  });

  it("reads .nvmrc at origin/main's tip, where HEAD's would read ABSENT", () => {
    // origin/main pins the node running this test, so the resolver answers
    // with its own bin dir; HEAD pins a major no host has.
    expect(out).toContain(
      `node(.nvmrc @ origin/main ${fx.tip}): ${path.dirname(process.execPath)}`
    );
  });

  it("counts the release-notes lag against origin/main's notes", () => {
    const gather = (...args: string[]) => {
      const run = spawnSync(
        process.execPath,
        [
          path.join(fx.repo, "scripts/orchestration/release-notes-gather.mjs"),
          "--check",
          ...args,
        ],
        { encoding: "utf8", timeout: 60_000 }
      );
      expect(run.status).toBe(0);
      return run.stdout.trim();
    };
    expect(gather()).toBe(
      `release notes: current through 2026-09-02 [notes @ origin/main ${fx.tip}]`
    );
    // THE STALE READ, ON REQUEST — and the positive control: the same fixture
    // read at HEAD reports the incident's shape, merges "uncovered" that main's
    // notes already cover, and the label says where that number came from.
    expect(gather("--ref", "HEAD")).toBe(
      "release notes: 2 user-visible merge(s) uncovered since 2026-09-01 (#1, #2) " +
        `— batch them (docs/orchestration/dispatch.md, Release notes) [notes @ HEAD ${fx.base}]`
    );
  });

  it("reports, and does not move, a checkout holding local work", () => {
    const held = buildStaleFixture();
    fs.writeFileSync(path.join(held.repo, "app/x.ts"), "export const x = 3;\n");
    const out = checkin({ repo: held.repo, script: held.script });
    expect(out).toContain(
      `checkout: ${held.base} (detached, 1 uncommitted) — 2 behind origin/main ${held.tip}`
    );
    expect(out).toContain("holds local work");
    expect(out).not.toContain("--ff-only");
    expect(git(held.repo, "rev-parse", "--short=7", "HEAD").trim()).toBe(
      held.base
    );
    expect(fs.readFileSync(path.join(held.repo, "app/x.ts"), "utf8")).toBe(
      "export const x = 3;\n"
    );
  });

  it("says == origin/main once the checkout is current", () => {
    const fresh = buildStaleFixture();
    git(fresh.repo, "fetch", "-q", "origin", "main");
    git(fresh.repo, "merge", "-q", "--ff-only", "origin/main");
    expect(checkin({ repo: fresh.repo, script: fresh.script })).toContain(
      `checkout: ${fresh.tip} (detached, clean) — == origin/main ${fresh.tip}`
    );
  });
});
