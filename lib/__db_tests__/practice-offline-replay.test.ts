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

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { applyIntent } from "@/lib/offline/writes";
import { buildIntent } from "@/lib/offline/queue";
import { logPracticeSession } from "@/lib/practice-log";
import { getPracticeDayCount } from "@/lib/queries/wellness";
import { practiceIdentity } from "@/lib/practice";

const PRACTICE = "Sauna";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function practiceIntent(profileId: number, date: string) {
  return buildIntent(
    "practice",
    date,
    {
      practice: PRACTICE,
      identity: practiceIdentity(PRACTICE),
      durationMin: 20,
    },
    profileId
  );
}

describe("applyIntent — practice (#2908)", () => {
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

  it("dead-letters an entry too old to log automatically", () => {
    const p = newProfile("practice-stale");
    const intent = practiceIntent(p, "2000-01-01");
    const outcome = applyIntent(p, intent);
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/too old/);
    expect(getPracticeDayCount(p, PRACTICE, "2000-01-01")).toBe(0);
  });

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
