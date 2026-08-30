import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// THE ORCHESTRATOR'S MCP GRANT IS THE WRITE SET AND NOTHING ELSE
// (owner, 2026-08-30). environment.md §GitHub access has said "REST for every
// read" all along, but the orchestrate skill still GRANTED the MCP read tools
// — and a rule that says don't while the grant says can is the
// instructed-not-structural theatre this repo keeps paying for (the same
// argument reconcile-tracker.test.ts makes for the no-close scan). With the
// read grants gone, MCP-read drift is impossible rather than forbidden;
// reads ride Bash (curl / gh api), which the skill grants anyway.

const MCP_WRITE_SET = [
  "mcp__github__merge_pull_request",
  "mcp__github__update_pull_request",
];

describe("orchestrate skill tool grants", () => {
  const text = fs.readFileSync(
    path.join(process.cwd(), ".claude/skills/orchestrate/SKILL.md"),
    "utf8"
  );
  const allowed = /^allowed-tools:\s*(.+)$/m.exec(text);

  it("grants exactly the MCP write set, no MCP reads", () => {
    expect(allowed).not.toBeNull();
    const mcpGrants = allowed![1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("mcp__"));
    expect(mcpGrants.sort()).toEqual([...MCP_WRITE_SET].sort());
  });

  it("names no read-shaped MCP tool anywhere in the grant line", () => {
    // Belt to the braces above: _read, list_, search_, and the Actions reads
    // are the tools the harness prompt pushes hardest.
    expect(allowed![1]).not.toMatch(
      /mcp__github__(?:\w*_read|list_\w*|search_\w*|actions_get|actions_list)/
    );
  });
});
