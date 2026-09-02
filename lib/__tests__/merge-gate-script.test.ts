import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  baseDetectorNotice,
  checkRunsVerdict,
  closedStatusDescription,
  readinessVerdict,
  receiptVerdict,
} from "../../scripts/orchestration/merge-gate-core.mjs";

// THE MERGE GATE. Verdict branches run against the pure core; the smaller
// stub-curl set drives the real CLI where process, auth and transport matter.
// The exact-head invariant
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
  // Head vs BASE-BRANCH check runs: the base read is the one addressed by ref.
  if (url.includes(state.pr.head.sha))
    reply({ total_count: state.checkRuns.length, check_runs: state.checkRuns });
  if (state.baseCheckRunsStatus) {
    process.stdout.write("{}\\n" + state.baseCheckRunsStatus);
    process.exit(0);
  }
  reply({ total_count: state.baseCheckRuns.length, check_runs: state.baseCheckRuns });
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
  baseCheckRuns?: unknown[];
  baseCheckRunsStatus?: number;
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
    baseCheckRuns: overrides.baseCheckRuns ?? [],
    baseCheckRunsStatus: overrides.baseCheckRunsStatus,
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

function receipt(overrides: Fixture) {
  const state = fixture(overrides);
  return receiptVerdict(state.pr, state.reviews, HEAD);
}

describe("merge-gate.mjs", () => {
  it("opens the gate and sends no write verb", () => {
    const run = runGate({});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("GATE OPEN");
    expect(run.stdout).toContain(
      `receipt: reviewer-agent states ${HEAD.slice(0, 8)}`
    );
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

  it("closes on a receipt pinned to a PREVIOUS head — the review is void", () => {
    const result = receipt({
      reviews: [
        {
          state: "COMMENTED",
          user: { login: "reviewer-agent" },
          body: `Exact-head review of ${OLD_HEAD}: clean.`,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("VOIDS");
  });

  it("closes a same-account review that states the SHA but not independence", () => {
    // The #4258 boundary: on a shared identity the receipt must SAY the
    // reviewer did not author the change — a SHA alone is not the claim.
    const result = receipt({
      reviews: [
        {
          state: "COMMENTED",
          user: { login: "author-agent" },
          body: `Reviewed my own ${HEAD}.`,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not assert independence");
  });

  it("opens on a shared-identity receipt that states SHA AND non-authorship", () => {
    // The orchestrator and its lanes post as one account (#4258): a genuine
    // independent review used to fail on identity rather than content. The
    // claim the gate can actually check is the stated one.
    const result = receipt({
      reviews: [
        {
          state: "COMMENTED",
          user: { login: "author-agent" },
          body:
            `Independent review of ${HEAD}: I did not author this change. ` +
            "Verified claims against the repo; no findings.",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("shared identity");
    expect(result.message).toContain("did not author");
  });

  it("a shared-identity assertion still needs THIS head's SHA", () => {
    const result = receipt({
      reviews: [
        {
          state: "COMMENTED",
          user: { login: "author-agent" },
          body: `Independent review of ${OLD_HEAD}: I did not author this change.`,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("closes when a review exists but never states the SHA", () => {
    const result = receipt({
      reviews: [
        { state: "COMMENTED", user: { login: "reviewer-agent" }, body: "LGTM" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no exact-head receipt");
    expect(closedStatusDescription(result.message)).toContain(
      "gate CLOSED — no exact-head receipt"
    );
  });

  it("keeps the published failure description inside GitHub's 140-character limit", () => {
    const result = checkRunsVerdict(
      [
        green("lint"),
        {
          name: `test-${"very-long-check-name-".repeat(10)}`,
          status: "completed",
          conclusion: "failure",
        },
      ],
      null,
      HEAD
    );
    const status = closedStatusDescription(result.message);
    expect(status.length).toBeLessThanOrEqual(140);
    expect(status).toContain("gate CLOSED — red checks on this head");
  });

  it("closes on a red check and names it", () => {
    const result = checkRunsVerdict(
      [
        green("lint"),
        { name: "test", status: "completed", conclusion: "failure" },
      ],
      null,
      HEAD
    );
    expect(result.kind).toBe("fail");
    expect(result.message).toContain("red checks on this head: test");
  });

  it("exits 2 — NOT a verdict — while a check is still running", () => {
    const result = checkRunsVerdict(
      [green("lint"), { name: "test", status: "in_progress" }],
      null,
      HEAD
    );
    expect(result.kind).toBe("incomplete");
    expect(result.message).toContain("CI INCOMPLETE");
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
    expect(checkRunsVerdict(withSelf.checkRuns, null, HEAD).kind).toBe(
      "incomplete"
    );
    const result = checkRunsVerdict(withSelf.checkRuns, "merge-gate", HEAD);
    expect(result.kind).toBe("pass");
    expect(result.ignored).toBe(true);
    const cli = runGate(withSelf, {}, ["--ignore-check", "merge-gate"]);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain('ignoring check "merge-gate"');
    // The exclusion is by NAME, not by status: a pending check that is not
    // the wrapper still blocks.
    const other = checkRunsVerdict(
      [green("lint"), { name: "test", status: "in_progress" }],
      "merge-gate",
      HEAD
    );
    expect(other.kind).toBe("incomplete");
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
    const state = fixture({ pr: { draft: true } });
    const result = readinessVerdict(state.pr);
    expect(result.failures).toEqual([expect.stringContaining("DRAFT")]);
  });

  // A RED THAT NO GATE READS IS A RED NOBODY CLOSES (#4722). e2e-main runs on
  // pushes to main, so it is never on a PR head and every check above is
  // structurally blind to it — main stayed red there for eight merges while
  // every PR read green. The notice states it; it must never close the gate,
  // which .github/workflows/e2e-main.yml reserves as a separate ruling.
  const SHA = `${"9".repeat(40)}`;
  const at = (
    name: string,
    conclusion: string | null,
    status = "completed"
  ) => ({
    name,
    status,
    conclusion,
    head_sha: SHA,
  });
  it.each([
    [[], "no verdict on main"],
    [
      [at("e2e-main (1)", "success"), at("e2e-main (2)", "failure")],
      "is RED — e2e-main (2)",
    ],
    [
      [at("e2e-main (1)", null, "in_progress"), at("e2e-main (2)", "success")],
      "still running",
    ],
    // A shard that SKIPPED did not pass, so it may not be counted as one that
    // did (#4370). All-skipped is the shape e2e-main produces for a push with no
    // runtime surface, and it used to read here as a four-shard green.
    [
      [at("e2e-main (1)", "success"), at("e2e-main (2)", "skipped")],
      "is green (1 of 2 shards ran)",
    ],
    [
      [at("e2e-main (1)", "skipped"), at("e2e-main (2)", "skipped")],
      "ran NOTHING (2 shards skipped",
    ],
    [[at("lint", "failure")], "no verdict on main"],
  ])("reports main's e2e-main standing: %#", (runs, expected) => {
    expect(baseDetectorNotice(runs, "main")).toContain(expected);
  });

  it("prints a RED base detector and still OPENS the gate", () => {
    const run = runGate({
      baseCheckRuns: [
        {
          name: "e2e-main (2)",
          status: "completed",
          conclusion: "failure",
          head_sha: SHA,
        },
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("e2e-main: main@99999999 is RED");
    expect(run.stdout).toContain("GATE OPEN");
  });

  it("says the standing is unknown when the base read fails, and still opens", () => {
    const run = runGate({ baseCheckRunsStatus: 404 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("e2e-main standing unknown");
    expect(run.stdout).toContain("GATE OPEN");
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
