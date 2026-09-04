import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  closedIssueRefusal,
  unreachableIssueWarning,
} from "../../scripts/orchestration/dispatch-brief.mjs";

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

/** A stub `curl` that FAILS each issue read with its configured body, exit 22. */
function failingCurl(dir: string, bodies: Record<string, string>): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!${process.execPath}
const bodies = ${JSON.stringify(bodies)};
const issue = process.argv.at(-1).match(/\\/issues\\/(\\d+)$/)?.[1];
process.stdout.write(bodies[issue] ?? "");
process.exit(22);
`,
    { mode: 0o755 }
  );
  return bin;
}

function runNew(
  dir: string,
  bin: string,
  extraEnv: Record<string, string> = {},
  issues = "4347"
) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "new",
      "--branch",
      "stale-lane-4347",
      "--issues",
      issues,
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

// A CHECK THAT CANNOT RUN MUST NOT BECOME A CHECK THAT BLOCKS (#4460). The
// no-token path above honours that; the REQUEST path did not — curl runs under
// execFileSync with --fail-with-body and no try/catch, so a 404, a rate limit
// or a proxy blip threw and crashed `new` outright. With the repo unreachable
// EVERY dispatch was blocked by a check that could not run, which is exactly
// what the comment above issueStates disclaims. Only a CLOSED answer refuses.

describe("unreachableIssueWarning", () => {
  const st = (number: number, over = {}) => ({
    number,
    state: "open",
    closedAt: null,
    ...over,
  });
  it.each([
    [[st(1), st(2)], null, "GitHub answered for every issue"],
    [
      [st(1), st(9, { state: "unknown", error: "no such issue (404)" })],
      "#9: no such issue (404)",
      "one unanswered — named, not swallowed",
    ],
    [[], null, "a dispatch that names no issue"],
  ])("%#: %s", (states, expected, _why) => {
    const warning = unreachableIssueWarning(states);
    if (expected === null) expect(warning).toBeNull();
    else expect(warning).toContain(expected as string);
  });
});

describe("dispatch-brief.mjs new, when GitHub does not answer", () => {
  it("warns with every failure shape, then dispatches without exposing the token", () => {
    const dir = makeTmpDir("dispatch-unreachable");
    const run = runNew(
      dir,
      failingCurl(dir, {
        "404": '{"message":"Not Found","status":"404"}',
        "429": '{"message":"API rate limit exceeded"}',
        // With no body there is nothing to quote but err.message, and that is the
        // whole curl command — the row that can reach the token.
        "500": "",
      }),
      {},
      "404,429,500"
    );
    // Warn and DISPATCH, in the no-token path's voice.
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("GITHUB DID NOT ANSWER");
    expect(run.stderr).toContain("no such issue (404) — mistyped --issues?");
    expect(run.stderr).toContain("API rate limit exceeded");
    expect(run.stderr).toContain("curl exited 22");
    expect(run.stderr).not.toContain("REFUSED");
    // execFileSync's own message carries the whole command; quoting it here
    // would print the Bearer token, which is what the crash path did.
    expect(run.stderr).not.toContain("stub token 2");
    expect(fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8")).toContain(
      '"status":"active"'
    );
  });
});
