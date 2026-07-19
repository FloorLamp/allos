// DB INTEGRATION TIER — the mood_logs store (#992): the ONE write core
// (upsertMoodLog) every path shares, its per-day idempotency, the offline-replay
// flow, the check-in reminder's auto-pause counter lifecycle, and the check-in
// builder's gates. Runs against the real schema (migration 073) on a throwaway
// temp DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  upsertMoodLog,
  applyIntent,
  alreadyReplayed,
} from "@/lib/offline/writes";
import { getMoodLogs, getMoodOnDate } from "@/lib/queries";
import {
  getMoodCheckinIgnored,
  bumpMoodCheckinIgnored,
  setProfileMoodCheckin,
} from "@/lib/settings";
import {
  buildMoodCheckin,
  moodCheckinCallbackData,
} from "@/lib/notifications/mood";
import { MOOD_CHECKIN_AUTOPAUSE_DAYS } from "@/lib/mood";
import { buildIntent } from "@/lib/offline/queue";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("upsertMoodLog — the one idempotent per-day write core", () => {
  it("inserts, then a same-day write UPDATES the single row (never duplicates)", () => {
    const p = newProfile("mood-upsert");
    expect(upsertMoodLog(p, "2026-07-10", { valence: 4 })).toBe(true);
    expect(
      upsertMoodLog(p, "2026-07-10", {
        valence: 2,
        energy: 3,
        anxiety: 4,
        factors: ["work", "sleep"],
        note: "long day",
      })
    ).toBe(true);

    const logs = getMoodLogs(p);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      date: "2026-07-10",
      valence: 2,
      energy: 3,
      anxiety: 4,
      factors: ["sleep", "work"],
      notes: "long day",
    });
  });

  it("rejects a bad date or out-of-range scale without writing", () => {
    const p = newProfile("mood-reject");
    expect(upsertMoodLog(p, "2026-02-30", { valence: 3 })).toBe(false);
    expect(upsertMoodLog(p, "2026-07-10", { valence: 7 })).toBe(false);
    expect(upsertMoodLog(p, "2026-07-10", { valence: 3, energy: 0 })).toBe(
      false
    );
    expect(getMoodLogs(p)).toEqual([]);
  });

  it("scopes reads by profile", () => {
    const a = newProfile("mood-a");
    const b = newProfile("mood-b");
    upsertMoodLog(a, "2026-07-10", { valence: 5 });
    expect(getMoodOnDate(b, "2026-07-10")).toBeNull();
    expect(getMoodOnDate(a, "2026-07-10")?.valence).toBe(5);
  });
});

describe("offline replay — the mood flow (#28/#992)", () => {
  it("applies a queued mood intent exactly once (duplicate key → no-op)", () => {
    const p = newProfile("mood-replay");
    const intent = buildIntent(
      "mood",
      "2026-07-11",
      { valence: 4, energy: null, anxiety: null, factors: [], note: null },
      p
    );
    expect(applyIntent(p, intent)).toBe("done");
    expect(alreadyReplayed(p, intent.key)).toBe(true);
    // The triple-fire race: the same key replayed again is a no-op.
    expect(applyIntent(p, intent)).toBe("duplicate");
    expect(getMoodLogs(p)).toHaveLength(1);
  });

  it("rejects a permanently-invalid mood payload (no key recorded)", () => {
    const p = newProfile("mood-replay-bad");
    const intent = buildIntent(
      "mood",
      "2026-07-11",
      { valence: 9, energy: null, anxiety: null, factors: [], note: null },
      p
    );
    expect(applyIntent(p, intent)).toBe("rejected");
    expect(alreadyReplayed(p, intent.key)).toBe(false);
    expect(getMoodLogs(p)).toEqual([]);
  });
});

describe("check-in reminder — auto-pause lifecycle (#992)", () => {
  it("builds only when opted in, pauses after N ignored sends, re-arms on submission", () => {
    const p = newProfile("mood-checkin");
    const date = today(p);

    // Off by default: no check-in.
    expect(buildMoodCheckin(p, date)).toBeNull();

    setProfileMoodCheckin(p, true);
    const msg = buildMoodCheckin(p, date);
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe("mood");
    // Five one-tap face buttons carrying the parseable token.
    expect(msg!.actions).toHaveLength(5);
    expect(msg!.actions![2].data).toBe(moodCheckinCallbackData(p, 3, date));

    // N delivered-but-unanswered sends → auto-pause (the tick bumps on delivery).
    for (let i = 0; i < MOOD_CHECKIN_AUTOPAUSE_DAYS; i++) {
      bumpMoodCheckinIgnored(p);
    }
    expect(getMoodCheckinIgnored(p)).toBe(MOOD_CHECKIN_AUTOPAUSE_DAYS);
    expect(buildMoodCheckin(p, date)).toBeNull();

    // A submitted check-in (ANY write path) resets the counter → re-armed for a
    // day that has no log yet.
    upsertMoodLog(p, "2020-01-01", { valence: 3 });
    expect(getMoodCheckinIgnored(p)).toBe(0);
    expect(buildMoodCheckin(p, date)).not.toBeNull();
  });

  it("never asks about a day that's already logged", () => {
    const p = newProfile("mood-checkin-logged");
    setProfileMoodCheckin(p, true);
    const date = today(p);
    upsertMoodLog(p, date, { valence: 4 });
    expect(buildMoodCheckin(p, date)).toBeNull();
  });
});
