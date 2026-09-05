import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  baseDetectorNotice,
  bodySession,
  checkRunsVerdict,
  independenceClaim,
  closedStatusDescription,
  falsifyingPassVerdict,
  holdVerdict,
  normaliseSession,
  ownershipVerdict,
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
// The two orchestrator sessions of #5177, as their PR footers spell them.
const SELF_SESSION = "session_0000000000000000000001";
const OTHER_SESSION = "session_0000000000000000000002";

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
// The status code rides the body only for a caller that ASKED for it with -w.
// merge-gate.mjs does; adversarial-review-brief.mjs, which the gate now runs
// itself (#5126), does not — and appending it to that one's reply made every
// response a non-JSON body it correctly refused to decide on.
const reply = (body) => {
  process.stdout.write(
    JSON.stringify(body) + (args.includes("-w") ? "\\n200" : "")
  );
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
if (url.includes("/issues/") && url.includes("/comments")) {
  reply(url.includes("page=1") ? (state.prComments ?? []) : []);
}
if (url.includes("/comments")) {
  reply(url.includes("page=1") ? (state.reviewComments ?? []) : []);
}
if (url.includes("/reviews")) {
  reply(url.includes("page=1") ? state.reviews : []);
}
// adversarial-review-brief.mjs --check, which the gate now runs itself (#5126):
// it reads the PR, its files, and any issue a closing keyword names.
if (url.includes("/files")) {
  reply(url.includes("page=1") ? (state.files ?? []) : []);
}
if (url.includes("/issues/")) reply({ number: 1, title: "", body: "" });
if (url.includes("/pulls/")) reply(state.pr);
process.stderr.write("stub curl: unhandled " + method + " " + url + "\\n");
process.exit(9);
`;

interface Fixture {
  pr?: Partial<Record<string, unknown>>;
  reviews?: unknown[];
  prComments?: unknown[];
  files?: unknown[];
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
      // adversarial-review-brief.mjs refuses a PR object with no number, and
      // the gate runs it (#5126) — a fixture without one would reach every case
      // below through the "could not answer" branch instead of the real matrix.
      number: 4100,
      state: "open",
      draft: false,
      head: { sha: HEAD },
      user: { login: "author-agent" },
      // A REAL title, not an absent one: the gate checks it (#4983), so a
      // fixture with none would run every case below past a check that never
      // fired and read as if it had.
      title: "Rank a ride against the rides that came before it",
      // A REAL body too, for the same reason: the ownership check (#5177) reads
      // the session footer out of it, so a fixture with none would run every
      // case below past a check that reported UNKNOWN instead of firing.
      body: `Summary.\n\n_Generated by [Claude Code](https://claude.ai/code/${SELF_SESSION})_`,
      ...overrides.pr,
    },
    // Empty by default, which is what --check reads as "ordinary": no declared
    // high-stakes path, so no falsifying pass is mandated.
    files: overrides.files ?? [],
    prComments: overrides.prComments ?? [],
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
      // Pinned, never inherited: this test container really does export a
      // session id, and a case that read the HOST's would pass here for a
      // reason no other machine reproduces.
      CLAUDE_CODE_REMOTE_SESSION_ID: SELF_SESSION,
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
    [
      "a mid-clause dash pair",
      "The walk exists twice — in A and in B — and it drifts",
    ],
    // Ranges and compounds are not separators, and U+2212 is arithmetic.
    ["an unspaced dash", "The 10:00Z–12:00Z band guesses the zone"],
    ["a minus sign", "Top − m42 assumes a pure translate"],
    [
      "a trailing reference",
      "The temperature fold offers the dose (#4712 judgement 1)",
    ],
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
    [
      "a colon tail",
      "Fix the reader: it dropped three types",
      "carries a colon tail",
    ],
    [
      "a colon tail nine characters in",
      "Main red: the notice count is #4370 wording",
      "carries a colon tail",
    ],
    [
      "an em-dash tail",
      "Fix the reader — it dropped three types",
      "carries a dash tail",
    ],
    [
      "a hyphen tail",
      "Fix the reader - it dropped three types",
      "carries a dash tail",
    ],
    [
      "a dash pair AND a tail",
      "The walk exists twice — in A and in B — and it drifts — badly",
      "carries a dash tail",
    ],
    // The exception is about the TAIL, so a trailing reference is still
    // counted in the length: the squash subject carries it.
    [
      "a trailing reference over the bound",
      `${"R".repeat(60)} (#4712 judgement 1)`,
      "is 80 characters",
    ],
    [
      "both halves at once",
      `Fix the reader: ${"R".repeat(70)}`,
      "is 86 characters and carries a colon tail",
    ],
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
    expect(run.stdout).toContain(
      "PASS: PR title is one clause of 49 characters"
    );
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

// THE PRECONDITIONS THAT USED TO LIVE ONLY IN PROSE (#5126, #5177, #5166).
//
// Every case here is one way a merge that must WAIT could read as ready. The
// shape they share is the defect the issues name: a precondition an orchestrator
// wrote in a sentence is a precondition the gate cannot fail on, and a gate that
// cannot fail is not a gate.

/** Reviews and PR comments arrive at the core as one note set. */
const note = (body: string, at = "2026-09-04T12:00:00Z", user = "claude") => ({
  body,
  at,
  user,
});

describe("merge-gate-core: the shared-identity receipt reads MARKDOWN (#5166)", () => {
  const sharedReceipt = (body: string) =>
    receiptVerdict(
      { user: { login: "claude" }, head: { sha: HEAD } },
      [{ state: "COMMENTED", user: { login: "claude" }, body }],
      HEAD
    );

  // The emphasised spellings. Each of these was REFUSED before the strip, and
  // the middle one is the exact sentence #5166 was reproduced on (PR #5137).
  it.each([
    ["plain, the control", `Reviewed ${HEAD}. I did not author this change.`],
    ["bold on the word", `Reviewed ${HEAD}. I did **not** author this change.`],
    ["underscores", `Reviewed ${HEAD}. I did _not_ author this change.`],
    ["italics on write", `Reviewed ${HEAD}. I did *not* write this change.`],
    ["inline code", `Reviewed ${HEAD}. I did \`not\` author this change.`],
    [
      "bold across the phrase",
      `Reviewed ${HEAD}. **I did not author this change.**`,
    ],
  ])("accepts a receipt that stresses the word — %s", (_case, body) => {
    const result = sharedReceipt(body);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("shared identity");
  });

  // The other direction, and it is the one that makes the strip safe to do:
  // normalising must not turn a sentence ABOUT somebody else's claim, or a
  // sentence that says the claim could not be made, into the claim itself.
  it("refuses a claim that is only QUOTED, and says so", () => {
    const result = sharedReceipt(
      `Reviewed ${HEAD}.\n\n> I did **not** author this change.\n\nThat is what the lane wrote.`
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("BLOCKQUOTED");
  });

  // Fences quote as surely as a `>` does, once both readers share one splitter
  // (#5183) — a receipt that SHOWS the sentence as an example has not said it.
  it("refuses a claim that is only shown as a fenced example", () => {
    const result = sharedReceipt(
      `Reviewed ${HEAD}. The receipt sentence goes:\n\n\`\`\`\nI did not author this change.\n\`\`\`\n`
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("BLOCKQUOTED");
  });

  it("refuses a HEDGED claim, and says so", () => {
    const result = sharedReceipt(
      `Reviewed ${HEAD}. I could **not** establish that I did not author this change.`
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HEDGED");
  });

  // The strip removes characters; it must not remove word boundaries. A
  // snake_case identifier is the shape that would break if it did.
  it("does not manufacture the phrase out of an identifier", () => {
    const result = sharedReceipt(
      `Reviewed ${HEAD}. The helper is called did_not_author_check.`
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not assert independence");
  });
});

describe("merge-gate-core: the general hold (#5126)", () => {
  it("is absent when nobody placed one", () => {
    expect(holdVerdict([note("Exact-head review, no findings.")])).toEqual({
      held: false,
      message: null,
    });
  });

  it("closes on a hold, quoting the reason its author gave", () => {
    const result = holdVerdict([
      note("MERGE-HOLD: falsifying pass still running on this head"),
    ]);
    expect(result.held).toBe(true);
    expect(result.message).toContain(
      "MERGE-HOLD: falsifying pass still running on this head"
    );
  });

  // The emphasis half of #5126's blockquoted-and-emphasised case. The
  // blockquote half was RULED THE OTHER WAY by #5183 and lives below with the
  // rest of the quoting forms.
  it("reads a hold written as an emphasised PR comment", () => {
    const result = holdVerdict([
      note("**MERGE-HOLD:** waiting on #5112's refuter"),
    ]);
    expect(result.held).toBe(true);
  });

  it("lifts on a LATER lift, and says the hold was lifted", () => {
    const result = holdVerdict([
      note("MERGE-HOLD: pass running", "2026-09-04T12:00:00Z"),
      note("MERGE-HOLD LIFTED: pass came back clean", "2026-09-04T13:00:00Z"),
    ]);
    expect(result.held).toBe(false);
    expect(result.message).toContain("LIFTED");
  });

  // A lift is not permanent absolution: the hold placed AFTER it stands.
  it("holds again on a hold placed after a lift", () => {
    const result = holdVerdict([
      note("MERGE-HOLD LIFTED: cleared", "2026-09-04T13:00:00Z"),
      note(
        "MERGE-HOLD: second refuter found something",
        "2026-09-04T14:00:00Z"
      ),
    ]);
    expect(result.held).toBe(true);
  });

  // Two markers stamped the same second are not ordered by anything, and the
  // reading that opens a gate on a coin flip is the wrong one.
  it("holds when a hold and a lift share a timestamp", () => {
    const result = holdVerdict([
      note("MERGE-HOLD LIFTED: cleared", "2026-09-04T13:00:00Z"),
      note("MERGE-HOLD: not cleared", "2026-09-04T13:00:00Z"),
    ]);
    expect(result.held).toBe(true);
  });

  // A HOLD IS NOT HEAD-BOUND, and this is the case that says why: a hold a push
  // could lift is a hold anyone can walk through by pushing.
  it("survives a head change, unlike the receipt and the pass", () => {
    const result = holdVerdict([
      note(`MERGE-HOLD: do not land ${OLD_HEAD} or its successors`),
    ]);
    expect(result.held).toBe(true);
  });
});

describe("merge-gate-core: the mandated falsifying pass (#5126)", () => {
  const GROUNDS = "declared path lib/offline/writes.ts";

  it("asks for nothing when --check did not say MANDATORY", () => {
    expect(falsifyingPassVerdict([note("anything")], HEAD, null)).toEqual({
      ok: true,
      kind: "not-required",
      message: null,
    });
  });

  // #5112 exactly: the receipt existed, the gate opened, and the pass was still
  // running. It now closes, naming the grounds that mandated it.
  it("closes on MANDATORY with no pass verdict at all, naming the grounds", () => {
    const result = falsifyingPassVerdict(
      [note(`Exact-head review of ${HEAD}: no findings.`)],
      HEAD,
      GROUNDS
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("missing");
    expect(result.message).toContain(GROUNDS);
  });

  it("opens on SURVIVES for this exact head, printing the pass's OWN line", () => {
    const result = falsifyingPassVerdict(
      [
        note(
          `FALSIFYING-PASS: SURVIVES ${HEAD} — 4 attacks built, none landed`
        ),
      ],
      HEAD,
      GROUNDS
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain(
      `FALSIFYING-PASS: SURVIVES ${HEAD} — 4 attacks built, none landed`
    );
  });

  // A HEAD CHANGE VOIDS THE PASS, exactly as it voids the receipt. Without this
  // the marker would be a label by another name: evidence about code that is no
  // longer there.
  it("closes on a pass pinned to a PREVIOUS head", () => {
    const result = falsifyingPassVerdict(
      [note(`FALSIFYING-PASS: SURVIVES ${OLD_HEAD}`)],
      HEAD,
      GROUNDS
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("stale");
    expect(result.message).toContain("VOIDS");
  });

  it("closes when the pass FALSIFIED this head", () => {
    const result = falsifyingPassVerdict(
      [note(`FALSIFYING-PASS: FALSIFIED ${HEAD} — 3 CONFIRMED reproductions`)],
      HEAD,
      GROUNDS
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("3 CONFIRMED reproductions");
  });

  // A verdict this gate cannot read is not a verdict. Answering "open" here
  // would be the permissive failure the whole issue is about.
  it("closes on a marker that says neither SURVIVES nor FALSIFIED", () => {
    const result = falsifyingPassVerdict(
      [note(`FALSIFYING-PASS: looked at ${HEAD}, mostly fine`)],
      HEAD,
      GROUNDS
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("unreadable");
  });

  it("reads a pass posted with emphasis, as a person would write it", () => {
    const result = falsifyingPassVerdict(
      [note(`**FALSIFYING-PASS: SURVIVES ${HEAD}**`)],
      HEAD,
      GROUNDS
    );
    expect(result.ok).toBe(true);
  });
});

// #5183. The grammar could not be WRITTEN DOWN on the surface it is read from:
// a PR comment explaining it, with the examples fenced, placed a live hold and
// a stale pass verdict on two of another session's PRs. Every form below is one
// the repo actually writes; each also carries the control that keeps a "nothing
// matched" from passing for the wrong reason.

const QUOTED_HOLD = "MERGE-HOLD: an example, not a hold";
const QUOTED_PASS = `FALSIFYING-PASS: SURVIVES ${HEAD}`;
const PASS_GROUNDS = "declared path lib/offline/writes.ts";

/** Every way this repo quotes a line, applied to one marker. */
const quotings: [string, (line: string) => string][] = [
  [
    "a ``` fence",
    (line) => `How it reads:\n\n\`\`\`\n${line}\n\`\`\`\n\ndone.`,
  ],
  [
    "a fence with an info string",
    (line) => `How it reads:\n\n\`\`\`text\n${line}\n\`\`\`\n\ndone.`,
  ],
  ["a ~~~ fence", (line) => `How it reads:\n\n~~~\n${line}\n~~~\n\ndone.`],
  ["four spaces of indent", (line) => `How it reads:\n\n    ${line}\n\ndone.`],
  ["a tab of indent", (line) => `How it reads:\n\n\t${line}\n\ndone.`],
  ["a blockquote", (line) => `How it reads:\n\n> ${line}\n\ndone.`],
  [
    "a blockquote around an indent",
    (line) => `How it reads:\n\n>     ${line}\n\ndone.`,
  ],
];

describe("merge-gate-core: quoting a marker does not place one (#5183)", () => {
  it.each(quotings)("a hold inside %s is not read", (_case, quote) => {
    expect(holdVerdict([note(quote(QUOTED_HOLD))]).held).toBe(false);
  });

  // NOT SILENTLY. A fence that swallows a marker without saying so is the other
  // way to lose a hold, and this gate's whole rule is that it never goes quiet
  // about a precondition it saw.
  it.each(quotings)(
    "and the gate SAYS a hold inside %s went unread",
    (_c, quote) => {
      const message = holdVerdict([note(quote(QUOTED_HOLD))]).message;
      expect(message).toContain("NOT read");
      expect(message).toContain(QUOTED_HOLD);
    }
  );

  // The permissive direction, and the reason blockquotes were ruled to quote:
  // a pass verdict OPENS a merge, so a reader that honours a quoted marker lets
  // anybody quote somebody else's pass into existence.
  it.each(quotings)(
    "a pass verdict inside %s does not open the merge",
    (_case, quote) => {
      const result = falsifyingPassVerdict(
        [note(quote(QUOTED_PASS))],
        HEAD,
        PASS_GROUNDS
      );
      expect(result.ok).toBe(false);
      expect(result.kind).toBe("missing");
    }
  );

  // THE CONTROL for all three above: the same two lines, unquoted, still work.
  // Without it every case here would also pass against a reader that had
  // stopped reading markers altogether.
  it("still reads both markers when they are not quoted", () => {
    expect(holdVerdict([note(QUOTED_HOLD)]).held).toBe(true);
    expect(
      falsifyingPassVerdict([note(QUOTED_PASS)], HEAD, PASS_GROUNDS).ok
    ).toBe(true);
  });

  // The comment #5183 was actually filed over: examples AND a real marker, in
  // one body. The examples must not arm, and the real one must still fire.
  it("holds on the real marker that follows a fenced example", () => {
    const result = holdVerdict([
      note(
        `How it reads:\n\n\`\`\`\n${QUOTED_HOLD}\n\`\`\`\n\n` +
          "MERGE-HOLD: and this one I mean"
      ),
    ]);
    expect(result.held).toBe(true);
    expect(result.message).toContain("and this one I mean");
  });

  // An indented code block cannot interrupt a paragraph, in CommonMark and on
  // GitHub — so an indented CONTINUATION line is still prose, and a marker
  // wrapped onto one still speaks.
  it("reads an indented line that continues a paragraph", () => {
    const result = holdVerdict([
      note("Blocking this, because:\n    MERGE-HOLD: the refuter is still out"),
    ]);
    expect(result.held).toBe(true);
  });
});

describe("merge-gate-core: an unterminated fence (#5183)", () => {
  const opened = (tail: string) =>
    `How it reads:\n\n\`\`\`\n${QUOTED_HOLD}\n\nnothing closes that fence.\n\n${tail}`;
  const real = "MERGE-HOLD: and this one I mean";

  // CommonMark runs an unclosed fence to the end of the document, and that is
  // what GitHub renders — so what the writer SEES as code is read as code. The
  // alternative, reading an unpaired fence as ordinary text, would re-arm every
  // example under it.
  it("runs to the end of the body, as GitHub renders it", () => {
    expect(holdVerdict([note(opened(real))]).held).toBe(false);
  });

  it("names both swallowed lines rather than going quiet", () => {
    const message = holdVerdict([note(opened(real))]).message;
    expect(message).toContain("NOT read");
    expect(message).toContain("2 MERGE-HOLD line(s)");
  });

  // THE CONTROL: close the fence and the same trailing marker fires. The case
  // above must fail because the fence is open, not because the body never
  // carried a marker.
  it("reads the trailing marker once the fence is closed", () => {
    const closed = opened(`\`\`\`\n\n${real}`);
    expect(holdVerdict([note(closed)]).held).toBe(true);
  });
});

describe("merge-gate-core: both readers agree what quoting means (#5183)", () => {
  const CLAIM = "I did not author this change.";

  it.each(quotings)("%s speaks for neither reader", (_case, quote) => {
    expect(holdVerdict([note(quote(QUOTED_HOLD))]).held).toBe(false);
    const claim = independenceClaim(quote(CLAIM));
    expect(claim.asserts).toBe(false);
    expect(claim.why).toBe("quoted");
  });

  // THE CONTROL, again: unquoted, both readers hear the same lines.
  it("and both read the unquoted line", () => {
    expect(holdVerdict([note(QUOTED_HOLD)]).held).toBe(true);
    expect(independenceClaim(CLAIM).asserts).toBe(true);
  });
});

describe("merge-gate-core: whose PR is this (#5177)", () => {
  const withBody = (body: string | null) => ({ body });

  it("passes a PR whose footer names the running session", () => {
    const result = ownershipVerdict(
      withBody(
        `_Generated by [Claude Code](https://claude.ai/code/${SELF_SESSION})_`
      ),
      SELF_SESSION
    );
    expect(result.severity).toBe("pass");
    expect(result.kind).toBe("mine");
  });

  // The three merges of 2026-09-04: every ledger check said CLEAR, correctly,
  // because the branches were never in this session's ledger.
  it("closes on a PR belonging to the other session, and names the escape", () => {
    const result = ownershipVerdict(
      withBody(`https://claude.ai/code/${OTHER_SESSION}`),
      SELF_SESSION
    );
    expect(result.severity).toBe("fail");
    expect(result.message).toContain(OTHER_SESSION);
    expect(result.message).toContain("--adopt-pr");
  });

  it("lets --adopt-pr through as a decision, not as a silence", () => {
    const result = ownershipVerdict(
      withBody(`https://claude.ai/code/${OTHER_SESSION}`),
      SELF_SESSION,
      true
    );
    expect(result.severity).toBe("note");
    expect(result.message).toContain("ADOPTED");
  });

  // THE NULL IS NOT A PASS. An older or human-authored PR carries no footer,
  // and that is a different answer from "it is yours" — the distinction
  // receiptVerdict already draws between no receipt and an unasserted one.
  it("reports an unmarked PR as UNKNOWN, never as a pass", () => {
    const result = ownershipVerdict(withBody("No footer here."), SELF_SESSION);
    expect(result.severity).not.toBe("pass");
    expect(result.kind).toBe("unmarked");
    expect(result.message).toContain("UNKNOWN");
  });

  // And neither is an unanswerable question. A host with no session id must say
  // the check did not run, or it becomes a check that cannot fail.
  it("reports UNCHECKED when the host exposes no session id", () => {
    const result = ownershipVerdict(
      withBody(`https://claude.ai/code/${OTHER_SESSION}`),
      null
    );
    expect(result.severity).not.toBe("pass");
    expect(result.message).toContain("UNCHECKED");
  });

  // The host spells it cse_<id> where the PR footer spells it session_<id>.
  it("normalises the host's spelling onto the footer's", () => {
    expect(normaliseSession("cse_0000000000000000000001")).toBe(SELF_SESSION);
    expect(normaliseSession(`https://claude.ai/code/${SELF_SESSION}`)).toBe(
      SELF_SESSION
    );
    expect(normaliseSession("")).toBe(null);
  });

  // ── THE ID COMES FROM A POSITION, NOT FROM THE WORDS (#5254) ─────────────
  //
  // The first row is #5252's body: a sentence about what the check-in stamps,
  // above a correct trailer. The shipped reader took the first `session_`
  // anywhere and refused that session's own PR as another's, offering
  // `--adopt-pr` — the override for the collision #5177 exists to prevent — as
  // the way out. The rest are the shapes that reader also got wrong, in both
  // directions.
  const TRAILER = (id: string) =>
    `\n\n---\n_Generated by [Claude Code](https://claude.ai/code/${id})_`;

  it.each([
    [
      "prose about `.session_id` above a correct trailer",
      "The check-in stamps `.boot_id` and `.session_id` on every run." +
        TRAILER(SELF_SESSION),
      SELF_SESSION,
    ],
    [
      "prose crediting the RUNNING session above another's trailer",
      `Reviewed and promoted by orchestrator C (\`${SELF_SESSION}\`).` +
        TRAILER(OTHER_SESSION),
      OTHER_SESSION,
    ],
    [
      "a session URL quoted BELOW the trailer, which last-match alone would take",
      "Body." +
        TRAILER(SELF_SESSION) +
        `\n\n> quoting https://claude.ai/code/${OTHER_SESSION}`,
      SELF_SESSION,
    ],
    [
      "a trailer carrying no id, with the commit trailer's own URL above it",
      `Body.\n\nhttps://claude.ai/code/${SELF_SESSION}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
      SELF_SESSION,
    ],
    [
      "a column name that is not an id at all",
      "The copy keeps `session_kinds` and `notes`." + TRAILER(SELF_SESSION),
      SELF_SESSION,
    ],
    ["prose about `.session_id` and nothing else", "It stamps `.session_id`.", null],
    ["no session anywhere", "No footer here.", null],
  ])("reads %s", (_case, body, expected) => {
    expect(bodySession(body)).toBe(expected);
  });

  // AND THE VERDICT MOVES WITH IT, both ways — the reader is only interesting
  // because #5177's refusal and its pass hang off it.
  it("passes #5252's own body and still closes on the other session's", () => {
    const own =
      "The check-in stamps `.boot_id` and `.session_id`." +
      TRAILER(SELF_SESSION);
    expect(ownershipVerdict(withBody(own), SELF_SESSION).severity).toBe("pass");
    const theirs =
      `Reviewed by orchestrator C (\`${SELF_SESSION}\`).` +
      TRAILER(OTHER_SESSION);
    const refused = ownershipVerdict(withBody(theirs), SELF_SESSION);
    expect(refused.severity).toBe("fail");
    expect(refused.message).toContain(OTHER_SESSION);
  });
});

// THE MATRIX THROUGH THE REAL CLI. The pure cases above pin the decisions; these
// pin that the gate actually READS the notes — reviews and PR comments both, the
// two places #5112's hold was written — and that the exact-head rule survives the
// round trip.
describe("merge-gate.mjs holds and passes end to end", () => {
  const AUTH = [{ filename: "lib/auth.ts" }];

  it("closes on a MERGE-HOLD posted as a PR comment", () => {
    const run = runGate({
      prComments: [
        {
          user: { login: "claude" },
          created_at: "2026-09-04T12:00:00Z",
          body: "MERGE-HOLD: falsifying pass still running",
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("MERGE HOLD in force");
    expect(run.stdout).toContain("STATUS: gate CLOSED");
  });

  it("opens again once the hold is lifted", () => {
    const run = runGate({
      prComments: [
        {
          user: { login: "claude" },
          created_at: "2026-09-04T12:00:00Z",
          body: "MERGE-HOLD: falsifying pass still running",
        },
        {
          user: { login: "claude" },
          created_at: "2026-09-04T13:00:00Z",
          body: "MERGE-HOLD LIFTED: pass returned SURVIVES",
        },
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("GATE OPEN");
  });

  // #5112's own shape: a high-stakes path in the diff, a receipt on the head,
  // and no pass. This is the run that used to print GATE OPEN.
  it("closes a MANDATORY diff that has no falsifying pass", () => {
    const run = runGate({ files: AUTH });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("MANDATORY adversarial review");
    expect(run.stdout).toContain("lib/auth.ts");
  });

  it("opens the same diff once the pass posts SURVIVES on this head", () => {
    const run = runGate({
      files: AUTH,
      prComments: [
        {
          user: { login: "claude" },
          created_at: "2026-09-04T12:00:00Z",
          body: `FALSIFYING-PASS: SURVIVES ${HEAD} — 5 attacks, none landed`,
        },
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("GATE OPEN");
    expect(run.stdout).toContain("5 attacks, none landed");
  });

  // And closes again on the next push: the same note, now naming a head that is
  // no longer current, is evidence about code that is gone.
  it("closes again when a push moves the head under a posted pass", () => {
    const run = runGate({
      files: AUTH,
      prComments: [
        {
          user: { login: "claude" },
          created_at: "2026-09-04T12:00:00Z",
          body: `FALSIFYING-PASS: SURVIVES ${OLD_HEAD} — 5 attacks, none landed`,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("VOIDS");
  });

  it("closes on the other session's PR and opens with --adopt-pr", () => {
    const body = `Summary.\n\nhttps://claude.ai/code/${OTHER_SESSION}`;
    const refused = runGate({ pr: { body } });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("belongs to ANOTHER session");
    const adopted = runGate({ pr: { body } }, {}, ["--adopt-pr"]);
    expect(adopted.status).toBe(0);
    expect(adopted.stdout).toContain("ADOPTED another session's PR");
  });

  // A GUARD MUST NOT FAIL INTO ITS PERMISSIVE ANSWER. When the MANDATORY
  // question cannot be asked at all, "no pass required" is the one answer that
  // must not come back — it is #5112's outcome reached by a different route.
  it("closes rather than assuming ordinary when --check cannot be asked", () => {
    const run = runGate({}, {}, ["--repo", "someone/else"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("UNANSWERED");
    expect(run.stdout).not.toContain("no falsifying pass is required");
  });

  it("says the ownership check went UNRUN with no session to compare to", () => {
    const run = runGate({}, { CLAUDE_CODE_REMOTE_SESSION_ID: "" });
    expect(run.stdout).toContain("PR OWNERSHIP UNCHECKED");
    expect(run.stdout).not.toContain("PASS: PR belongs to");
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

// THE TITLE RULE AS A COMMAND (#5068). title-rule.mjs shipped as exports and
// nothing else: run as a command it printed nothing and exited 0 for every
// string, while dispatch briefs told lanes to run it as THE check that a title
// is one clause within budget. Titles were still caught, but by the merge gate
// an hour later on an already-open PR. A guard that exits 0 on everything is
// worse than no guard — it turns a check into a ritual and the person running
// it reasonably believes they have checked.
//
// So the REFUSAL direction is what this describe exists for. A test that only
// asserted a good title exits 0 would pass unchanged against the broken file
// and reproduce the very defect; every case below therefore pins an exit code
// AND the output that goes with it, and the two that must be non-zero come
// first. The colon-tail control is the string from the issue.
describe("title-rule.mjs as a command", () => {
  const TITLE_RULE = path.join(REPO, "scripts/orchestration/title-rule.mjs");
  const runTitle = (...args: string[]) =>
    spawnSync(process.execPath, [TITLE_RULE, ...args], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30_000,
    });

  it.each([
    [
      "a colon tail",
      "Fix: dashboard performance - assert one read per window",
      ["title carries a colon tail"],
    ],
    // Both halves arrive together, one to a line, so a rewrite fixes both at
    // once rather than meeting the same gate twice.
    [
      "a length and a tail at once",
      `Fix the reader: ${"R".repeat(70)}`,
      ["title is 86 characters", "title carries a colon tail"],
    ],
  ])("exits 1 on %s and names it", (_case, title, lines) => {
    const run = runTitle(title);
    expect(run.status).toBe(1);
    expect(run.stdout.trim().split("\n")).toEqual([
      ...lines,
      "the rule is 72 characters max, one clause, no colon or dash tail (#4983); the detail is the body's first line",
    ]);
  });

  it("explains itself and exits non-zero with no title to check", () => {
    const run = runTitle();
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage: title-rule.mjs "<title>"');
  });

  it("accepts a conforming title, and says so rather than going quiet", () => {
    const run = runTitle("Rank a ride against the rides that came before it");
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("title is one clause of 49 characters");
  });
});
