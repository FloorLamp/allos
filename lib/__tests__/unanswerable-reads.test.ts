import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// A HELPER THAT CANNOT ASK ITS QUESTION MUST SAY SO (#5256, the class #5252
// proved). #5252 fixed five check-in reads that suppressed stderr and fell back
// to something plausible, and landed a scan that keeps the helper PATHS alive.
// Nothing catches the other half: a fallback that is a GUESS rather than an
// answer. These pins hold the three sites this issue names.
//
// WHY THE SUPPRESSION SHAPE ITSELF IS NOT SCANNED, and this is the measured
// argument rather than an opinion. `scripts/orchestrator-checkin.sh` has nine
// `2>/dev/null || <fallback>` sites and they are syntactically identical. Eight
// are honest, because the fallback IS the answer: MISSING for an absent boot or
// session file, an empty string for a detached HEAD or an unreadable mtime,
// `true` for an empty reflog or roster, "UNWRITTEN — run queue-snapshot.mjs"
// for a queue nobody has taken. One was a guess — a hard-coded checkout path —
// and it is fixed below. A pattern gate on the shape would therefore fire on
// eight correct lines to catch one wrong one, and a gate at that ratio is
// routed around or deleted within a week, taking the real check with it. The
// distinguishing question is whether the fallback is an answer or a guess, and
// that is a question about MEANING. So the rule is written down instead, in
// docs/orchestration/environment.md, and enforced by the reviews that read it.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const checkin = read("scripts/orchestrator-checkin.sh");
const digest = read("scripts/orchestration/pm-digest.sh");
const environment = read("docs/orchestration/environment.md");

describe("the PM digest's state dir", () => {
  // EXECUTED, not pinned: the refusal is the whole behaviour, and a text pin
  // cannot tell a refusal that runs from one written above an early `exit 0`.
  // A `node` on PATH that fails is exactly what a broken resolver looks like.
  it("refuses rather than falling back to a hard-coded directory", () => {
    const stub = makeTmpDir("pm-digest-resolver");
    const node = path.join(stub, "node");
    writeFileSync(node, "#!/bin/sh\necho 'host.mjs: boom' >&2\nexit 1\n", {
      mode: 0o755,
    });
    const run = spawnSync(
      "bash",
      [path.join(REPO, "scripts/orchestration/pm-digest.sh"), "--peek"],
      {
        cwd: REPO,
        encoding: "utf8",
        env: { ...process.env, SCRATCH: "", PATH: `${stub}:${process.env.PATH}` },
      }
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("PM DIGEST: STATE-DIR RESOLVER FAILED");
    // stderr is left alone, so the reader's own error is the explanation.
    expect(run.stderr).toContain("host.mjs: boom");
    // Nothing was reported: a digest that could not find its window must not
    // print one. This also proves the refusal precedes every read below it.
    expect(run.stdout).toBe("");
  });

  it("resolves through host.mjs, and announces the one assumption left", () => {
    expect(digest).toContain('node "$HELPERS/host.mjs" state-dir');
    // The only honest fallback: a shell with no node cannot ask at all.
    expect(digest).toContain("no node on PATH: state dir ASSUMED");
    // What #3710's resolver exists to delete, and what this restored.
    expect(digest).not.toContain("state-dir 2>/dev/null || echo");
  });

  it("stops guessing the repo the window is measured in", () => {
    expect(digest).not.toContain("--show-toplevel 2>/dev/null || echo");
    expect(digest).toContain("repo taken from this script's own path");
  });
});

describe("the check-in's stale-tooling verdict", () => {
  it("announces the fetch every comparison against main leans on", () => {
    expect(checkin).toContain('if git -C "$REPO" fetch origin main -q; then');
    expect(checkin).toContain("fetch of origin/main FAILED");
    // The tip is captured from OUR fetch, not re-read later: sibling worktrees
    // share one .git, so FETCH_HEAD is not ours to rely on by the time the
    // environment section runs.
    expect(checkin).toContain('MAIN_TIP=$(git -C "$REPO" rev-parse origin/main');
  });

  it("prints the scripts/ drift, and never a half-answer", () => {
    expect(checkin).toContain("tooling: current with origin/main");
    expect(checkin).toContain("scripts/ DIFFER from origin/main");
    expect(checkin).toContain("scripts/ identical — verdicts stand");
    // Each of the three reads can fail on its own, and each failure says so
    // rather than printing the reassuring half of the answer it still had.
    expect(checkin.match(/tooling: \*\*\* UNCOMPARED/g)).toHaveLength(3);
  });

  it("warns and never refuses — a stale checkout must not stop a session", () => {
    const block = checkin.slice(checkin.indexOf("head_here=$("));
    const verdict = block.slice(0, block.indexOf("\nfi\n") + 4);
    expect(verdict).toContain("tooling:");
    expect(verdict).not.toContain("exit 1");
  });

  it("stops guessing the checkout every verdict is about", () => {
    expect(checkin).not.toContain("--show-toplevel 2>/dev/null || echo");
    expect(checkin).toContain("repo taken from this script's own path");
  });
});

describe("the unknown vocabulary", () => {
  it("is written down where the runbook keeps environment rules", () => {
    expect(environment).toContain("A helper that cannot answer says so");
    expect(environment).toContain("the ledger spelt its refusal that way until");
    expect(environment).toContain("`tooling:` line reports it every wake");
  });

  // `?` was the ledger's word for "no ledger, go look" and #5252 retired it for
  // UNMEASURED. It stays retired: a bare `?` in a report reads as a value, and
  // the four `?` renderings left in scripts/ are absent table cells in tools no
  // orchestrator reads for a verdict (dependabot-eval-brief, gitleaks-explain,
  // profile-dashboard, restore). The two recorders may not reintroduce it.
  it("keeps a bare `?` out of both recorders", () => {
    for (const source of [checkin, digest]) {
      expect(source).not.toMatch(/echo\s+["']?\?["']?\s*(?:$|[;)|&])/m);
      expect(source).not.toMatch(/\|\|\s*echo\s+["']\?["']/);
    }
    expect(read("scripts/orchestration/ledger.mjs")).not.toContain('"?"');
  });
});
