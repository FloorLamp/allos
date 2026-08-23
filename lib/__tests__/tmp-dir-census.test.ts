import { execFileSync } from "node:child_process";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// THE EXTENSIONS THE CENSUS READS — every one the test tiers will actually
// EXECUTE, not just the one they mostly use.
//
// This was `.ts` alone, and `.ts` alone put three tracked files under
// `components/__tests__/` (`activity-editor-surface.test.tsx`,
// `imported-name-offer.test.tsx`, `logged-via-surface.test.tsx`) and the two
// `e2e/*.mjs` build helpers OUTSIDE the census's reach. Measured 2026-08-23: a
// real `fs.mkdtempSync` planted in `components/__tests__/zz-planted.test.tsx` left
// the whole census green. The tap-floor census names this exact failure mode —
// "a rename, a directory the walk does not enter, an extension filter" — and this
// one had it.
//
// The list is what a runtime here can load, not what the tree happens to hold
// today: a `.mts` or a `.jsx` written tomorrow must not be a hole. Data and prose
// under the same roots (`e2e/spec-durations.json`, `lib/__db_tests__/AGENTS.md`,
// `lib/__tests__/__fixtures__/*.json` — 3 tracked files) cannot carry the call and
// stay out; the planted-corpus tests below pin BOTH halves of that choice.
const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

// THE FLOOR THE CORPUS MUST CLEAR, asserted before any verdict is pronounced over
// it. Not the exact count — test files arrive with every feature — but a number
// well above zero, so a walk that has stopped reaching them fails LOUDLY instead
// of reporting a clean sweep it never took.
//
// Measured 2026-08-23 at this head: 2,341 source files under the five roots
// (2,336 `.ts`, 3 `.tsx`, 2 `.mjs`), out of 2,344 tracked files. The floor is
// deliberately slack: retiring a whole test directory is a legitimate thing to do
// and should not red this guard. What is NOT legitimate is the corpus collapsing
// toward zero — measured on this file before the floor existed, three separate
// ways to empty it (a root renamed to a directory that does not exist, an
// extension filter that matches nothing, the walk short-circuiting to `[]`) each
// left all 8 tests green, because `git ls-files` over a nonexistent path exits 0
// with no output. Lower this only after counting, and say what you counted.
const CORPUS_FLOOR = 2000;

function scannedSources(
  base: string = REPO
): Array<{ file: string; source: string }> {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCANNED_DIRS], {
    cwd: base,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((f) => SCANNED_EXTENSIONS.some((ext) => f.endsWith(ext)));
  return files.map((file) => ({
    file,
    source: readFileSync(path.join(base, file), "utf8"),
  }));
}

describe("the temp-directory census (#3248)", () => {
  const sources = scannedSources();

  // THE CORPUS ITSELF, ASSERTED BEFORE ANYTHING IS PRONOUNCED CLEAN. The verdict
  // below is an ABSENCE assertion, which is the shape that passes hardest when the
  // thing underneath it has quietly gone missing.
  it("reads the corpus it is about to pronounce clean", () => {
    expect(
      sources.length,
      `The census read ${sources.length} source files under ${SCANNED_DIRS.join(
        ", "
      )}, below the floor of ${CORPUS_FLOOR}. Either this walk has stopped reaching ` +
        "them (a root renamed, an extension filter that no longer matches, a " +
        "`git ls-files` that returned nothing and exited 0) or the test tree really " +
        "shrank by a fifth — check which before lowering this number."
    ).toBeGreaterThanOrEqual(CORPUS_FLOOR);

    // Per root, because the total can clear the floor while one root has silently
    // dropped out — `lib/__tests__/` alone is 1,014 files and would carry it.
    for (const dir of SCANNED_DIRS) {
      const inRoot = sources.filter((s) => s.file.startsWith(dir));
      expect(
        inRoot.length,
        `No file at all under \`${dir}\`. That root is either gone from the tree or ` +
          "gone from this walk, and the second one is silent."
      ).toBeGreaterThan(0);
    }

    // And the corpus is not all-`.ts`, which is the state it was in before
    // 2026-08-23 and the state a narrowed filter would put it back into.
    const nonTs = sources
      .filter((s) => !s.file.endsWith(".ts"))
      .map((s) => s.file);
    expect(
      nonTs,
      "Every file the census read ends in `.ts`, so `.tsx` and `.mjs` test sources " +
        "under these roots are outside its reach again. Today those are the three " +
        "`components/__tests__/*.test.tsx` files and the two `e2e/*.mjs` helpers."
    ).not.toEqual([]);
  });

  it("finds no test file making a temp directory outside makeTmpDir", () => {
    const raw = findRawTmpCallSites(sources, ALLOWED).map(
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

// Everything above proves the MATCHER can see a bad call: it is handed literal
// source strings. None of it proves the WALK can. `scannedSources()` was called by
// exactly one assertion — an `expect(raw).toEqual([])` over a corpus nobody had
// counted — and measured 2026-08-23, THREE independent ways to collapse it to zero
// left all 8 tests green: pointing `SCANNED_DIRS` at a directory that does not
// exist, filtering on an extension nothing carries, and short-circuiting the
// function to `[]`. `git ls-files` over a nonexistent path exits 0 with no output,
// so the collapse is completely silent.
//
// The floor above catches the collapse. This catches the subtler half: a walk that
// still returns thousands of files while no longer REACHING one root, one
// subdirectory, or one extension. One offender is written to disk and the whole
// walk is re-run over it, so it is the walk that has to go and find it.
//
// WHY A CORPUS OF ITS OWN AND NOT `git add -f` INTO THE REAL TREE. Vitest runs
// test files concurrently and dozens of other guards walk these same roots,
// collect a file list, and read it a moment later; planting into the live tree
// lands a create-then-unlink inside that window and kills unrelated tests with
// ENOENT (measured on #3557's tap-floor census, blocker 1). The census walks
// `git ls-files`, so the corpus is a real one-file git repository under `TMPDIR`
// that only this process can see — the same `execFileSync`, the same pathspecs,
// the same filter, a base nobody else touches.
describe("the census walk reaches a planted offender", () => {
  const base = makeTmpDir("tmp-census-corpus");

  // A corpus with a SHAPE, so the readings below are not two zeroes agreeing: one
  // seed under each scanned root, in the extension that root really uses, plus a
  // data file that carries the construct in its text and must stay unread.
  const SEEDS: ReadonlyArray<readonly [string, string]> = [
    ["lib/__tests__/seed-clean.test.ts", `const dir = makeTmpDir("seed");\n`],
    ["lib/__db_tests__/seed-clean.test.ts", `export const seeded = 1;\n`],
    ["lib/__action_tests__/seed-clean.test.ts", `export const seeded = 2;\n`],
    ["components/__tests__/seed-clean.test.tsx", `export const Seed = 3;\n`],
    ["e2e/seed-clean.mjs", `export const seeded = 4;\n`],
    // Not source. If this ever shows up as a finding the filter has been widened
    // to things the runtime never loads, and the census starts crying wolf over
    // fixture data — which is how a guard gets deleted.
    [
      "e2e/seed-durations.json",
      `{ "note": "fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))" }\n`,
    ],
  ];
  const SEEDED_SOURCES = SEEDS.map(([rel]) => rel).filter(
    (rel) => !rel.endsWith(".json")
  );

  // A real call, not a comment: the same line the twenty leaking call sites of
  // #3248 were written with.
  const OFFENDER = `const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planted-"));\n`;

  const write = (rel: string, source: string): void => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, "utf8");
  };
  // `-f` so a global excludes file cannot quietly drop a plant and hand this test
  // a green it did not earn.
  const track = (): void => {
    execFileSync("git", ["-C", base, "add", "-f", "-A"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const offenders = (): string[] =>
    findRawTmpCallSites(scannedSources(base), ALLOWED)
      .map((s) => s.file)
      .sort();

  beforeAll(() => {
    execFileSync("git", ["init", "-q", base], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const [rel, source] of SEEDS) write(rel, source);
    track();
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("reads the seeded corpus and finds nothing in it", () => {
    expect(
      scannedSources(base)
        .map((s) => s.file)
        .sort(),
      "The walk did not read back the corpus this test wrote to disk. Every reading " +
        "below would then be empty and they would all agree, which is the shape of a " +
        "walk that has stopped walking — not of a passing test."
    ).toEqual([...SEEDED_SOURCES].sort());
    expect(offenders()).toEqual([]);
  });

  it("flags an offender planted in each scanned root", () => {
    // In a SUBDIRECTORY, so finding it also proves the walk recurses rather than
    // reading one directory's entries. The extension per root is the one that root
    // really holds — `components/__tests__/` is `.tsx`, `e2e/` helpers are `.mjs`,
    // and both were outside the census entirely until 2026-08-23.
    const planted = [
      "lib/__tests__/__planted__/zz-planted.test.ts",
      "lib/__db_tests__/__planted__/zz-planted.test.ts",
      "lib/__action_tests__/__planted__/zz-planted.test.ts",
      "components/__tests__/__planted__/zz-planted.test.tsx",
      "e2e/__planted__/zz-planted.mjs",
    ];
    for (const rel of planted) write(rel, OFFENDER);
    track();

    expect(
      offenders(),
      "The census did not see files written to disk inside its scanned roots. The " +
        "matcher's own tests cannot tell you this: it is the WALK that failed — a " +
        "root it does not enter, a subdirectory it does not recurse into, or an " +
        "extension it no longer reads."
    ).toEqual([...planted].sort());

    // And the finding is additive, not a rewrite: removing the plants returns the
    // corpus to clean, which is what makes the reading above mean something.
    for (const rel of planted) fs.rmSync(path.join(base, rel));
    track();
    expect(offenders()).toEqual([]);
  });

  it("reads every extension that can carry the call", () => {
    // A LITERAL list, deliberately not derived from `SCANNED_EXTENSIONS` — a loop
    // over the constant shrinks with the constant and stays green, which is the
    // exact defect this whole block exists to close.
    const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
    const planted = exts.map((ext) => `lib/__tests__/__planted__/zz-ext${ext}`);
    for (const rel of planted) write(rel, OFFENDER);
    // Same construct, in a file the runtime never loads. It must stay unread.
    write(
      "lib/__tests__/__planted__/zz-ext.json",
      `{ "note": "fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))" }\n`
    );
    track();

    expect(
      offenders(),
      "An extension the test tiers can execute is outside the census. A leak written " +
        "into that file is invisible, and nothing turns red."
    ).toEqual([...planted].sort());

    fs.rmSync(path.join(base, "lib/__tests__/__planted__"), {
      recursive: true,
      force: true,
    });
    track();
    expect(offenders()).toEqual([]);
  });
});

describe("the stale sweep", () => {
  // The sweep is the WHOLE mechanism — the one thing that survives a killed
  // process, which is how runs end on this box — so it gets a real filesystem
  // rather than a mock, and both of its bounds are exercised: what it reclaims and
  // what it must not touch.
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
    const foreign = plant("hsperfdata_root", STALE_AFTER_MS + 60_000);
    // AND TWO THAT CONTAIN `allos-` WITHOUT STARTING WITH IT, which is the pair
    // that tells `startsWith` apart from `includes`. `hsperfdata_root` alone
    // cannot: it shares no substring with the prefix, so it stays alive under
    // BOTH predicates and the permissive one ships green. Measured 2026-08-23 —
    // relaxing the filter to `includes` deletes exactly these two and the census
    // stays 8 passed. The names are the real collateral this predicate has already
    // destroyed on this box during #3248's own development: a sibling lane's cache
    // and another lane's scratch directory.
    const nested = plant("lens-allos-cache", STALE_AFTER_MS + 60_000);
    const dotted = plant("sibling.allos-scratch", STALE_AFTER_MS + 60_000);

    expect(
      sweepStaleTmpEntries(root, now),
      "The sweep reclaimed a different number of entries than the two it is " +
        "supposed to see. More than two means the prefix filter has widened to " +
        "entries it does not own — `lens-allos-cache` and `sibling.allos-scratch` " +
        "below are the pair that catches that."
    ).toBe(2);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(
      [nested, dotted].filter((p) => !fs.existsSync(p)),
      "The sweep deleted an entry that only CONTAINS the shared prefix. It is " +
        "matching a substring where it must match a leading one, and everything " +
        "else in /tmp with `allos-` anywhere in its name is now in scope."
    ).toEqual([]);
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
