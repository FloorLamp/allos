import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

// THE SCANNER THE REPOSITORY CENSUSES READ SOURCE THROUGH (#3087).
//
// There was no direct test of it, which is why a defect in it survived three rounds
// of review on the PR that shipped it: every census that used it stayed green,
// because a comment stripper that deletes too much makes findings DISAPPEAR. A guard
// reading through a broken stripper reports a pass it never took, and its own suite
// agrees. So the stripper is pinned here, on its own, with the real shapes this tree
// contains rather than with toy input.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const lineOf = (src: string, n: number) => src.split("\n")[n - 1];

describe("what it strips and what it must not", () => {
  it("does not let a `/*` inside a LINE comment open a block comment", () => {
    // THE DEFECT THIS FILE EXISTS FOR. Stripping block comments first made the `/*`
    // in an ordinary English sentence swallow everything up to the next unrelated
    // `*/` in the file.
    const src = [
      "// presentational sections → components/activity-form/*: Header,",
      "const stamp = useLoggedViaStamp();",
      "const re = /x/; /* a real block comment */",
      "const after = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(lineOf(out, 2)).toBe("const stamp = useLoggedViaStamp();");
    expect(lineOf(out, 4)).toBe("const after = 1;");
    expect(out).not.toContain("activity-form");
    expect(out).not.toContain("a real block comment");
  });

  it("does not let a `//` inside a STRING start a line comment", () => {
    const src = [
      'const url = "https://example.com/a";',
      "const q = 'x // not a comment';",
      "const kept = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toBe(src);
  });

  it("does not let a `//` inside a REGEX start a line comment", () => {
    // Verbatim the shape the old two-regex stripper was written as: the escaped
    // slash immediately before the closing slash reads as `//` to a scanner that
    // does not know it is inside a regex, and the rest of the line disappears.
    const src = "const block = /\\/\\*[\\s\\S]*?\\*\\//g; const kept = 1;";
    expect(stripComments(src)).toBe(src);
  });

  it("does not let a `/*` inside a REGEX open a block comment", () => {
    const src = [
      "const cls = /[/*]/;",
      "const kept = 1;",
      "const later = 2; /* real */",
    ].join("\n");
    const out = stripComments(src);
    expect(lineOf(out, 1)).toBe("const cls = /[/*]/;");
    expect(lineOf(out, 2)).toBe("const kept = 1;");
    expect(out).not.toContain("real");
  });

  it("does not let a `//` or a `/*` inside a TEMPLATE become a comment", () => {
    const src = [
      "const t = `see https://example.com/${id} /* not a comment`;",
      "const kept = 1;",
    ].join("\n");
    expect(stripComments(src)).toBe(src);
  });

  it("scans code inside a template's `${…}` interpolation", () => {
    const src = "const t = `a${/* gone */ b}c`; const kept = 1;";
    const out = stripComments(src);
    expect(out).not.toContain("gone");
    expect(out).toContain("const kept = 1;");
    expect(out).toHaveLength(src.length);
  });

  it("strips a block comment that CONTAINS a `//`", () => {
    const src = [
      "/*",
      " * see https://example.com/x // and a line comment inside",
      " */",
      "const kept = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(out.trim()).toBe("const kept = 1;");
  });

  it("leaves a JSX closing tag and a JSX block comment alone", () => {
    // `</div>` puts a `/` after `<`, and a self-closing tag followed by `{/* … */}`
    // puts one after `}`. Reading either as a regex opener would run to the next `/`
    // on the line and step over the real comment behind it.
    const src = [
      "const a = (",
      "  <div>",
      "    <Foo bar={1} /> {/* gone */}",
      "  </div>",
      "); // also gone",
      "const kept = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(lineOf(out, 3)).toBe("    <Foo bar={1} /> {          }");
    expect(lineOf(out, 4)).toBe("  </div>");
    expect(lineOf(out, 5)).toBe(");             ");
    expect(lineOf(out, 6)).toBe("const kept = 1;");
  });

  it("still reads a regex where one genuinely follows an operator or a keyword", () => {
    const src = [
      "const m = s.replace(/a\\/\\/b/, x);",
      "if (typeof s === 'string') return /a\\/\\/b/.test(s);",
      "const f = () => /a\\/\\/b/.test(s);",
      "const kept = 1;",
    ].join("\n");
    expect(stripComments(src)).toBe(src);
  });

  it("keeps every byte offset and every line number", () => {
    // Byte-for-byte length is what lets a census report `file:line` from the
    // stripped source and mean the line in the real file.
    for (const rel of [
      "components/ActivityForm.tsx",
      "lib/notify-log-format.ts",
      "lib/migrations/snapshot-policy.ts",
      "lib/card-meta-value-census.ts",
    ]) {
      const src = read(rel);
      const out = stripComments(src);
      expect(out, rel).toHaveLength(src.length);
      expect(out.split("\n"), rel).toHaveLength(src.split("\n").length);
    }
  });
});

describe("the four spans the old stripper deleted", () => {
  // Every `/*` in the census universe (app/**, components/**, lib/**, minus the test
  // tiers) that sits inside an ordinary `//` sentence. Under the pair of ordered
  // regexes this replaced, each one opened a block comment that ran to the next
  // unrelated `*/` in the file. Re-derived by diffing the two strippers over the
  // tracked tree; the lines below are the first real code inside each deleted span:
  //
  //   components/ActivityForm.tsx:108      deleted through :1352 — 843 lines
  //   lib/notify-log-format.ts:76          deleted through :180  —  60 lines
  //   lib/migrations/snapshot-policy.ts:30 deleted through :97   —  10 lines
  //   lib/card-meta-value-census.ts:139    closed on its own line —  0 lines
  //
  // The fourth is here because it is the same defect and would swallow the file the
  // day someone deletes the `*/` later on that line; it is listed with its measured
  // zero so the count is not inflated.
  const SURVIVORS: [string, number, string][] = [
    ["components/ActivityForm.tsx", 220, "useLoggedViaStamp"],
    ["lib/notify-log-format.ts", 82, "NOTIFY_DECLINE_MESSAGES"],
    ["lib/migrations/snapshot-policy.ts", 64, "MIGRATION_SNAPSHOT_KEEP"],
    ["lib/card-meta-value-census.ts", 144, "test(container)"],
  ];

  it.each(SURVIVORS)("keeps %s:%d as code", (rel, line, needle) => {
    const out = stripComments(read(rel));
    expect(lineOf(out, line)).toContain(needle);
    // …and the line is byte-identical to the real file: nothing on it was a comment.
    expect(lineOf(out, line)).toBe(lineOf(read(rel), line));
  });

  it("finds NO phantom block comment anywhere in the tree", () => {
    // The general form, so a fifth one cannot be written tomorrow: a `/*` that the
    // scanner says is inside a line comment must never be treated as an opener. Read
    // as an assertion about the SCANNER — every `/*` the naive regex would match is
    // either real, or the scanner has already blanked the `//` that precedes it on
    // its own line and blanks only to the end of that line.
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          out.push(...walk(p));
        } else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
      }
      return out;
    };
    const bad: string[] = [];
    for (const sub of ["app", "components", "lib"]) {
      for (const abs of walk(path.join(REPO, sub))) {
        const src = fs.readFileSync(abs, "utf8");
        const clean = stripComments(src);
        for (const m of src.matchAll(/\/\*/g)) {
          const at = m.index;
          const ls = src.lastIndexOf("\n", at) + 1;
          if (!src.slice(ls, at).includes("//")) continue;
          if (clean.slice(ls, at).includes("//")) continue;
          // A `/*` inside a line comment. The scanner must have blanked it, and
          // must have stopped at the end of that line.
          const eol = src.indexOf("\n", at);
          const rel = path.relative(REPO, abs).split(path.sep).join("/");
          if (clean.slice(at, at + 2).trim() !== "")
            bad.push(`${rel}: not blanked at offset ${at}`);
          else if (eol >= 0 && clean[eol] !== "\n")
            bad.push(`${rel}: blanking ran past the end of its line`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── WHO ELSE STILL ROLLS THEIR OWN (#3595) ──────────────────────────────────────
//
// #3595 asks a question this module cannot answer by existing: is any other source
// scanner still reading raw text, or stripping comments with a pair of regexes of
// its own? Membership should be the import, and this is the census that says who is
// not a member yet.
//
// WHY IT IS A RATCHET AND NOT A SWEEP. Measured 2026-08-23: FORTY-SEVEN files still
// carried a hand-rolled comment deleter, 57 sites between them, and all but a handful
// spelled the exact ordered pair this module was written to replace —
//
//   src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
//
// — which strips BLOCK comments first, so a `/*` written inside a `//` sentence
// opens a span that runs to the next unrelated `*/`. That is the defect that hid
// 1,244 lines of components/ActivityForm.tsx from the census whose whole job was to
// watch it, and it hid them in the direction where everything stays green.
//
// Converting forty-seven guards in one pass would change what each of them SEES,
// which is a verdict change per file and needs each one re-measured. So that pass
// froze the population instead: the list below is exactly who hand-rolls one today,
// and the assertion is set EQUALITY. A new one cannot be written without this going
// red, and converting one means deleting its line — the list is a work queue that
// can only shrink.
//
// EIGHT CAME OFF IT IN #3621, AND THE RULE THEY CAME OFF BY IS WORTH MORE THAN THE
// EIGHT. The two strippers never agree byte-for-byte — the hand-rolled pair DELETES,
// this module BLANKS — so "the output is the same" is not the question. The question
// is whether they removed the same CHARACTERS, which is decidable: compare the
// non-whitespace projections of both outputs over the corpus that scanner actually
// walks. Equal everywhere ⇒ the conversion is verdict-preserving by proof, not by
// hope. Unequal on N files ⇒ the guard now reads those N differently and the test
// result is a re-measurement rather than a formality. Both cases were converted, and
// the numbers, per file, at this head:
//
//   mood-guardrails            7 named modules            0 of 7 differ
//   nav-routes                 4 named modules            0 of 4 differ
//   mobility-coverage-apart    1 named module             0 of 1 differ
//   records-action-grammar     app/(app)/records          0 of 73 differ
//   one-tap-call-sites         components + app        19 of 1042 differ
//   one-tap                    sql-scan sourceFiles    38 of 1610 differ
//   cadence-home               app/(app)/training         9 of 70 differ
//   cadence-registry           lib                    342 of 1475 differ
//
// EVERY ONE OF THEM STAYED GREEN, and the direction of the difference is why that is
// reassuring rather than suspicious. The hand-rolled line regex is unanchored, so it
// deletes from any `//` — including the one inside `"https://…"` — and takes the rest
// of that line with it. The old strippers therefore saw LESS code than the file
// contains; converting makes each guard see MORE. A guard that was going to fire on
// something newly visible would have gone red here. None did.
//
// The two cadence entries had a NARROWER hand-roll (`^\s*//.*$` — whole-line comments
// only), so a trailing `// …` survived it entirely; their numbers above are measured
// against that spelling, not the common one.
//
// THE INSTRUMENT IS COMMITTED, because the rule is only worth having if the next
// conversion can re-run it: `scripts/strip-comments-equivalence.ts <pathspec>`, with
// `--narrow` for the other spelling. Reading a number out of a lane's transcript is
// not a measurement anybody can repeat.
//
// ── THE OTHER POPULATION: SCANNERS THAT BLANK NOTHING AT ALL ────────────────────
//
// The larger half of #3621 and the harder one. Measured at this head: 153 files under
// lib/__tests__ read source text and neither import this module nor hand-roll a
// stripper. (#3621 filed it as ~106 over a narrower reader predicate; the number moves
// with how "reads source" is spelled, which is itself a reason to say what you counted.)
//
// THE RULE, STATED SO IT CAN BE ARGUED WITH RATHER THAN APPLIED BY FEEL:
//
//   A scanner needs blanking when its pattern is one this repo's PROSE can write.
//   Not "could a comment contain these characters" — everything could — but "does
//   this tree write that shape in sentences". Three tests, in order:
//
//     1. Can the pattern match with NO delimiter a sentence would have to carry?
//        `<table`, `btn`, a bare identifier, a class token: yes. A pattern anchored
//        on a quoted literal — `data-testid="fitness-tile-title"`, `from "@/lib/db"`
//        — mostly cannot, because prose quoting a testid quotes it in BACKTICKS, and
//        the scanner is looking for the double quotes.
//     2. Is the pattern the file's OWN SUBJECT? A guard about buttons has comments
//        full of `btn`; a guard about the card boundary has comments full of `sm:`.
//        Documentation clusters exactly where the pattern does, so this is the
//        signal that a green scan is a scan of its own explanation (#3509).
//     3. Which direction does a surviving comment fail in? A comment adding a match
//        is a false FINDING — noise someone investigates. A comment that makes a
//        guard stop being able to FAIL is silent, and that one is not optional:
//        #3600's last failing direction went green because a page gained a JSX
//        comment naming the convention its guard hunted for.
//
//   Rule 3 outranks the other two. A scanner whose failure direction is silent gets
//   blanked whatever its pattern looks like.
//
// WHAT #3621 DID NOT DO, SAID PLAINLY RATHER THAN LEFT TO INFERENCE: the 153 are not
// decided. The rule above is the criterion, `hygieneScanText` in e2e-hygiene.test.ts
// is the first application of it (frequency counts over spec text, where a sentence
// explaining a banned call counted as one), and the rest is a queue nobody has walked.
// A list of undecided files is the TODO this ratchet's own design refuses, so there
// is no second frozen list here — only the rule and the count.
//
// NOT EVERY ENTRY IS A BUG. `lib/__tests__/card-mode-boundary.test.ts` strips CSS,
// where `//` is not a comment at all and this module's scanner would blank the rest
// of a line on a `url(https://…)`. A converted-away entry and a legitimately
// separate one both leave the list the same way — by being argued about — which is
// the point of naming them.
//
// THE CENSUS READS ITS OWN CORPUS COMMENT-BLANKED, which is what keeps it from
// firing on prose: strip-comments.ts itself quotes the retired regex twice in the
// header above in order to argue against it, and lib/__tests__/tmp-dir-census.ts
// makes the same move for its own construct. A guard that fired on the
// documentation explaining it would teach the next author to stop writing the
// documentation (#3509).
describe("the hand-rolled comment strippers still in the tree (#3595)", () => {
  const CENSUS_ROOTS = ["lib", "components", "app", "e2e", "scripts"];

  /**
   * The regex literals that DELETE comment syntax. Both halves of the retired pair,
   * in every spelling the tree actually uses — `[^\n]*` and `.*$` for the line half.
   */
  const HAND_ROLLED = [
    [/\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//, "a block-comment deleter"],
    [/\/\\\/\\\/[^/]*\//, "a line-comment deleter"],
  ] as const;

  /**
   * Every file that still carries one, measured 2026-08-23. This is the work queue
   * for converting them to `stripComments`, and the assertion below is set equality
   * so it cannot grow. Delete a line when its file starts importing this module.
   */
  const HAND_ROLLED_TODAY = [
    "lib/__tests__/actions-write-access.test.ts",
    "lib/__tests__/bio-age-inputs-card-scan.test.ts",
    "lib/__tests__/card-mode-boundary.test.ts",
    "lib/__tests__/chip-primitive-census.test.ts",
    "lib/__tests__/chrome-refresh-scan.test.ts",
    "lib/__tests__/copy-lint.test.ts",
    "lib/__tests__/cycle-offer-renderers.test.ts",
    "lib/__tests__/date-locale-guard.test.ts",
    "lib/__tests__/db-template-key.test.ts",
    "lib/__tests__/disclaimers.test.ts",
    "lib/__tests__/e2e-hygiene.test.ts",
    "lib/__tests__/fasting-standdown.test.ts",
    "lib/__tests__/fiber-symptom-panel.test.ts",
    "lib/__tests__/flag-notability.test.ts",
    "lib/__tests__/food-habit-observation.test.ts",
    "lib/__tests__/food-limit-note.test.ts",
    "lib/__tests__/goal-liveness.test.ts",
    "lib/__tests__/icon-button-tooltip-scan.test.ts",
    "lib/__tests__/immediate-tx.test.ts",
    "lib/__tests__/ingest-narrowing-scan.test.ts",
    "lib/__tests__/instant-writer-scan.test.ts",
    "lib/__tests__/migration-historical-fixture-scan.test.ts",
    "lib/__tests__/mobile-density-convention.test.ts",
    "lib/__tests__/notes-text.test.ts",
    "lib/__tests__/observation-substrate.test.ts",
    "lib/__tests__/offline-queue.test.ts",
    "lib/__tests__/overlay-motion-chokepoint.test.ts",
    "lib/__tests__/protocol-offer-renderers.test.ts",
    "lib/__tests__/reconcile-registry.test.ts",
    "lib/__tests__/settings-groups.test.ts",
    "lib/__tests__/sql-clock-seam.test.ts",
    "lib/__tests__/telegram-chokepoint.test.ts",
    "lib/__tests__/telegram-command-authority.test.ts",
    "lib/__tests__/test-clock-freeze-scan.test.ts",
    "lib/__tests__/time-columns.test.ts",
    "lib/__tests__/trailing-average-boundary.test.ts",
    "lib/__tests__/typed-route-props.test.ts",
    "lib/__tests__/ux-geometry-census.test.ts",
    "lib/user-error-copy-census.ts",
  ] as const;

  /** This census must quote the construct in order to look for it. */
  const SELF = "lib/__tests__/strip-comments.test.ts";

  const sources = (): { rel: string; code: string }[] =>
    execFileSync("git", ["ls-files", "-z", "--", ...CENSUS_ROOTS], {
      cwd: REPO,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .split("\0")
      .filter((f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f))
      .map((rel) => ({
        rel,
        code: stripComments(fs.readFileSync(path.join(REPO, rel), "utf8")),
      }));

  const rollsOwn = (
    files: readonly { rel: string; code: string }[]
  ): string[] =>
    files
      .filter(
        ({ rel, code }) =>
          rel !== SELF && HAND_ROLLED.some(([re]) => re.test(code))
      )
      .map((f) => f.rel)
      .sort();

  it("reads the corpus it is about to pronounce on", () => {
    const files = sources();
    expect(
      files.length,
      `The census read ${files.length} source files under ${CENSUS_ROOTS.join(", ")}. ` +
        "A walk that has stopped reaching them reports that nobody hand-rolls a " +
        "stripper any more, which is the reassuring direction."
    ).toBeGreaterThanOrEqual(2000);
    for (const root of CENSUS_ROOTS)
      expect(
        files.filter((f) => f.rel.startsWith(`${root}/`)).length,
        `No file at all under \`${root}/\`.`
      ).toBeGreaterThan(0);
  });

  it("finds exactly the files already known to hand-roll one", () => {
    expect(
      rollsOwn(sources()),
      "The set of files stripping comments by hand has changed. If a file was " +
        "ADDED, route it through lib/__tests__/strip-comments.ts instead — the " +
        "ordered pair of regexes strips block comments first, so a `/*` inside a " +
        "`//` sentence swallows everything to the next unrelated `*/` (#3087, " +
        "1,244 lines of components/ActivityForm.tsx). If one was CONVERTED, delete " +
        "its line from HAND_ROLLED_TODAY above — this list can only shrink."
    ).toEqual([...HAND_ROLLED_TODAY]);
  });

  it("sees a hand-rolled stripper planted in the corpus, and not one in prose", () => {
    // A green sweep over a tree that already complies says nothing about what the
    // sweep can SEE (#3325). The prose case is the one that matters: this file and
    // strip-comments.ts both QUOTE the retired pair in order to argue against it,
    // and a census that counted those would fire on its own explanation.
    const planted = [
      {
        rel: "lib/__tests__/zz-planted-block.test.ts",
        code: stripComments(
          'const code = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");\n'
        ),
      },
      {
        rel: "lib/__tests__/zz-planted-line.test.ts",
        code: stripComments(
          'const code = src.replace(/\\/\\/[^\\n]*/g, "");\n'
        ),
      },
      {
        rel: "lib/__tests__/zz-planted-prose.test.ts",
        code: stripComments(
          '// Do not write src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "") — use stripComments.\n' +
            "const code = stripComments(src);\n"
        ),
      },
      {
        rel: "lib/__tests__/zz-planted-member.test.ts",
        code: stripComments("const code = stripComments(src);\n"),
      },
    ];
    expect(rollsOwn(planted)).toEqual([
      "lib/__tests__/zz-planted-block.test.ts",
      "lib/__tests__/zz-planted-line.test.ts",
    ]);
  });
});
