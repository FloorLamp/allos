import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WORKFLOW = path.join(REPO, ".github/workflows/merge-gate.yml");

function triggerNames(source: string): string[] {
  const block = /^on:\n([\s\S]*?)\npermissions:/m.exec(source);
  expect(
    block,
    "the merge-gate trigger block must precede permissions"
  ).not.toBeNull();
  return [...block![1].matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
}

describe("the merge-gate workflow trigger contract", () => {
  it("uses only the supported events that can recompute its verdict", () => {
    const source = fs.readFileSync(WORKFLOW, "utf8");
    expect(triggerNames(source)).toEqual([
      "pull_request",
      "pull_request_review",
      "workflow_run",
      "workflow_dispatch",
    ]);
  });
});
