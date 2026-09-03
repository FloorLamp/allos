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
  */status*) body='{"statuses":[]}' ;;
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
const board = (runs: ReturnType<typeof check>[]) =>
  spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHECK_RUNS: JSON.stringify({
        total_count: runs.length,
        check_runs: runs,
      }),
      GH_TOKEN: "test",
      PATH: `${bin}:${process.env.PATH}`,
    },
  }).stdout;

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
