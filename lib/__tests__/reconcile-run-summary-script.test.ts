import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  RUN_SUMMARY_ISSUE,
  RUN_SUMMARY_MARKER,
} from "../../scripts/orchestration/reconcile-tracker-core";

// THE RUN-SUMMARY WRITER, DRIVEN AS A SCRIPT — same stub-curl construction as
// the other confined writers' tests. What matters here is the control flow, and
// all of it is about a LIVE-TRACKER WRITE that has to be hard to do by accident:
// a dry run writes nothing, an apply with no write credential writes nothing,
// and one run can never post twice however often the script is re-run on the
// same evidence. Write confinement itself is source-scanned in
// `./reconcile-tracker.test.ts`.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(
  REPO,
  "scripts/orchestration/reconcile-run-summary.ts"
);
const TSX = path.join(REPO, "node_modules/.bin/tsx");

const RAN_AT = "2026-09-08T09:00:00Z";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Serves and mutates #865's comment chain from STUB_STATE; logs every call. */
const STUB_CURL = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = args[args.length - 1];
const at = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const method = at("-X") ?? "GET";
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf8"));
fs.appendFileSync(
  process.env.STUB_LOG,
  JSON.stringify({ method, url, data: at("--data-binary") }) + "\\n"
);
const reply = (code, body) => {
  process.stdout.write(JSON.stringify(body) + "\\n" + code);
  process.exit(0);
};
if (method === "GET" && url.includes("/comments")) {
  // [?&] and not a bare page=: per_page=100 matches "page=100" otherwise.
  const page = Number((url.match(/[?&]page=(\\d+)/) ?? [, "1"])[1]);
  reply(200, page === 1 ? state.comments : []);
}
if (method === "POST" && url.includes("/comments")) {
  const created = { id: 9001, body: JSON.parse(at("--data-binary")).body };
  state.comments.push(created);
  fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  reply(201, created);
}
process.stderr.write("stub curl: unhandled " + method + " " + url + "\\n");
process.exit(9);
`;

interface State {
  comments: Array<{ id: number; body: string }>;
}

function evidenceFile(
  dir: string,
  over: Partial<{
    truncated: boolean;
    changed: number;
    unverifiable: number;
  }> = {}
): string {
  const findings = [
    ...Array.from({ length: over.changed ?? 0 }, (_, i) => ({
      kind: "unqualified-path",
      bucket: "changed",
      issue: 100 + i,
      anchor: "a.ts",
      detail: "",
    })),
    ...Array.from({ length: over.unverifiable ?? 0 }, (_, i) => ({
      kind: "dead-path",
      bucket: "unverifiable",
      issue: 200 + i,
      anchor: "b.ts",
      detail: "",
    })),
  ];
  const file = path.join(dir, "ev.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      watermark: { previous: null, current: RAN_AT },
      sweptCommit: COMMIT,
      totals: {
        issuesExamined: 3,
        prsExamined: 42,
        prsExaminedTruncated: over.truncated ?? false,
      },
      findings,
      docs: [],
      labelFindings: [],
      verifiedClean: [],
    })
  );
  return file;
}

function runScript(
  state: State,
  scriptArgs: readonly string[],
  env: Record<string, string | undefined> = {}
) {
  const dir = makeTmpDir("reconcile-run-summary-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  // `gh` on PATH, authenticated only when STUB_GH_TOKEN is set — the
  // read-credential fallback of #3710. It exists so a case can put the process
  // in the one state that separates a read credential from a write one (no
  // GH_TOKEN, but `gh auth token` answering), which no amount of unsetting
  // variables can reproduce; unset, it exits 1 like an unauthenticated host.
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\n[ -n "$STUB_GH_TOKEN" ] || exit 1\nprintf '%s\\n' "$STUB_GH_TOKEN"\n`,
    { mode: 0o755 }
  );
  const stateFile = path.join(dir, "state.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(log, "");
  const run = spawnSync(TSX, [SCRIPT, ...scriptArgs], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "stub token 1",
      GITHUB_TOKEN: undefined,
      STUB_STATE: stateFile,
      STUB_LOG: log,
      ...env,
    } as NodeJS.ProcessEnv,
  });
  const calls = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; url: string; data: string });
  return {
    ...run,
    dir,
    calls,
    state: JSON.parse(fs.readFileSync(stateFile, "utf8")) as State,
  };
}

const empty = (): State => ({ comments: [] });

describe("reconcile-run-summary.ts", () => {
  it("a dry run prints the line and writes nothing", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const run = runScript(empty(), ["--evidence", evidenceFile(dir)]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${RUN_SUMMARY_MARKER} ${RAN_AT}`);
    expect(run.stdout).toContain(`would comment on #${RUN_SUMMARY_ISSUE}`);
    expect(run.calls.every((c) => c.method === "GET")).toBe(true);
    expect(run.state.comments).toEqual([]);
  });

  it("with no token at all it still prints, posts nothing, and says what it could not check", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const run = runScript(empty(), ["--evidence", evidenceFile(dir)], {
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${RUN_SUMMARY_MARKER} ${RAN_AT}`);
    expect(run.stdout).toContain("the duplicate check did not run");
    expect(run.calls).toEqual([]);
    expect(run.state.comments).toEqual([]);
  });

  it("--apply without a WRITE credential refuses before any call", () => {
    // The gh-auth fallback is a read credential; a write rides the named
    // variables only (environment.md §GitHub access).
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const run = runScript(
      empty(),
      ["--evidence", evidenceFile(dir), "--apply"],
      {
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      }
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("needs GH_TOKEN or GITHUB_TOKEN");
    expect(run.calls).toEqual([]);
  });

  it("--apply refuses a gh-auth READ credential even though a dry run uses it", () => {
    // environment.md §GitHub access: the gh fallback is a read credential and a
    // write rides the named variables only. Unsetting GH_TOKEN alone cannot
    // test that — on a host with `gh` authenticated the fallback answers, and
    // an --apply that accepted it would post with a credential nobody granted
    // it for writing.
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const readOnly = {
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      STUB_GH_TOKEN: "gh-read-token",
    };
    const posted = runScript(
      empty(),
      ["--evidence", evidenceFile(dir), "--apply"],
      readOnly
    );
    expect(posted.status).toBe(2);
    expect(posted.stderr).toContain("needs GH_TOKEN or GITHUB_TOKEN");
    expect(posted.calls).toEqual([]);
    expect(posted.state.comments).toEqual([]);

    // The same credential IS enough to read, so the dry run's duplicate check
    // runs rather than silently degrading to "would be the first".
    const dryRun = runScript(
      { comments: [{ id: 1, body: `${RUN_SUMMARY_MARKER} ${RAN_AT} · …` }] },
      ["--evidence", evidenceFile(dir)],
      readOnly
    );
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("is ALREADY on");
    expect(dryRun.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("--apply posts exactly one comment and verifies by re-read", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const run = runScript(empty(), [
      "--evidence",
      evidenceFile(dir),
      "--apply",
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("(verified)");
    const writes = run.calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("POST");
    expect(writes[0].url).toContain(`/issues/${RUN_SUMMARY_ISSUE}/comments`);
    // One field, and no field an issue's state could ride in.
    expect(Object.keys(JSON.parse(writes[0].data))).toEqual(["body"]);
    expect(run.state.comments).toHaveLength(1);
    expect(run.state.comments[0].body).toContain(
      `${RUN_SUMMARY_MARKER} ${RAN_AT}`
    );
    // The line is ONE line; the trailer sits below it.
    expect(run.state.comments[0].body.split("\n")[0]).toContain("boring:");
  });

  it("never posts twice for one run, however often it is re-run", () => {
    // A run is identified by the GATHER's stamp, which is fixed in the evidence
    // file — so a rerun with a different --outcome is still the same run.
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const evidence = evidenceFile(dir, { changed: 2 });
    const first = runScript(empty(), ["--evidence", evidence, "--apply"]);
    expect(first.status).toBe(0);
    const second = runScript(first.state, ["--evidence", evidence, "--apply"]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(`already carries a summary for ${RAN_AT}`);
    expect(second.calls.every((c) => c.method === "GET")).toBe(true);
    expect(second.state.comments).toHaveLength(1);
  });

  it("a dry run says when the line is already on the issue", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const evidence = evidenceFile(dir);
    const posted = runScript(empty(), ["--evidence", evidence, "--apply"]);
    const dryRun = runScript(posted.state, ["--evidence", evidence]);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("is ALREADY on");
    expect(dryRun.state.comments).toHaveLength(1);
  });

  it("takes `patched` from the applier's outcome file, not from a retyped count", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const outcome = path.join(dir, "outcome.json");
    fs.writeFileSync(
      outcome,
      JSON.stringify({ applied: 2, refused: 0, skipped: 0, wrote: true })
    );
    const run = runScript(empty(), [
      "--evidence",
      evidenceFile(dir, { changed: 3 }),
      "--outcome",
      outcome,
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("patched 2");
    expect(run.stdout).toContain("unapplied candidates 1");
    expect(run.stdout).toContain("boring: no");
  });

  it("refuses an outcome file that cannot belong to this evidence", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const outcome = path.join(dir, "outcome.json");
    fs.writeFileSync(outcome, JSON.stringify({ applied: 9 }));
    const run = runScript(empty(), [
      "--evidence",
      evidenceFile(dir, { changed: 1 }),
      "--outcome",
      outcome,
      "--apply",
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("from different runs");
    expect(run.calls).toEqual([]);
  });

  it("refuses evidence with no run stamp before touching the network", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ totals: {} }));
    const run = runScript(empty(), ["--evidence", file, "--apply"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no run stamp");
    expect(run.calls).toEqual([]);
  });

  it("a truncated sweep is recorded as such, not as a boring run", () => {
    const dir = makeTmpDir("reconcile-run-summary-evidence");
    const run = runScript(empty(), [
      "--evidence",
      evidenceFile(dir, { truncated: true }),
      "--apply",
    ]);
    expect(run.status).toBe(0);
    const body = run.state.comments[0].body;
    expect(body).toContain("boring: not established");
    expect(body).not.toContain("boring: yes");
    expect(body).toContain("merged PRs examined ≥42");
  });
});
