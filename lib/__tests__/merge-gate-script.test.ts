import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE MERGE GATE, DRIVEN AS A SCRIPT — the same stub-curl construction as
// `./delete-unknown-labels-script.test.ts`. What matters here is the verdict
// logic in the script's control flow: the exact-head invariant
// (review-merge.md §Merge) says merge needs a non-author receipt STATING the
// current head SHA, green checks on that head, and zero unresolved threads.
// Each case below is one way a head that must not merge could read as safe.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/merge-gate.mjs");

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const OLD_HEAD = "0123456789abcdef0123456789abcdef01234567";

/** Serves the fixture from STUB_STATE; records every call in STUB_LOG. */
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
const reply = (body) => {
  process.stdout.write(JSON.stringify(body) + "\\n200");
  process.exit(0);
};
if (method === "POST" && url.endsWith("/graphql")) {
  if (state.graphqlStatus) {
    process.stdout.write("{}\\n" + state.graphqlStatus);
    process.exit(0);
  }
  reply({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: state.threads,
          },
        },
      },
    },
  });
}
if (url.includes("/check-runs")) {
  reply({ total_count: state.checkRuns.length, check_runs: state.checkRuns });
}
if (url.includes("/comments")) {
  reply(url.includes("page=1") ? (state.reviewComments ?? []) : []);
}
if (url.includes("/reviews")) {
  reply(url.includes("page=1") ? state.reviews : []);
}
if (url.includes("/pulls/")) reply(state.pr);
process.stderr.write("stub curl: unhandled " + method + " " + url + "\\n");
process.exit(9);
`;

interface Fixture {
  pr?: Partial<Record<string, unknown>>;
  reviews?: unknown[];
  checkRuns?: unknown[];
  threads?: unknown[];
  graphqlStatus?: number;
  reviewComments?: unknown[];
}

const green = (name: string) => ({
  name,
  status: "completed",
  conclusion: "success",
});

/** A fixture whose gate is OPEN; each test breaks exactly one thing. */
function fixture(overrides: Fixture) {
  return {
    pr: {
      state: "open",
      draft: false,
      head: { sha: HEAD },
      user: { login: "author-agent" },
      ...overrides.pr,
    },
    reviews: overrides.reviews ?? [
      {
        state: "COMMENTED",
        user: { login: "reviewer-agent" },
        body: `Exact-head review of ${HEAD}: verified claims, no findings.`,
      },
    ],
    checkRuns: overrides.checkRuns ?? [green("lint"), green("test")],
    threads: overrides.threads ?? [],
    graphqlStatus: overrides.graphqlStatus,
    reviewComments: overrides.reviewComments ?? [],
  };
}

function runGate(
  overrides: Fixture,
  env: Record<string, string> = {},
  extraArgs: readonly string[] = []
) {
  const dir = makeTmpDir("merge-gate-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  const state = path.join(dir, "state.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(state, JSON.stringify(fixture(overrides)));
  fs.writeFileSync(log, "");
  const run = spawnSync(process.execPath, [SCRIPT, "4100", ...extraArgs], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "stub token 1",
      STUB_STATE: state,
      STUB_LOG: log,
      ...env,
    },
  });
  const calls = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; url: string; data: string });
  return { ...run, calls };
}

describe("merge-gate.mjs", () => {
  it("opens the gate for a receipted, green, thread-clean head", () => {
    const run = runGate({});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("GATE OPEN");
    expect(run.stdout).toContain(
      `receipt: reviewer-agent states ${HEAD.slice(0, 8)}`
    );
  });

  it("closes on a receipt pinned to a PREVIOUS head — the review is void", () => {
    const run = runGate({
      reviews: [
        {
          state: "COMMENTED",
          user: { login: "reviewer-agent" },
          body: `Exact-head review of ${OLD_HEAD}: clean.`,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("VOIDS");
  });

  it("closes when the only stated-SHA review is the AUTHOR's own", () => {
    const run = runGate({
      reviews: [
        {
          state: "COMMENTED",
          user: { login: "author-agent" },
          body: `Reviewed my own ${HEAD}.`,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("no exact-head receipt");
  });

  it("closes when a review exists but never states the SHA", () => {
    const run = runGate({
      reviews: [
        { state: "COMMENTED", user: { login: "reviewer-agent" }, body: "LGTM" },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("no exact-head receipt");
  });

  it("closes on a red check and names it", () => {
    const run = runGate({
      checkRuns: [
        green("lint"),
        { name: "test", status: "completed", conclusion: "failure" },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("red checks on this head: test");
  });

  it("exits 2 — NOT a verdict — while a check is still running", () => {
    const run = runGate({
      checkRuns: [green("lint"), { name: "test", status: "in_progress" }],
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("CI INCOMPLETE");
  });

  it("--ignore-check excludes the gate's own wrapper, and only it", () => {
    // The CI wrapper's job is a pending check run on the very head it
    // evaluates — without self-exclusion it reads CI as incomplete forever.
    const withSelf = {
      checkRuns: [
        green("lint"),
        green("test"),
        { name: "merge-gate", status: "in_progress" },
      ],
    };
    expect(runGate(withSelf).status).toBe(2);
    const run = runGate(withSelf, {}, ["--ignore-check", "merge-gate"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('ignoring check "merge-gate"');
    // The exclusion is by NAME, not by status: a pending check that is not
    // the wrapper still blocks.
    const other = runGate(
      { checkRuns: [green("lint"), { name: "test", status: "in_progress" }] },
      {},
      ["--ignore-check", "merge-gate"]
    );
    expect(other.status).toBe(2);
  });

  it("closes on an unresolved review thread, outdated or not", () => {
    const run = runGate({
      threads: [
        {
          isResolved: false,
          path: "lib/dri.ts",
          comments: { nodes: [{ body: "profile scoping missing here" }] },
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("1 unresolved review thread");
    expect(run.stdout).toContain("lib/dri.ts");
  });

  it("opens over REST when GraphQL is refused and NO comment threads exist", () => {
    // The #4231 degrade: the orchestrator's container 403s every GraphQL
    // call, and exit 2's "re-invoke" never terminated — three passing steps
    // could not open the gate. Zero top-level review comments is a
    // REST-observable proof that zero threads are unresolved.
    const run = runGate({ graphqlStatus: 403 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("proven over REST");
  });

  it("closes as resolution-UNKNOWN when GraphQL is refused and threads exist", () => {
    const run = runGate({
      graphqlStatus: 403,
      reviewComments: [
        { id: 1, path: "lib/dri.ts", body: "is this scoped?" },
        { id: 2, in_reply_to_id: 1, path: "lib/dri.ts", body: "yes — see L40" },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("resolution UNKNOWN");
    // Replies never double-count: one parent + one reply is ONE thread.
    expect(run.stdout).toContain("1 review-comment thread(s)");
  });

  it("still treats a non-403 GraphQL failure as transient (exit 2)", () => {
    const run = runGate({ graphqlStatus: 502 });
    expect(run.status).toBe(2);
  });

  it("closes on a draft PR — PRs open READY", () => {
    const run = runGate({ pr: { draft: true } });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("DRAFT");
  });

  it("blocks (exit 3) without a token rather than reporting empty sets", () => {
    const run = runGate(
      {},
      { GH_TOKEN: "", GITHUB_TOKEN: "", PATH: "/nonexistent" }
    );
    expect(run.status).toBe(3);
    expect(run.stderr).toContain(
      "no GH_TOKEN/GITHUB_TOKEN and no authenticated gh"
    );
  });

  it("sends no write verb — every call is a GET or the GraphQL read", () => {
    const run = runGate({});
    expect(run.status).toBe(0);
    for (const call of run.calls) {
      if (call.method === "POST") {
        expect(call.url).toMatch(/\/graphql$/);
        expect(call.data).toContain('"query"');
        expect(call.data).not.toContain("mutation");
      } else {
        expect(call.method).toBe("GET");
      }
    }
  });
});

describe("merge-gate.mjs source confinement", () => {
  // The runtime assertion above proves the happy path writes nothing; this
  // pins the CONSTRUCTION, so a write verb cannot ride in on an error branch
  // the fixtures never reach.
  // Comments stripped: the scan is over code, and the header talks ABOUT the
  // verbs it forswears.
  const source = fs
    .readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("holds no REST write verb at all", () => {
    for (const verb of ["PATCH", "PUT", "DELETE"]) {
      expect(source).not.toContain(`"${verb}"`);
    }
  });

  it("POSTs only to graphql, and only a query", () => {
    const posts = [...source.matchAll(/"POST"/g)];
    expect(posts).toHaveLength(1);
    expect(source).toContain("api.github.com/graphql");
    expect(source).not.toContain("mutation");
  });
});
