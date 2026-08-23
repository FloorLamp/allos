import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// THE GUARD THAT STOPS #2719 NEEDING A FOURTH SWEEP.
//
// `text-link` is the app's ONE inline action-link treatment (app/globals.css):
// `font-medium text-brand-600 hover:underline dark:text-brand-400`. #2719 picked
// it out of four near-copies on the dashboard widgets — brand-600 against
// brand-700, with and against `font-medium` — and #3487 item 2 then moved the
// household setup's links onto it.
//
// NEITHER SWEEP REACHED THE REST OF THE TREE. Measured 2026-08-23 on main, before
// #3607 item 3: SIXTY-FOUR classNames across fifty-one files still spelled the
// treatment out by hand, against NINE call sites using the utility. #3607 filed
// one of the sixty-four (PlanSection's "Open registry →") because that is the one
// a person happened to walk past. So the shape here is not "somebody wrote it
// wrong once"; it is that hand-rolling was the DEFAULT and the utility was the
// exception, which no number of sweeps fixes on its own — the next fifty links
// get written the same way the last fifty were.
//
// ── WHAT COUNTS AS AN OFFENDER ────────────────────────────────────────────────
//
// A STATIC brand tone beside `hover:underline`, inside one string literal. That is
// #3607's own signature, and both halves are load-bearing:
//
//   • STATIC. `hover:text-brand-600 hover:underline` is `text-link-muted`, the
//     quiet sibling that STARTS slate and takes the brand tone on hover. It is a
//     different treatment with its own utility, and fourteen call sites in the
//     `hover:` family sit one token away from this pattern. A guard that swept
//     them in would be crying wolf on the layout working, which is how a census
//     gets deleted and takes the real rule with it (#3325's five shipped
//     `ORDER BY … COLLATE NOCASE` sorts).
//   • `hover:underline`. `text-brand-600` on its own is just a brand-toned string
//     — a status word, a chart key (`lib/strength-standards.ts` tones a
//     proficiency band with it). It is the UNDERLINE-ON-HOVER that makes the pair
//     a link treatment.
//
// The tone token is not required to sit next to `hover:underline`, because it
// mostly does not: the shipped hand-rolls interleave `text-sm`, `inline-flex`,
// `-mx-2`, `md:inline-flex` and `disabled:opacity-50` between them.
//
// ── STRING LITERALS, NOT LINES ────────────────────────────────────────────────
//
// The scan reads each source's string literals (", ', `) rather than its lines.
// Prettier does not break a string literal, so today every hand-roll is on one
// line and a line scan would find them all — but a template literal CAN be
// written across lines by hand, and a rule that a reformat can slip past is a
// rule that quietly stops holding. Reading literals also means a COMMENT quoting
// the retired form (there are several, including this file) is not a finding,
// which is the other direction the same mistake runs in.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// WHERE CLASSNAMES LIVE. `lib/` is deliberately out: it holds tone tokens
// (`strength-standards.ts`) but no `className` composition, and it also holds the
// test files that must be free to QUOTE the retired form in order to argue about
// it — including this one.
const SCANNED_DIRS = ["app/", "components/"];

// Every extension a Next build will compile from those roots. `.ts` is included
// because a shared class-string constant does not have to live in a `.tsx`.
const SCANNED_EXTENSIONS = [
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mts",
  ".mjs",
] as const;

// THE FLOOR THE CORPUS MUST CLEAR, asserted before any verdict is pronounced over
// it. Measured 2026-08-23 at this head: 1,054 files under the two roots (548 in
// `app/`, 506 in `components/`). The floor is slack — surfaces get consolidated —
// but the corpus collapsing toward zero is the failure this catches, and it is a
// silent one: `git ls-files` over a path that does not exist exits 0 with no
// output, so a renamed root leaves an absence assertion passing over nothing.
const CORPUS_FLOOR = 800;

interface Source {
  file: string;
  source: string;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

/**
 * Every string literal in a source, with the line it starts on. Deliberately
 * simple: it is looking for class strings, not parsing TypeScript, and the shapes
 * it must not be fooled by are comments (handled — a comment is not a literal) and
 * template literals with interpolations (handled — `${…}` just becomes part of the
 * captured text, and the tokens either sit inside the literal or they do not).
 */
function stringLiterals(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) != null) {
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      text: m[0],
    });
  }
  return out;
}

// A STATIC `text-brand-600` — not `hover:`/`focus:`/`group-hover:`-prefixed, and
// not the tail of a longer token — anywhere in the same literal as
// `hover:underline`.
const STATIC_BRAND_TONE = /(?<![\w:-])text-brand-600(?![\w-])/;
const HOVER_UNDERLINE = /(?<![\w:-])hover:underline(?![\w-])/;

export function findHandRolledTextLinks(sources: Source[]): Finding[] {
  const found: Finding[] = [];
  for (const { file, source } of sources) {
    for (const { line, text } of stringLiterals(source)) {
      if (!STATIC_BRAND_TONE.test(text)) continue;
      if (!HOVER_UNDERLINE.test(text)) continue;
      found.push({ file, line, text: text.replace(/\s+/g, " ").slice(0, 120) });
    }
  }
  return found;
}

function scannedSources(base: string = REPO): Source[] {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCANNED_DIRS], {
    cwd: base,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((f) => SCANNED_EXTENSIONS.some((ext) => f.endsWith(ext)));
  return files.map((file) => ({
    file,
    source: fs.readFileSync(path.join(base, file), "utf8"),
  }));
}

describe("the text-link census (#3607 item 3 / #2719)", () => {
  const sources = scannedSources();

  // THE CORPUS ITSELF, ASSERTED BEFORE ANYTHING IS PRONOUNCED CLEAN. The verdict
  // below is an ABSENCE assertion, and an absence assertion over an empty corpus
  // is the one shape that passes hardest exactly when it has stopped working.
  it("reads the corpus it is about to pronounce clean", () => {
    expect(
      sources.length,
      `The census read ${sources.length} source files under ${SCANNED_DIRS.join(
        ", "
      )}, below the floor of ${CORPUS_FLOOR}. Either the walk has stopped reaching ` +
        "them (a root renamed, an extension filter that no longer matches, a " +
        "`git ls-files` that returned nothing and exited 0) or the app really shrank " +
        "by a quarter — check which before lowering this number."
    ).toBeGreaterThanOrEqual(CORPUS_FLOOR);

    for (const dir of SCANNED_DIRS) {
      expect(
        sources.filter((s) => s.file.startsWith(dir)).length,
        `No file at all under \`${dir}\`. That root is either gone from the tree ` +
          "or gone from this walk, and the second one is silent."
      ).toBeGreaterThan(0);
    }

    // And it read class strings, not just file names: the utility this rule
    // points people AT has to be findable in the corpus, or the corpus is not the
    // one the rule is about.
    expect(
      sources.filter((s) => /(?<![\w:-])text-link(?![\w-])/.test(s.source))
        .length,
      "Not one file in the corpus uses `text-link`. The walk is reading something " +
        "other than the app's components."
    ).toBeGreaterThan(20);
  });

  it("no className hand-rolls the text-link treatment", () => {
    const offenders = findHandRolledTextLinks(sources).map(
      (f) =>
        `${f.file}:${f.line} — ${f.text}\n    Use \`text-link\` (app/globals.css). ` +
        "It expands to exactly `font-medium text-brand-600 hover:underline " +
        "dark:text-brand-400`, so the swap is character-for-character; keep any " +
        "size/layout tokens (`text-sm`, `inline-flex`, `mt-1`) beside it. The " +
        "quiet variant — slate that takes the brand tone on hover — is " +
        "`text-link-muted`."
    );
    expect(offenders).toEqual([]);
  });

  it("the text-link utility is defined, and expands to what this rule claims", () => {
    // The rule above tells people the swap is loss-free. That sentence is only
    // true while the utility still expands to these four declarations, so it is
    // checked rather than asserted in prose.
    const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
    expect(css).toMatch(/@utility\s+text-link\s*\{/);
    expect(css).toMatch(
      /@utility\s+text-link\s*\{[\s\S]*?@apply font-medium text-brand-600 hover:underline dark:text-brand-400;/
    );
    expect(css).toMatch(/@utility\s+text-link-muted\s*\{/);
  });
});

describe("the census's reach", () => {
  // A green sweep over a tree that already complies says nothing about what the
  // sweep can SEE, so it is run over sources authored to break it — in the
  // spellings this repo actually held before the conversion.
  it("sees every spelling of the hand-roll this repo had", () => {
    const found = findHandRolledTextLinks([
      // The canonical form, all four tokens, from PlanSection.
      {
        file: "a.tsx",
        source: `className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"`,
      },
      // Without `font-medium` — one of the four near-copies #2719 named.
      {
        file: "b.tsx",
        source: `className="text-brand-600 hover:underline dark:text-brand-400"`,
      },
      // A different dark tone (LesionPhotoStrip's brand-300).
      {
        file: "c.tsx",
        source: `className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"`,
      },
      // Layout tokens between the two halves of the signature, and a responsive
      // variant after them (training/page.tsx). Nothing may depend on adjacency.
      {
        file: "d.tsx",
        source: `className="hidden shrink-0 items-center py-1 text-sm font-medium text-brand-600 hover:underline md:inline-flex dark:text-brand-400"`,
      },
      // Inside a template literal with an interpolation (DoseLedgerLink).
      {
        file: "e.tsx",
        source:
          "className={`inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400 ${className}`}",
      },
      // A branch of a ternary, where `font-medium` lives on the other side of the
      // interpolation entirely (StrengthSets).
      {
        file: "f.tsx",
        source: `canAddSet ? "text-brand-600 hover:underline dark:text-brand-400" : "text-slate-300"`,
      },
      // Written across lines by hand inside a template literal — the shape a line
      // scan would miss.
      {
        file: "g.tsx",
        source:
          "className={`text-sm font-medium text-brand-600\n  hover:underline dark:text-brand-400`}",
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
    const found = findHandRolledTextLinks([
      // `text-link-muted`'s family: the tone arrives ON HOVER. Fourteen shipped
      // call sites look like this, and flagging them would delete the guard.
      {
        file: "a.tsx",
        source: `className="text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"`,
      },
      {
        file: "b.tsx",
        source: `className="font-semibold text-slate-800 hover:text-brand-600 hover:underline"`,
      },
      // A brand tone with no underline affordance at all: a chart key.
      {
        file: "c.tsx",
        source: `intermediate: "text-brand-600 dark:text-brand-400",`,
      },
      // The sanctioned spellings.
      { file: "d.tsx", source: `className="text-sm text-link"` },
      { file: "e.tsx", source: `className="text-xs text-link-muted"` },
      // A comment naming the retired form in order to argue about it — this file
      // and several specs do exactly that.
      {
        file: "f.tsx",
        source: `// never hand-roll text-brand-600 hover:underline; use text-link`,
      },
      // A token that merely CONTAINS the tone's name.
      {
        file: "g.tsx",
        source: `className="text-brand-6000 hover:underline"`,
      },
      // A hover underline with a brand tone belonging to a DIFFERENT element's
      // dark variant only.
      {
        file: "h.tsx",
        source: `className="hover:underline dark:text-brand-400"`,
      },
    ]);
    expect(found).toEqual([]);
  });
});

// Everything above proves the MATCHER can see a hand-roll: it is handed literal
// source strings. None of it proves the WALK can. `scannedSources()` feeds a single
// absence assertion, and the ways that walk can silently return nothing are the
// same three lib/__tests__/tmp-dir-census.test.ts measured on 2026-08-23: a root
// renamed to a path that does not exist, an extension filter that matches nothing,
// and a short-circuit to `[]` — `git ls-files` over a nonexistent pathspec exits 0
// with no output, so all three are silent.
//
// The floor above catches the collapse. This catches the subtler half: a walk that
// still returns a thousand files while no longer REACHING one root, one
// subdirectory, or one extension.
//
// WHY A CORPUS OF ITS OWN AND NOT `git add -f` INTO THE REAL TREE: vitest runs
// files concurrently and several other guards walk these same roots, so a
// create-then-unlink in the live tree kills unrelated tests with ENOENT (measured
// on #3557's tap-floor census). The corpus is a one-file git repository under
// TMPDIR that only this process can see — same `execFileSync`, same pathspecs, same
// filter, a base nobody else touches.
describe("the census walk reaches a planted offender", () => {
  const base = makeTmpDir("text-link-corpus");

  // A corpus with a SHAPE, so the readings below are not two zeroes agreeing: one
  // clean seed under each scanned root, plus a file the walk must NOT read.
  const SEEDS: ReadonlyArray<readonly [string, string]> = [
    ["app/(app)/seed/page.tsx", `export const A = "text-sm text-link";\n`],
    ["components/Seed.tsx", `export const B = "text-link-muted";\n`],
    // Not a compiled source. If this ever shows up as a finding the filter has
    // widened to things the build never reads, and the census starts reporting on
    // fixture data.
    [
      "components/seed-notes.md",
      "avoid `text-brand-600 hover:underline` in a className\n",
    ],
  ];
  const SEEDED_SOURCES = SEEDS.map(([rel]) => rel).filter(
    (rel) => !rel.endsWith(".md")
  );

  const OFFENDER = `export const C = "text-sm font-medium text-brand-600 hover:underline dark:text-brand-400";\n`;

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
    findHandRolledTextLinks(scannedSources(base))
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
      "app/(app)/__planted__/zz-planted.tsx",
      "components/__planted__/zz-planted.tsx",
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

  it("reads every extension a className can be written in", () => {
    // A LITERAL list, deliberately not derived from `SCANNED_EXTENSIONS` — a loop
    // over the constant shrinks with the constant and stays green, which is the
    // exact defect this block exists to close.
    const exts = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"];
    const planted = exts.map((ext) => `components/__planted__/zz-ext${ext}`);
    for (const rel of planted) write(rel, OFFENDER);
    // The same string in a file the build never compiles. It must stay unread.
    write("components/__planted__/zz-ext.md", OFFENDER);
    track();

    expect(
      offenders(),
      "An extension a className can be written in is outside the census. A hand-roll " +
        "in that file is invisible, and nothing turns red."
    ).toEqual([...planted].sort());

    fs.rmSync(path.join(base, "components/__planted__"), {
      recursive: true,
      force: true,
    });
    track();
    expect(offenders()).toEqual([]);
  });
});
