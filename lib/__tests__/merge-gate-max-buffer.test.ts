// THE GATE MUST SURVIVE A BIG READ (#5403).
//
// `merge-gate.mjs`'s `curl()` runs `execFileSync`, whose `maxBuffer` default is
// 1 MiB — and exceeding that default THROWS rather than returning a failure, so
// an oversized response killed the gate mid-run instead of failing a check. The
// read that hit it is the base-moved comparison, which carries every commit the
// base gained with its full message: on PR #5423, whose head sat nine merges
// behind, that payload measured 1,063,297 bytes. It is also the read the gate
// marks `soft`, and `soft` cannot help — it is checked inside `gh()` after
// `curl()` returns, and the throw escapes before any status exists to soften.
//
// So the fixture forces exactly that shape: a stubbed `curl` whose comparison
// response is deliberately larger than the old default, on a gate run that must
// still reach a verdict. The assertion is the verdict LINE, not the exit code —
// a crash also exits 1, so exit status alone cannot tell the two apart.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { makeTmpDir } from "./tmp-dir";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/orchestration/merge-gate.mjs", import.meta.url)
);
const OLD_DEFAULT_MAX_BUFFER = 1024 * 1024;
const HEAD = "477cd8a1afd4ff38afb33ff7c9b1de5fd380fb31";

const bin = makeTmpDir("merge-gate-max-buffer");
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

// The padding is a commit-message-shaped string because that is what actually
// makes a comparison big — 40 KB of it per commit on a busy base.
const comparePath = path.join(bin, "compare.json");
fs.writeFileSync(
  comparePath,
  JSON.stringify({
    merge_base_commit: { sha: HEAD },
    total_commits: 0,
    commits: [],
    files: [],
    pad: "a commit subject and its body, repeated ".repeat(30_000),
  })
);

const prPath = path.join(bin, "pr.json");
fs.writeFileSync(
  prPath,
  JSON.stringify({
    number: 12,
    state: "open",
    draft: false,
    mergeable: true,
    title: "A title the gate accepts",
    body: "",
    user: { login: "someone" },
    head: { sha: HEAD, ref: "a-branch" },
    base: { ref: "main" },
  })
);

const curl = path.join(bin, "curl");
fs.writeFileSync(
  curl,
  `#!/bin/sh
# merge-gate's curl asks for the status code with -w, so every answer here is
# body, newline, code — the shape curl() splits on its last newline.
case "$*" in
  *graphql*) printf '{}\\n403' ;;
  *compare*) cat ${JSON.stringify(comparePath)}; printf '\\n200' ;;
  *reviews*|*comments*) printf '[]\\n200' ;;
  *check-runs*) printf '{"total_count":1,"check_runs":[{"id":1,"name":"a-check","status":"completed","conclusion":"success"}]}\\n200' ;;
  */status*) printf '{"state":"success","statuses":[]}\\n200' ;;
  *pulls/12*) cat ${JSON.stringify(prPath)}; printf '\\n200' ;;
  *) printf '{}\\n200' ;;
esac
`
);
fs.chmodSync(curl, 0o755);

it("reaches a verdict when the base comparison outgrows the exec default", () => {
  // The fixture only tests anything if it actually crosses the old ceiling.
  expect(fs.statSync(comparePath).size).toBeGreaterThan(OLD_DEFAULT_MAX_BUFFER);

  // `--repo` off the default keeps adversarial-review-brief.mjs unspawned: its
  // refusal is a FAIL the gate records and carries on from, which is all this
  // needs, and it leaves one process reading one stubbed curl.
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "12", "--repo", "owner/name", "--session", "session_0test12"],
    {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "test", PATH: `${bin}:${process.env.PATH}` },
    }
  );

  expect(run.stderr).not.toContain("ENOBUFS");
  expect(run.stdout).toContain(`PR #12 head ${HEAD.slice(0, 8)} (open)`);
  // The line the base-moved verdict computes FROM that oversized payload: it
  // can only be printed if the comparison was read and parsed.
  expect(run.stdout).toContain(`CI base IS main@${HEAD.slice(0, 8)}`);
  expect(run.stdout).toContain("GATE CLOSED");
});
