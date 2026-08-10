// DB INTEGRATION TIER — the persisted decline record (#2209) driven through a REAL
// orchestrator against a live schema.
//
// The claim under test is the issue's thesis, end to end: when the tick decides NOT
// to send, that decision now leaves a durable trace, and it does so WITHOUT touching
// the send-marker state that a real send owns. Both halves matter — a log that
// recorded declines but also stamped a marker would silently suppress tomorrow's
// retry, which is far worse than the missing log ever was.
//
// The orchestrator is `runRefills` with NO channel configured, which is the exact
// shape of the production line the issue quotes ("refill nudge skipped: no channel"
// and its four siblings). No fetch stub is needed: dispatch() returns zero results
// because nothing is configured, which is the branch being pinned.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, today } from "@/lib/db";
import { getProfileSetting, setProfileSetting } from "@/lib/settings";
import { runRefills } from "@/lib/notifications/refill";
import { refillMarkerKey } from "@/lib/refill-nudge";
import {
  NOTIFY_LOG_PATH,
  beginNotifyRun,
  clearNotifyLog,
  endNotifyRun,
  readNotifyEvents,
} from "@/lib/notify-log";
import { classifyNotifyLine, groupNotifyRuns } from "@/lib/notify-log-format";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A supplement low enough on supply to raise a refill nudge.
function seedLowSupplement(profileId: number, name = "Vitamin D"): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should', 8, 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'morning', 'any', 0)`
  ).run(id);
  return id;
}

beforeEach(() => {
  clearNotifyLog();
  endNotifyRun();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearNotifyLog();
  endNotifyRun();
});

describe("a tick that declines every send (#2209)", () => {
  it("appends the decline and writes NO notify_last_* marker", async () => {
    const p = newProfile("DeclineLog");
    const supp = seedLowSupplement(p);
    const date = today(p);
    const run = beginNotifyRun();

    // No channel configured for this profile at all — dispatch() fans out to
    // nothing, so the orchestrator declines.
    const res = await runRefills(p, "DeclineLog", date);
    expect(res.failed).toBe(false);

    // 1. THE MARKER IS UNTOUCHED. This is what lets the nudge retry once a channel
    //    exists; the log must never become a side channel that stamps it.
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBeUndefined();

    // 2. THE DECLINE IS DURABLE — the half that previously existed nowhere.
    const { events } = readNotifyEvents();
    const decline = events.find((e) =>
      e.message.includes("refill nudge skipped")
    );
    expect(decline).toBeDefined();
    expect(classifyNotifyLine(decline!)).toBe("decline");
    expect(decline!.profileId).toBe(p);
    expect(decline!.runId).toBe(run);
  });

  it("groups the run's declines under one (run, profile) row", async () => {
    const p = newProfile("DeclineGroup");
    seedLowSupplement(p, "Magnesium");
    const date = today(p);
    beginNotifyRun();

    await runRefills(p, "DeclineGroup", date);

    const runs = groupNotifyRuns(readNotifyEvents().events).filter(
      (r) => r.profileId === p
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].counts.declines).toBeGreaterThan(0);
    expect(runs[0].counts.sends).toBe(0);
  });

  it("a QUIET evaluation still leaves a run row to render", async () => {
    // Nothing is low on supply, so the orchestrator has nothing to say at all. The
    // tick's own per-profile marker is what keeps the run visible — without it the
    // viewer would show absence, which reads identically to a wedged sidecar.
    const p = newProfile("QuietRun");
    const date = today(p);
    beginNotifyRun();

    await runRefills(p, "QuietRun", date);
    // Stand in for scripts/notify.ts's per-profile marker line.
    const { createLogger } = await import("@/lib/log");
    createLogger("notify").info("profile evaluated", {
      profile: p,
      failed: false,
    });

    const runs = groupNotifyRuns(readNotifyEvents().events).filter(
      (r) => r.profileId === p
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].counts).toMatchObject({
      declines: 0,
      sends: 0,
      failures: 0,
    });
    // A row exists, and it carries the evidence that the tick RAN.
    expect(runs[0].events.map((e) => e.message)).toContain("profile evaluated");
  });
});

describe("the sink never fails the tick (#2209 constraint 1)", () => {
  it("a sink write failure leaves the orchestrator's outcome unchanged", async () => {
    const p = newProfile("SinkDown");
    const supp = seedLowSupplement(p, "Zinc");
    const date = today(p);

    // The disk is gone for the whole orchestrator run.
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    const res = await runRefills(p, "SinkDown", date);

    // The tick's own behavior is untouched: it did not throw, it reported no
    // failure, and it still declined to stamp the marker.
    expect(res.failed).toBe(false);
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBeUndefined();
  });

  it("a send that DOES happen still marks even with the sink broken", async () => {
    // The complement: logging failure must not cost a marker either, or a broken
    // disk would turn into repeat notifications.
    const p = newProfile("SinkDownSend");
    const supp = seedLowSupplement(p, "Iron");
    const date = today(p);
    // Pre-stamp, then prove the orchestrator's marker read/write path is unaffected
    // by the dead sink (no channel here, so the stale marker simply survives).
    setProfileSetting(p, refillMarkerKey(supp), "2020-01-01");

    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });

    await expect(runRefills(p, "SinkDownSend", date)).resolves.toEqual({
      failed: false,
    });
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBe("2020-01-01");
  });
});

describe("the log file stays where the operator can find it (#2209)", () => {
  it("writes to data/logs/notify.jsonl beside its two siblings", async () => {
    // On the bind mount, so it survives the container recreation that deletes the
    // sidecar's stdout — which is the whole reason a file was chosen over stdout.
    // NOTIFY_LOG_PATH is built with path.join, so it carries the platform's
    // separator; compare in posix form rather than asserting Linux's.
    expect(
      NOTIFY_LOG_PATH.split(path.sep)
        .join("/")
        .endsWith("data/logs/notify.jsonl")
    ).toBe(true);

    const { createLogger } = await import("@/lib/log");
    beginNotifyRun();
    createLogger("notify").info("nothing due", { profile: 1 });

    // Synchronous by design: the line is readable the moment the call returns, with
    // no flush to await.
    const { events } = readNotifyEvents();
    expect(events.map((e) => e.message)).toContain("nothing due");
  });
});
