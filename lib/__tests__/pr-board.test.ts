import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { makeTmpDir } from "./tmp-dir";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/orchestration/pr-board.mjs", import.meta.url)
);
const bin = makeTmpDir("pr-board");
const curl = path.join(bin, "curl");

fs.writeFileSync(
  curl,
  `#!/bin/sh
case "$*" in
  *annotations*) body='[]' ;;
  *check-runs*) body="$CHECK_RUNS" ;;
  */status*)
    # An UNREADABLE status endpoint is its own state, not an empty one: curl
    # fails, gh() answers null, and the row must not read GREEN off half the
    # evidence (#5022).
    if [ "$COMMIT_STATUSES" = unreadable ]; then exit 7; fi
    body="$COMMIT_STATUSES" ;;
  *reviews*) body='[]' ;;
  *) body='[{"number":12,"draft":false,"mergeable":true,"title":"A title","head":{"sha":"0123456789abcdef","ref":"a-branch"}}]' ;;
esac
printf '%s' "$body"
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
const board = (
  runs: ReturnType<typeof check>[],
  commitStatuses = '{"statuses":[]}'
) =>
  spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHECK_RUNS: JSON.stringify({
        total_count: runs.length,
        check_runs: runs,
      }),
      COMMIT_STATUSES: commitStatuses,
      GH_TOKEN: "test",
      PATH: `${bin}:${process.env.PATH}`,
    },
  }).stdout;

const statuses = (...rows: { context: string; state: string }[]) =>
  JSON.stringify({ statuses: rows });

// A `cancelled` run never reached a verdict (#4800, #4802), and on this board it
// did both harms at once: it inflated the denominator and painted a settled-green
// row red. The `run 1/2` row is the denominator half — three raw runs, two real
// checks — and it is the assertion a red-only fix would leave failing.
it.each([
  [
    "a cancelled run beside its replacement is green",
    [check(1, "e2e", "cancelled"), check(2, "e2e", "success")],
    "GREEN",
  ],
  [
    "a superseded run is out of the denominator, not just out of the red",
    [
      check(1, "e2e", "cancelled"),
      check(2, "e2e", "success"),
      check(3, "lint", null),
    ],
    "run 1/2",
  ],
  [
    "a real failure beside a cancellation still reds",
    [check(1, "e2e", "cancelled"), check(2, "e2e", "failure")],
    "RED 1",
  ],
  [
    "a name whose every run was cancelled has no verdict, and says so",
    [check(1, "gitleaks", "cancelled"), check(2, "lint", "success")],
    "<<< no verdict: gitleaks (every run cancelled — re-run it)",
  ],
])("cancelled is not a verdict: %s", (_case, runs, expected) => {
  expect(board(runs)).toContain(expected);
});

it("does not call a head with no verdict green", () => {
  const row = board([check(1, "gitleaks", "cancelled")]);
  expect(row).not.toContain("GREEN");
  expect(row).toContain("run 0/1");
});

// THE SECOND ENDPOINT, NOW THROUGH THE SHARED READER (#5022). This board
// already read both; what it did not do was distinguish a status endpoint it
// COULD NOT READ from one that answered "no statuses". `gh` returns null on a
// failed read, `?? []` turned that into an empty list, and the row printed
// GREEN off half the evidence — the reassuring-lie shape this file's own
// header warns about twice.
it.each([
  [
    "a failing status names its endpoint beside the context",
    statuses({ context: "merge-gate", state: "failure" }),
    "status merge-gate failure",
  ],
  [
    "a pending status is counted, not ignored",
    statuses({ context: "merge-gate", state: "pending" }),
    "run 1/2",
  ],
  [
    "an unreadable status endpoint keeps the row off GREEN and says so",
    "unreadable",
    "<<< commit statuses UNREADABLE",
  ],
])("commit statuses: %s", (_case, commitStatuses, expected) => {
  expect(board([check(1, "lint", "success")], commitStatuses)).toContain(
    expected
  );
});

// A SUCCESS status leaves no word on the row, so the only place it can be seen
// is the arithmetic: `run 2/3` and not `run 1/2` is the whole assertion, and a
// board that dropped the status would print the second.
it("counts a green status into both halves of the fraction", () => {
  expect(
    board(
      [check(1, "lint", "success"), check(2, "e2e", null)],
      statuses({ context: "merge-gate", state: "success" })
    )
  ).toContain("run 2/3");
});

it("does not read an unreadable status endpoint as an empty one", () => {
  const row = board([check(1, "lint", "success")], "unreadable");
  expect(row).not.toContain("GREEN");
  expect(row).toContain("status?");
});
