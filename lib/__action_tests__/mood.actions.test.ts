// SERVER-ACTION TIER — the daily wellbeing check-in write path (issue #992).
//
// Proves the real logMood action runs through the (mocked) auth guard and
// enforces: the per-day idempotent upsert (a re-tap updates today's single row),
// the expand fields (energy/anxiety/factors/note), input rejection, per-profile
// scoping, the date fallback to the profile's today, the #2128 backfill window
// (a dated write lands on that date; an out-of-window one is refused), and the
// reminder re-arm (a submission resets the ignored counter).
//
// Dates are relative to the profile's own today because #2128 bounded the
// action to MOOD_LOG_DATE_WINDOW_DAYS — a fixed past date would now be refused.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { logMood } from "@/app/(app)/mood-actions";
import {
  MOOD_DATE_OUT_OF_WINDOW_ERROR,
  MOOD_LOG_DATE_WINDOW_DAYS,
  moodSeriesPoints,
} from "@/lib/mood";
import { getMoodLogs, getMoodOnDate } from "@/lib/queries";
import { getMoodCheckinIgnored, bumpMoodCheckinIgnored } from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
});

describe("logMood — one-tap + expanded save", () => {
  it("logs a bare valence tap and revalidates the surfaces", async () => {
    const login = createLogin();
    const profile = createProfile("mood-tap", login.id);
    actAs(login, profile);

    const DATE = today(profile.id);
    const res = await logMood(fd({ date: DATE, valence: 4 }));
    expect(res).toEqual({ ok: true });
    expect(getMoodOnDate(profile.id, DATE)).toMatchObject({
      valence: 4,
      energy: null,
      factors: [],
    });
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(revalidate).toHaveBeenCalledWith("/trends");
    expect(revalidate).toHaveBeenCalledWith("/sleep");
  });

  it("a same-day re-log UPDATES the one row (idempotent per profile+date)", async () => {
    const login = createLogin();
    const profile = createProfile("mood-relog", login.id);
    actAs(login, profile);

    const DATE = today(profile.id);
    await logMood(fd({ date: DATE, valence: 5 }));
    const form = fd({
      date: DATE,
      valence: 2,
      energy: 3,
      anxiety: 4,
      note: "rough one",
    });
    form.append("factors", "social");
    form.append("factors", "work");
    form.append("factors", "not-a-factor"); // dropped, never an error
    const res = await logMood(form);
    expect(res).toEqual({ ok: true });

    const logs = getMoodLogs(profile.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      date: DATE,
      valence: 2,
      energy: 3,
      anxiety: 4,
      // Normalized to vocabulary order (#1311 shrank the set to work, social).
      factors: ["work", "social"],
      notes: "rough one",
    });
  });

  it("rejects an out-of-range valence with a friendly error", async () => {
    const login = createLogin();
    const profile = createProfile("mood-bad", login.id);
    actAs(login, profile);

    const res = await logMood(fd({ date: today(profile.id), valence: 9 }));
    expect(res.ok).toBe(false);
    expect(getMoodLogs(profile.id)).toEqual([]);
  });

  it("falls back to the profile's today for a malformed date", async () => {
    const login = createLogin();
    const profile = createProfile("mood-date", login.id);
    actAs(login, profile);

    await logMood(fd({ date: "not-a-date", valence: 3 }));
    expect(getMoodOnDate(profile.id, today(profile.id))?.valence).toBe(3);
  });

  it("writes land on the ACTING profile only", async () => {
    const login = createLogin();
    const a = createProfile("mood-scope-a", login.id);
    const b = createProfile("mood-scope-b", login.id);
    actAs(login, a);
    const DATE = today(a.id);
    await logMood(fd({ date: DATE, valence: 1 }));
    expect(getMoodOnDate(a.id, DATE)?.valence).toBe(1);
    expect(getMoodOnDate(b.id, DATE)).toBeNull();
    // And nothing leaked into any other profile's rows.
    const count = db
      .prepare("SELECT COUNT(*) c FROM mood_logs WHERE profile_id = ?")
      .get(b.id) as { c: number };
    expect(count.c).toBe(0);
  });

  it("a submitted check-in re-arms an auto-paused reminder", async () => {
    const login = createLogin();
    const profile = createProfile("mood-rearm", login.id);
    actAs(login, profile);

    for (let i = 0; i < 5; i++) bumpMoodCheckinIgnored(profile.id);
    expect(getMoodCheckinIgnored(profile.id)).toBe(5);
    await logMood(fd({ date: today(profile.id), valence: 3 }));
    expect(getMoodCheckinIgnored(profile.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The #2128 backfill: mood was CORRECT-ONLY — a past rating was editable from
// the readings table while a MISSED day was unrecoverable forever. The action
// already parsed a date; these pin that a dated write now lands on that date
// (and reaches the trend), bounded by the dose-log-window-style window.
// ---------------------------------------------------------------------------

describe("logMood — the #2128 backfill window", () => {
  it("a yesterday write lands on yesterday and feeds the trend", async () => {
    const login = createLogin();
    const profile = createProfile("mood-backfill", login.id);
    actAs(login, profile);

    const on = today(profile.id);
    const yesterday = shiftDateStr(on, -1);
    const res = await logMood(fd({ date: yesterday, valence: 2 }));
    expect(res).toEqual({ ok: true });
    expect(getMoodOnDate(profile.id, yesterday)?.valence).toBe(2);
    expect(getMoodOnDate(profile.id, on)).toBeNull();

    // The trend recomputes from the same rows every mood chart reads: the dated
    // write is a point on the valence series at ITS date.
    expect(moodSeriesPoints(getMoodLogs(profile.id), "valence")).toEqual([
      { date: yesterday, value: 2 },
    ]);
    // ...and the surfaces that render it were revalidated.
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });

  it("accepts the whole declared window, nothing older", async () => {
    const login = createLogin();
    const profile = createProfile("mood-window", login.id);
    actAs(login, profile);

    const on = today(profile.id);
    const oldest = shiftDateStr(on, -MOOD_LOG_DATE_WINDOW_DAYS);
    expect(await logMood(fd({ date: oldest, valence: 3 }))).toEqual({
      ok: true,
    });

    const tooOld = shiftDateStr(on, -(MOOD_LOG_DATE_WINDOW_DAYS + 1));
    const res = await logMood(fd({ date: tooOld, valence: 3 }));
    expect(res).toEqual({ ok: false, error: MOOD_DATE_OUT_OF_WINDOW_ERROR });
    expect(getMoodOnDate(profile.id, tooOld)).toBeNull();
  });

  it("refuses a future date — backfill is past-only", async () => {
    const login = createLogin();
    const profile = createProfile("mood-future", login.id);
    actAs(login, profile);

    const tomorrow = shiftDateStr(today(profile.id), 1);
    const res = await logMood(fd({ date: tomorrow, valence: 4 }));
    expect(res).toEqual({ ok: false, error: MOOD_DATE_OUT_OF_WINDOW_ERROR });
    expect(getMoodLogs(profile.id)).toEqual([]);
  });
});
