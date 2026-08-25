import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FLOW_KINDS } from "@/lib/offline/queue";
import { QUICK_LOG_IDS } from "@/lib/quick-log";
import { QUICK_LOG_ROW_CONTRACT } from "@/lib/quick-log-row-contract";

describe("quick-log row contract (#3275)", () => {
  it("declares exactly every QuickLogId", () => {
    expect(Object.keys(QUICK_LOG_ROW_CONTRACT).sort()).toEqual(
      [...QUICK_LOG_IDS].sort()
    );
  });

  it("names only real queue flows and requires an argument for exclusions", () => {
    for (const id of QUICK_LOG_IDS) {
      const story = QUICK_LOG_ROW_CONTRACT[id].offline;
      if (story.status === "covered") {
        expect(story.flows.length, id).toBeGreaterThan(0);
        for (const flow of story.flows) expect(FLOW_KINDS, id).toContain(flow);
      } else {
        expect(story.argument.length, id).toBeGreaterThan(40);
      }
    }
  });

  it("codifies the #3166 stool ruling as queue coverage", () => {
    expect(QUICK_LOG_ROW_CONTRACT["log-stool"].offline).toMatchObject({
      status: "covered",
      flows: ["stool"],
    });
    expect(QUICK_LOG_ROW_CONTRACT["log-stool"].offline.detail).toContain(
      "#3166"
    );
  });

  it("requires field-bearing submit forms to use inline alert plus toast", () => {
    for (const id of QUICK_LOG_IDS) {
      const failure = QUICK_LOG_ROW_CONTRACT[id].failure;
      if (failure.fields === "form") {
        expect(failure.channel, id).toBe("inline-and-toast");
      }
    }

    for (const file of [
      "app/(app)/trends/MeasurementsQuickAdd.tsx",
      "components/UploadForm.tsx",
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, `${file}: visible inline failure`).toMatch(
        /role=["']alert["']/
      );
      expect(source, `${file}: paired failure helper`).toMatch(
        /const fail = \(message: string\)[\s\S]*?setError\(message\);[\s\S]*?toast\(message, \{ tone: "error" \}\);/
      );
    }
  });

  it("uses Save for forms and makes every different commit verb an argued exception", () => {
    for (const id of QUICK_LOG_IDS) {
      const commit = QUICK_LOG_ROW_CONTRACT[id].commit;
      if (commit.kind === "form")
        expect(commit.verb, id).toMatch(/^Save(?:\s|$)/);
      if (commit.kind === "exception") {
        expect(commit.argument.length, id).toBeGreaterThan(40);
      }
    }
  });
});
