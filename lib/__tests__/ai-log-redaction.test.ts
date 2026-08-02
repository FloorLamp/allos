// recordAiEvent's redaction parity with errors.jsonl (#1842) is only observable
// at the append boundary, so this file chdirs into a throwaway tmp dir BEFORE
// importing lib/ai-log (AI_LOG_PATH resolves from process.cwd() at import time),
// keeping the writes out of the repo's data/logs. Safe because vitest runs each
// test file in its own forked process. No DB, no network.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "allos-ai-log-")));
process.env.LOG_LEVEL = "error"; // silence the stdout echo of each event

const { recordAiEvent, readAiEvents, AI_LOG_PATH } = await import("../ai-log");

describe("recordAiEvent redacts secrets before append (#1842)", () => {
  it("masks a secret-looking detail in the persisted line", () => {
    recordAiEvent({
      feature: "insight",
      status: "ok",
      detail: "request sent with authorization: Bearer sk-live-12345",
    });
    const raw = fs.readFileSync(AI_LOG_PATH, "utf8");
    expect(raw).not.toContain("sk-live-12345");
    expect(raw).toContain("***");
    expect(readAiEvents(1)[0].detail).not.toContain("sk-live-12345");
  });

  it("masks a secret-looking error, in the return value too", () => {
    const event = recordAiEvent({
      feature: "extraction",
      status: "failed",
      error: "provider refused: token=supersecret",
    });
    expect(event.error).toBe("provider refused: token=***");
    expect(fs.readFileSync(AI_LOG_PATH, "utf8")).not.toContain("supersecret");
  });

  it("leaves non-secret detail untouched", () => {
    const event = recordAiEvent({
      feature: "suggestions",
      status: "ok",
      detail: "3 suggestions for profile 2",
    });
    expect(event.detail).toBe("3 suggestions for profile 2");
  });
});
