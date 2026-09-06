import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE CHECK-IN'S ROSTER SECTION, EXECUTED (#5259). It used to print the roster
// file whole: ~200 `(done: …)` trailers first, the handful of live `Cluster`
// lines last, and the alarms after that — the #5242 divergence banner sat below
// that wall for hours. The block is sliced out of the real script and run on a
// fixture roster, so this pins what prints and in what order, not the prose.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const checkin = fs.readFileSync(
  path.join(REPO, "scripts/orchestrator-checkin.sh"),
  "utf8"
);
const start = checkin.indexOf('echo "--- in-flight roster');
const end = checkin.indexOf("# ROSTER vs LEDGER DIVERGENCE");
expect(start).toBeGreaterThan(0);
expect(end).toBeGreaterThan(start);
const block = checkin.slice(start, end);

const done = (n: number) => `(done: old-lane-${n} 2026-09-0${n}T00:00:00.000Z)`;
const fixture = [
  done(1),
  done(2),
  done(3),
  "Cluster wt-a lane-a issues=1 port=5400",
  done(4),
  "Cluster wt-b lane-b issues=2,3 port=5600",
  done(5),
].join("\n");

function render(roster: string | null) {
  const dir = makeTmpDir("checkin-roster");
  const file = path.join(dir, ".roster");
  if (roster !== null) fs.writeFileSync(file, `${roster}\n`);
  const run = spawnSync("bash", ["-c", block], {
    encoding: "utf8",
    env: { ...process.env, ROSTER: file },
  });
  expect(run.status).toBe(0);
  return run.stdout.split("\n").filter(Boolean);
}

describe("the check-in's roster section", () => {
  it("prints live lanes first, then the closed count with only the newest three", () => {
    const lines = render(fixture);
    expect(lines.slice(1, 3)).toEqual([
      "  Cluster wt-a lane-a issues=1 port=5400",
      "  Cluster wt-b lane-b issues=2,3 port=5600",
    ]);
    expect(lines[3]).toContain("5 closed dispatch(es) on record");
    expect(lines.slice(4)).toEqual(
      [done(3), done(4), done(5)].map((d) => `    ${d}`)
    );
    expect(lines.join("\n")).not.toContain("old-lane-1");
  });

  it.each([
    ["only closed trailers", [done(1), done(2)].join("\n"), "2 closed"],
    ["an empty file", "", null],
    ["no file at all", null, null],
  ])("says so when there is nothing live — %s", (_case, roster, closed) => {
    const lines = render(roster);
    expect(lines[1]).toBe("  (no live Cluster line)");
    if (closed) expect(lines[2]).toContain(closed);
    else expect(lines).toHaveLength(2);
  });
});
