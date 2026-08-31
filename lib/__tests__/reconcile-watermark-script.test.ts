import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import { WATERMARK_ISSUE_TITLE } from "../../scripts/orchestration/reconcile-tracker-core";

// THE WATERMARK WRITER, DRIVEN AS A SCRIPT — the same stub-curl construction
// as the other confined writers' tests. What matters is the control flow: a
// dry run writes NOTHING; an apply stamps the one carrier issue (creating it
// with its labels on the very first stamp) and verifies by re-read; and a
// stale evidence file can never rewind the window. Write confinement itself
// is source-scanned in `./reconcile-tracker.test.ts`.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/reconcile-watermark.ts");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

const OLD = "2026-08-29T06:00:00Z";
const NEW = "2026-08-30T09:30:00Z";

/** Serves and mutates a one-issue tracker from STUB_STATE; logs every call. */
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
  JSON.stringify({ method, url, data: at("-d") }) + "\\n"
);
const save = () =>
  fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
const reply = (code, body) => {
  process.stdout.write(JSON.stringify(body) + "\\n" + code);
  process.exit(0);
};
if (method === "GET" && url.includes("/issues?")) {
  reply(200, url.includes("page=1") || !/page=\\d/.test(url) ? state.issues : []);
}
const one = url.match(/\\/issues\\/(\\d+)$/);
if (method === "GET" && one) {
  const found = state.issues.find((i) => i.number === Number(one[1]));
  reply(found ? 200 : 404, found ?? { message: "missing" });
}
if (method === "PATCH" && one) {
  const found = state.issues.find((i) => i.number === Number(one[1]));
  found.body = JSON.parse(at("-d")).body;
  save();
  reply(200, found);
}
if (method === "POST" && url.endsWith("/issues")) {
  const payload = JSON.parse(at("-d"));
  const created = { number: 4300, ...payload };
  state.issues.push(created);
  save();
  reply(201, created);
}
process.stderr.write("stub curl: unhandled " + method + " " + url + "\\n");
process.exit(9);
`;

const carrier = (iso: string) => ({
  number: 4200,
  title: WATERMARK_ISSUE_TITLE,
  body: `machine state\n\n\`\`\`json\n{"lastRunAt":"${iso}"}\n\`\`\``,
});

interface State {
  issues: Array<{ number: number; title: string; body: string }>;
}

function runScript(state: State, scriptArgs: readonly string[]) {
  const dir = makeTmpDir("reconcile-watermark-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
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
      STUB_STATE: stateFile,
      STUB_LOG: log,
    },
  });
  const calls = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; url: string; data: string });
  return {
    ...run,
    calls,
    state: JSON.parse(fs.readFileSync(stateFile, "utf8")) as State,
  };
}

describe("reconcile-watermark.ts", () => {
  it("reads the carrier's stamp without any write", () => {
    const run = runScript({ issues: [carrier(OLD)] }, []);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`#4200: lastRunAt ${OLD}`);
    expect(run.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a dry-run stamp plans the write and touches nothing", () => {
    const run = runScript({ issues: [carrier(OLD)] }, ["stamp", NEW]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`would stamp #4200: ${OLD} → ${NEW}`);
    expect(run.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("--apply stamps the carrier and verifies by re-read", () => {
    const dir = makeTmpDir("reconcile-watermark-evidence");
    const evidence = path.join(dir, "ev.json");
    fs.writeFileSync(
      evidence,
      JSON.stringify({ watermark: { previous: OLD, current: NEW } })
    );
    const run = runScript({ issues: [carrier(OLD)] }, [
      "stamp",
      "--evidence",
      evidence,
      "--apply",
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`stamped #4200: ${OLD} → ${NEW} (verified)`);
    expect(run.state.issues[0].body).toContain(`"lastRunAt":"${NEW}"`);
    // Exactly one write, and it is the body PATCH.
    const writes = run.calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("PATCH");
  });

  it("the FIRST --apply creates the carrier, labeled out of the queue", () => {
    const run = runScript({ issues: [] }, ["stamp", NEW, "--apply"]);
    expect(run.status).toBe(0);
    const created = run.state.issues.find(
      (i) => i.title === WATERMARK_ISSUE_TITLE
    );
    expect(created?.body).toContain(`"lastRunAt":"${NEW}"`);
    const post = run.calls.find((c) => c.method === "POST");
    // parked keeps it out of every dispatch queue; infra is its domain.
    expect(JSON.parse(post!.data).labels).toEqual(["infra", "parked"]);
  });

  it("refuses to rewind the window from a stale evidence file", () => {
    const dir = makeTmpDir("reconcile-watermark-evidence");
    const evidence = path.join(dir, "ev.json");
    fs.writeFileSync(
      evidence,
      JSON.stringify({ watermark: { previous: null, current: OLD } })
    );
    const run = runScript({ issues: [carrier(NEW)] }, [
      "stamp",
      "--evidence",
      evidence,
      "--apply",
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("refusing to rewind");
    expect(run.state.issues[0].body).toContain(NEW);
  });

  it("rejects a non-ISO stamp before touching the network", () => {
    const run = runScript({ issues: [carrier(OLD)] }, [
      "stamp",
      "yesterday",
      "--apply",
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ISO instant");
    expect(run.calls).toEqual([]);
  });
});
