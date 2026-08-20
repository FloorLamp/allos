import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// A frozen clock must not outlive the file that froze it (#3263).
//
// The DB and server-action tiers share ONE worker process across many files, and
// `process.env` is process-global. So a file that sets `ALLOS_TEST_NOW` in a
// `beforeEach` and never unsets it does not merely freeze its own clock — it
// freezes the clock for every file scheduled after it in that worker, at a date
// none of them chose.
//
// The resulting failures land in innocent files and look nothing like their cause:
// a PRN countdown reading "Next dose in ~2655.7h", a niggle dated "today" where the
// fixture said "yesterday", a digest slot that had silently turned over. Each is a
// correct computation over somebody else's `now`. Worse, the set of victims depends
// on file ORDERING, so it moves between runs and reads as flake — the diagnosis
// that costs the most time, because it argues against looking for a cause at all.
//
// The rule is therefore mechanical rather than a matter of judgement: if a test
// file SETS the frozen instant, that same file must also DELETE it. Files that only
// read the variable, or only mention it in prose, are not affected.
const ROOT = path.join(__dirname, "..", "..");
const TIER_DIRS = ["lib/__tests__", "lib/__db_tests__", "lib/__action_tests__"];

const CLOCK_ENV = "ALLOS_TEST_NOW";

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Source with comments removed — prose about the variable must not register. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const SET = new RegExp(
  String.raw`process\.env\.${CLOCK_ENV}\s*=` +
    // `delete process.env.X` is not an assignment; `x = process.env.X` is a read.
    String.raw`(?!=)`
);
const CLEAR = new RegExp(String.raw`delete\s+process\.env\.${CLOCK_ENV}\b`);

describe(`a frozen ${CLOCK_ENV} is cleared by the file that set it`, () => {
  it("every test file that freezes the clock also unfreezes it", () => {
    const offenders: string[] = [];
    let setters = 0;
    for (const dir of TIER_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const code = codeOnly(fs.readFileSync(file, "utf8"));
        if (!SET.test(code)) continue;
        setters++;
        if (!CLEAR.test(code)) {
          offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
        }
      }
    }
    // The scan must actually be finding the files that freeze the clock; a regex
    // that silently matched nothing would pass this test forever.
    expect(setters).toBeGreaterThan(10);
    expect(
      offenders,
      `These files set process.env.${CLOCK_ENV} but never delete it. ` +
        `The tiers share one process, so the freeze leaks into every file that ` +
        `runs after them:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
