import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE PULSE, DRIVEN AS A SCRIPT, for the one thing only the script knows:
// whether a fetch ended because the collection ran out or because it hit its
// page cap. `computeMetrics` cannot see it — it is handed arrays — and the
// report is where the belief forms, so the seam between them is what needs
// proving.
//
// Measured on the live repo 2026-09-05: the pager stops at 10 pages of 100 and
// the report printed "969 closed PRs scanned" under a heading that says
// denominators FIRST, with 2545 closed PRs in the repo. Today's numbers were
// fine; the defect is that the tool cannot tell you the day it starts lying.
//
// Same stub-curl construction as reconcile-tracker-script.test.ts, for the same
// reason: this script's curl prints raw JSON with no status suffix.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/session-metrics.mjs");

/** Serves N full pages per collection, then an empty one. Merges are dated by
 * page, so ten full pages of PRs reach back further than one. */
const STUB_CURL = `#!${process.execPath}
const url = process.argv[process.argv.length - 1];
const page = Number((url.match(/[?&]page=(\\d+)/) ?? [, "1"])[1]);
const day = String(28 - page).padStart(2, "0");
const at = "2026-08-" + day + "T00:00:00Z";
const full = (make) => Array.from({ length: 100 }, (_, i) => make(page * 1000 + i));
const emit = (rows) => {
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
};
const pages = (name) => Number(process.env["STUB_" + name + "_PAGES"]);
if (url.includes("/pulls?state=closed")) {
  emit(
    page <= pages("CLOSED_PR")
      ? full((n) => ({ number: n, title: "a merged pull request", merged_at: at, created_at: at, updated_at: at }))
      : []
  );
}
if (url.includes("/pulls?state=open")) {
  emit(page <= pages("OPEN_PR") ? full((n) => ({ number: n, draft: false })) : []);
}
if (url.includes("/issues?state=open")) {
  emit(page <= pages("OPEN_ISSUE") ? full((n) => ({ number: n, created_at: at, labels: [] })) : []);
}
process.stderr.write("stub curl: unhandled " + url + "\\n");
process.exit(9);
`;

function runPulse(
  pages: { closedPr: number; openPr: number; openIssue: number },
  days = 1
) {
  const dir = makeTmpDir("session-metrics-script");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  return spawnSync(process.execPath, [SCRIPT, "--days", String(days)], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "stub token 1",
      STUB_CLOSED_PR_PAGES: String(pages.closedPr),
      STUB_OPEN_PR_PAGES: String(pages.openPr),
      STUB_OPEN_ISSUE_PAGES: String(pages.openIssue),
    },
  });
}

const ONE = { closedPr: 1, openPr: 1, openIssue: 1 };

describe("session-metrics reports a fetch it could not finish (#5310)", () => {
  it("says TRUNCATED and prints a FLOOR when the closed-PR fetch hits its cap", () => {
    // Ten full pages: the tenth came back full, so page eleven had rows too.
    // `--days 1` keeps the window inside the fetched boundary, so the report is
    // still honest enough to print — it just has to say what it is.
    const run = runPulse({ ...ONE, closedPr: 10 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1000 merged PRs examined");
    expect(run.stdout).toContain("**TRUNCATED**");
    expect(run.stdout).toContain("FLOOR");
  });

  it("says nothing extra when the fetch reached the end of the collection", () => {
    // The converse through the same run, so the line above is the truncation
    // talking rather than a constant in the template.
    const run = runPulse({ ...ONE, closedPr: 9 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("900 merged PRs examined");
    expect(run.stdout).not.toContain("TRUNCATED");
  });

  it("refuses a --days window that reaches past the boundary it fetched", () => {
    // The cap landed at 2026-08-18 in the stub; a 3000-day window asks about
    // time nothing ever looked at. An undercount here reads exactly like a
    // quiet fortnight, and there is no line that could rescue it.
    const run = runPulse({ ...ONE, closedPr: 10 }, 3000);
    expect(run.status).toBe(2);
    // The WINDOW refusal specifically. "hit its 10-page cap" alone would also be
    // satisfied by either unwindowed refusal below, so it would not pin this one.
    expect(run.stderr).toContain("--days 3000 reaches back to");
    expect(run.stderr).toContain(
      "closed-PR fetch hit its 10-page cap at 2026-08-18"
    );
    expect(run.stdout).toBe("");
  });

  it.each([
    ["openPr", "open-PR"],
    ["openIssue", "open-issue"],
  ])("refuses outright when the %s fetch hits the cap", (key, printed) => {
    // These print as bare denominators with no window to bound them, so there
    // is no floor line that could make a clipped one honest.
    const run = runPulse({ ...ONE, [key]: 10 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`the ${printed} fetch hit its 10-page cap`);
    expect(run.stdout).toBe("");
  });
});
