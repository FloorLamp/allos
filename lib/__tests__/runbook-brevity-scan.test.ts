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

const MAX_BULLET_LINES = 4;
const MAX_PARAGRAPH_LINES = 2;
const MAX_BLOCKQUOTE_LINES = 5;

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
      const lineCount = source.endsWith("\n")
        ? source.split("\n").length - 1
        : source.split("\n").length;
      expect(
        lineCount,
        `${relativePath} has ${lineCount} lines (budget ${lineBudget}). ` +
          `Move detail to a focused document instead of raising the budget.`
      ).toBeLessThanOrEqual(lineBudget);

      const violations = scanBlocks(source)
        .filter((block) => block.lines > LIMITS[block.kind])
        .map(
          (block) =>
            `line ${block.start}: ${block.kind} spans ${block.lines} lines ` +
            `(max ${LIMITS[block.kind]})`
        );
      expect(
        violations,
        `${relativePath} has blocks past the short-instruction shape:\n` +
          `${violations.join("\n")}\n` +
          `Keep the decision here and move narrative or history elsewhere.`
      ).toEqual([]);
    }
  );
});
