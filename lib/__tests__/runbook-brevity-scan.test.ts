import { readFileSync } from "node:fs";
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
//   directive is quoted verbatim and gets the headroom).
// Tables, headings and fenced code blocks are exempt: tables are the dense
// reference surfaces (environment facts, agent signals) and code blocks are
// commands.
//
// THE MEASURE IS WIDTH, NOT NEWLINES (#2771). This scan first counted SOURCE lines
// "at the file's 80-column wrap" — but `.prettierrc` leaves `proseWrap` unset and
// Prettier's default is `preserve`, so nothing rewraps a Markdown paragraph and
// that wrap was a convention no tool applied. A 553-character bullet written
// without a single newline measured ONE line and passed both this gate and
// `prettier --check`: the war story the scan was bought to keep out, admitted in
// full, by a formatting choice rather than an argument.
//
// The alternative was setting `proseWrap: "always"` so the assumed wrap became a
// fact. Measured, that is 54 of 60 Markdown files and ~10k changed lines — a
// repo-wide reflow that collides with every branch in flight, to buy a property
// this scan can simply compute. So the scan computes it: a source line counts for
// `ceil(length / WRAP_COLUMNS)` lines. A file that IS hand-wrapped at 80 — which
// the runbook is, every non-table line but one — measures exactly as before, and
// deleting the newlines no longer buys anything.

const RUNBOOK = path.join(process.cwd(), "docs", "orchestration.md");

const MAX_BULLET_LINES = 4;
const MAX_PARAGRAPH_LINES = 2;
const MAX_BLOCKQUOTE_LINES = 5;
const WRAP_COLUMNS = 80;

type Block = {
  kind: "bullet" | "paragraph" | "quote";
  start: number;
  lines: number;
};

/** Lines this source line occupies once wrapped at WRAP_COLUMNS. */
function widthLines(line: string): number {
  return Math.max(1, Math.ceil(line.length / WRAP_COLUMNS));
}

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
    .filter((b) => b.lines > LIMITS[b.kind])
    .map(
      (b) =>
        `line ${b.start}: ${b.kind} spans ${b.lines} lines (max ${LIMITS[b.kind]})`
    );
}

describe("runbook brevity", () => {
  it("docs/orchestration.md keeps every block within the short-bullet shape", () => {
    const source = readFileSync(RUNBOOK, "utf8");
    const violations = brevityViolations(source);
    expect(
      violations,
      `docs/orchestration.md has blocks past the short-bullet shape:\n` +
        `${violations.join("\n")}\n` +
        `Trim the rule to its decision and move the narrative to ` +
        `docs/orchestration-incidents.md, citing it as "_incidents: §section_".`
    ).toEqual([]);
  });
});

// A green census over a document that happens to comply proves nothing about what
// the census can SEE. These run the same `brevityViolations` over sources written
// to break it (#2677).
describe("the brevity scan's reach", () => {
  const WAR_STORY = "war story about a gate that failed one night ";

  it("counts a bullet written as ONE line, which no formatter rewraps", () => {
    // #2771's mutation, made permanent. Against the source-line count this bullet
    // measured 1 line and passed; `prettier --check` passed it too, because
    // `proseWrap: preserve` has no opinion about a long line.
    const bullet = `- ${WAR_STORY.repeat(12).trim()}`;
    expect(bullet.length).toBeGreaterThan(MAX_BULLET_LINES * WRAP_COLUMNS);
    expect(brevityViolations(bullet)).toEqual([
      `line 1: bullet spans ${widthLines(bullet)} lines (max ${MAX_BULLET_LINES})`,
    ]);
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
      const oneLine = brevityViolations(text);
      const wrapped = brevityViolations(hardWrap(text, WRAP_COLUMNS));
      expect(oneLine.length > 0, `${text.slice(0, 24)} unwrapped`).toBe(over);
      expect(wrapped.length > 0, `${text.slice(0, 24)} wrapped`).toBe(over);
    }
  });

  it("still counts a wrapped block exactly as it did before", () => {
    // The measure is a SUPERSET, not a replacement: for the file as actually
    // written — hand-wrapped inside 80 columns — every line counts for one, so the
    // thresholds keep meaning what they meant. That is why this was the cheap fix
    // and the repo-wide reflow was not.
    const wrapped = ["- a rule", "  and its one qualifier", "  and one more"];
    expect(scanBlocks(wrapped.join("\n"))[0].lines).toBe(wrapped.length);
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
    // And the exempt kinds are exempt however long they get: a war story inside a
    // fenced block, a table cell or a heading is out of reach by design, because
    // capping those would push prose back into the bullets.
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
