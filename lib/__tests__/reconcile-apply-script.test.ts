import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE BODY APPLIER, DRIVEN AS A SCRIPT — the stub-curl construction of
// `./reconcile-labels-script.test.ts`, aimed at the visibility contract
// (2026-08-30): a body PATCH is silent, so an issue with READERS — a comment
// chain, or an in-flight issue named via --notify — must get a comment saying
// what changed, and a quiet issue must NOT (a mechanical sweep commenting on
// every dead-path fix is tracker noise). That conditional lives in the
// script's control flow, which the source scans in
// `./reconcile-tracker.test.ts` cannot reach.
//
// The same stub drives the body writer the applier routes through (#5673):
// the guard that saves the current body first and refuses a blanking write.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/reconcile-apply.ts");
const BODY_WRITER = path.join(
  REPO,
  "scripts/orchestration/issue-body-write.ts"
);
const TSX = path.join(REPO, "node_modules/.bin/tsx");

/** Serves GET issue, GET open PRs, PATCH body/state, POST comment from a JSON state file. */
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
  JSON.stringify({ args, method, url, body: at("--data-binary") }) + "\\n"
);
const emit = (value) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};
const one = url.match(/\\/issues\\/(\\d+)$/);
if (method === "GET" && one) emit(state[one[1]]);
if (method === "GET" && url.includes("/pulls?state=open")) {
  emit(url.includes("page=1") ? state.pulls : []);
}
if (method === "PATCH" && one) {
  Object.assign(state[one[1]], JSON.parse(at("--data-binary")));
  fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  emit(state[one[1]]);
}
const comment = url.match(/\\/issues\\/(\\d+)\\/comments$/);
if (method === "POST" && comment) {
  state[comment[1]].comments += 1;
  fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  emit({ id: 1 });
}
process.stderr.write("stub curl: unhandled " + method + " " + url + "\\n");
process.exit(9);
`;

interface Call {
  /** The WHOLE curl argv, so what a request DECLARES is observable (#5792). */
  args: string[];
  method: string;
  url: string;
  body: string | null;
}

/** The header values one call sent, in order. */
const headersOf = (c: Call): string[] =>
  c.args.filter((_, i) => c.args[i - 1] === "-H");

// What a JSON write must declare. Written out here rather than imported, so the
// test disagrees with a change instead of following it. This pins CONSTRUCTION,
// not delivery: writes from this container are credentialed by the agent proxy,
// so a live round trip returns 2xx with no `Authorization` header at all.
// `./issue-body-write.test.ts` records that measurement and the out-of-band
// probe that pins delivery — against an issue number that cannot exist, the
// request without `Content-Type` is refused by the proxy with 415 and the same
// request with it reaches GitHub, which answers 404 (#5758, #5792).
const JSON_WRITE_HEADERS = [
  "Authorization: Bearer stub token 1",
  "Accept: application/vnd.github+json",
  "Content-Type: application/json",
];

interface StubIssue {
  body: string;
  comments: number;
  labels?: string[];
  assignees?: string[];
  created_at?: string;
}

interface Tracker {
  /** Open PRs the stub serves. */
  pulls?: { number: number; title: string; body: string }[];
  /** Issues an active ledger row holds. */
  claimed?: number[];
  /** A gather's evidence, passed via --evidence. */
  staleP3?: { issue: number; ageDays: number; detail: string }[];
}

/** The stub curl on PATH, its state and call log, and this run's scratch. */
function stubTracker(issues: Record<string, StubIssue>, tracker: Tracker) {
  const dir = makeTmpDir("reconcile-apply-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  const state = path.join(dir, "state.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(
    state,
    JSON.stringify({
      pulls: tracker.pulls ?? [],
      ...Object.fromEntries(
        Object.entries(issues).map(([n, i]) => [
          n,
          {
            number: Number(n),
            title: `issue ${n}`,
            body: i.body,
            state: "open",
            comments: i.comments,
            labels: (i.labels ?? []).map((name) => ({ name })),
            assignees: (i.assignees ?? []).map((login) => ({ login })),
            created_at: i.created_at ?? "2026-09-01T00:00:00Z",
          },
        ])
      ),
    })
  );
  fs.writeFileSync(log, "");
  // A ledger of this test's own, so the container's live lanes never count.
  const ledger = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(
    ledger,
    tracker.claimed?.length
      ? JSON.stringify({
          at: "2026-09-10T00:00:00Z",
          status: "active",
          branch: "some-lane",
          issues: tracker.claimed.map(String),
        }) + "\n"
      : ""
  );
  const scratch = path.join(dir, "scratch");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: "stub token 1",
    ALLOS_DISPATCH_LEDGER: ledger,
    SCRATCH: scratch,
    STUB_STATE: state,
    STUB_LOG: log,
  };
  const calls = (): Call[] =>
    fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Call);
  const bodyOf = (issue: string): string =>
    (
      JSON.parse(fs.readFileSync(state, "utf8")) as Record<
        string,
        { body: string }
      >
    )[issue].body;
  /** The pre-write bodies the body writer kept, oldest first. */
  const kept = (): string[] => {
    const at = path.join(scratch, "issue-bodies");
    if (!fs.existsSync(at)) return [];
    return fs
      .readdirSync(at)
      .sort()
      .map((name) => fs.readFileSync(path.join(at, name), "utf8"));
  };
  return { dir, env, calls, bodyOf, kept };
}

function runApply(
  issues: Record<string, StubIssue>,
  plan: Record<string, unknown>,
  extraArgs: readonly string[],
  tracker: Tracker = {}
) {
  const stub = stubTracker(issues, tracker);
  const planFile = path.join(stub.dir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const args = [SCRIPT, planFile, ...extraArgs];
  if (tracker.staleP3) {
    const evidence = path.join(stub.dir, "evidence.json");
    fs.writeFileSync(evidence, JSON.stringify({ staleP3: tracker.staleP3 }));
    args.push("--evidence", evidence);
  }
  const run = spawnSync(TSX, args, {
    cwd: REPO,
    encoding: "utf8",
    env: stub.env,
  });
  return {
    status: run.status,
    stdout: run.stdout,
    calls: stub.calls(),
    kept: stub.kept(),
  };
}

/** The body writer as the PM runs it: `issue-body-write.ts <issue> <file>`. */
function runBodyWrite(
  issues: Record<string, StubIssue>,
  issue: string,
  body: string | null,
  extraArgs: readonly string[] = []
) {
  const stub = stubTracker(issues, {});
  const file = path.join(stub.dir, "body.md");
  if (body !== null) fs.writeFileSync(file, body);
  const run = spawnSync(TSX, [BODY_WRITER, issue, file, ...extraArgs], {
    cwd: REPO,
    encoding: "utf8",
    env: stub.env,
  });
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    calls: stub.calls(),
    body: stub.bodyOf(issue),
    kept: stub.kept(),
  };
}

const PATCH = {
  kind: "path-refresh",
  anchor: "lib/old-place.ts",
  replacement: "lib/new-place.ts",
  reason: "moved",
};
const patchPlan = (...issues: string[]) =>
  Object.fromEntries(issues.map((issue) => [issue, [PATCH]]));
const BODY = "The code sits in `lib/old-place.ts` today.";

describe("reconcile-apply visibility contract", () => {
  it("announces edits only for issues with readers", () => {
    const run = runApply(
      {
        "7": { body: BODY, comments: 3 },
        "8": { body: BODY, comments: 0 },
        "9": { body: BODY, comments: 0 },
      },
      patchPlan("7", "8", "9"),
      ["--apply", "--notify", "9,42"]
    );
    expect(run.status).toBe(0);
    const writesFor = (issue: string) =>
      run.calls.filter(
        (c) => c.method !== "GET" && c.url.includes(`/issues/${issue}`)
      );
    expect(writesFor("7").map((c) => c.method)).toEqual(["PATCH", "POST"]);
    expect(writesFor("8").map((c) => c.method)).toEqual(["PATCH"]);
    expect(writesFor("9").map((c) => c.method)).toEqual(["PATCH", "POST"]);
    const note = JSON.parse(writesFor("7")[1].body ?? "{}").body as string;
    expect(note).toContain("lib/old-place.ts → lib/new-place.ts");
    expect(note).toContain(
      "_Generated by [Claude Code](https://claude.ai/code)_"
    );
    expect(run.stdout).toContain("in flight");
    // Each body edit went through the body writer, which kept the pre-edit
    // body in scratch first (#5673).
    expect(run.kept).toEqual([BODY, BODY, BODY]);
  });

  it("--outcome records how many patches landed, for the run summary line", () => {
    // The run summary line (#865) needs "drift patched", and this is the only
    // place that number exists — the gather proposes candidates and cannot know
    // which of them landed. Written rather than retyped from stdout: a
    // hand-copied count in a durable record is a count nobody can check.
    const outcome = path.join(makeTmpDir("reconcile-outcome"), "outcome.json");
    const run = runApply(
      {
        "7": { body: BODY, comments: 0 },
        "8": { body: "unrelated", comments: 0 },
      },
      patchPlan("7", "8"),
      ["--apply", "--outcome", outcome]
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(outcome, "utf8"))).toEqual({
      applied: 1,
      refused: 1,
      skipped: 0,
      wrote: true,
    });
    expect(run.stdout).toContain("applied 1 · refused 1");
  });

  it("a DRY RUN's outcome reports zero applied, so a summary built from it counts nothing as patched", () => {
    const outcome = path.join(makeTmpDir("reconcile-outcome"), "outcome.json");
    const run = runApply({ "7": { body: BODY, comments: 0 } }, patchPlan("7"), [
      "--outcome",
      outcome,
    ]);
    expect(run.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(outcome, "utf8"))).toMatchObject({
      applied: 0,
      wrote: false,
    });
    expect(run.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a dry run writes neither, and says the comment would follow", () => {
    const run = runApply(
      { "7": { body: BODY, comments: 3 } },
      patchPlan("7"),
      []
    );
    expect(run.status).toBe(0);
    expect(run.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(run.stdout).toContain("would also comment");
  });
});

describe("the stale-P3 close (#5671)", () => {
  // The gather listed these; the applier re-reads each and re-runs the rule
  // before writing, so a claim, owner or label that arrived since keeps it open.
  const old = "2026-07-01T00:00:00Z";
  const stale = (issue: number) => ({
    issue,
    ageDays: 60,
    detail: "P3 filed 60 days ago — no claim, no assignee, no open PR",
  });
  const p3 = (over: Partial<StubIssue> = {}): StubIssue => ({
    body: "an old P3",
    comments: 0,
    labels: ["P3", "docs"],
    created_at: old,
    ...over,
  });

  it("--apply closes the qualifying issue with the one comment, not_planned", () => {
    const run = runApply(
      {
        "31": p3(),
        "32": p3({ assignees: ["someone"] }),
        "33": p3(),
        "34": p3({ labels: ["P3", "docs", "needs-human"] }),
        "35": p3(),
      },
      {},
      ["--apply"],
      {
        staleP3: [31, 32, 33, 34, 35].map(stale),
        claimed: [33],
        pulls: [{ number: 900, title: "Towards #35", body: "" }],
      }
    );
    expect(run.status).toBe(0);
    const writes = run.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => [c.method, c.url.split("/issues/")[1]])).toEqual([
      ["POST", "31/comments"],
      ["PATCH", "31"],
    ]);
    expect(JSON.parse(writes[0].body ?? "{}")).toEqual({
      body: "Unclaimed for 30 days. Reopen with a claim or an owner priority.",
    });
    expect(JSON.parse(writes[1].body ?? "{}")).toEqual({
      state: "closed",
      state_reason: "not_planned",
    });
    // Both of this script's writes send a JSON body, so both must say so
    // (#5792). Without the declaration the proxy answers 415 and neither the
    // comment nor the close ever reaches the API — a reconcile pass that
    // prints "closed 1" over a request GitHub never saw.
    expect(writes.map(headersOf)).toEqual([
      JSON_WRITE_HEADERS,
      JSON_WRITE_HEADERS,
    ]);
    expect(run.stdout).toContain("#31 stale-p3: closed not_planned");
    expect(run.stdout).toContain("stale P3 closed 1, kept 4");
  });

  it("a dry run lists each qualifying issue with its reason and writes nothing", () => {
    const run = runApply({ "31": p3() }, {}, [], { staleP3: [stale(31)] });
    expect(run.status).toBe(0);
    expect(run.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(run.stdout).toMatch(
      /#31 stale-p3: would close not_planned — P3 filed \d+ days ago — no claim, no assignee, no open PR/
    );
  });
});

describe("the body-write guard (#5673)", () => {
  // One PATCH from a missing file blanked #4959's body, and the body is the
  // only state the pinned Ladder issue has. So the writer saves the current
  // body to $SCRATCH before judging the new one, and refuses an empty body or
  // one under half the current length unless --force says so.
  const LADDER = [
    "# Priority ladder — updated 2026-09-08 14:00Z",
    "",
    "## Rungs",
    "",
    "1. #5671 stale-P3 close (landed 2026-09-09).",
    "2. #5673 Ladder rotation and guarded body writes (dispatched).",
    "3. #5674 documentation word cap (banked, awaiting review).",
    "",
    "## Slices",
    "",
    "- Orchestrator F: `docs/orchestration/**`, `scripts/orchestration/**`.",
    "- Orchestrator G: `app/(app)/history/**`, `components/IntradayChart.tsx`.",
    "",
    "## Landing order",
    "",
    "Green heads land serially; a red main takes priority over routine landing.",
    "",
  ].join("\n");
  const tracker = { "7": { body: LADDER, comments: 0 } };
  const half = LADDER.slice(0, Math.floor(LADDER.length / 2) - 1);
  const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

  it.each([
    ["an empty file", ""],
    ["a half-length body", half],
  ])(
    "%s is refused, naming both lengths, after the current body is saved",
    (_name, body) => {
      const run = runBodyWrite(tracker, "7", body);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `refusing #7: the new body is ${body.length} chars, the current body ${LADDER.length}`
      );
      expect(run.stderr).toContain("--force");
      expect(writes(run.calls)).toEqual([]);
      expect(run.body).toBe(LADDER);
      expect(run.kept).toEqual([LADDER]);
    }
  );

  it("a missing body file never reaches the network", () => {
    const run = runBodyWrite(tracker, "7", null);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("does not exist");
    expect(run.calls).toEqual([]);
    expect(run.body).toBe(LADDER);
  });

  it("a normal update is applied, with the pre-edit body kept in scratch", () => {
    const next = LADDER.replace("(dispatched)", "(banked, awaiting review)");
    const run = runBodyWrite(tracker, "7", next);
    expect(run.status).toBe(0);
    expect(
      writes(run.calls).map((c) => [c.method, JSON.parse(c.body ?? "{}")])
    ).toEqual([["PATCH", { body: next }]]);
    expect(run.body).toBe(next);
    expect(run.kept).toEqual([LADDER]);
    expect(run.stdout).toMatch(
      /saved the current body of #7 \(\d+ chars\) to \S+\/issue-bodies\/7-\S+\.md/
    );
  });

  it("--force writes the short body, still after saving the current one", () => {
    const run = runBodyWrite(tracker, "7", half, ["--force"]);
    expect(run.status).toBe(0);
    expect(writes(run.calls).map((c) => c.method)).toEqual(["PATCH"]);
    expect(run.body).toBe(half);
    expect(run.kept).toEqual([LADDER]);
  });
});
