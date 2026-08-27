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

fs.writeFileSync(
  curl,
  `#!/bin/sh
case "$*" in
  *check-runs*) body='{"total_count":1,"check_runs":[{"id":1,"name":"gitleaks","status":"completed","conclusion":"success"}]}' ;;
  *workflows/ci.yml/runs*)
    if [ "$CI_STATUS" = absent ]; then body='{"workflow_runs":[]}'
    else body='{"workflow_runs":[{"id":1,"event":"pull_request","head_sha":"0123456789abcdef","status":"completed","conclusion":"success"},{"id":2,"name":"CI","event":"pull_request","head_sha":"0123456789abcdef","status":"'"$CI_STATUS"'","conclusion":"'"$CI_CONCLUSION"'","html_url":"https://example.test/ci"}]}'
    fi ;;
  *) body='{"mergeable_state":"clean","head":{"sha":"0123456789abcdef"}}' ;;
esac
printf '%s\\n200' "$body"
`
);
fs.chmodSync(curl, 0o755);

afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

it.each([
  ["absent", "success", 2, "UNSETTLED"],
  ["queued", "success", 2, "UNSETTLED"],
  ["in_progress", "success", 2, "UNSETTLED"],
  ["completed", "success", 0, "GREEN"],
  ["completed", "failure", 1, "RED"],
  ["completed", "cancelled", 1, "RED"],
  ["completed", "timed_out", 1, "RED"],
  ["completed", "startup_failure", 1, "RED"],
])(
  "treats a %s CI run with a %s conclusion correctly",
  (status, conclusion, code, verdict) => {
    const result = spawnSync(process.execPath, [SCRIPT, "123", "--once"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI_CONCLUSION: conclusion,
        CI_STATUS: status,
        GH_TOKEN: "test",
        NODE_OPTIONS: `--import=${fastTimers}`,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).toBe(code);
    expect(result.stdout).toContain(verdict);
  }
);
