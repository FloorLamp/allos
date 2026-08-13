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
// Shape enforced, by source lines at the file's 80-column wrap:
// - a list item (bullet or numbered, any nesting) spans at most
//   MAX_BULLET_LINES lines including its continuations;
// - a paragraph outside lists/tables/code/quotes spans at most
//   MAX_PARAGRAPH_LINES lines (section leads stay leads);
// - a blockquote spans at most MAX_BLOCKQUOTE_LINES lines (the standing
//   directive is quoted verbatim and gets the headroom).
// Tables, headings and fenced code blocks are exempt: tables are the dense
// reference surfaces (environment facts, agent signals) and code blocks are
// commands.

const RUNBOOK = path.join(process.cwd(), "docs", "orchestration.md");

const MAX_BULLET_LINES = 4;
const MAX_PARAGRAPH_LINES = 2;
const MAX_BLOCKQUOTE_LINES = 5;

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
      if (current?.kind === "quote") current.lines++;
      else {
        close();
        current = { kind: "quote", start: i + 1, lines: 1 };
      }
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
      close();
      current = { kind: "bullet", start: i + 1, lines: 1 };
      continue;
    }
    // An indented line after a list item is that item's continuation; anything
    // else opens or extends a paragraph.
    if (current?.kind === "bullet" && /^\s+\S/.test(line)) {
      current.lines++;
      continue;
    }
    if (current?.kind === "paragraph") current.lines++;
    else {
      close();
      current = { kind: "paragraph", start: i + 1, lines: 1 };
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

describe("runbook brevity", () => {
  it("docs/orchestration.md keeps every block within the short-bullet shape", () => {
    const source = readFileSync(RUNBOOK, "utf8");
    const violations = scanBlocks(source)
      .filter((b) => b.lines > LIMITS[b.kind])
      .map(
        (b) =>
          `line ${b.start}: ${b.kind} spans ${b.lines} lines (max ${LIMITS[b.kind]})`
      );
    expect(
      violations,
      `docs/orchestration.md has blocks past the short-bullet shape:\n` +
        `${violations.join("\n")}\n` +
        `Trim the rule to its decision and move the narrative to ` +
        `docs/orchestration-incidents.md, citing it as "_incidents: §section_".`
    ).toEqual([]);
  });
});
