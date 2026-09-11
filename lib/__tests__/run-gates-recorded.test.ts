import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE WAITING IDIOM IS A SCRIPT NOW (#5385, #5366), and this runs it for real
// against a stub gate and a stub resolver. The four-line paste it replaces was
// folded into one `&&` chain by two lanes on 2026-09-06 and backgrounded whole:
// `$L` empty in the foreground, `.pid` in the main checkout, a finished gate
// reported KILLED. What the script owes is that the three files land under the
// resolved state dir whatever the caller's cwd, that the exit code travels
// through `.exit` intact, and that `--wait` blocks on the RECORDED PID — a fact
// no sibling's process name can impersonate — and not on anything else.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** A helpers dir holding the real script beside a stub gate and resolver. */
function harness(gateExit: number) {
  const tmp = makeTmpDir("run-gates-recorded");
  const helpers = path.join(tmp, "helpers");
  const state = path.join(tmp, "state");
  const cwd = path.join(tmp, "worktree");
  fs.mkdirSync(helpers);
  fs.mkdirSync(state);
  fs.mkdirSync(cwd);
  fs.copyFileSync(
    path.join(REPO, "scripts/orchestration/run-gates-recorded.sh"),
    path.join(helpers, "run-gates-recorded.sh")
  );
  const setGate = (exit: number, sleepSeconds = 0) =>
    fs.writeFileSync(
      path.join(helpers, "agent-gates.sh"),
      `#!/bin/sh\necho "=== GATE lint: PASS ==="\n` +
        (sleepSeconds ? `sleep ${sleepSeconds}\n` : "") +
        `echo "stub gates exiting ${exit}"\nexit ${exit}\n`,
      { mode: 0o755 }
    );
  setGate(gateExit);
  // The resolver answers from the environment, or refuses like the real one.
  fs.writeFileSync(
    path.join(helpers, "host.mjs"),
    'if (!process.env.TEST_STATE_DIR) { console.error("host.mjs: boom"); process.exit(1); }\nconsole.log(process.env.TEST_STATE_DIR);\n'
  );
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [path.join(helpers, "run-gates-recorded.sh"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, TEST_STATE_DIR: state, ...env },
      timeout: 30_000,
    });
  const script = path.join(helpers, "run-gates-recorded.sh");
  return { helpers, state, cwd, run, script, setGate };
}

/** Start a run through the script and read back what it says it recorded. */
function startRun(h: ReturnType<typeof harness>, branch: string) {
  const run = h.run([branch]);
  return {
    run,
    log: /\blog:? (\S+)/.exec(run.stdout)?.[1],
    runId: /\(run ([^)]+)\)/.exec(run.stdout)?.[1],
  };
}

/**
 * The record `start` writes — a run's own three files plus the branch pointer
 * at them — without running a gate. Answers the run's own log path.
 */
function fabricateRun(
  state: string,
  branch: string,
  runId: string,
  files: { log?: string; pid?: string; exit?: string }
) {
  const base = `gates-${branch}-${runId}.log`;
  const run = path.join(state, base);
  if (files.log !== undefined) fs.writeFileSync(run, files.log);
  if (files.pid !== undefined) fs.writeFileSync(`${run}.pid`, files.pid);
  if (files.exit !== undefined) fs.writeFileSync(`${run}.exit`, files.exit);
  const stable = path.join(state, `gates-${branch}.log`);
  fs.symlinkSync(base, stable);
  fs.symlinkSync(`${base}.pid`, `${stable}.pid`);
  fs.symlinkSync(`${base}.exit`, `${stable}.exit`);
  return run;
}

/** Age a recorded run's three files, so a sweep sees them as a day old. */
function backdate(log: string, hoursAgo = 25) {
  const when = (Date.now() - hoursAgo * 3_600_000) / 1000;
  for (const p of [log, `${log}.pid`, `${log}.exit`])
    if (fs.existsSync(p)) fs.utimesSync(p, when, when);
}

describe("run-gates-recorded.sh", () => {
  it.each([
    [0, 0],
    [3, 3],
  ])(
    "records log, pid and exit under the state dir and exits with the gates' code %i",
    (gateExit, expected) => {
      const h = harness(gateExit);
      const run = h.run(["some-branch"]);
      expect(run.status).toBe(expected);
      expect(run.stdout).toContain(`GATES EXIT=${gateExit}`);
      expect(run.stdout).toContain(`stub gates exiting ${gateExit}`);
      const log = path.join(h.state, "gates-some-branch.log");
      expect(fs.readFileSync(`${log}.exit`, "utf8").trim()).toBe(
        String(gateExit)
      );
      expect(fs.readFileSync(`${log}.pid`, "utf8").trim()).toMatch(/^\d+$/);
      expect(fs.readFileSync(log, "utf8")).toContain("=== GATE lint: PASS ===");
      // The defect this replaces: nothing lands in the caller's cwd.
      expect(fs.readdirSync(h.cwd)).toEqual([]);
    }
  );

  it("--wait blocks on the recorded PID and reports the exit that run wrote", () => {
    const h = harness(0);
    const log = fabricateRun(h.state, "br", "20260911T000000Z-1", {});
    // A run in flight whose starting shell is gone — the detached shape: bash
    // backgrounds the run, records `$!`, and exits, so the run is reparented
    // to init and reaped there. (A child of THIS process would stay a zombie
    // while the worker sits in spawnSync, and a zombie still answers
    // `kill -0`.) Nothing here is named agent-gates.sh, so a wait by name
    // would find nothing and return at once.
    const starter = spawnSync(
      "bash",
      [
        "-c",
        `{ sleep 1; echo 7 > "${log}.exit"; echo done > "${log}"; } >/dev/null 2>&1 & echo $!`,
      ],
      { encoding: "utf8" }
    );
    fs.writeFileSync(`${log}.pid`, starter.stdout);
    const started = Date.now();
    const run = h.run(["br", "--wait"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(run.status).toBe(7);
    expect(run.stdout).toContain("GATES EXIT=7");
  });

  it("--wait with a dead run and no exit file says KILLED, never a code", () => {
    const h = harness(0);
    // A pid that is certainly not alive: our own child that has already exited.
    const gone = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
    fabricateRun(h.state, "br", "20260911T000000Z-1", {
      log: "partial output\n",
      pid: gone.stdout,
    });
    const run = h.run(["br", "--wait"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("GATES EXIT=KILLED — no exit recorded");
  });

  it.each([
    [
      ["br"],
      { TEST_STATE_DIR: "" },
      ["STATE-DIR RESOLVER FAILED", "host.mjs: boom"],
    ],
    [["br", "--frob"], {}, ["unknown mode --frob"]],
  ])(
    "refuses before running — args %j, env %j — and touches nothing",
    (args, env, fragments) => {
      const h = harness(0);
      const run = h.run(args, env);
      expect(run.status).toBe(2);
      for (const f of fragments) expect(run.stderr).toContain(f);
      expect(fs.readdirSync(h.state)).toEqual([]);
    }
  );

  // A BRANCH NAME WITH A `/` IN IT (#5761). `$L` is built by interpolating the
  // branch, so `codex/foo` names a DIRECTORY that nothing creates. The `start`
  // redirection then fails before agent-gates.sh is invoked, no gate runs at
  // all, and the report said `KILLED`. A flat branch name reproduces none of
  // that, which is why every case above passed while this was broken.
  it("runs the gates for a branch whose name contains a slash", () => {
    const h = harness(0);
    const branch = "codex/slash-named-5761";
    const run = h.run([branch]);
    // The gates RAN: the stub's own line is in the log and in the report.
    expect(run.stdout).toContain("stub gates exiting 0");
    expect(run.stdout).not.toContain("KILLED");
    expect(run.status).toBe(0);
    const log = path.join(h.state, `gates-${branch}.log`);
    expect(fs.readFileSync(log, "utf8")).toContain("=== GATE lint: PASS ===");
    expect(fs.readFileSync(`${log}.exit`, "utf8").trim()).toBe("0");
    // `--wait` needs the same directory to have existed when `$!` was recorded.
    expect(fs.readFileSync(`${log}.pid`, "utf8").trim()).toMatch(/^\d+$/);
    expect(fs.readdirSync(h.cwd)).toEqual([]);
  });

  it("a slash-named run that fails still reports the gates' own code", () => {
    // The positive control for the case above: creating the directory must not
    // turn a real gate failure into a pass.
    const h = harness(3);
    const run = h.run(["codex/slash-named-5761"]);
    expect(run.status).toBe(3);
    expect(run.stdout).toContain("GATES EXIT=3");
  });

  it("a run that never started says so, and is not reported as KILLED", () => {
    // The redirection creates the log as its first act, so no log means
    // agent-gates.sh was never invoked. "Killed" names a cause that did not
    // happen — a session limit, an OOM — and sends the reader to re-run.
    const h = harness(0);
    const gone = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
    const log = fabricateRun(h.state, "br", "20260911T000000Z-1", {
      pid: gone.stdout,
    });
    const run = h.run(["br", "--wait"]);
    expect(run.stdout).not.toContain("KILLED");
    expect(run.stderr).toContain("NOTHING RAN");
    expect(run.stderr).toContain(log);
    expect(run.status).toBe(2);
  });

  // THE REPLAY FACE (#5712). `--wait` collects a run that has ALREADY finished
  // far more often than it waits on a live one — that is the detached-start
  // path the header documents. What it used to print for a finished run was
  // that run's exit and log VERBATIM, with nothing saying no gate had run: a
  // lane that fixed its code and re-collected read its own pre-fix verdict.
  // The defect was found by a lane noticing two readings were byte-identical,
  // down to a `1498ms` duration a real re-run cannot reproduce, so what is
  // asserted here is the distinguishing TEXT, not that something was printed.
  it.each([[0], [3]])(
    "--wait on a finished run names it as a replay rather than serving exit %i as fresh",
    (gateExit) => {
      const h = harness(gateExit);
      const first = startRun(h, "br");
      expect(first.run.status).toBe(gateExit);
      // The run has an identity in the output that starts it...
      expect(first.runId).toBeTruthy();
      const replay = h.run(["br", "--wait"]);
      // ...and the collection that re-reads it says so, names the same run,
      // and says how long ago it ended. The PASS row is the dangerous
      // direction: a stale green is what reaches main.
      expect(replay.stdout).toMatch(/REPLAY[^\n]*finished[^\n]*ago/);
      expect(replay.stdout).toContain(first.runId!);
      // The verdict itself stays readable — a replay is legitimate to read.
      expect(replay.status).toBe(gateExit);
      expect(replay.stdout).toContain(`GATES EXIT=${gateExit}`);
    }
  );

  it("--wait on a run still in flight reports that run, and calls it no replay", async () => {
    // THE POSITIVE CONTROL for the case above: a script that labelled every
    // collection a replay would pass it. This one is genuinely waited on, so
    // it must name the run it watched and must NOT be called a replay.
    const h = harness(0);
    h.setGate(5, 3);
    const child = spawn("bash", [h.script, "br"], {
      cwd: h.cwd,
      env: { ...process.env, TEST_STATE_DIR: h.state },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      !fs.readdirSync(h.state).some((n) => n.endsWith(".pid"))
    )
      await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    const wait = h.run(["br", "--wait"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(wait.stdout).toContain("GATES EXIT=5");
    expect(wait.stdout).not.toContain("REPLAY");
    expect(wait.stdout).toMatch(/run \S+/);
    expect(wait.status).toBe(5);
  }, 30_000);

  // THE RECORD THE NEXT RUN USED TO DESTROY (#5712). The log was keyed on the
  // branch ALONE, so a second `start` on it truncated the first run's log and
  // removed its `.exit`. Observed on `stream-reveal-arrival-5040`: a lane ran
  // its gates, the orchestrator re-ran them on the same branch 82 minutes
  // later, and the lane's own record was gone — the record that would settle
  // the disagreement, deleted exactly when the lane's claim starts to matter.
  it("a second start on the same branch keeps the first run's record", () => {
    const h = harness(3);
    const first = startRun(h, "br");
    h.setGate(0);
    const second = startRun(h, "br");
    expect(first.log).toBeTruthy();
    expect(second.log).not.toBe(first.log);
    expect(fs.readFileSync(first.log!, "utf8")).toContain(
      "stub gates exiting 3"
    );
    expect(fs.readFileSync(`${first.log}.exit`, "utf8").trim()).toBe("3");
    expect(fs.readFileSync(second.log!, "utf8")).toContain(
      "stub gates exiting 0"
    );
    expect(fs.readFileSync(`${second.log}.exit`, "utf8").trim()).toBe("0");
  });

  it("the branch's own name still finds the newest run's three files", () => {
    // Per-run records only help a reader who can reach them: the stable name
    // every doc and habit uses points at the newest run.
    const h = harness(0);
    startRun(h, "br");
    h.setGate(3);
    const second = startRun(h, "br");
    const stable = path.join(h.state, "gates-br.log");
    expect(second.log).not.toBe(stable);
    expect(fs.realpathSync(stable)).toBe(fs.realpathSync(second.log!));
    expect(fs.readFileSync(stable, "utf8")).toContain("stub gates exiting 3");
    expect(fs.readFileSync(`${stable}.exit`, "utf8").trim()).toBe("3");
    expect(fs.readFileSync(`${stable}.pid`, "utf8").trim()).toMatch(/^\d+$/);
  });

  it("start reclaims superseded runs older than a day, and only those", () => {
    // Per-run records accumulate, so they get the by-construction reclaim this
    // tree already uses for walk trees and temp dirs: swept at CREATION, since
    // a process that was killed runs no teardown. Three things it must not
    // take: a run another lane is still writing, the newest run of any branch,
    // and anything this script did not name.
    const h = harness(0);
    const superseded = startRun(h, "br");
    const newestOfOther = startRun(h, "other");
    const live = path.join(
      h.state,
      `gates-br-19700101T000000Z-${process.pid}.log`
    );
    fs.writeFileSync(live, "another lane is writing this\n");
    fs.writeFileSync(`${live}.pid`, `${process.pid}\n`);
    const legacy = path.join(h.state, "gates-before-run-ids.log");
    fs.writeFileSync(legacy, "not this script's to remove\n");
    for (const p of [superseded.log!, newestOfOther.log!, live, legacy])
      backdate(p);

    const fresh = startRun(h, "br");

    expect(fs.existsSync(superseded.log!)).toBe(false);
    expect(fs.existsSync(`${superseded.log}.exit`)).toBe(false);
    expect(fs.existsSync(newestOfOther.log!)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(fresh.log!)).toBe(true);
  });

  it("--wait with no recorded run refuses rather than waiting on a name", () => {
    const h = harness(0);
    const run = h.run(["br", "--wait"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no run recorded for br");
  });
});
