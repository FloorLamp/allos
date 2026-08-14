import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The runbook is rules only, short bullets, no prose (owner, 2026-08-13).
// Narratives and receipts belong in docs/orchestration-incidents.md — the
// runbook cites them as `_incidents: §section_`. This scan is the CI tooth:
// runbook rules had regrown into inline war stories (one bullet reached 18
// lines) within days of each trim, because every incident wants to be
// institutionalized where the rule lives. The receipts file is exempt — it is
// WHERE the prose goes, and capping it would just push narratives back here.
//
// Shape enforced, in lines AT WRAP_COLUMNS — a line's own length decides how many
// it counts for, so the measure survives a file nothing rewraps:
// - a list item (bullet or numbered, any nesting) spans at most
//   MAX_BULLET_LINES lines including its continuations;
// - a paragraph outside lists/tables/code/quotes spans at most its file's GENRE
//   paragraph cap (section leads stay leads);
// - a blockquote spans at most MAX_BLOCKQUOTE_LINES lines (the standing
//   directive is quoted verbatim and gets the headroom);
// - and the whole file stays inside its FILE_BUDGETS entry.
// Tables, headings and fenced code blocks are exempt from the BLOCK shape:
// tables are the dense reference surfaces (environment facts, agent signals)
// and code blocks are commands. They still count toward the file budget.
//
// THE MEASURE IS WIDTH, NOT NEWLINES (#2771). This scan first counted SOURCE lines
// "at the file's 80-column wrap" — but `.prettierrc` leaves `proseWrap` unset and
// Prettier's default is `preserve`, so nothing rewraps a Markdown paragraph and
// that wrap was a convention no tool applied. A 553-character bullet written
// without a single newline measured ONE line and passed both this gate and
// `prettier --check`: the war story the scan was bought to keep out, admitted in
// full, by a formatting choice rather than an argument.
//
// The per-file budgets #2775 added have the SAME hole, and it is the wider one: a
// budget of 80 lines bounds a one-pager only while a line is a line, and 80 lines
// of 500 characters is a 40,000-character "one-pager" that passes. Both halves are
// therefore measured the same way.
//
// The alternative was setting `proseWrap: "always"` so the assumed wrap became a
// fact. Measured, that is 54 of 60 Markdown files and ~10k changed lines — a
// repo-wide reflow that collides with every branch in flight, to buy a property
// this scan can simply compute. So the scan computes it: a source line counts for
// `ceil(length / WRAP_COLUMNS)` lines. The guarded files are hand-wrapped inside
// 80 columns, so every budget survives the change untouched, and deleting the
// newlines no longer buys anything.
//
// THE PARAGRAPH CAP IS PER GENRE (#2784). Two lines was calibrated for
// `docs/orchestration.md` — terse imperative bullets, where a paragraph is a
// section lead and two lines is generous. #2775 brought eleven more files under the
// same gate, six of them directory-scoped `AGENTS.md` files carrying ordinary
// explanatory prose, and the very first paragraph written in the new genre tripped
// the cap on the day it was written: the owner's 177-character intro, which #2782
// split in two without a word changing.
//
// That reflow is the argument for moving the cap rather than the argument for
// keeping it. A gate whose enforcement action is "insert a blank line, change no
// words" shortened nothing — it chose the author's paragraph breaks. Two
// width-lines is 160 characters, under two ordinary sentences, so capping
// explanatory prose there does not bound a document, it bounds a thought. What
// bounds the document is the FILE budget, and that has been the un-evadable half
// since #2771 made it measure width.
//
// So the cap moved to where the registry already says these files differ. A file
// declares a GENRE and the genre carries the cap. `runbook` keeps 2: the terseness
// this gate was bought for is real, bullets are its shape, and paying for a
// problem in the prose files by giving headroom back to the file the gate was
// bought for would be the wrong trade. `prose` gets 3, which admits the owner's
// intro as ONE paragraph and still refuses a war story. The vocabulary is two words
// rather than twelve free integers, so the second dimension is a choice between two
// stated calibrations rather than a number anyone can nudge to make a failure go
// away.
//
// WHICH GENRE A NEW FILE GETS is decidable without asking anyone, which is the
// point: a per-genre cap nobody can predict is worse than a wrong single number,
// because the gate stops being a rule and becomes a surprise. The boundary is
// `docs/orchestration*` and nothing else — that is the operational runbook, read
// mid-task under time pressure — and the census below pins that membership in
// BOTH directions, so the genre cannot spread by drift. Everything else is
// `prose`, including a file that does not obviously belong to either. The
// default is deliberately the looser cap: the FILE budget still bounds the
// document, so guessing wrong costs one line of paragraph rather than an
// uncapped file. Wanting `runbook` for something outside `docs/orchestration/`
// means claiming a second operational surface — a real design question, and it
// fails the census until someone answers it.
//
// Two things deliberately NOT done, recorded so they are not rediscovered.
// `proseWrap: "always"` stays rejected on #2771's measurement — 54 of 60 Markdown
// files, ~10k lines — and should not be re-proposed without new information. And
// six guarded files carry 81-82 character lines: the width measure charges them
// correctly, and reflowing them pre-emptively is the repo-wide churn #2790 already
// demonstrated colliding with a branch in flight. What they do deserve is a failure
// message that NAMES them, because the author who wrote four source lines and was
// told six has no way to see that the fix is a rewrap rather than a deletion.

const MAX_BULLET_LINES = 4;
const MAX_BLOCKQUOTE_LINES = 5;
const WRAP_COLUMNS = 80;

/**
 * The paragraph cap, per genre (#2784). Two words, not twelve integers: a new file
 * picks a calibration that already has an argument behind it.
 */
const GENRE_PARAGRAPH_LINES = {
  /** Imperative rules and bullets. A paragraph here is a section lead. */
  runbook: 2,
  /** Explanatory one-pagers. A paragraph here is a paragraph. */
  prose: 3,
} as const;

type Genre = keyof typeof GENRE_PARAGRAPH_LINES;

/** Lines this source line occupies once wrapped at WRAP_COLUMNS. */
function widthLines(line: string): number {
  return Math.max(1, Math.ceil(line.length / WRAP_COLUMNS));
}

/** A whole file's length, in those same lines. */
function fileLines(source: string): number {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.reduce((n, line) => n + widthLines(line), 0);
}

const FILE_BUDGETS = {
  "AGENTS.md": { lines: 80, genre: "prose" },
  "app/AGENTS.md": { lines: 80, genre: "prose" },
  "components/AGENTS.md": { lines: 60, genre: "prose" },
  "lib/AGENTS.md": { lines: 100, genre: "prose" },
  "lib/migrations/AGENTS.md": { lines: 80, genre: "prose" },
  "lib/queries/AGENTS.md": { lines: 60, genre: "prose" },
  "docs/orchestration.md": { lines: 80, genre: "runbook" },
  "docs/orchestration/dispatch.md": { lines: 100, genre: "runbook" },
  "docs/orchestration/e2e-ci.md": { lines: 100, genre: "runbook" },
  "docs/orchestration/environment.md": { lines: 100, genre: "runbook" },
  "docs/orchestration/lifecycle.md": { lines: 80, genre: "runbook" },
  "docs/orchestration/review-merge.md": { lines: 100, genre: "runbook" },
} as const satisfies Record<string, { lines: number; genre: Genre }>;

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

function findAgentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_DIRS.has(entry.name)) return [];
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return findAgentFiles(absolute);
    return entry.name === "AGENTS.md"
      ? [path.relative(process.cwd(), absolute)]
      : [];
  });
}

function guardedFiles(): string[] {
  const agentFiles = findAgentFiles(process.cwd());
  const orchestrationFiles = readdirSync(
    path.join(process.cwd(), "docs", "orchestration"),
    { withFileTypes: true }
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.posix.join("docs/orchestration", entry.name));
  return [...agentFiles, "docs/orchestration.md", ...orchestrationFiles].sort();
}

type Block = {
  kind: "bullet" | "paragraph" | "quote";
  start: number;
  lines: number;
  /** Source lines in this block that run past WRAP_COLUMNS (#2784). */
  overflow: number;
};

function scanBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let inFence = false;
  let current: Block | null = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  const over = (line: string): number => (line.length > WRAP_COLUMNS ? 1 : 0);
  const extend = (line: string): void => {
    current!.lines += widthLines(line);
    current!.overflow += over(line);
  };
  const open = (kind: Block["kind"], i: number, line: string): Block => ({
    kind,
    start: i + 1,
    lines: widthLines(line),
    overflow: over(line),
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      close();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "" || /^#{1,6}\s/.test(line) || /^\s*\|/.test(line)) {
      close();
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (current?.kind === "quote") extend(line);
      else {
        close();
        current = open("quote", i, line);
      }
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
      close();
      current = open("bullet", i, line);
      continue;
    }
    // An indented line after a list item is that item's continuation; anything
    // else opens or extends a paragraph.
    if (current?.kind === "bullet" && /^\s+\S/.test(line)) {
      extend(line);
      continue;
    }
    if (current?.kind === "paragraph") extend(line);
    else {
      close();
      current = open("paragraph", i, line);
    }
  }
  close();
  return blocks;
}

/** The line cap for a block kind, given the file's genre paragraph cap. */
function limitFor(kind: Block["kind"], paragraphLines: number): number {
  if (kind === "bullet") return MAX_BULLET_LINES;
  if (kind === "quote") return MAX_BLOCKQUOTE_LINES;
  return paragraphLines;
}

/**
 * Why a block measured more than its author typed (#2784).
 *
 * Six guarded files carry 81-82 character lines, and #2790 is what that costs when
 * nobody is told: a four-source-line bullet with two 81-character lines counts as
 * six, and the author reading "spans 6 lines" has no way to see that the fix is a
 * rewrap costing nothing rather than a sentence they have to give up.
 */
function overflowNote(overflow: number): string {
  if (overflow === 0) return "";
  return (
    ` — ${overflow} of its source lines run past ${WRAP_COLUMNS} columns and are ` +
    `charged for the overflow, so rewrapping those costs no words`
  );
}

function brevityViolations(source: string, paragraphLines: number): string[] {
  return scanBlocks(source)
    .filter((block) => block.lines > limitFor(block.kind, paragraphLines))
    .map(
      (block) =>
        `line ${block.start}: ${block.kind} spans ${block.lines} lines ` +
        `(max ${limitFor(block.kind, paragraphLines)})` +
        overflowNote(block.overflow)
    );
}

describe("runbook brevity", () => {
  it("registers every agent and orchestration instruction file", () => {
    expect(guardedFiles()).toEqual(Object.keys(FILE_BUDGETS).sort());
  });

  it("keeps the terse-bullet runbook on the calibration it was bought for", () => {
    // The #2784 loosening reaches the prose one-pagers and NOTHING else. Stated
    // here so that moving `docs/orchestration.md` — the file whose regrown war
    // stories bought this gate — into the prose genre is a deliberate edit with a
    // failing test in front of it, rather than a one-word change in a table.
    const runbookFiles = Object.entries(FILE_BUDGETS)
      .filter(([, budget]) => budget.genre === "runbook")
      .map(([file]) => file)
      .sort();
    expect(runbookFiles).toEqual(
      Object.keys(FILE_BUDGETS)
        .filter((file) => file.startsWith("docs/orchestration"))
        .sort()
    );
    expect(GENRE_PARAGRAPH_LINES.runbook).toBe(2);
  });

  it.each(Object.entries(FILE_BUDGETS))(
    "%s stays within its line and block budgets",
    (relativePath, budget) => {
      const source = readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8"
      );
      const lineCount = fileLines(source);
      const sourceLines = source.replace(/\n$/, "").split("\n").length;
      const charged = lineCount - sourceLines;
      expect(
        lineCount,
        `${relativePath} has ${lineCount} lines (budget ${budget.lines})` +
          (charged > 0
            ? `, ${charged} of them charged for source lines past ` +
              `${WRAP_COLUMNS} columns`
            : "") +
          `. Move detail to a focused document instead of raising the budget.`
      ).toBeLessThanOrEqual(budget.lines);

      const violations = brevityViolations(
        source,
        GENRE_PARAGRAPH_LINES[budget.genre]
      );
      expect(
        violations,
        `${relativePath} (${budget.genre}) has blocks past the ` +
          `short-instruction shape:\n${violations.join("\n")}\n` +
          `Keep the decision here and move narrative or history elsewhere.`
      ).toEqual([]);
    }
  );
});

// A green census over documents that happen to comply proves nothing about what
// the census can SEE. These run the same measures over sources written to break
// them (#2677).
describe("the brevity scan's reach", () => {
  const WAR_STORY = "war story about a gate that failed one night ";
  const RUNBOOK = GENRE_PARAGRAPH_LINES.runbook;
  const PROSE = GENRE_PARAGRAPH_LINES.prose;

  it("counts a bullet written as ONE line, which no formatter rewraps", () => {
    // #2771's mutation, made permanent. Against the source-line count this bullet
    // measured 1 line and passed; `prettier --check` passed it too, because
    // `proseWrap: preserve` has no opinion about a long line.
    const bullet = `- ${WAR_STORY.repeat(12).trim()}`;
    expect(bullet.length).toBeGreaterThan(MAX_BULLET_LINES * WRAP_COLUMNS);
    expect(brevityViolations(bullet, RUNBOOK)).toEqual([
      `line 1: bullet spans ${widthLines(bullet)} lines ` +
        `(max ${MAX_BULLET_LINES})` +
        // The whole bullet is one source line past the wrap, so the #2784 note
        // fires here too — correctly: rewrapping it is the first thing to try.
        overflowNote(1),
    ]);
  });

  it("counts a FILE that spends its budget on long lines", () => {
    // The same evasion at file granularity, which is the one #2775's per-file
    // budgets newly depend on: 20 lines of 400 characters is a 8,000-character
    // document that a 60-line budget would otherwise call a one-pager.
    const padded = Array.from({ length: 20 }, () => WAR_STORY.repeat(9)).join(
      "\n"
    );
    expect(padded.split("\n")).toHaveLength(20);
    expect(fileLines(padded)).toBeGreaterThan(60);
  });

  it("reaches the same verdict whichever way a block is spelled", () => {
    // The property the old measure was assumed to have and did not. Where an
    // author's editor puts a newline is not an argument about length, so the two
    // spellings of one paragraph must land on the same side of the limit — in both
    // directions, or "unwrap it" and "wrap it" become ways to change the verdict.
    const long = WAR_STORY.repeat(6).trim();
    const short = "One short lead sentence.";
    for (const [text, over] of [
      [long, true],
      [short, false],
    ] as const) {
      expect(
        brevityViolations(text, RUNBOOK).length > 0,
        `${text.slice(0, 24)} unwrapped`
      ).toBe(over);
      expect(
        brevityViolations(hardWrap(text, WRAP_COLUMNS), RUNBOOK).length > 0,
        `${text.slice(0, 24)} wrapped`
      ).toBe(over);
    }
  });

  it("binds the paragraph cap to the GENRE, in both directions", () => {
    // #2784's whole content, exercised rather than spelled. A global cap of either
    // value fails this: at 2 the prose case is rejected, at 3 the runbook case is
    // admitted. The dimension has to DO something in both directions or it is a
    // column in a table nobody is keeping honest.
    const threeLines = WAR_STORY.repeat(4).trim();
    expect(widthLines(threeLines)).toBe(3);
    expect(brevityViolations(threeLines, PROSE)).toEqual([]);
    expect(brevityViolations(threeLines, RUNBOOK)).toEqual([
      `line 1: paragraph spans 3 lines (max ${RUNBOOK})` + overflowNote(1),
    ]);

    // And the loosening is one line, not a licence: four still fails everywhere.
    const fourLines = WAR_STORY.repeat(6).trim();
    expect(widthLines(fourLines)).toBeGreaterThan(PROSE);
    for (const cap of [RUNBOOK, PROSE])
      expect(brevityViolations(fourLines, cap)).toHaveLength(1);
  });

  it("admits the owner's intro as ONE paragraph, which is the calibration", () => {
    // The concrete case #2784 was filed about: 177 characters, three width-lines,
    // hand-wrapped inside 80 columns. #2782 split it in two to pass a cap of 2
    // without changing a word, which is the enforcement action that showed the cap
    // was measuring the wrong thing. It is restored in AGENTS.md by this change, so
    // this asserts the real file rather than a reconstruction of it.
    const source = readFileSync(path.join(process.cwd(), "AGENTS.md"), "utf8");
    const intro = scanBlocks(source).find(
      (block) => block.kind === "paragraph"
    );
    expect(intro?.lines).toBe(3);
    expect(FILE_BUDGETS["AGENTS.md"].genre).toBe("prose");
    expect(brevityViolations(source, PROSE)).toEqual([]);
    expect(brevityViolations(source, RUNBOOK).length).toBeGreaterThan(0);
  });

  it("names the source lines past the wrap, because that is the cheap fix", () => {
    // #2790's trap, made legible. Two 81-character lines turn a four-source-line
    // bullet into six, and the author who counted four needs to be told which half
    // of the excess is a rewrap costing no words. Non-vacuous by construction: the
    // twin below is the same block wrapped, and it says nothing extra.
    const overWide = [
      `- ${"a".repeat(79)}`,
      `  ${"b".repeat(79)}`,
      `  ${"c".repeat(20)}`,
      `  ${"d".repeat(20)}`,
    ];
    expect(overWide.filter((l) => l.length > WRAP_COLUMNS)).toHaveLength(2);
    const [violation] = brevityViolations(overWide.join("\n"), RUNBOOK);
    expect(violation).toContain("spans 6 lines");
    expect(violation).toContain(
      `2 of its source lines run past ${WRAP_COLUMNS}`
    );

    const wrapped = [
      `- ${"a".repeat(70)}`,
      ...Array(5).fill(`  ${"b".repeat(70)}`),
    ];
    const [twin] = brevityViolations(wrapped.join("\n"), RUNBOOK);
    expect(twin).toContain("spans 6 lines");
    expect(twin).not.toContain("run past");
  });

  it("leaves the 81-82 character lines alone, and says why", () => {
    // Declined deliberately (#2784), so the decline is asserted rather than
    // implied. Those lines are not a defect under a width measure — they are
    // charged exactly one extra line each — and a pre-emptive reflow of six
    // instruction files is the branch-colliding churn #2790 already paid for once.
    // The honest inequality is pinned in the test below; this pins that the
    // situation it describes is still real, so neither claim goes vacuous.
    const withOverflow = Object.keys(FILE_BUDGETS).filter((relativePath) =>
      readFileSync(path.join(process.cwd(), relativePath), "utf8")
        .split("\n")
        .some((line) => line.length > WRAP_COLUMNS)
    );
    expect(withOverflow.length).toBeGreaterThan(0);
    for (const relativePath of withOverflow) {
      const source = readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8"
      );
      // Charged, never excused — and never charged twice for one overflow.
      const lines = source.replace(/\n$/, "").split("\n");
      const over = lines.filter((l) => l.length > WRAP_COLUMNS).length;
      expect(fileLines(source), relativePath).toBeGreaterThanOrEqual(
        lines.length + over
      );
    }
  });

  it("counts a wrapped document exactly as the old measure did", () => {
    // The measure is a SUPERSET, never a discount: a line inside WRAP_COLUMNS
    // counts for one, so a hand-wrapped file measures exactly as it always did and
    // the thresholds and twelve budgets keep meaning what they meant. That is why
    // this was the cheap fix and the repo-wide reflow was not.
    const wrapped = ["- a rule", "  and its one qualifier", "  and one more"];
    expect(scanBlocks(wrapped.join("\n"))[0].lines).toBe(wrapped.length);
    for (const relativePath of Object.keys(FILE_BUDGETS)) {
      const source = readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8"
      );
      const lines = source.replace(/\n$/, "").split("\n");
      // Equal where nothing overflows, never LOWER where something does. The
      // guarded files are hand-wrapped but not perfectly — several carry a line a
      // character or two past 80 — so the honest claim is the inequality, with
      // equality only for the files that earn it.
      expect(fileLines(source), relativePath).toBeGreaterThanOrEqual(
        lines.length
      );
      if (!lines.some((l) => l.length > WRAP_COLUMNS))
        expect(fileLines(source), relativePath).toBe(lines.length);
    }
  });

  it("states what it CANNOT see", () => {
    // Two gaps, both deliberate, both worth naming rather than leaving to be
    // discovered — a guard credited with more than it does is worse than none.
    //
    // It measures SOURCE characters, not rendered width. A bullet carrying a long
    // URL or heavy inline markup is charged for syntax the reader never sees, so
    // the scan is conservative rather than accurate. The bias is the safe one, but
    // it is a bias.
    const linkHeavy = `- see [the runbook](${"x".repeat(400)})`;
    expect(brevityViolations(linkHeavy, RUNBOOK)).toHaveLength(1);
    // And the exempt kinds stay exempt from the BLOCK shape however long they get:
    // a war story inside a fenced block, a table cell or a heading is out of that
    // reach by design, because capping those would push prose back into the
    // bullets. Only the file budget still counts them.
    const hidden = [
      "```",
      WAR_STORY.repeat(12),
      "```",
      "",
      `| Thing | ${WAR_STORY.repeat(12)} |`,
      "",
      `#### ${WAR_STORY.repeat(12)}`,
    ].join("\n");
    expect(brevityViolations(hidden, RUNBOOK)).toEqual([]);
    expect(fileLines(hidden)).toBeGreaterThan(hidden.split("\n").length);
  });
});

/** Greedy wrap, for asserting that a wrapped block and its one-line twin agree. */
function hardWrap(text: string, width: number): string {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length > width && line !== "") {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line !== "") out.push(line);
  return out.join("\n");
}
