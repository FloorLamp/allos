import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { makeTmpDir } from "./tmp-dir";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/orchestration/ci-watch.mjs", import.meta.url)
);
const bin = makeTmpDir("ci-watch");
const curl = path.join(bin, "curl");
const fastTimers = `data:text/javascript,${encodeURIComponent(
  "const timer=setTimeout;globalThis.setTimeout=(fn,_ms,...args)=>timer(fn,0,...args)"
)}`;

// The fake curl serves CHECK_RUNS_2 from the second check-runs call onward, so a
// test can move the registered set BETWEEN the watcher's two samples. That is
// the only way to exercise settlement at all, because settlement is defined as
// two matching fingerprints — a static payload can only ever say "settled".
fs.writeFileSync(
  curl,
  `#!/bin/sh
case "$*" in
  *check-runs*)
    printf x >> "$STATE"
    if [ "$(wc -c < "$STATE" | tr -d ' ')" -gt 1 ] && [ -n "$CHECK_RUNS_2" ]
      then body="$CHECK_RUNS_2"
      else body="$CHECK_RUNS"
    fi ;;
  */status*) body="$COMMIT_STATUSES" ;;
  *workflows/ci.yml/runs*)
    if [ "$CI_STATUS" = absent ]; then body='{"workflow_runs":[]}'
    else body='{"workflow_runs":[{"id":1,"event":"pull_request","head_sha":"0123456789abcdef","status":"completed","conclusion":"success"},{"id":2,"name":"CI","event":"pull_request","head_sha":"0123456789abcdef","status":"'"$CI_STATUS"'","conclusion":"'"$CI_CONCLUSION"'","html_url":"https://example.test/ci"}]}'
    fi ;;
  *) body='{"mergeable_state":"'"$MERGEABLE_STATE"'","head":{"sha":"0123456789abcdef"}}' ;;
esac
printf '%s\\n200' "$body"
`
);
fs.chmodSync(curl, 0o755);

afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

const check = (id: number, name: string, conclusion: string | null) => ({
  id,
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
});
const payload = (runs: ReturnType<typeof check>[]) =>
  JSON.stringify({ total_count: runs.length, check_runs: runs });

const GREEN_ONE = payload([check(1, "gitleaks", "success")]);

// The other endpoint (#5022). `statuses` is the per-context list; the combined
// `state` field is deliberately never read, because it is `pending` for a
// commit that has no statuses at all.
const statuses = (...rows: { context: string; state: string }[]) =>
  JSON.stringify({ statuses: rows });
const NO_STATUSES = statuses();

let seq = 0;
function watch(env: Record<string, string> = {}) {
  const state = path.join(bin, `state-${++seq}`);
  fs.writeFileSync(state, "");
  return spawnSync(process.execPath, [SCRIPT, "123", "--once"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHECK_RUNS: GREEN_ONE,
      COMMIT_STATUSES: NO_STATUSES,
      CI_CONCLUSION: "success",
      CI_STATUS: "completed",
      GH_TOKEN: "test",
      MERGEABLE_STATE: "clean",
      NODE_OPTIONS: `--import=${fastTimers}`,
      PATH: `${bin}:${process.env.PATH}`,
      STATE: state,
      ...env,
    },
  });
}

// A cancelled CI workflow run reached no verdict either, so it is neither the
// red this row used to assert nor a green: it is unsettled, and exit 2 asks for
// the re-run it needs (#4802).
it.each([
  ["absent", "success", 2, "UNSETTLED"],
  ["queued", "success", 2, "UNSETTLED"],
  ["in_progress", "success", 2, "UNSETTLED"],
  ["completed", "success", 0, "GREEN"],
  ["completed", "failure", 1, "RED"],
  ["completed", "cancelled", 2, "UNSETTLED"],
  ["completed", "timed_out", 1, "RED"],
  ["completed", "startup_failure", 1, "RED"],
])(
  "treats a %s CI run with a %s conclusion correctly",
  (status, conclusion, code, verdict) => {
    const result = watch({ CI_CONCLUSION: conclusion, CI_STATUS: status });

    expect(result.status).toBe(code);
    expect(result.stdout).toContain(verdict);
  }
);

it("says a cancelled CI workflow run needs re-running, rather than only 're-invoke'", () => {
  const result = watch({ CI_CONCLUSION: "cancelled", CI_STATUS: "completed" });
  expect(result.stdout).toContain("The CI workflow run itself was cancelled");
});

// A `cancelled` CHECK RUN is not a verdict either (#4800, #4802): GitHub returns
// the newest run per name PER CHECK SUITE, so a head whose workflow was
// triggered twice carries the concurrency-cancelled run beside the green that
// replaced it. Nothing here picks a winner, so a real red beside a cancellation
// still reds — the last two rows are that assertion in both orders.
it.each([
  [
    "one plain green is still green",
    [check(1, "check", "success")],
    0,
    "GREEN",
  ],
  [
    "a cancelled run beside its replacement is green",
    [check(1, "check", "cancelled"), check(2, "check", "success")],
    0,
    "GREEN",
  ],
  [
    "order carries no meaning — nothing picks a winner",
    [check(1, "check", "success"), check(2, "check", "cancelled")],
    0,
    "GREEN",
  ],
  [
    "every run under a name cancelled is no verdict, not a red",
    [check(1, "check", "cancelled"), check(2, "check", "cancelled")],
    2,
    "UNSETTLED",
  ],
  [
    "a real failure beside a success still fails",
    [check(1, "check", "failure"), check(2, "check", "success")],
    1,
    "RED",
  ],
  [
    "a real failure beside a cancellation still fails",
    [check(1, "check", "cancelled"), check(2, "check", "failure")],
    1,
    "RED",
  ],
])("cancelled is not a verdict: %s", (_case, runs, code, verdict) => {
  const result = watch({ CHECK_RUNS: payload(runs) });

  expect(result.status).toBe(code);
  expect(result.stdout).toContain(verdict);
});

it("counts the verdicts it has, and names the check that has none", () => {
  const green = watch({
    CHECK_RUNS: payload([
      check(1, "check", "cancelled"),
      check(2, "check", "success"),
      check(3, "lint", "success"),
    ]),
  });
  expect(green.stdout).toContain(
    "GREEN — all 2 check run(s) and 0 commit status(es) settled"
  );

  const none = watch({
    CHECK_RUNS: payload([
      check(1, "check", "cancelled"),
      check(2, "lint", "success"),
    ]),
  });
  expect(none.status).toBe(2);
  expect(none.stdout).toContain(
    "no verdict for check (every run cancelled — re-run it)"
  );
});

// SETTLEMENT READS THE RAW SET, THE VERDICT READS THE FILTERED ONE, and this
// pair is what that decision buys. The first row's polls hold the SAME filtered
// set — only a cancelled run arrives between them — so a fingerprint taken over
// the filtered set would call it settled and print GREEN in the middle of a
// suite registering. The second row is the control: an unmoving set still
// settles, so the first row's exit 2 is the fingerprint and not the harness.
const SETTLED_PAIR = [
  check(1, "lint", "success"),
  check(3, "check", "success"),
];
it.each([
  [
    "a cancelled run arriving between polls is registration still moving",
    payload([...SETTLED_PAIR, check(2, "check", "cancelled")]),
    2,
    "UNSETTLED",
  ],
  ["a set that does not move settles", payload(SETTLED_PAIR), 0, "GREEN"],
])("settlement: %s", (_case, second, code, verdict) => {
  const result = watch({
    CHECK_RUNS: payload(SETTLED_PAIR),
    CHECK_RUNS_2: second,
  });

  expect(result.status).toBe(code);
  expect(result.stdout).toContain(verdict);
});

// THE STALE-DIRTY NOTE COMPARED ARRAYS TO 0 (`s.pending === 0`), so its branch
// could never be taken and every dirty read exited BLOCKED — the #4016 defect
// that block was written to fix, still shipping, wearing a `===`. The second row
// is the converse: dirty must STILL block while the checks are unsettled, which
// is the half a bare "stop blocking on dirty" would have thrown away.
it.each([
  [
    "a settled green outlives a cached dirty flag",
    GREEN_ONE,
    0,
    "The flag is stale",
  ],
  [
    "dirty still blocks while the checks are unsettled",
    payload([check(1, "gitleaks", null)]),
    3,
    "BLOCKED",
  ],
])("mergeable_state=dirty: %s", (_case, runs, code, expected) => {
  const result = watch({ CHECK_RUNS: runs, MERGEABLE_STATE: "dirty" });

  expect(result.status).toBe(code);
  expect(result.stdout + result.stderr).toContain(expected);
});

// BOTH ENDPOINTS, ONE VERDICT (#5022). A commit's statuses are a disjoint set
// this watcher never read, so `GREEN — all 19 registered checks settled` was a
// claim about `/check-runs` alone — printed on PR #5319 beside a `merge-gate`
// status reading `failure`. The last two rows are the pair that has to hold in
// BOTH directions: an independent context reds, and the gate's own context —
// which merge-gate.mjs recomputes, and which is legitimately `failure` on
// every pre-review head — reports without reddening. A watcher red on every
// healthy PR is a watcher nobody reads.
it.each([
  ["no statuses at all behaves exactly as today", NO_STATUSES, 0, "GREEN"],
  [
    "an all-success status set is green and counted",
    statuses({ context: "deploy", state: "success" }),
    0,
    "GREEN — all 1 check run(s) and 1 commit status(es) settled",
  ],
  [
    "a pending status is unsettled, not absent",
    statuses({ context: "deploy", state: "pending" }),
    2,
    "1 pending: status deploy",
  ],
  [
    "a failing independent status reds a green check set",
    statuses({ context: "deploy", state: "failure" }),
    1,
    "RED — 1 failing check(s)",
  ],
  [
    "the failing row names its endpoint, not just its context",
    statuses({ context: "deploy", state: "error" }),
    1,
    "error: status deploy",
  ],
  [
    "the gate's own status is reported beside the green, not folded into it",
    statuses({ context: "merge-gate", state: "failure" }),
    0,
    "NOT MERGEABLE YET — status merge-gate failed:",
  ],
])("both endpoints: %s", (_case, commitStatuses, code, expected) => {
  const result = watch({ COMMIT_STATUSES: commitStatuses });

  expect(result.status).toBe(code);
  expect(result.stdout).toContain(expected);
});

// GREEN ONE CHECK EARLY (#5317). Two matching fingerprints both landed before
// `merge-gate-job` registered, and `mergeable_state` — on screen in every poll
// line — said `unstable` throughout and was right. It cannot simply block
// settlement, because a non-passing status makes a PR `unstable` too and this
// repo posts one on every pre-review head; the first two rows are that pair.
// The third is the control that keeps the first honest: same green checks,
// `clean`, settles.
it.each([
  [
    "unstable with nothing to explain it is a check that has not registered",
    "unstable",
    NO_STATUSES,
    2,
    "mergeable_state=unstable while every check run and commit status we can read is green",
  ],
  [
    "unstable explained by the gate's own closed status still settles",
    "unstable",
    statuses({ context: "merge-gate", state: "failure" }),
    0,
    "GREEN",
  ],
  [
    "a clean head with the same checks settles",
    "clean",
    NO_STATUSES,
    0,
    "GREEN",
  ],
])(
  "settlement: %s",
  (_case, mergeableState, commitStatuses, code, expected) => {
    const result = watch({
      COMMIT_STATUSES: commitStatuses,
      MERGEABLE_STATE: mergeableState,
    });

    expect(result.status).toBe(code);
    expect(result.stdout).toContain(expected);
  }
);
