// SERVER-ACTION TIER — the AI-log Clear action (issue #1842), the mirror of the
// Errors tab's clearErrors. This tier's mock makes requireAdmin() pass for the
// acting session, so it asserts the EFFECT (the file truncates in place and the
// tab revalidates) and the no-session refusal; the member-role redirect is the
// real requireAdmin's job, and the presence of the requireAdmin() call itself is
// enforced by the actions-write-access scan.
//
// AI_LOG_PATH resolves from process.cwd() at import time and would otherwise be
// SHARED with any db-test that records AI events in a parallel worker — a
// truncation here could race their byte-offset tail reads. So this file chdirs
// into a throwaway tmp dir BEFORE the app modules load (vitest runs each file in
// its own forked process) and every module below is imported dynamically to keep
// that ordering.

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "allos-ai-clear-")));
process.env.LOG_LEVEL = "error"; // silence the stdout echo of each event

const { revalidatePath } = await import("next/cache");
const { clearAiLogAction } = await import("@/app/(app)/settings/logs/actions");
const { recordAiEvent, readAiEvents, aiLogSize, AI_LOG_PATH } =
  await import("@/lib/ai-log");
const { seedActor } = await import("./harness");
const { clearActingSession } = await import("./session-state");

describe("clearAiLogAction (#1842)", () => {
  it("truncates the log in place and revalidates the tab", async () => {
    seedActor();
    recordAiEvent({ feature: "insight", status: "ok", detail: "before clear" });
    expect(aiLogSize()).toBeGreaterThan(0);

    await clearAiLogAction();

    // Truncated, not unlinked: the path stays put for the next append.
    expect(fs.statSync(AI_LOG_PATH).size).toBe(0);
    expect(readAiEvents()).toEqual([]);
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/settings/logs");

    // The sink still works after a clear.
    recordAiEvent({ feature: "insight", status: "ok", detail: "after clear" });
    expect(readAiEvents()).toHaveLength(1);
  });

  it("refuses without a session, leaving the log intact", async () => {
    seedActor();
    recordAiEvent({ feature: "extraction", status: "ok", detail: "kept" });
    const before = aiLogSize();

    clearActingSession();
    await expect(clearAiLogAction()).rejects.toThrow();
    expect(aiLogSize()).toBe(before);
  });
});
