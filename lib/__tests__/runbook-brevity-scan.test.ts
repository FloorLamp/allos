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
// - a paragraph outside lists/tables/code/quotes spans at most
//   MAX_PARAGRAPH_LINES lines (section leads stay leads);
// - a blockquote spans at most MAX_BLOCKQUOTE_LINES lines (the standing
//   directive is quoted verbatim and gets the headroom);
// - and the whole file stays inside its FILE_LINE_BUDGETS entry.
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
// newlines no longer buys anything. It found one real block on its first run:
// AGENTS.md's intro was a 177-character single line, three lines of prose under a
// two-line paragraph cap, reflowed here without changing a word.

const MAX_BULLET_LINES = 4;
const MAX_PARAGRAPH_LINES = 2;
const MAX_BLOCKQUOTE_LINES = 5;
const WRAP_COLUMNS = 80;

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

const FILE_LINE_BUDGETS = {
  "AGENTS.md": 80,
  "app/AGENTS.md": 80,
  "components/AGENTS.md": 60,
  "lib/AGENTS.md": 100,
  "lib/migrations/AGENTS.md": 80,
  "lib/queries/AGENTS.md": 60,
  "docs/orchestration.md": 80,
  "docs/orchestration/dispatch.md": 100,
  "docs/orchestration/e2e-ci.md": 100,
  "docs/orchestration/environment.md": 100,
  "docs/orchestration/lifecycle.md": 80,
  "docs/orchestration/review-merge.md": 100,
} as const;

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
      if (current?.kind === "quote") current.lines += widthLines(line);
      else {
        close();
        current = { kind: "quote", start: i + 1, lines: widthLines(line) };
      }
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
      close();
      current = { kind: "bullet", start: i + 1, lines: widthLines(line) };
      continue;
    }
    // An indented line after a list item is that item's continuation; anything
    // else opens or extends a paragraph.
    if (current?.kind === "bullet" && /^\s+\S/.test(line)) {
      current.lines += widthLines(line);
      continue;
    }
    if (current?.kind === "paragraph") current.lines += widthLines(line);
    else {
      close();
      current = { kind: "paragraph", start: i + 1, lines: widthLines(line) };
    }
  }
  close();
  return blocks;
}

const LIMITS: Record<Block["kind"], number> = {
  bullet: MAX_BULLET_LINES,
  paragraph: MAX_PARAGRAPH_LINES,
  quote: MAX_BLOCKQUOTE_LINES,
};

function brevityViolations(source: string): string[] {
  return scanBlocks(source)
    .filter((block) => block.lines > LIMITS[block.kind])
    .map(
      (block) =>
        `line ${block.start}: ${block.kind} spans ${block.lines} lines ` +
        `(max ${LIMITS[block.kind]})`
    );
}

describe("runbook brevity", () => {
  it("registers every agent and orchestration instruction file", () => {
    expect(guardedFiles()).toEqual(Object.keys(FILE_LINE_BUDGETS).sort());
  });

  it.each(Object.entries(FILE_LINE_BUDGETS))(
    "%s stays within its line and block budgets",
    (relativePath, lineBudget) => {
      const source = readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8"
      );
      const lineCount = fileLines(source);
      expect(
        lineCount,
        `${relativePath} has ${lineCount} lines (budget ${lineBudget}). ` +
          `Move detail to a focused document instead of raising the budget.`
      ).toBeLessThanOrEqual(lineBudget);

      const violations = brevityViolations(source);
      expect(
        violations,
        `${relativePath} has blocks past the short-instruction shape:\n` +
          `${violations.join("\n")}\n` +
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

  it("counts a bullet written as ONE line, which no formatter rewraps", () => {
    // #2771's mutation, made permanent. Against the source-line count this bullet
    // measured 1 line and passed; `prettier --check` passed it too, because
    // `proseWrap: preserve` has no opinion about a long line.
    const bullet = `- ${WAR_STORY.repeat(12).trim()}`;
    expect(bullet.length).toBeGreaterThan(MAX_BULLET_LINES * WRAP_COLUMNS);
    expect(brevityViolations(bullet)).toEqual([
      `line 1: bullet spans ${widthLines(bullet)} lines ` +
        `(max ${MAX_BULLET_LINES})`,
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
        brevityViolations(text).length > 0,
        `${text.slice(0, 24)} unwrapped`
      ).toBe(over);
      expect(
        brevityViolations(hardWrap(text, WRAP_COLUMNS)).length > 0,
        `${text.slice(0, 24)} wrapped`
      ).toBe(over);
    }
  });

  it("counts a wrapped document exactly as the old measure did", () => {
    // The measure is a SUPERSET, never a discount: a line inside WRAP_COLUMNS
    // counts for one, so a hand-wrapped file measures exactly as it always did and
    // the thresholds and twelve budgets keep meaning what they meant. That is why
    // this was the cheap fix and the repo-wide reflow was not.
    const wrapped = ["- a rule", "  and its one qualifier", "  and one more"];
    expect(scanBlocks(wrapped.join("\n"))[0].lines).toBe(wrapped.length);
    for (const relativePath of Object.keys(FILE_LINE_BUDGETS)) {
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
    expect(brevityViolations(linkHeavy)).toHaveLength(1);
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
    expect(brevityViolations(hidden)).toEqual([]);
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
