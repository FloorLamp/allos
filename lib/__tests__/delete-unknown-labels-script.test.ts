import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE LABEL DELETER, DRIVEN AS A SCRIPT — the same stub-curl construction as
// `./reconcile-labels-script.test.ts`, and for the same reason: the guarantees
// that matter here (a dry run writes NOTHING; an apply deletes exactly the
// off-taxonomy strays and touches nothing else) live in the script's control
// flow, not in a function that could be tested in isolation. The pure taxonomy
// itself (`KNOWN_LABELS`) is pinned in `./reconcile-tracker.test.ts`, which
// also source-scans this script's write confinement.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(
  REPO,
  "scripts/orchestration/delete-unknown-labels.ts"
);
const TSX = path.join(REPO, "node_modules/.bin/tsx");

/** The stub: serves the label list from a state file, records every call. */
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
  JSON.stringify({ method, url }) + "\\n"
);
if (method === "GET" && url.includes("/labels?")) {
  process.stdout.write(JSON.stringify(state.map((name) => ({ name }))));
  process.exit(0);
}
const del = url.match(/\\/labels\\/([^/?]+)$/);
if (method === "DELETE" && del) {
  const name = decodeURIComponent(del[1]);
  const i = state.indexOf(name);
  // The script reads the STATUS (curl -w), so the stub's stdout is one.
  if (i === -1) { process.stdout.write("404"); process.exit(0); }
  state.splice(i, 1);
  fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  process.stdout.write("204");
  process.exit(0);
}
process.stderr.write("stub curl: unhandled " + method + " " + url + "\\n");
process.exit(9);
`;

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  /** Label names the script sent a DELETE for, in order. */
  deletes: string[];
  /** The label list left behind. */
  remaining: string[];
}

function runScript(live: readonly string[], extraArgs: readonly string[]): Run {
  const dir = makeTmpDir("delete-unknown-labels-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  const state = path.join(dir, "state.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(state, JSON.stringify(live));
  fs.writeFileSync(log, "");

  const run = spawnSync(TSX, [SCRIPT, ...extraArgs], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "stub token 1",
      STUB_STATE: state,
      STUB_LOG: log,
    },
  });
  const deletes = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; url: string })
    .filter((c) => c.method === "DELETE")
    .map((c) => decodeURIComponent(c.url.split("/labels/")[1]));
  return {
    stdout: run.stdout,
    stderr: run.stderr,
    status: run.status,
    deletes,
    remaining: JSON.parse(fs.readFileSync(state, "utf8")) as string[],
  };
}

const LIVE = ["P2", "bug", "design", "training", "deps", "tooling", "sleep"];

describe("delete-unknown-labels.ts", () => {
  it("a dry run plans the strays and writes NOTHING", () => {
    const run = runScript(LIVE, []);
    expect(run.status).toBe(0);
    expect(run.deletes).toEqual([]);
    expect(run.remaining).toEqual(LIVE);
    for (const stray of ["deps", "tooling", "sleep"]) {
      expect(run.stdout).toContain(`delete ${stray}`);
    }
    expect(run.stdout).toContain("dry run");
  });

  it("--apply deletes exactly the off-taxonomy strays and nothing else", () => {
    const run = runScript(LIVE, ["--apply"]);
    expect(run.status).toBe(0);
    expect(run.deletes.sort()).toEqual(["deps", "sleep", "tooling"]);
    expect(run.remaining).toEqual(["P2", "bug", "design", "training"]);
    expect(run.stdout).toContain("deleted 3");
  });
});
