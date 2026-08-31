import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import { closedIssueRefusal } from "../../scripts/orchestration/dispatch-brief.mjs";

// A BRIEF IS ONLY AS FRESH AS THE TRACKER READ BEHIND IT (#4451). #4347 was
// closed at 03:09:32Z and dispatched at 09:43Z; the lane spent half its
// dispatch discovering the diff was empty. The queue snapshot downstream can
// only ANNOTATE a stale row — `new` is the point that can refuse, so it
// re-reads state there, before it writes anything.
//
// The drives below go through the SCRIPT, not the predicate, because the
// defect was never in the predicate: it was that nothing asked. What is
// measured is reach — GitHub answers, and the ledger and roster stay empty.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/dispatch-brief.mjs");

const state = (
  number: number,
  over: Partial<{ state: string; closedAt: string | null }> = {}
) => ({
  number,
  state: over.state ?? "open",
  closedAt: over.closedAt ?? null,
});

describe("closedIssueRefusal", () => {
  it.each([
    [[state(1), state(2)], null, "every issue still open"],
    [
      [
        state(1),
        state(2, { state: "closed", closedAt: "2026-08-31T03:09:32Z" }),
      ],
      "#2 closed 2026-08-31T03:09:32Z",
      "one of a cluster closed",
    ],
    [
      [state(9, { state: "closed" })],
      "#9 closed at an unknown time",
      "closed with no timestamp",
    ],
    [[], null, "a dispatch that names no issue"],
  ])("%#: %s", (states, expected, _why) => {
    const refusal = closedIssueRefusal(states);
    if (expected === null) expect(refusal).toBeNull();
    else expect(refusal).toContain(expected as string);
  });

  it("names the remedy, because a refusal a caller cannot act on is a wall", () => {
    const refusal = closedIssueRefusal([
      state(4347, { state: "closed", closedAt: "2026-08-31T03:09:32Z" }),
    ]);
    expect(refusal).toContain("issue-read.mjs");
    expect(refusal).toContain("--issues");
  });
});

/** A stub `curl` on PATH answering every issue read with one canned issue. */
function stubCurl(dir: string, issue: Record<string, unknown>): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(issue))});\n`,
    { mode: 0o755 }
  );
  return bin;
}

function runNew(
  dir: string,
  bin: string,
  extraEnv: Record<string, string> = {}
) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "new",
      "--branch",
      "stale-lane-4347",
      "--issues",
      "4347",
      "--priority",
      "P2",
      "--lane",
      "operator",
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SCRATCH: dir,
        ALLOS_DISPATCH_LEDGER: path.join(dir, "ledger.jsonl"),
        GH_TOKEN: "stub token 2",
        ...extraEnv,
      },
    }
  );
}

describe("dispatch-brief.mjs new, driven against a tracker that has moved", () => {
  it("refuses a closed issue and writes NOTHING — no ledger row, no roster line", () => {
    const dir = makeTmpDir("dispatch-stale");
    const bin = stubCurl(dir, {
      number: 4347,
      state: "closed",
      closed_at: "2026-08-31T03:09:32Z",
    });
    const run = runNew(dir, bin);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("REFUSED");
    expect(run.stderr).toContain("#4347 closed 2026-08-31T03:09:32Z");
    // The refusal must precede every side effect, or it only annotates too.
    expect(fs.existsSync(path.join(dir, "ledger.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".roster"))).toBe(false);
  });

  it("dispatches an OPEN issue — the check discriminates, it does not just block", () => {
    const dir = makeTmpDir("dispatch-open");
    const bin = stubCurl(dir, { number: 4451, state: "open", closed_at: null });
    const run = runNew(dir, bin);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("stale-lane-4347");
    expect(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8")).toContain(
      '"status":"active"'
    );
  });

  it("degrades without a read token: warns, dispatches, never blocks on a check it cannot run", () => {
    const dir = makeTmpDir("dispatch-notoken");
    const bin = stubCurl(dir, {
      number: 4451,
      state: "closed",
      closed_at: "2026-08-31T03:09:32Z",
    });
    const run = runNew(dir, bin, { GH_TOKEN: "", GITHUB_TOKEN: "", PATH: bin });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("NO READ TOKEN");
  });
});
