// SERVER-ACTION TIER — the daily wellbeing check-in write path (issue #992).
//
// Proves the real logMood action runs through the (mocked) auth guard and
// enforces: the per-day idempotent upsert (a re-tap updates today's single row),
// the expand fields (energy/anxiety/factors/note), input rejection, per-profile
// scoping, the date fallback to the profile's today, and the reminder re-arm
// (a submission resets the ignored counter).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { logMood } from "@/app/(app)/mood/actions";
import { getMoodLogs, getMoodOnDate } from "@/lib/queries";
import { getMoodCheckinIgnored, bumpMoodCheckinIgnored } from "@/lib/settings";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-07-10";

beforeEach(() => {
  revalidate.mockClear();
});

describe("logMood — one-tap + expanded save", () => {
  it("logs a bare valence tap and revalidates the surfaces", async () => {
    const login = createLogin();
    const profile = createProfile("mood-tap", login.id);
    actAs(login, profile);

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

    await logMood(fd({ date: DATE, valence: 5 }));
    const form = fd({
      date: DATE,
      valence: 2,
      energy: 3,
      anxiety: 4,
      note: "rough one",
    });
    form.append("factors", "work");
    form.append("factors", "sleep");
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
      factors: ["sleep", "work"],
      notes: "rough one",
    });
  });

  it("rejects an out-of-range valence with a friendly error", async () => {
    const login = createLogin();
    const profile = createProfile("mood-bad", login.id);
    actAs(login, profile);

    const res = await logMood(fd({ date: DATE, valence: 9 }));
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
    await logMood(fd({ date: DATE, valence: 3 }));
    expect(getMoodCheckinIgnored(profile.id)).toBe(0);
  });
});
