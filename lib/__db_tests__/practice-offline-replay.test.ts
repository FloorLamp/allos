// DB INTEGRATION TIER — the "practice" offline-replay flow (#2908, owner decision 3).
//
// `practice-session` was an ARGUED EXCLUSION in the #2130 coverage record: cadenced, not
// idempotent, and the #2007 layer-3 same-day re-log confirm asks a question from the
// server-known session count that an offline capture cannot answer. Decision 3 amends
// that argument rather than discarding it — the queued intent is "practice X happened on
// day D" with set-to semantics, so replay inserts only when that (practice-identity,
// day) holds no session.
//
// The acceptance criterion these pin is the one that would otherwise be prose: replay of
// a (practice, day) that ALREADY holds a session is a no-op, proven by logging from
// "another device" between capture and replay.

import { afterEach, describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { alreadyReplayed, applyIntent } from "@/lib/offline/writes";
import { buildIntent } from "@/lib/__tests__/queued-intent-fixture";
import { logPracticeSession } from "@/lib/practice-log";
import { getPracticeDayCount } from "@/lib/queries/wellness";
import { practiceIdentity } from "@/lib/practice";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { TIER_FROZEN_INSTANT } from "./frozen-clock";

const PRACTICE = "Sauna";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function practiceIntent(profileId: number, date: string) {
  const isPrimaryDay = date === today(profileId);
  return buildIntent(
    "practice",
    date,
    {
      practice: PRACTICE,
      identity: practiceIdentity(PRACTICE),
      durationMin: 20,
      ...(isPrimaryDay ? {} : { endTime: "09:00" }),
    },
    profileId,
    isPrimaryDay
  );
}

describe("applyIntent — practice (#2908)", () => {
  afterEach(() => vi.setSystemTime(TIER_FROZEN_INSTANT));

  it("replays a queued tap into one session, and a second flush of the same key is a duplicate", () => {
    const p = newProfile("practice-replay");
    const date = today(p);
    const intent = practiceIntent(p, date);

    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(1);

    expect(applyIntent(p, intent)).toEqual({ status: "duplicate" });
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(1);
  });

  it("is a NO-OP when another device logged that day between capture and replay", () => {
    const p = newProfile("practice-other-device");
    const date = today(p);
    // Captured offline…
    const intent = practiceIntent(p, date);
    // …and while the phone had no signal, the same day was logged elsewhere.
    expect(logPracticeSession(p, PRACTICE, date, "page").kind).toBe("logged");
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(1);

    // The replay reports DONE — the state the intent wanted is the state that stands,
    // exactly as a dose confirm finding the dose already taken does — and writes
    // nothing. This is the double-log the #2130 exclusion was protecting against.
    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(1);
  });

  it("folds spellings by identity, so a differently-spelled same-day session still blocks the insert", () => {
    const p = newProfile("practice-spelling");
    const date = today(p);
    const intent = practiceIntent(p, date);
    expect(logPracticeSession(p, "sauna", date, "page").kind).toBe("logged");

    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    // One session for the day, under the spelling the other device used.
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(1);
  });

  it("two queued taps of the same day land as one session", () => {
    const p = newProfile("practice-two-taps");
    const date = today(p);
    expect(applyIntent(p, practiceIntent(p, date))).toEqual({ status: "done" });
    expect(applyIntent(p, practiceIntent(p, date))).toEqual({ status: "done" });
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(1);
  });

  it("keeps an old dated capture eligible when its visible end time was stated", () => {
    const p = newProfile("practice-stale");
    const intent = practiceIntent(p, "2000-01-01");
    const outcome = applyIntent(p, intent);
    expect(outcome).toEqual({ status: "done" });
    expect(getPracticeDayCount(p, PRACTICE, "2000-01-01")).toBe(1);
  });

  it("keeps a primary tap's T1 end minute when replay crosses midnight", () => {
    const p = newProfile("practice-primary-instant");
    setTimezone(p, "UTC");
    const tappedAt = new Date("2026-08-29T23:50:00.000Z");
    vi.setSystemTime(tappedAt);
    const date = today(p);
    const intent = buildIntent(
      "practice",
      date,
      {
        practice: PRACTICE,
        identity: practiceIdentity(PRACTICE),
        durationMin: null,
      },
      p,
      true,
      tappedAt
    );

    vi.setSystemTime(new Date("2026-08-30T00:10:00.000Z"));
    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(
      db
        .prepare(
          "SELECT date, end_time FROM practice_logs WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
        )
        .get(p)
    ).toEqual({ date, end_time: "23:50" });
  });

  it("requires and preserves the visible end minute for a nonprimary day", () => {
    const p = newProfile("practice-nonprimary-instant");
    const date = shiftDateStr(today(p), -1);
    const base = {
      practice: PRACTICE,
      identity: practiceIdentity(PRACTICE),
      durationMin: null,
    };

    for (const endTime of [undefined, null, "", "25:00"]) {
      const intent = buildIntent(
        "practice",
        date,
        { ...base, ...(endTime === undefined ? {} : { endTime }) },
        p,
        false
      );
      expect(applyIntent(p, intent)).toEqual({
        status: "rejected",
        reason: "Choose an end time for a practice on a past day.",
      });
      expect(alreadyReplayed(p, intent.key)).toBe(false);
    }
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(0);
    expect(
      applyIntent(
        p,
        buildIntent("practice", date, { ...base, endTime: "09:00" }, p, false)
      )
    ).toEqual({ status: "done" });
    expect(
      db
        .prepare(
          "SELECT date, end_time FROM practice_logs WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
        )
        .get(p)
    ).toEqual({ date, end_time: "09:00" });
  });

  it.each([
    ["a DST-gap minute", "America/New_York", "2026-03-08", "02:30"],
    ["a future minute", "UTC", "2026-08-29", "23:59"],
  ])(
    "rejects %s for a nonprimary practice before recording it",
    (_name, tz, date, endTime) => {
      const p = newProfile(`practice-refused-${_name}`);
      setTimezone(p, tz);
      vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
      const intent = buildIntent(
        "practice",
        date,
        {
          practice: PRACTICE,
          identity: practiceIdentity(PRACTICE),
          durationMin: null,
          endTime,
        },
        p,
        false
      );

      expect(applyIntent(p, intent)).toEqual({
        status: "rejected",
        reason: "Choose an end time for a practice on a past day.",
      });
      expect(alreadyReplayed(p, intent.key)).toBe(false);
      expect(getPracticeDayCount(p, PRACTICE, date)).toBe(0);
    }
  );

  it("rejects a shapeless payload rather than writing", () => {
    const p = newProfile("practice-shapeless");
    const date = today(p);
    const intent = practiceIntent(p, date);
    expect(applyIntent(p, { ...intent, payload: {} as never })).toEqual({
      status: "rejected",
    });
    expect(getPracticeDayCount(p, PRACTICE, date)).toBe(0);
  });
});
