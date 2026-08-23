// THE ONE TEMP-DIRECTORY MAKER FOR THE TEST TREE (#3248, and #2529 before it).
//
// WHY A SHARED SUBSTRATE RATHER THAN ANOTHER TEARDOWN. #2529 found 13,615
// stranded `/tmp/allos-db-shared-*` directories eating the whole writable
// allowance, and fixed it where it found it: an `afterAll` in
// `lib/__db_tests__/setup-shared.ts`. That fix WORKS and still works — measured
// on this container 2026-08-23, `allos-db-shared-*` was 14 of 3,248 stranded
// directories, 0.4%. What came back at scale (#3248: 19,221 directories, 24 GB)
// was the SAME LEAK THROUGH DIFFERENT CALL SITES: `allos-jsonl-*` at 846,
// `allos-email-notify-*` at 488, the four `allos-offsite-*` prefixes at 1,220
// between them — every one a `fs.mkdtempSync` written straight into a spec with
// no teardown at all.
//
// So the regression was never "the fix stopped holding". A PER-SITE fix cannot
// cover sites that do not exist yet, and this tree grew twenty more of them. The
// only fix that cannot regress the same way is one that (a) every site shares and
// (b) a guard REQUIRES every site to use — `./tmp-dir-census.test.ts` fails the
// build on a raw `mkdtempSync` under a test directory.
//
// ONE DEFENCE, DELIBERATELY: A SWEEP AT CREATION TIME. Before making a directory
// we unlink the `/tmp/allos-*` entries that are older than any live run could be.
// A teardown hook — `afterAll`, or `process.on("exit")` — cannot run in a process
// that was KILLED, and on this box that is the normal way a run ends: agents
// hitting a 10-minute tool cap mid-`agent-gates.sh`, a foreground Bash call timing
// out at 2 minutes and killing `npm run test` mid-flight, contention kills,
// container restarts. Sweeping reclaims those by CONSTRUCTION, with no cooperation
// from the process that leaked them.
//
// AND A `process.on("exit")` UNLINK WAS TRIED AND REMOVED, so nobody adds it back
// believing it helps. Measured 2026-08-23: a one-test probe file created a
// directory through this helper and the directory SURVIVED the run. Both unit
// tiers run on pooled workers (`pool: "threads"` / `"forks"`), and the pool
// terminates a worker rather than letting it exit, so the handler never fires.
// A second mechanism that works only when the first was not needed is not a
// second mechanism; it is a comment that lies.
//
// THE RESIDUAL, STATED: the steady state is up to one staleness window's worth of
// directories rather than zero — roughly 300 on this container, ~100 MB, against
// the 19,221 and 24 GB #3248 measured. It is self-limiting, which unbounded growth
// was not, and it is exactly what #3248 proposed.
//
// Nothing here changes the `afterAll`/rolling-discard logic in the db-tier setup
// files. That logic is correct for the exits it can see, it keeps the largest
// prefix near zero within a run, and #3248 explicitly put it out of scope.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every temp entry the test tree creates starts with this, so ONE sweep pattern
// covers all of them. It is also why the census refuses a bare `mkdtempSync`:
// a spec that invents its own prefix (`nul-census-`, `fact-census-`,
// `gitleaks-range-`, `dose-scan-census-` — 379 stranded directories between them,
// measured 2026-08-23) is invisible to the sweep and to the check-in's counters.
export const TMP_PREFIX = "allos-";

// HOW OLD AN ENTRY MUST BE BEFORE THE SWEEP WILL UNLINK IT, in milliseconds of
// wall clock since its mtime.
//
// WHAT THE MTIME ACTUALLY MEASURES, because a bound is only as good as the
// quantity it bounds. A directory's mtime advances when an entry is CREATED or
// UNLINKED directly inside it, and not otherwise. Measured 2026-08-23 on this
// container: appending to a file already inside it, overwriting that file, and
// writing a file in a SUBdirectory each left the mtime unmoved (0 ms), while
// creating one entry and unlinking one both moved it. So for a fixture that is
// seeded once and then written to — which is every temp directory here — the
// mtime is effectively CREATION time, and what this bounds is THE LIFETIME OF ONE
// TEMP DIRECTORY FROM CREATION. It is NOT time since last use, and a run that
// keeps a directory busy for longer than the window is swept out from under
// itself. Anyone shortening this window is choosing a lifetime cap.
//
// So the bound has to exceed the longest a single temp directory legitimately
// lives. The longest-lived one in the tree is `allos-db-shared-*`: it is seeded in
// `beforeAll` and discarded by the NEXT file's `beforeAll`, so it lives for one
// test file — bounded above by the whole DB tier, measured at ~190 s end to end on
// a quiet box (#3248), which one hour clears ~19x over.
//
// THE MARGIN THAT MATTERS IS THE LOADED ONE, and ~19x is not it. `vitest.timeouts.ts`
// in this same tree records the same DB tier taking 862 s instead of 161 s at load
// average 18.1 on these four cores — and a starved box is exactly the case the
// generosity is for. Against 862 s one hour is 4.2x. Still comfortable, and it is
// the number to argue with if this window is ever shortened. Deliberately
// generous: reclaiming an hour late costs disk that was already stranded, whereas
// sweeping a live run's fixture out from under it fails a test with a mystery
// ENOENT.
export const STALE_AFTER_MS = 60 * 60 * 1000;

// Sweep ONCE PER PROCESS, not once per created directory. The sweep is O(entries
// in /tmp) and nothing it would reclaim on a second pass could have aged past the
// threshold during a single test run.
let swept = false;

/**
 * Unlink every `/tmp/allos-*` entry (file or directory) whose mtime is older than
 * `STALE_AFTER_MS`. Returns how many entries it removed.
 *
 * Exported so the census test can drive it against a corpus rather than against
 * the real `/tmp`, and so a human can call it deliberately.
 */
export function sweepStaleTmpEntries(
  root: string = os.tmpdir(),
  now: number = Date.now(),
  staleAfterMs: number = STALE_AFTER_MS
): number {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = path.join(root, name);
    try {
      // lstat, not stat: a dangling symlink named `allos-*` must still be
      // reclaimable, and we never want to follow one out of the temp root.
      const age = now - fs.lstatSync(full).mtimeMs;
      if (age < staleAfterMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      // A concurrent sweep from a sibling agent's vitest worker got there first,
      // or the entry belongs to another uid. Neither is worth failing a test over
      // — the next run sweeps again.
    }
  }
  return removed;
}

function sweepOnce(): void {
  if (swept) return;
  swept = true;
  const removed = sweepStaleTmpEntries();
  // NOT silent when it finds something, and silent when it does not. #3248's
  // author could not do the per-prefix A/B that would have named the real leaker
  // because nothing had ever announced the backlog; a line here would have
  // surfaced it months earlier. Printing on every clean `npm run test:db` would
  // train everyone to ignore it, so the line only appears when there was in fact
  // something to reclaim.
  if (removed > 0) {
    console.warn(
      `[tmp-dir] swept ${removed} stale /tmp/${TMP_PREFIX}* entries (older than ${
        STALE_AFTER_MS / 60_000
      } min) — a previous run was killed before it could clean up (#3248)`
    );
  }
}

/**
 * Make a throwaway temp directory for a test, named `/tmp/allos-<label>-XXXXXX`.
 *
 * `label` is the old per-suite prefix WITHOUT the `allos-` and without the
 * trailing dash: `makeTmpDir("jsonl")` produces what
 * `mkdtempSync(path.join(os.tmpdir(), "allos-jsonl-"))` used to.
 *
 * Callers may still delete the directory themselves; nothing here requires it.
 */
export function makeTmpDir(label: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    throw new Error(
      `makeTmpDir: label must be lowercase words and digits joined by dashes, got ${JSON.stringify(label)}`
    );
  }
  sweepOnce();
  return fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}${label}-`));
}

// ---------------------------------------------------------------------------
// The guard's scanner (driven by ./tmp-dir-census.test.ts).
//
// Kept beside the helper rather than inside the test file so the rule and the
// thing that enforces it live together, and so the census can run the scanner
// over a corpus authored to BREAK it.

/** One test-tree source that makes a temp directory without going through here. */
export interface RawTmpCallSite {
  file: string;
  line: number;
  text: string;
}

// The construct as this repo actually spells it, in every variant present when
// the census was written:
//   fs.mkdtempSync(path.join(os.tmpdir(), "allos-jsonl-"))
//   mkdtempSync(path.join(os.tmpdir(), "nul-census-"))       // named import
//   fsMod.mkdtempSync(...)                                    // aliased namespace
//   fs.mkdtemp(...)  /  fs.promises.mkdtemp(...)              // async, none today
// So: match the METHOD NAME, with or without a receiver, rather than any
// particular import spelling — a census keyed to one import style is blind to the
// other two, which are both in the tree.
const RAW_MKDTEMP = /(?:^|[^\w.])(?:[\w$]+\.)*mkdtemp(?:Sync)?\s*\(/;

/**
 * Find every raw `mkdtemp` call in the given sources. Pure over (path, source)
 * pairs so the census can feed it a synthetic corpus.
 *
 * `allowed` is the small set of paths that may name the construct: this module,
 * which is the one place that calls it, and the census, which must QUOTE it in a
 * corpus authored to break the guard. Anything else is a leak waiting to happen.
 */
export function findRawTmpCallSites(
  sources: ReadonlyArray<{ file: string; source: string }>,
  allowed: readonly string[]
): RawTmpCallSite[] {
  const out: RawTmpCallSite[] = [];
  for (const { file, source } of sources) {
    if (allowed.includes(file)) continue;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? "";
      // A comment or a doc line that NAMES the construct in order to argue about
      // it is not a call site. Several already exist (this file has four), and a
      // guard that cried wolf on them would be deleted within a week — taking the
      // real guard with it.
      const code = text.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      if (!RAW_MKDTEMP.test(code)) continue;
      out.push({ file, line: i + 1, text: text.trim() });
    }
  }
  return out;
}
