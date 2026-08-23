import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE DOMAIN-ADD PATH OF reconcile-labels.ts, DRIVEN AS A SCRIPT (#3122).
//
// `./reconcile-tracker.test.ts` exercises the pure core and scans this script's
// SOURCE for the close-capability guarantee. Neither reaches its read-modify-write
// control flow, which is where the bug lived: the script read each issue ONCE per
// plan key and then judged every add for that issue against that one snapshot, so
// a plan file listing two domains for one issue passed the already-classified
// guard twice and landed BOTH labels, with no refusal logged. The invariant the
// whole routine exists to guarantee — one domain label, an add may only fill a gap
// — was violated silently.
//
// So the test drives the real entrypoint with a STUB `curl` on PATH, the same
// construction `adversarial-consult-tier.test.ts` uses. That is what makes this a
// test of the script rather than of a function extracted out of it: the loop, the
// re-read, the ordering of write and refusal are all in play, and a regression that
// re-introduces the stale snapshot fails here whatever shape it takes.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/reconcile-labels.ts");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

/** The stub. Serves the three endpoints the script uses, from a JSON state file. */
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
  JSON.stringify({ method, url, body: at("--data-binary") }) + "\\n"
);
const emit = (value) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};
if (method === "GET" && url.includes("/issues?")) emit(Object.values(state));
const one = url.match(/\\/issues\\/(\\d+)$/);
if (method === "GET" && one) emit(state[one[1]]);
const add = url.match(/\\/issues\\/(\\d+)\\/labels$/);
if (method === "POST" && add) {
  for (const name of JSON.parse(at("--data-binary")).labels) {
    state[add[1]].labels.push({ name });
  }
  fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  emit(state[add[1]].labels);
}
process.stderr.write("stub curl: unhandled " + method + " " + url + "\\n");
process.exit(9);
`;

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  /** Every label POST the script made, as "<issue>:<label>". */
  writes: string[];
}

function runScript(
  issues: Record<string, { labels: string[]; body?: string }>,
  plan: Record<string, Array<{ label: string; reason: string }>>,
  extraArgs: readonly string[]
): Run {
  const dir = makeTmpDir("reconcile-labels-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  const state = path.join(dir, "state.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(
    state,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(issues).map(([n, i]) => [
          n,
          {
            number: Number(n),
            title: `issue ${n}`,
            body: i.body ?? "a body with no stated priority",
            state: "open",
            labels: i.labels.map((name) => ({ name })),
          },
        ])
      )
    )
  );
  fs.writeFileSync(log, "");
  const planFile = path.join(dir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));

  const run = spawnSync(TSX, [SCRIPT, "--plan", planFile, ...extraArgs], {
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
  const writes = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; url: string; body: string })
    .filter((c) => c.method === "POST")
    .map((c) => {
      const issue = c.url.match(/\/issues\/(\d+)\/labels$/)?.[1] ?? "?";
      return `${issue}:${(JSON.parse(c.body) as { labels: string[] }).labels.join(",")}`;
    });
  return { stdout: run.stdout, stderr: run.stderr, status: run.status, writes };
}

describe("reconcile-labels.ts --plan, applying", () => {
  it("fills a gap with the one domain the plan names", () => {
    const run = runScript(
      { "3051": { labels: ["bug", "P2"] } },
      {
        "3051": [{ label: "wellness", reason: "citations point at wellness" }],
      },
      ["--apply"]
    );
    expect(run.status).toBe(0);
    expect(run.writes).toEqual(["3051:wellness"]);
    expect(run.stdout).toContain("#3051 +wellness: ok");
  });

  it("lands ONE label when the plan lists two domains for the same issue", () => {
    // The #3122 failure verbatim: an agent hedging between two domains instead of
    // asking. Before the fix both labels landed and nothing was logged.
    const run = runScript(
      { "3051": { labels: ["bug", "P2"] } },
      {
        "3051": [
          { label: "wellness", reason: "hedge A" },
          { label: "training", reason: "hedge B" },
        ],
      },
      ["--apply"]
    );
    expect(run.status).toBe(0);
    expect(run.writes).toEqual(["3051:wellness"]);
    expect(run.stdout).toContain("#3051 +wellness: ok");
    expect(run.stdout).toContain(
      "#3051 +training: REFUSED (already-classified) — carries wellness"
    );
    expect(run.stdout).toContain("wrote 1 · refused 1");
  });

  it("refuses an add onto an issue that already carries a domain", () => {
    const run = runScript(
      { "3051": { labels: ["bug", "P2", "db"] } },
      { "3051": [{ label: "wellness", reason: "re-classify" }] },
      ["--apply"]
    );
    expect(run.writes).toEqual([]);
    expect(run.stdout).toContain(
      "#3051 +wellness: REFUSED (already-classified) — carries db"
    );
  });

  it("refuses a label that is not a domain, and writes nothing", () => {
    const run = runScript(
      { "3051": { labels: ["bug"] } },
      { "3051": [{ label: "P1", reason: "wrong axis" }] },
      ["--apply"]
    );
    expect(run.writes).toEqual([]);
    expect(run.stdout).toContain("#3051 +P1: REFUSED (not-a-domain)");
  });
});

describe("reconcile-labels.ts --plan, dry run", () => {
  it("promises exactly the writes an --apply run would make", () => {
    // THE HALF A RE-READ CANNOT FIX. With no --apply nothing is written, so every
    // re-read returns the same labels — a dry run judging only on re-reads would
    // print two `ok` lines for a pair of writes the real run could never perform,
    // and the dry run is what a human reads before authorising the apply.
    const run = runScript(
      { "3051": { labels: ["bug", "P2"] } },
      {
        "3051": [
          { label: "wellness", reason: "hedge A" },
          { label: "training", reason: "hedge B" },
        ],
      },
      []
    );
    expect(run.status).toBe(0);
    expect(run.writes).toEqual([]);
    expect(run.stdout).toContain("#3051 +wellness: ok");
    expect(run.stdout).toContain(
      "#3051 +training: REFUSED (already-classified)"
    );
    expect(run.stdout).toContain("would write 1 · refused 1");
  });
});

describe("the stub is really being reached", () => {
  // Without this, every assertion above would pass just as well against a script
  // that silently failed before its first request.
  it("makes the reads the script documents, and no unexpected call", () => {
    const run = runScript(
      { "3051": { labels: ["bug"] } },
      { "3051": [{ label: "wellness", reason: "r" }] },
      ["--apply"]
    );
    expect(run.stderr).not.toContain("stub curl: unhandled");
    expect(run.status).toBe(0);
  });
});
