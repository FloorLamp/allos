import { spawnSync } from "node:child_process";
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
  fs.writeFileSync(
    path.join(helpers, "agent-gates.sh"),
    `#!/bin/sh\necho "=== GATE lint: PASS ==="\necho "stub gates exiting ${gateExit}"\nexit ${gateExit}\n`,
    { mode: 0o755 }
  );
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
  return { helpers, state, cwd, run };
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
    const log = path.join(h.state, "gates-br.log");
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
    const log = path.join(h.state, "gates-br.log");
    fs.writeFileSync(log, "partial output\n");
    // A pid that is certainly not alive: our own child that has already exited.
    const gone = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
    fs.writeFileSync(`${log}.pid`, gone.stdout);
    const run = h.run(["br", "--wait"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("GATES EXIT=KILLED — no exit recorded");
  });

  it("refuses before running when the state dir cannot be resolved", () => {
    const h = harness(0);
    const run = h.run(["br"], { TEST_STATE_DIR: "" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("STATE-DIR RESOLVER FAILED");
    expect(run.stderr).toContain("host.mjs: boom");
    expect(fs.readdirSync(h.state)).toEqual([]);
  });

  it("--wait with no recorded pid refuses rather than waiting on a name", () => {
    const h = harness(0);
    const run = h.run(["br", "--wait"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no PID recorded");
  });
});
