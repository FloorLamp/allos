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
  clearMoodRating,
  deleteMoodLog,
  updateMoodRating,
} from "@/lib/offline/writes";
import { getMoodLogs, getMoodOnDate } from "@/lib/queries";
import { getMoodReadings } from "@/lib/queries/mood";
import { moodSeriesPoints } from "@/lib/mood";
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
        factors: ["social", "work"],
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
      // Normalized to vocabulary order (#1311 shrank the set to work, social).
      factors: ["work", "social"],
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

// ---- The three charted ratings (#1408) --------------------------------------
//
// Energy and Calm became charted metrics with detail pages of their own, so the
// store's read layer answers per COLUMN and the write core corrects and clears per
// column. These pin the store half; the display relabel and the Server Actions over
// it are pinned in lib/__action_tests__/metric-readings.actions.test.ts.

describe("the check-in's three ratings as series (#1408)", () => {
  it("reads each rating off the SAME rows, listing only the days that carry it", () => {
    const p = newProfile("mood-series");
    upsertMoodLog(p, "2026-07-10", { valence: 4, energy: 2, anxiety: 5 });
    // A one-tap day: valence only, the normal case for the two expand-only scales.
    upsertMoodLog(p, "2026-07-11", { valence: 3 });
    upsertMoodLog(p, "2026-07-12", { valence: 5, energy: 5, anxiety: 1 });

    const logs = getMoodLogs(p);
    expect(moodSeriesPoints(logs, "valence")).toHaveLength(3);
    expect(moodSeriesPoints(logs, "energy")).toEqual([
      { date: "2026-07-10", value: 2 },
      { date: "2026-07-12", value: 5 },
    ]);
    // Calm arrives on the card's relabelled axis (stored 5 → plotted 1).
    expect(moodSeriesPoints(logs, "calm")).toEqual([
      { date: "2026-07-10", value: 1 },
      { date: "2026-07-12", value: 5 },
    ]);

    // The readings table reads the same way, newest first, in STORED semantics.
    expect(getMoodReadings(p, 50, "energy").map((r) => r.date)).toEqual([
      "2026-07-12",
      "2026-07-10",
    ]);
    expect(getMoodReadings(p, 50, "anxiety")[0].value).toBe(1);
    expect(getMoodReadings(p, 50).map((r) => r.value)).toEqual([5, 3, 4]);
  });

  it("corrects ONE rating without disturbing the rest of the check-in", () => {
    const p = newProfile("mood-correct");
    upsertMoodLog(p, "2026-07-10", {
      valence: 4,
      energy: 2,
      anxiety: 5,
      note: "long day",
    });
    const [row] = getMoodReadings(p, 50);

    expect(updateMoodRating(p, row.id, "energy", 4)).toBe(true);
    expect(getMoodOnDate(p, "2026-07-10")).toMatchObject({
      valence: 4,
      energy: 4,
      anxiety: 5,
      notes: "long day",
    });
    // The same 1–5 guard the check-in enforces on insert — a correction may not
    // smuggle in a value the card could never have produced.
    expect(updateMoodRating(p, row.id, "anxiety", 9)).toBe(false);
    expect(updateMoodRating(p, row.id, "anxiety", 2.5)).toBe(false);
    expect(getMoodOnDate(p, "2026-07-10")?.anxiety).toBe(5);
  });

  it("clearing an optional rating keeps the day; clearing valence is a whole-row delete", () => {
    const p = newProfile("mood-clear");
    upsertMoodLog(p, "2026-07-10", {
      valence: 4,
      energy: 2,
      anxiety: 5,
      note: "long day",
    });
    const [row] = getMoodReadings(p, 50);

    // A mis-tapped energy must not take that day's mood, note and Calm with it.
    expect(clearMoodRating(p, row.id, "energy")).toBe(true);
    expect(getMoodOnDate(p, "2026-07-10")).toMatchObject({
      valence: 4,
      energy: null,
      anxiety: 5,
      notes: "long day",
    });
    // Already cleared → nothing to change.
    expect(clearMoodRating(p, row.id, "energy")).toBe(false);
    // Valence IS the check-in, so removing it removes the day (unchanged, #1488).
    expect(deleteMoodLog(p, row.id)).toBe(true);
    expect(getMoodLogs(p)).toEqual([]);
  });

  it("scopes every per-rating write by profile", () => {
    const a = newProfile("mood-rating-a");
    const b = newProfile("mood-rating-b");
    upsertMoodLog(a, "2026-07-10", { valence: 4, energy: 2, anxiety: 5 });
    const [foreign] = getMoodReadings(a, 50);

    expect(updateMoodRating(b, foreign.id, "energy", 5)).toBe(false);
    expect(clearMoodRating(b, foreign.id, "anxiety")).toBe(false);
    expect(getMoodReadings(b, 50, "energy")).toEqual([]);
    expect(getMoodOnDate(a, "2026-07-10")).toMatchObject({
      energy: 2,
      anxiety: 5,
    });
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
    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(alreadyReplayed(p, intent.key)).toBe(true);
    // The triple-fire race: the same key replayed again is a no-op.
    expect(applyIntent(p, intent)).toEqual({ status: "duplicate" });
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
    expect(applyIntent(p, intent)).toEqual({ status: "rejected" });
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
