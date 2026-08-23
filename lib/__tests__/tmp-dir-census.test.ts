import { execFileSync } from "node:child_process";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_MS,
  TMP_PREFIX,
  findRawTmpCallSites,
  makeTmpDir,
  sweepStaleTmpEntries,
} from "./tmp-dir";

// THE GUARD THAT KEEPS #3248 FROM COMING BACK A THIRD TIME.
//
// #2529 fixed the temp-dir leak at the one call site that was leaking. #3248 is
// the same leak at the same scale (19,221 directories, 24 GB) through TWENTY
// OTHER call sites written since — none of which the #2529 fix could ever have
// covered, because a per-site teardown only covers the site it is written at.
//
// So the fix is a shared maker (./tmp-dir.ts) plus this: a census that FAILS when
// a test file makes a temp directory outside it. Without the census the helper is
// a suggestion, and the next twenty specs will spell `mkdtempSync` inline exactly
// as the last twenty did.
//
// SCOPE. The test tiers, which are what run constantly on a long-lived
// orchestration container. `scripts/` is deliberately out: those run by hand, once,
// and `scripts/gen-zip-centroids.ts` cleans up after itself.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// The two files that may name the construct, each with the reason.
//   - the maker itself, which is the one place that calls it;
//   - this census, which must QUOTE it in a corpus authored to break the guard.
// Adding a third entry is a deliberate act with a sentence attached.
const ALLOWED = [
  "lib/__tests__/tmp-dir.ts",
  "lib/__tests__/tmp-dir-census.test.ts",
] as const;
const SELF = ALLOWED[0];

const SCANNED_DIRS = [
  "lib/__tests__/",
  "lib/__db_tests__/",
  "lib/__action_tests__/",
  "components/__tests__/",
  "e2e/",
];

function scannedSources(): Array<{ file: string; source: string }> {
  const files = execFileSync("git", ["ls-files", "-z", ...SCANNED_DIRS], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((f) => f.endsWith(".ts"));
  return files.map((file) => ({
    file,
    source: readFileSync(path.join(REPO, file), "utf8"),
  }));
}

describe("the temp-directory census (#3248)", () => {
  it("finds no test file making a temp directory outside makeTmpDir", () => {
    const raw = findRawTmpCallSites(scannedSources(), ALLOWED).map(
      (s) =>
        `${s.file}:${s.line} — ${s.text}\n    Use makeTmpDir("<label>") from ` +
        `lib/__tests__/tmp-dir.ts. A raw mkdtemp is invisible to the stale-entry ` +
        `sweep, so an interrupted run strands the directory forever (#3248).`
    );
    expect(raw).toEqual([]);
  });
});

describe("the census's reach", () => {
  // A green sweep over a tree that already complies says nothing about what the
  // sweep can SEE, so it is run over sources authored to break it — in every
  // spelling that was actually present in this repo before the conversion.
  it("sees every spelling of the construct this repo has used", () => {
    const found = findRawTmpCallSites(
      [
        {
          file: "a.ts",
          source: `const d = fs.mkdtempSync(path.join(os.tmpdir(), "allos-x-"));`,
        },
        {
          file: "b.ts",
          source: `const d = mkdtempSync(path.join(os.tmpdir(), "nul-census-"));`,
        },
        {
          file: "c.ts",
          source: `const r = fsMod.mkdtempSync(path.join(os.tmpdir(), "food-"));`,
        },
        {
          file: "d.ts",
          source: `const d = await fs.promises.mkdtemp(os.tmpdir() + "/x-");`,
        },
        {
          file: "e.ts",
          // The prefix is what makes a leak invisible to the SWEEP, but the census
          // keys on the CALL, not the prefix — a site with the right prefix and no
          // teardown leaks just the same until the sweep ages it out.
          source: `const d = fs.mkdtempSync(path.join(os.tmpdir(), "${TMP_PREFIX}ai-clear-"));`,
        },
      ],
      ALLOWED
    );
    expect(found.map((f) => f.file)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
    ]);
  });

  it("stays quiet on the benign neighbours", () => {
    const found = findRawTmpCallSites(
      [
        // A comment that names the construct in order to argue about it. Four of
        // these live in tmp-dir.ts itself and several more in the specs; a guard
        // that fired on them would be deleted within a week.
        { file: "a.ts", source: `// never call fs.mkdtempSync(...) directly` },
        {
          file: "b.ts",
          source: ` * planted in a mkdtemp corpus only this test sees`,
        },
        // The sanctioned call.
        { file: "c.ts", source: `const dir = makeTmpDir("jsonl");` },
        // A different fs call on a temp path is not this rule's business.
        {
          file: "d.ts",
          source: `fs.writeFileSync(path.join(os.tmpdir(), "allos-takeout-1.zip"), z);`,
        },
        // A symbol that merely CONTAINS the name.
        { file: "e.ts", source: `const notMkdtempSyncEither = 1;` },
      ],
      ALLOWED
    );
    expect(found).toEqual([]);
  });

  it("exempts the one module allowed to make the directory", () => {
    expect(
      findRawTmpCallSites(
        [
          {
            file: SELF,
            source: `fs.mkdtempSync(path.join(os.tmpdir(), "x-"));`,
          },
        ],
        ALLOWED
      )
    ).toEqual([]);
  });
});

describe("the stale sweep", () => {
  // The sweep is the half that survives a KILLED process, which is how runs end on
  // this box, so it gets a real filesystem rather than a mock.
  it("reclaims entries past the threshold and leaves live ones alone", () => {
    const root = makeTmpDir("tmp-sweep-corpus");
    const now = Date.now();
    const plant = (name: string, ageMs: number): string => {
      const full = path.join(root, name);
      fs.mkdirSync(full, { recursive: true });
      writeFileSync(path.join(full, "test.db"), "x");
      const seconds = (now - ageMs) / 1000;
      utimesSync(full, seconds, seconds);
      return full;
    };
    const stale = plant(
      `${TMP_PREFIX}db-shared-aaaaaa`,
      STALE_AFTER_MS + 60_000
    );
    const live = plant(`${TMP_PREFIX}db-shared-bbbbbb`, 30_000);
    // A file, not a directory: `allos-takeout-*.zip` leaks as plain files.
    const staleFile = path.join(root, `${TMP_PREFIX}takeout-test-1234.zip`);
    writeFileSync(staleFile, "zip");
    const old = (now - STALE_AFTER_MS - 60_000) / 1000;
    utimesSync(staleFile, old, old);
    // Someone else's temp entry, aged past the threshold. Not ours to delete.
    const foreign = path.join(root, "hsperfdata_root");
    fs.mkdirSync(foreign);
    utimesSync(foreign, old, old);

    expect(sweepStaleTmpEntries(root, now)).toBe(2);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    // Sweeping the same root again is a no-op, not a second count.
    expect(sweepStaleTmpEntries(root, now)).toBe(0);
  });

  it("survives a root that does not exist", () => {
    expect(sweepStaleTmpEntries(path.join("/nonexistent-xyz-77", "t"))).toBe(0);
  });
});

describe("makeTmpDir", () => {
  it("names the directory so the sweep and the check-in can both see it", () => {
    const dir = makeTmpDir("census-demo");
    expect(path.basename(dir)).toMatch(
      new RegExp(`^${TMP_PREFIX}census-demo-`)
    );
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("refuses a label that would break the shared prefix", () => {
    expect(() => makeTmpDir("Allos/../escape")).toThrow(/label must be/);
    expect(() => makeTmpDir("")).toThrow(/label must be/);
  });
});
