import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE GATHERER'S OWN PAGE CAP (#5343). `commits.length < 100` is the exhaustion
// signal and the sweep spent it on a bare `break`, so a clipped fetch and a
// complete one printed the same counts and the same `current through` line.
//
// This site takes the FLOOR shape rather than the refusal the sibling sweeps
// take: the list is windowed by `--since`, a shortened list is still worth
// reading, and `--check` is a pm-digest line that must keep exiting 0. What a
// floor cannot survive is silence — the commits API returns NEWEST FIRST, so the
// merges a clipped fetch drops are the OLDEST ones, which are exactly the ones
// most overdue for notes.
//
// Driven as a script with a stub `curl` on PATH, the construction the confined
// writers' tests use, because the cap lives in the fetch and not in a function
// the core could be handed.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(
  REPO,
  "scripts/orchestration/release-notes-gather.mjs"
);

/** Serves `fullPages` full pages of merge commits, then one short page. */
function runGather(
  fullPages: number,
  args: readonly string[],
  subject = "Add a thing users can see"
) {
  const dir = makeTmpDir("release-notes-gather");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!${process.execPath}\n` +
      `const url = process.argv[process.argv.length - 1];\n` +
      `const page = Number((url.match(/[?&]page=(\\d+)/) ?? [, "1"])[1]);\n` +
      // Page N's commits are dated N days back, so the oldest instant the fetch
      // reached is a value the assertions can name.
      `const day = (n) => "2026-0" + (1 + Math.floor(n / 28)) + "-" + String((n % 28) + 1).padStart(2, "0");\n` +
      `const rows = page <= ${fullPages} ? 100 : 3;\n` +
      `process.stdout.write(JSON.stringify(Array.from({ length: rows }, (_, i) => ({\n` +
      `  commit: {\n` +
      `    message: ${JSON.stringify(subject)} + " (#" + (page * 1000 + i) + ")",\n` +
      `    committer: { date: day(page) + "T0" + (i % 9) + ":00:00Z" },\n` +
      `  },\n` +
      `}))));\n`,
    { mode: 0o755 }
  );
  return spawnSync(
    process.execPath,
    [SCRIPT, "--since", "2026-01-01", ...args],
    {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "stub token 1",
      },
    }
  );
}

describe("release-notes-gather.mjs at its commit page cap", () => {
  it("prints the count as a FLOOR and names the instant coverage stops at", () => {
    const run = runGather(10, []);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1000 PRs merged to main since 2026-01-01");
    expect(run.stdout).toContain("FLOOR, not a total");
    // The boundary is the OLDEST commit the fetch reached — page ten's date —
    // not the `since` the caller asked for.
    expect(run.stdout).toContain("2026-01-11T");
    expect(run.stdout).toContain("nothing merged between 2026-01-01 and that");
  });

  it("says nothing extra when the fetch reached the end of the window", () => {
    // The converse through the same render, so the line above is the truncation
    // talking rather than a constant in the template.
    const run = runGather(9, []);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("903 PRs merged to main since 2026-01-01");
    expect(run.stdout).not.toContain("FLOOR");
  });

  it("--check keeps exiting 0 and carries the floor into the digest line", () => {
    const run = runGather(10, ["--check"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("uncovered since 2026-01-01");
    expect(run.stdout).toContain("FLOOR, not a total");
  });

  it("--check withholds `current through` on a fetch that stopped short", () => {
    // The one claim a clipped fetch must never make: it is read as the lag being
    // closed, and the unread part of the window is where the lag lives. Every
    // subject here is [internal?], so nothing is uncovered and the pre-fix code
    // would have printed `current through` over half a window it never read.
    const run = runGather(
      10,
      ["--check"],
      "Runbook: tighten the dispatch brief"
    );
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("current through");
  });
});
