// SERVER-ACTION TIER — atomic Sleep and Mood Log edits.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { saveSleepMoodEntry } from "@/app/(app)/sleep/actions";
import { getMoodOnDate } from "@/lib/queries";
import { actAs, createLogin, createProfile, fd } from "./harness";

describe("saveSleepMoodEntry", () => {
  it("writes sleep and mood together", async () => {
    const login = createLogin();
    const profile = createProfile("sleep-mood-atomic", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    const result = await saveSleepMoodEntry(
      fd({ date, sleep_hours: "7.5", valence: "4", energy: "3" })
    );

    expect(result).toEqual({ ok: true });
    expect(
      db
        .prepare(
          "SELECT value FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?"
        )
        .get(profile.id, date)
    ).toEqual({ value: 450 });
    expect(getMoodOnDate(profile.id, date)).toMatchObject({
      valence: 4,
      energy: 3,
    });
  });

  it("validates both payloads before writing either one", async () => {
    const login = createLogin();
    const profile = createProfile("sleep-mood-reject", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    const result = await saveSleepMoodEntry(
      fd({ date, sleep_hours: "8", valence: "9" })
    );

    expect(result.ok).toBe(false);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min'"
        )
        .get(profile.id)
    ).toEqual({ count: 0 });
    expect(getMoodOnDate(profile.id, date)).toBeNull();
  });

  it("atomically rejects sleep edits when a synced window now owns the date", async () => {
    const login = createLogin();
    const profile = createProfile("sleep-mood-synced", login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const priorDate = shiftDateStr(date, -1);
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'oura', 'sleep_min', ?, ?, ?, 420)`
    ).run(profile.id, date, `${priorDate}T23:00:00Z`, `${date}T06:00:00Z`);

    const result = await saveSleepMoodEntry(
      fd({ date, sleep_hours: "8", valence: "4" })
    );

    expect(result).toEqual({
      ok: false,
      error: "Synced sleep entries cannot be edited here.",
    });
    expect(
      db
        .prepare(
          "SELECT source, value FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?"
        )
        .all(profile.id, date)
    ).toEqual([{ source: "oura", value: 420 }]);
    expect(getMoodOnDate(profile.id, date)).toBeNull();
  });
});
