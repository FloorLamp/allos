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
import {
  titleLength,
  titleRuleRefusal,
} from "../../scripts/orchestration/title-rule.mjs";

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
      // A REAL title, not an absent one: the gate checks it (#4983), so a
      // fixture with none would run every case below past a check that never
      // fired and read as if it had.
      title: "Rank a ride against the rides that came before it",
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

  // A CANCELLED RUN IS NOT A VERDICT (#4800). GitHub returns the latest run per
  // name PER CHECK SUITE, so a head whose workflow was triggered twice carries
  // the concurrency-cancelled run beside the green that replaced it. Discard
  // cancellations; of what is left under a name, ALL must be green.
  //
  // A RE-RUN NEVER REACHES THIS FUNCTION, which is why the tempting "prefer
  // red" rule is wrong rather than merely redundant: `rerun_failed_jobs` makes
  // a NEW run in the SAME suite (on #4800's head, `e2e (6)` failure 21:59:18
  // then success 22:10:28, both in suite 91296879440), and merge-gate.mjs reads
  // the DEFAULT listing, which hands over only the newest run of each suite —
  // 20 runs where `filter=all` returns 37. The last row is that head's real
  // input; preferring red would have blocked a sanctioned re-run.
  const job = (conclusion: string | null, status = "completed") => ({
    name: "merge-gate-job",
    status,
    conclusion,
  });
  it.each([
    [
      "a cancelled run beside its replacement is green",
      [job("cancelled"), job("success")],
      "pass",
    ],
    [
      "order carries no meaning — nothing picks a winner",
      [job("success"), job("cancelled")],
      "pass",
    ],
    [
      "a real failure beside a success still fails",
      [job("failure"), job("success")],
      "fail",
    ],
    [
      "a pending run beside a completed one is not a verdict",
      [job(null, "in_progress"), job("success")],
      "incomplete",
    ],
    [
      "every run cancelled is no verdict, not a red",
      [job("cancelled"), job("cancelled")],
      "incomplete",
    ],
    [
      "a re-run's discarded failure never arrives — one success is the input",
      [green("e2e (6)")],
      "pass",
    ],
  ])("cancelled is not a verdict: %s", (_case, runs, kind) => {
    expect(checkRunsVerdict(runs, null, HEAD).kind).toBe(kind);
  });

  it("names the check whose every run was cancelled, and does not call it red", () => {
    const result = checkRunsVerdict(
      [green("lint"), job("cancelled")],
      null,
      HEAD
    );
    expect(result.kind).toBe("incomplete");
    expect(result.message).toContain("no verdict for merge-gate-job");
  });

  it("counts a discarded cancellation out, and never reads it as an exclusion", () => {
    const runs = [green("lint"), job("cancelled"), job("success")];
    const result = checkRunsVerdict(runs, null, HEAD);
    expect(result.message).toContain("all 2 checks green");
    // `ignored` answers "did --ignore-check drop something", so discarding a
    // cancellation must not make the CLI announce an exclusion nobody asked for.
    expect(result.ignored).toBe(false);
    const cli = runGate({ checkRuns: runs });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("GATE OPEN");
    expect(cli.stdout).not.toContain("ignoring check");
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

  // THE TITLE RULE (#4983). A squash merge takes this title as the commit
  // subject, so a title nobody refused is one `git log` carries forever. Both
  // directions are pinned: a gate that refused a time, a range or a
  // mid-clause parenthetical would be routed around within a day, and the
  // three shapes it must not refuse are all live in this repo's own tracker.
  it.each([
    ["a compliant clause", "Rank a ride against the rides that came before it"],
    // A LITERAL 72, never the constant: a boundary case that reads the
    // bound from the code under test moves with it and can never fail.
    ["exactly 72 characters", "R".repeat(72)],
    // A colon inside a token is not a clause boundary: a time, a line
    // citation and a CSS pseudo-element, all three taken from open issues.
    ["a time", "The 9:30 sync drops HRV"],
    ["a line citation", "auth.test.ts:326 reads the frozen clock"],
    ["a pseudo-element", "The sweep is blind to ::after readouts"],
    // A PAIR of spaced dashes encloses a parenthetical — still one clause.
    ["a mid-clause dash pair", "The walk exists twice — in A and in B — and it drifts"],
    // Ranges and compounds are not separators, and U+2212 is arithmetic.
    ["an unspaced dash", "The 10:00Z–12:00Z band guesses the zone"],
    ["a minus sign", "Top − m42 assumes a pure translate"],
    ["a trailing reference", "The temperature fold offers the dose (#4712 judgement 1)"],
    // The exception is what makes this one pass: the reference is removed
    // before the separators are counted, so its own dash is not a tail.
    [
      "a dash inside a trailing reference",
      "Rank a ride against the rides before it (#4712 — judgement 1)",
    ],
    // Curly apostrophes are already in this repo's titles; this pair is one
    // real title either side of the bound, at 71 and (below) 73.
    [
      "a curly apostrophe under the bound",
      "A lane commit’s Fixes keyword closes an issue whose body marked it Refs",
    ],
  ])("accepts %s", (_case, title) => {
    expect(titleRuleRefusal("PR", title)).toBeNull();
  });

  it.each([
    ["one character over", "R".repeat(73), "is 73 characters"],
    [
      "a curly apostrophe over the bound",
      "A lane commit’s Fixes keyword closes an issue the PR body had marked Refs",
      "is 73 characters",
    ],
    ["a colon tail", "Fix the reader: it dropped three types", "carries a colon tail"],
    ["a colon tail nine characters in", "Main red: the notice count is #4370 wording", "carries a colon tail"],
    ["an em-dash tail", "Fix the reader — it dropped three types", "carries a dash tail"],
    ["a hyphen tail", "Fix the reader - it dropped three types", "carries a dash tail"],
    ["a dash pair AND a tail", "The walk exists twice — in A and in B — and it drifts — badly", "carries a dash tail"],
    // The exception is about the TAIL, so a trailing reference is still
    // counted in the length: the squash subject carries it.
    ["a trailing reference over the bound", `${"R".repeat(60)} (#4712 judgement 1)`, "is 80 characters"],
    ["both halves at once", `Fix the reader: ${"R".repeat(70)}`, "is 86 characters and carries a colon tail"],
  ])("refuses %s", (_case, title, clause) => {
    const refusal = titleRuleRefusal("PR", title);
    expect(refusal).toContain(`PR title ${clause}`);
    // The rule is QUOTED, so the reader rewriting the title need not look it up.
    expect(refusal).toContain(
      "the rule is 72 characters max, one clause, no colon or dash tail (#4983)"
    );
  });

  // 72 characters OF WHAT: grapheme clusters, because the rule exists so a
  // title survives a truncating list and a grapheme is what a reader sees
  // there. The three counts agree on every title in the live tracker, so the
  // choice can only bite on an emoji or a combining mark — and there the
  // reader's count is the one that should decide.
  it("counts what a reader counts, not UTF-16 code units", () => {
    const flag = "🇬🇧";
    expect(flag.length).toBe(4);
    expect([...flag].length).toBe(2);
    expect(titleLength(flag)).toBe(1);
    const title = `${flag.repeat(72)}`;
    expect(titleLength(title)).toBe(72);
    expect(titleRuleRefusal("PR", title)).toBeNull();
    expect(titleRuleRefusal("PR", `${flag.repeat(73)}`)).toContain(
      "is 73 characters"
    );
  });

  it("refuses through the CLI in the shape every other refusal prints", () => {
    const run = runGate({
      pr: { title: "Fix the reader: it dropped three types" },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL: PR title carries a colon tail");
    expect(run.stdout).toContain("GATE CLOSED — 1 failure(s)");
    // The published status is the evaluator's own clause, inside GitHub's limit.
    const status = run.stdout
      .split("\n")
      .find((line) => line.startsWith("STATUS: "))!;
    expect(status.length - "STATUS: ".length).toBeLessThanOrEqual(140);
    expect(status).toContain("gate CLOSED — PR title carries a colon tail");
  });

  it("names the length it measured when the title passes", () => {
    const run = runGate({});
    expect(run.stdout).toContain("PASS: PR title is one clause of 49 characters");
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
    // The same reading of `cancelled` the head checks get (#4800): a shard whose
    // run was cancelled and re-triggered must not be attributed as a red, and a
    // shard set that was ENTIRELY cancelled has no verdict rather than a green.
    //
    // THE COUNT IS #4370's WORDING, and the two rules meet here: `cancelled` is
    // discarded before counting (#4800) while `skipped` is counted and named
    // (#4370), so this pair reads "2 of 2" rather than "2 shards". Both merged
    // green alone and this row was the seam between them — it is the assertion,
    // not the behaviour, that had to move.
    [
      [
        at("e2e-main (1)", "success"),
        at("e2e-main (2)", "cancelled"),
        at("e2e-main (2)", "success"),
      ],
      "is green (2 of 2 shards ran)",
    ],
    [[at("e2e-main (1)", "cancelled")], "every shard run was cancelled"],
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
