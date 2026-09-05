import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  independenceNotice,
  judgeIndependence,
} from "../../scripts/orchestration/landing-independence-core.mjs";

// MERGES ARE SERIAL, PRs ARE NOT (owner, 2026-09-02). Every merge stales the
// other open PRs' CI, and re-running each one at ~16 minutes serialised the
// day at a median 26 minutes between merges. The runbook's escape — "write
// down why the two file sets cannot interact" — is now a function, and these
// pins hold the two ways it can be wrong: an overlap it misses, and a shared
// file it treats as ordinary.

describe("judgeIndependence", () => {
  it("is independent when the changed paths are disjoint and ordinary", () => {
    const v = judgeIndependence({
      candidate: ["lib/charts/intraday.ts", "components/IntradayChart.tsx"],
      landed: ["lib/notifications/recap.ts", "app/(app)/upcoming/page.tsx"],
    });
    expect(v).toEqual({ independent: true, overlap: [], shared: [] });
  });

  it("is not independent when any path was changed on both sides", () => {
    const v = judgeIndependence({
      candidate: ["lib/rank-core.ts", "components/Now.tsx"],
      landed: ["lib/rank-core.ts"],
    });
    expect(v.independent).toBe(false);
    expect(v.overlap).toEqual(["lib/rank-core.ts"]);
  });

  it("is not independent when EITHER side touched a shared file", () => {
    // Disjoint diffs to an append-only barrel still interact: keep BOTH
    // entries, later merge last (review-merge.md §Migrations).
    const candidateSide = judgeIndependence({
      candidate: [
        "lib/migrations/versions/index.ts",
        "lib/migrations/versions/20260902-x.ts",
      ],
      landed: ["lib/food-log.ts"],
    });
    expect(candidateSide.independent).toBe(false);
    expect(candidateSide.shared).toEqual(["lib/migrations/versions/index.ts"]);

    const landedSide = judgeIndependence({
      candidate: ["lib/food-log.ts"],
      landed: ["e2e/seed/training.ts"],
    });
    expect(landedSide.independent).toBe(false);
    expect(landedSide.shared).toEqual(["e2e/seed/training.ts"]);
  });

  it("says which way it decided, in one line", () => {
    expect(
      independenceNotice(
        12,
        judgeIndependence({ candidate: ["a"], landed: [] }),
        0
      )
    ).toMatch(/nothing landed/);
    expect(
      independenceNotice(
        12,
        judgeIndependence({ candidate: ["a"], landed: ["b"] }),
        2
      )
    ).toMatch(/no shared paths with the 2 merge.*not visible here/);
    expect(
      independenceNotice(
        12,
        judgeIndependence({ candidate: ["a"], landed: ["a"] }),
        1
      )
    ).toMatch(/NOT independent \(paths changed on both sides: a\)/);
  });
});

// AND THE READ HAS TO REACH GITHUB AT ALL.
//
// This script asked through node's `fetch`, which ignores HTTP(S)_PROXY — the
// managed environments route GitHub through an agent proxy that answers fetch
// 403 and curl 200, as merge-gate.mjs and ci-watch.mjs both record. So every
// invocation here returned exit 2, "could not judge", and the re-run exemption
// the script exists to grant was silently unavailable.
//
// The stub below is the fixture that can tell the two spellings apart: it is a
// `curl` on PATH, so a script that calls `fetch` never reaches it and goes to
// the real network instead. A source grep for the word "fetch" could not do
// this — the script legitimately runs `git fetch` two lines later.
const SCRIPT = path.join(
  process.cwd(),
  "scripts/orchestration/landing-independence.mjs"
);

const STUB_CURL = `#!/usr/bin/env node
const body = process.env.STUB_BODY;
const status = process.env.STUB_STATUS || "200";
process.stdout.write(body + "\\n" + status);
process.exit(0);
`;

function runScript(body: unknown, status = "200") {
  const bin = path.join(makeTmpDir("landing-independence"), "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  return spawnSync(process.execPath, [SCRIPT, "4100"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_BODY: JSON.stringify(body),
      STUB_STATUS: status,
    },
  });
}

describe("the PR read", () => {
  // An already-merged PR answers and exits BEFORE any git call, so this case
  // isolates the transport: it passes only if the stub was the thing asked.
  it("goes through curl, which is the only spelling the proxy answers", () => {
    const run = runScript({
      merged_at: "2026-09-05T00:00:00Z",
      head: { sha: "0123456789abcdef0123456789abcdef01234567" },
    });
    expect(run.stdout).toContain("#4100 is already merged.");
    expect(run.status).toBe(0);
  });

  // Exit 2 keeps meaning "could not judge". A read this script cannot make
  // must never become an independence verdict it did not reach.
  it("still refuses to judge when the read fails", () => {
    const run = runScript({ message: "Not Found" }, "404");
    expect(run.stderr).toContain("could not read PR #4100: HTTP 404");
    expect(run.status).toBe(2);
  });
});
