import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ScannedSource,
  describeActFindings,
  findUnawaitedActSites,
  reactActLocalName,
} from "./awaited-act";
import { makeTmpDir } from "./tmp-dir";

// THE GUARD FOR #3578. The mechanism, the measurement behind the scope, and why
// no lint rule here covers it are all in ./awaited-act.ts — read that first.
//
// This file is the census half: it walks the tracked test tree, asserts the corpus
// it is about to pronounce clean, and then pronounces it clean. Shaped after
// `tmp-dir-census.test.ts`, because the failure it is guarding against is the same
// one: an absence assertion over a walk that has quietly stopped walking.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SCANNED_DIRS = [
  "lib/__tests__/",
  "lib/__db_tests__/",
  "lib/__action_tests__/",
  "components/__tests__/",
  "e2e/",
];

// Every extension a test runtime here can LOAD, not the ones the tree happens to
// use today. `components/__tests__/` is where React `act` lives and it is `.tsx`;
// a `.mts` or `.jsx` written tomorrow must not be a hole. (`tmp-dir-census` learned
// this the expensive way — a `.ts`-only filter left the three `components/__tests__/*.tsx`
// files outside its reach entirely.)
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
// it. Measured 2026-08-23 at this head: 2,346 source files under the five roots.
// Deliberately slack — retiring a test directory is legitimate; collapsing toward
// zero is not, and `git ls-files` over a path that does not exist exits 0 with no
// output, so the collapse is silent.
const CORPUS_FLOOR = 2000;

// AND A FLOOR ON THE POPULATION THIS GUARD IS ACTUALLY ABOUT, which the file count
// above cannot give it. The verdict below is "no unawaited act", and that is also
// true of a tree where nothing imports `act` at all — so the number that has to be
// non-zero is the number of REACT-ACT CALL SITES the walk found. Measured
// 2026-08-23: 23 sites across 5 files (activity-editor-surface, auto-update-reload,
// imported-name-offer, logout-retry, logout-unmount), every one `await act(`.
// If component tests stop using `act` entirely this fails and should be retired on
// purpose, with a sentence — not left green and empty.
const ACT_SITE_FLOOR = 15;
const ACT_FILE_FLOOR = 3;

function scannedSources(base: string = REPO): ScannedSource[] {
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

/** Every `act(` call site in a file that imports React's `act`, awaited or not. */
function actSites(sources: readonly ScannedSource[]): string[] {
  const sites: string[] = [];
  for (const { file, source } of sources) {
    const local = reactActLocalName(source);
    if (local === null) continue;
    const callRe = new RegExp(`(^|[^\\w.])${local}\\s*\\(`, "g");
    source.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import\b/.test(line)) return;
      for (const _ of line.matchAll(callRe)) sites.push(`${file}:${i + 1}`);
    });
  }
  return sites;
}

describe("the awaited-act census (#3578)", () => {
  const sources = scannedSources();

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
    // dropped out — `lib/__tests__/` alone would carry it.
    for (const dir of SCANNED_DIRS) {
      expect(
        sources.filter((s) => s.file.startsWith(dir)).length,
        `No file at all under \`${dir}\`. That root is either gone from the tree or ` +
          "gone from this walk, and the second one is silent."
      ).toBeGreaterThan(0);
    }
  });

  it("finds the act call sites the verdict below is about", () => {
    const sites = actSites(sources);
    const files = new Set(sites.map((s) => s.split(":")[0]));
    expect(
      sites.length,
      `Only ${sites.length} React \`act(\` call sites found, under the floor of ` +
        `${ACT_SITE_FLOOR}. "No unawaited act" is also true of a tree containing no ` +
        "act at all, so this number is what stops the verdict being vacuous. If " +
        "component tests genuinely stopped using act, retire this census on purpose."
    ).toBeGreaterThanOrEqual(ACT_SITE_FLOOR);
    expect(files.size).toBeGreaterThanOrEqual(ACT_FILE_FLOOR);
  });

  it("finds no unawaited React act() anywhere in the test tree", () => {
    expect(describeActFindings(findUnawaitedActSites(sources))).toEqual([]);
  });
});

describe("the census's reach", () => {
  // A green sweep over a tree that already complies says nothing about what the
  // sweep can SEE, so it is run over sources authored to break it.
  it("sees every spelling that drops the act result", () => {
    const found = findUnawaitedActSites([
      {
        file: "a.tsx",
        source: `import { act } from "@testing-library/react";\nit("x", () => {\n  return act(async () => {}).then(() => { expect(1).toBe(2); });\n});\n`,
      },
      {
        file: "b.tsx",
        source: `import { act, render } from "@testing-library/react";\nit("x", () => {\n  act(async () => {});\n});\n`,
      },
      {
        file: "c.tsx",
        source: `import { act } from "@testing-library/react";\nit("x", () => {\n  const done = act(async () => {});\n});\n`,
      },
      {
        file: "d.tsx",
        source: `import { act } from "@testing-library/react";\nit("x", () => {\n  void act(async () => {});\n});\n`,
      },
      {
        // Aliased on import — the identifier is not `act` at all.
        file: "e.tsx",
        source: `import { act as flush } from "@testing-library/react";\nit("x", () => {\n  return flush(async () => {}).then(() => {});\n});\n`,
      },
      {
        // `react`'s own act, which is what @testing-library re-exports.
        file: "f.tsx",
        source: `import { act } from "react";\nit("x", () => {\n  act(async () => {});\n});\n`,
      },
      {
        // Awaited, but still chained: `then` returns undefined either way, so the
        // assertions in the callback run after the case is over.
        file: "g.tsx",
        source: `import { act } from "@testing-library/react";\nit("x", async () => {\n  await act(async () => {}).then(() => { expect(1).toBe(2); });\n});\n`,
      },
    ]);
    expect(found.map((f) => f.file)).toEqual([
      "a.tsx",
      "b.tsx",
      "c.tsx",
      "d.tsx",
      "e.tsx",
      "f.tsx",
      "g.tsx",
    ]);
  });

  it("stays quiet on the benign neighbours", () => {
    const found = findUnawaitedActSites([
      // The correct spelling, which is 23 of this tree's 23 sites.
      {
        file: "a.tsx",
        source: `import { act } from "@testing-library/react";\nit("x", async () => {\n  await act(async () => {\n    screen.getByTestId("go").click();\n  });\n});\n`,
      },
      // A LOCAL `act()` fixture builder. Two shipped files do this 72 times
      // between them; keying on the spelling instead of the import would fire on
      // every one of them.
      {
        file: "b.ts",
        source: `function act(over = {}) {\n  return { type: "strength", ...over };\n}\nit("x", () => {\n  expect(storedActivityFault(act(), [])).toMatch(/No completed set/);\n});\n`,
      },
      // Prose that names the construct in order to argue about it — this census's
      // own header does it a dozen times, and so does the fixed case in
      // components/__tests__/imported-name-offer.test.tsx.
      {
        file: "c.tsx",
        source: `import { act } from "@testing-library/react";\n// \`await\`, not \`.then()\`: this case was the file's one \`return act(…).then(…)\`.\n * and never write act(...) unawaited\nit("x", async () => {\n  await act(async () => {});\n});\n`,
      },
      // A different symbol that merely CONTAINS the name.
      {
        file: "d.tsx",
        source: `import { act } from "@testing-library/react";\nit("x", async () => {\n  const redacted = compact(rows);\n  transact();\n  await act(async () => {});\n});\n`,
      },
      // A property access, not the imported binding.
      {
        file: "e.tsx",
        source: `import { act } from "@testing-library/react";\nit("x", async () => {\n  helper.act(1);\n  await act(async () => {});\n});\n`,
      },
      // A file that never imports act at all.
      {
        file: "f.ts",
        source: `const act = (n: number) => n + 1;\nit("x", () => {\n  expect(act(1)).toBe(2);\n});\n`,
      },
    ]);
    expect(found).toEqual([]);
  });
});

// Everything above proves the MATCHER can see a bad call: it is handed literal
// source strings. None of it proves the WALK can. `scannedSources()` feeds one
// absence assertion, and an absence assertion over an empty walk is green — so the
// walk is re-run over a corpus this test writes to disk, and it has to go and find
// the offender itself.
//
// A CORPUS OF ITS OWN, NOT `git add -f` INTO THE REAL TREE: vitest runs test files
// concurrently and a dozen other guards walk these same roots, so planting into the
// live tree lands a create-then-unlink inside their window and kills unrelated
// tests with ENOENT (measured on #3557's tap-floor census).
describe("the census walk reaches a planted offender", () => {
  const base = makeTmpDir("act-census-corpus");

  const SEEDS: ReadonlyArray<readonly [string, string]> = [
    [
      "components/__tests__/seed-clean.test.tsx",
      `import { act } from "@testing-library/react";\nit("x", async () => {\n  await act(async () => {});\n});\n`,
    ],
    ["lib/__tests__/seed-clean.test.ts", `export const seeded = 1;\n`],
    ["lib/__db_tests__/seed-clean.test.ts", `export const seeded = 2;\n`],
    ["lib/__action_tests__/seed-clean.test.ts", `export const seeded = 3;\n`],
    ["e2e/seed-clean.mjs", `export const seeded = 4;\n`],
    // Not source. If this ever shows up as a finding the filter has widened to
    // files the runtime never loads.
    [
      "e2e/seed-durations.json",
      `{ "note": "return act(async () => {}).then(() => {})" }\n`,
    ],
  ];
  const SEEDED_SOURCES = SEEDS.map(([rel]) => rel).filter(
    (rel) => !rel.endsWith(".json")
  );

  const OFFENDER = `import { act } from "@testing-library/react";\nit("planted", () => {\n  return act(async () => {}).then(() => {\n    expect(1).toBe(2);\n  });\n});\n`;

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
    findUnawaitedActSites(scannedSources(base))
      .map((f) => f.file)
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
    // reading one directory's entries.
    const planted = [
      "components/__tests__/__planted__/zz-planted.test.tsx",
      "lib/__tests__/__planted__/zz-planted.test.ts",
      "lib/__db_tests__/__planted__/zz-planted.test.ts",
      "lib/__action_tests__/__planted__/zz-planted.test.ts",
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

  it("reads every extension a test runtime can load", () => {
    // A LITERAL list, deliberately not derived from `SCANNED_EXTENSIONS` — a loop
    // over the constant shrinks with the constant and stays green.
    const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
    const planted = exts.map(
      (ext) => `components/__tests__/__planted__/zz${ext}`
    );
    for (const rel of planted) write(rel, OFFENDER);
    write(
      "components/__tests__/__planted__/zz.json",
      `{ "n": ${JSON.stringify(OFFENDER)} }\n`
    );
    track();

    expect(
      offenders(),
      "An extension the test tiers can execute is outside the census. A swallowed " +
        "act written into that file is invisible, and nothing turns red."
    ).toEqual([...planted].sort());

    fs.rmSync(path.join(base, "components/__tests__/__planted__"), {
      recursive: true,
      force: true,
    });
    track();
    expect(offenders()).toEqual([]);
  });
});
