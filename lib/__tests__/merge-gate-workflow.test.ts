import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { GATE_STATUS_CONTEXT } from "../../scripts/orchestration/merge-gate-core.mjs";

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
  it("gives the wrapper check a different name from the merge-gate status", () => {
    const source = fs.readFileSync(WORKFLOW, "utf8");
    const jobs = /^jobs:\n([\s\S]*)$/m.exec(source)?.[1] ?? "";
    const jobNames = [...jobs.matchAll(/^  ([\w-]+):$/gm)].map(
      (match) => match[1]
    );

    expect(jobNames).toEqual(["merge-gate-job"]);
    expect(source).toContain("--ignore-check merge-gate-job");
    // The published context and the one the gate excludes from its own
    // verdict are the SAME STRING or the #5022 self-block exclusion silently
    // stops matching, and the gate starts reading its own last answer back.
    expect(
      source.match(new RegExp(`context: "${GATE_STATUS_CONTEXT}"`, "g"))
    ).toHaveLength(1);
  });

  it("uses only the supported events that can recompute its verdict", () => {
    const source = fs.readFileSync(WORKFLOW, "utf8");
    expect(triggerNames(source)).toEqual([
      "pull_request",
      "pull_request_review",
      "workflow_run",
      "workflow_dispatch",
    ]);
  });

  it("publishes the evaluator's exact failing clause, not a generic log pointer", () => {
    const source = fs.readFileSync(WORKFLOW, "utf8");
    expect(source).toContain(
      "gate_output=$(node scripts/orchestration/merge-gate.mjs"
    );
    expect(source).toContain("s/^STATUS: //p");
    expect(source).toContain(
      'payload=$(jq -cn --arg state "$state" --arg desc "$desc"'
    );
    expect(source).toContain('-d "$payload"');
    expect(source).not.toContain(
      'desc="gate CLOSED — see the run log for each failure"'
    );
    expect(source).not.toContain('-d "{\\"state\\"');
  });
});
