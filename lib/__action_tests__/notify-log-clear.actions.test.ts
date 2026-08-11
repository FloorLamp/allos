// SERVER-ACTION TIER — the Notify tick log's global Clear action (issue #2284).
// The effect and authorization boundary both run for real: the log file is isolated
// under a throwaway cwd, auth resolves through the action-tier session mock, and
// only Next cache revalidation is stubbed by the shared setup.

import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-notify-clear-"));
process.chdir(tmpDir);

const { revalidatePath } = await import("next/cache");
const { clearNotifyEvents } =
  await import("@/app/(app)/settings/notify-log/actions");
const { NOTIFY_LOG_PATH, notifyLogSize, readNotifyEvents, recordNotifyEvent } =
  await import("@/lib/notify-log");
const { seedActor } = await import("./harness");

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function appendEvent(message: string): void {
  recordNotifyEvent({ level: "info", scope: "notify", msg: message });
}

describe("clearNotifyEvents (#2284)", () => {
  it("lets an admin truncate the log and revalidates the viewer", async () => {
    seedActor();
    appendEvent("before clear");
    expect(notifyLogSize()).toBeGreaterThan(0);

    await clearNotifyEvents();

    expect(fs.statSync(NOTIFY_LOG_PATH).size).toBe(0);
    expect(readNotifyEvents().events).toEqual([]);
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith(
      "/settings/notify-log"
    );

    appendEvent("after clear");
    expect(readNotifyEvents().events).toHaveLength(1);
  });

  it("refuses a member and leaves the global log intact", async () => {
    seedActor({ role: "member" });
    appendEvent("member must not clear this");
    const before = fs.readFileSync(NOTIFY_LOG_PATH, "utf8");

    await expect(clearNotifyEvents()).rejects.toThrow(
      "requireAdmin refused a non-admin"
    );

    expect(fs.readFileSync(NOTIFY_LOG_PATH, "utf8")).toBe(before);
  });
});
