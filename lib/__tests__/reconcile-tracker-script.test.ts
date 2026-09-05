import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE GATHERER, DRIVEN AS A SCRIPT, for the one thing only the script knows:
// whether a fetch ended because the collection ran out or because it hit its
// page cap. The core cannot see this — it is handed a list — and the report is
// where the belief forms, so the seam between them is what needs proving.
//
// Measured on the live tracker 2026-09-05: with no watermark stamped the PR
// fetch asks for every closed PR, stops after 1000 of the repo's 2544, and the
// report said `merged PRs examined: 969`. A high denominator, and the 1544
// merges behind the cap were never examined by anything.
//
// Same stub-curl construction as the confined writers' tests, except this
// script's curl prints raw JSON with no status suffix (`--fail-with-body`),
// so the stub does too.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/reconcile-tracker.ts");
const TSX = path.join(REPO, "node_modules/.bin/tsx");

/** Serves `STUB_ISSUE_PAGES` full issue pages and `STUB_PR_PAGES` full PR ones. */
const STUB_CURL = `#!${process.execPath}
const url = process.argv[process.argv.length - 1];
const page = Number((url.match(/[?&]page=(\\d+)/) ?? [, "1"])[1]);
const full = (make) => Array.from({ length: 100 }, (_, i) => make(page * 1000 + i));
const emit = (rows) => {
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
};
if (url.includes("/issues?")) {
  emit(
    page <= Number(process.env.STUB_ISSUE_PAGES)
      ? full((n) => ({ number: n, title: "an ordinary open issue", body: "", state: "open", labels: [] }))
      : []
  );
}
if (url.includes("/pulls?")) {
  emit(
    page <= Number(process.env.STUB_PR_PAGES)
      ? full((n) => ({ number: n, title: "a merged pull request", body: "", merged_at: "2026-09-01T00:00:00Z" }))
      : []
  );
}
process.stderr.write("stub curl: unhandled " + url + "\\n");
process.exit(9);
`;

function runGather(issuePages: number, prPages: number) {
  const dir = makeTmpDir("reconcile-tracker-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  const out = path.join(dir, "report.md");
  const json = path.join(dir, "evidence.json");
  const run = spawnSync(TSX, [SCRIPT, "--out", out, "--json", json], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "stub token 1",
      STUB_ISSUE_PAGES: String(issuePages),
      STUB_PR_PAGES: String(prPages),
    },
  });
  return {
    ...run,
    report: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "",
    evidence: fs.existsSync(json)
      ? (JSON.parse(fs.readFileSync(json, "utf8")) as { sweptCommit?: string })
      : null,
  };
}

/** HEAD of the checkout the gather ran in — the SHA it is claiming to sweep. */
function head(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
}

describe("the gatherer reports a fetch it could not finish (#865)", () => {
  it("says TRUNCATED when the PR fetch stops at its page cap", () => {
    // Ten full pages: the tenth came back full, so page eleven had rows too.
    const run = runGather(1, 10);
    expect(run.status).toBe(0);
    expect(run.report).toContain("merged PRs examined: 1000");
    expect(run.report).toContain("**TRUNCATED**");
  });

  it("says nothing extra when the fetch reached the end of the collection", () => {
    // The converse, through the same report, so the line above is proven to
    // be the truncation talking rather than a constant in the template.
    const run = runGather(1, 9);
    expect(run.status).toBe(0);
    expect(run.report).toContain("merged PRs examined: 900");
    expect(run.report).not.toContain("TRUNCATED");
  });

  it("records the real HEAD it swept, in the evidence and in the report", () => {
    // The run summary line (#865) prints this SHA as the tree the run's claims
    // were checked against, and the durable record is only worth as much as
    // that SHA is real. Compared against `git rev-parse HEAD` rather than a
    // shape check: `/^[0-9a-f]{40}$/` passes just as happily on a constant.
    const run = runGather(1, 1);
    expect(run.status).toBe(0);
    expect(run.evidence?.sweptCommit).toBe(head());
    expect(run.report).toContain(`Swept \`main\` at: ${head()}`);
  });

  it("refuses outright when the OPEN-ISSUE fetch hits the cap", () => {
    // No report line can rescue this one: every issue past the cap would be
    // silently unswept, and an unswept issue produces no finding to be wrong.
    const run = runGather(10, 1);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("open-issue fetch hit its page cap");
    expect(run.report).toBe("");
  });
});
