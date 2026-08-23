import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ScannedSource,
  conforms,
  describeMutationNote,
  findMutationNotes,
} from "./mutation-notes";
import { makeTmpDir } from "./tmp-dir";

// THE `MUTATION:` NOTE RATCHET (#3577). What a conforming note carries, why the
// rule is "say where you measured" rather than "run it", and what this guard
// explicitly does NOT check are all in ./mutation-notes.ts — read that first.
//
// THE MEASUREMENT THIS FREEZES. At this head there are 50 `MUTATION:` notes in 7
// files, and FOUR of them state both that they were measured and where. That ratio
// is the finding, not an accident of one file: round 11 of #3424 ran the 23 notes
// in one of these files and 14 were wrong, seven of them because the note named a
// mutation that kills nothing in the tier the note sits in.
//
// So the 46 are frozen, per file, and the counts may only SHRINK. A NEW note has to
// conform. Burning the 46 down means running each one and writing what happened —
// which is real work, and is exactly the work the convention exists to require.
// Nothing here does it for you, and nothing here pretends the 46 are fine.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Every root that can hold a note. `MUTATION:` notes live in tests today, but the
// construct is a comment — the rule is about where a claim about coverage can be
// written, which is anywhere.
const SCANNED_DIRS = [
  "app/",
  "components/",
  "lib/",
  "e2e/",
  "scripts/",
] as const;

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

// Measured 2026-08-23: 4,950 source files under the five roots. Slack, because the
// point is only to catch a walk that has collapsed — `git ls-files` over a path
// that does not exist exits 0 with no output.
const CORPUS_FLOOR = 4000;

// AND THE POPULATION THE VERDICT IS ABOUT. "Every note conforms" is also true of a
// tree with no notes in it, so the count of notes found is what stops this being
// vacuous. Measured 2026-08-23: 50.
const NOTE_FLOOR = 40;

// THE FROZEN NON-CONFORMING SET: file → notes that do not yet say they were
// measured and where. Counts may only SHRINK. Shrinking updates the entry;
// growing, or a file that is not here at all, fails the build.
//
// Every entry is the same debt with the same discharge: run the mutation, record
// what actually went red and in which tier, and drop the count. Do not discharge
// one by deleting the note — a case with no note is a case nobody has to justify,
// which is how the convention started manufacturing unearned confidence.
const NON_CONFORMING_ALLOW = new Map<string, number>([
  // The file round 11 corrected. Its 4 conforming notes are the only 4 in the
  // tree, and the model for the rest: mutation, tier, count, and what stayed green.
  ["lib/__db_tests__/hc-overlap-supersede-refutations.test.ts", 12],
  ["lib/__tests__/metric-window-overlap.test.ts", 17],
  ["lib/__db_tests__/hc-overlap-supersede.test.ts", 9],
  ["lib/__db_tests__/hc-overlap-unstamped-era.test.ts", 4],
  ["lib/__db_tests__/migration-20260821-hc-overlap-supersede.test.ts", 2],
  ["lib/__db_tests__/migration-20260822-hc-pushed-at-index.test.ts", 1],
  ["lib/__db_tests__/hc-overlap-push-property.test.ts", 1],
]);

// This census QUOTES the marker in corpora authored to break it, and its own
// module does too — neither is a claim about a test case.
const SELF = [
  "lib/__tests__/mutation-notes.ts",
  "lib/__tests__/mutation-note-census.test.ts",
];

function scannedSources(base: string = REPO): ScannedSource[] {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCANNED_DIRS], {
    cwd: base,
    maxBuffer: 128 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(
      (f) =>
        SCANNED_EXTENSIONS.some((ext) => f.endsWith(ext)) && !SELF.includes(f)
    );
  return files.map((file) => ({
    file,
    source: readFileSync(path.join(base, file), "utf8"),
  }));
}

describe("the MUTATION: note census (#3577)", () => {
  const sources = scannedSources();
  const notes = findMutationNotes(sources);

  it("reads the corpus it is about to pronounce on", () => {
    expect(
      sources.length,
      `The census read ${sources.length} source files under ${SCANNED_DIRS.join(
        ", "
      )}, below the floor of ${CORPUS_FLOOR}. Either this walk has stopped reaching ` +
        "them or the tree really shrank by a fifth — check which before lowering " +
        "this number."
    ).toBeGreaterThanOrEqual(CORPUS_FLOOR);

    for (const dir of SCANNED_DIRS) {
      expect(
        sources.filter((s) => s.file.startsWith(dir)).length,
        `No file at all under \`${dir}\`. That root is either gone from the tree or ` +
          "gone from this walk, and the second one is silent."
      ).toBeGreaterThan(0);
    }
  });

  it("finds the notes the verdict below is about", () => {
    expect(
      notes.length,
      `Only ${notes.length} \`MUTATION:\` notes found, under the floor of ` +
        `${NOTE_FLOOR}. "Every note conforms" is also true of a tree with no notes ` +
        "in it. If the convention was genuinely retired, retire this census with it " +
        "— on purpose, in the same diff."
    ).toBeGreaterThanOrEqual(NOTE_FLOOR);
  });

  it("every new MUTATION: note says it was measured and where", () => {
    const byFile = new Map<string, string[]>();
    for (const n of notes) {
      if (conforms(n)) continue;
      byFile.set(n.file, [
        ...(byFile.get(n.file) ?? []),
        describeMutationNote(n),
      ]);
    }
    const offenders: string[] = [];
    for (const [file, bad] of byFile) {
      const allowed = NON_CONFORMING_ALLOW.get(file);
      if (allowed === undefined) {
        offenders.push(
          `${file}: ${bad.length} MUTATION: note(s) that do not record a ` +
            `measurement.\n    ${bad.join("\n    ")}\n    A note is a CLAIM ABOUT ` +
            `COVERAGE and nothing runs it. Say the word \`Measured\` and name the ` +
            `tier or spec the reds appear in — 14 of 23 notes in one file were ` +
            `wrong, and seven of those named a tier that does not move (#3577).`
        );
      } else if (bad.length > allowed) {
        offenders.push(
          `${file} grew: ${bad.length} non-conforming MUTATION: notes, frozen at ` +
            `${allowed}. The count only shrinks.`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the two exempted files really do carry the marker", () => {
    // An exemption nobody checks is a blanket. Both are excused because they must
    // WRITE the marker — the matcher's header explains what a note is, and this
    // census quotes notes authored to break it. If either stops containing one, it
    // stops needing the excuse and its SELF entry should go.
    for (const rel of SELF) {
      const source = readFileSync(path.join(REPO, rel), "utf8");
      expect(
        findMutationNotes([{ file: rel, source }]).length,
        `${rel} is exempt from the walk but no longer carries a \`MUTATION:\` ` +
          "marker, so the exemption is unearned. Drop its SELF entry."
      ).toBeGreaterThan(0);
    }
  });

  it("the frozen counts are still the real ones", () => {
    // A ratchet nobody tightens is an allow-list. When a file's debt shrinks, the
    // entry has to shrink with it, or the slack it leaves is silently re-spendable.
    const stale: string[] = [];
    for (const [file, allowed] of NON_CONFORMING_ALLOW) {
      const actual = notes.filter(
        (n) => n.file === file && !conforms(n)
      ).length;
      if (actual < allowed) {
        stale.push(
          `${file}: frozen at ${allowed} but ${actual} remain — lower (or remove) ` +
            "its entry so the ratchet holds."
        );
      }
    }
    expect(stale).toEqual([]);
  });
});

describe("the census's reach", () => {
  const note = (body: string): ScannedSource => ({
    file: "a.test.ts",
    source: `it("x", () => {\n${body}\n  expect(1).toBe(1);\n});\n`,
  });

  it("sees a note that claims a red without saying it was run", () => {
    const found = findMutationNotes([
      note("  // MUTATION: drop the `AND date = ?` term and this goes red."),
      note(
        "  // MUTATION: make the boundary inclusive (`<=`) and 23 rows die."
      ),
    ]).filter((n) => !conforms(n));
    expect(found).toHaveLength(2);
    expect(describeMutationNote(found[0])).toContain("MEASURED");
  });

  it("sees a note that was measured but never says where", () => {
    const found = findMutationNotes([
      note("  // MUTATION: drop the gate. Measured: 5 tests red."),
    ]).filter((n) => !conforms(n));
    expect(found).toHaveLength(1);
    expect(describeMutationNote(found[0])).toContain("TIER");
    expect(describeMutationNote(found[0])).not.toContain("MEASURED");
  });

  it("stays quiet on a note that states both", () => {
    // The four spellings already in the tree, including the one whose measurement
    // sentence begins BEFORE the marker — a down-only reader would call it
    // unmeasured and send someone to re-measure work already done.
    const conforming = [
      note(
        "  // MUTATION: add `nutrition_kcal` to DAY_BUCKET_METRICS. Measured, and this\n" +
          "  // case does NOT move: 6624 db tests green. What the metric list is pinned\n" +
          "  // by is the pure tier: lib/__tests__/metric-window-overlap.test.ts reds 3."
      ),
      note(
        "  // MUTATION: drop the in-push term. Measured: 5 red across the three HC\n" +
          "  // specs, including hc-overlap-push-property.test.ts."
      ),
      note(
        "  // stored. MUTATION: give `pushStampFor` any window-derived fallback and the\n" +
          "  // 3500 row dies. Measured in the db tier: 4 red."
      ),
      note(
        "  // MUTATION: none. Measured — the case is over-determined, two independent\n" +
          "  // barriers each suffice, so nothing in the db tier reds on either alone."
      ),
    ];
    expect(findMutationNotes(conforming).filter((n) => !conforms(n))).toEqual(
      []
    );
  });

  it("stays quiet on the benign neighbours", () => {
    const found = findMutationNotes([
      // The word in ordinary prose, with no marker.
      note("  // A mutation of the payload shape is not this test's business."),
      // A string literal that happens to carry the marker: not a comment, so not
      // a claim about coverage.
      note('  const label = "MUTATION: not a comment";'),
      // The marker in a doc-comment run that IS measured and DOES name a tier.
      note(
        "  /**\n   * MUTATION: drop the clause. Measured: 18 red in the db tier.\n   */"
      ),
    ]);
    expect(found.filter((n) => !conforms(n))).toEqual([]);
  });
});

// Everything above proves the MATCHER can see a bad note: it is handed literal
// source strings. None of it proves the WALK can. The verdict over the real tree
// is an allow-listed absence assertion, which is green over an empty walk — so the
// walk is re-run over a corpus written to disk, in a temp git repository only this
// process can see (planting into the live tree lands a create-then-unlink inside
// other guards' read windows — measured on #3557's tap-floor census).
describe("the census walk reaches a planted offender", () => {
  const base = makeTmpDir("mutation-note-corpus");

  const CONFORMING =
    'it("x", () => {\n  // MUTATION: drop the clause. Measured: 18 red in the db tier.\n  expect(1).toBe(1);\n});\n';
  const OFFENDER =
    'it("x", () => {\n  // MUTATION: drop the clause and this goes red.\n  expect(1).toBe(1);\n});\n';

  const SEEDS: ReadonlyArray<readonly [string, string]> = [
    ["lib/__db_tests__/seed-clean.test.ts", CONFORMING],
    ["app/seed-clean.ts", "export const seeded = 1;\n"],
    ["components/seed-clean.tsx", "export const Seed = 2;\n"],
    ["e2e/seed-clean.mjs", "export const seeded = 3;\n"],
    ["scripts/seed-clean.ts", "export const seeded = 4;\n"],
    // Not source. A note quoted in fixture data is not a claim about a test case.
    [
      "e2e/seed-durations.json",
      '{ "n": "MUTATION: drop it and this reds." }\n',
    ],
  ];
  const SEEDED_SOURCES = SEEDS.map(([rel]) => rel).filter(
    (rel) => !rel.endsWith(".json")
  );

  const write = (rel: string, source: string): void => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, "utf8");
  };
  const track = (): void => {
    execFileSync("git", ["-C", base, "add", "-f", "-A"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const offenders = (): string[] =>
    findMutationNotes(scannedSources(base))
      .filter((n) => !conforms(n))
      .map((n) => n.file)
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

  it("reads the seeded corpus and finds nothing wrong in it", () => {
    expect(
      scannedSources(base)
        .map((s) => s.file)
        .sort(),
      "The walk did not read back the corpus this test wrote to disk. Every reading " +
        "below would then be empty and they would all agree, which is the shape of a " +
        "walk that has stopped walking — not of a passing test."
    ).toEqual([...SEEDED_SOURCES].sort());
    expect(offenders()).toEqual([]);
    // And the seeded conforming note WAS seen — otherwise the line above is two
    // zeroes agreeing.
    expect(findMutationNotes(scannedSources(base))).toHaveLength(1);
  });

  it("flags an offender planted in each scanned root", () => {
    const planted = [
      "lib/__db_tests__/__planted__/zz-planted.test.ts",
      "app/__planted__/zz-planted.ts",
      "components/__planted__/zz-planted.tsx",
      "e2e/__planted__/zz-planted.mjs",
      "scripts/__planted__/zz-planted.ts",
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

    for (const rel of planted) fs.rmSync(path.join(base, rel));
    track();
    expect(offenders()).toEqual([]);
  });
});
