// DB INTEGRATION TIER — the one read domain dormancy needs that no card already
// makes (#2652, lib/queries/domain-dormancy.ts).
//
// The point of this read is that it asks a DIFFERENT question from the card's.
// `getLastNightSummary` resolves one elected origin, over a row-capped session read and
// a 180-day duration trend, and answers "what was the most recent night". Dormancy asks
// "did anything arrive at all" — source-blind and unbounded — and the two answers
// genuinely part company on a profile with a strict source pin, which is what the
// central test below fixes in place.
//
// Fixtures are this file's own synthetic rows (obviously fictional) — no PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { getLastSleepRecordDate } from "@/lib/queries/domain-dormancy";
import { getLastNightSummary } from "@/lib/queries/sleep";
import { dormancyState } from "@/lib/domain-dormancy";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { setMetricSourcePriorityEntry } from "@/lib/settings/profile-attrs";

let seq = 0;
function mkProfile(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`DORMANCY${++seq}`)
      .lastInsertRowid
  );
}

function seedNight(profileId: number, wakeDay: string, source = "oura"): void {
  const zone = getTimezone(profileId);
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, ?, 'sleep_min', ?, ?, ?, 430)`
  ).run(
    profileId,
    source,
    wakeDay,
    zonedWallTimeToUtc(zone, shiftDateStr(wakeDay, -1), "23:00")!.toISOString(),
    zonedWallTimeToUtc(zone, wakeDay, "06:10")!.toISOString()
  );
}

describe("getLastSleepRecordDate", () => {
  it("a profile that has never recorded a night answers null", () => {
    expect(getLastSleepRecordDate(mkProfile())).toBeNull();
  });

  it("answers the newest wake day", () => {
    const p = mkProfile();
    const on = today(p);
    seedNight(p, shiftDateStr(on, -400));
    seedNight(p, shiftDateStr(on, -365));
    seedNight(p, shiftDateStr(on, -370));
    expect(getLastSleepRecordDate(p)).toBe(shiftDateStr(on, -365));
  });

  it("is SOURCE-BLIND — a replaced wearable is not a dormant domain", () => {
    const p = mkProfile();
    const on = today(p);
    seedNight(p, shiftDateStr(on, -300), "oura");
    seedNight(p, shiftDateStr(on, -5), "health-connect");
    expect(getLastSleepRecordDate(p)).toBe(shiftDateStr(on, -5));
  });

  it("scopes to its own profile", () => {
    const mine = mkProfile();
    const theirs = mkProfile();
    seedNight(theirs, shiftDateStr(today(theirs), -3));
    expect(getLastSleepRecordDate(mine)).toBeNull();
  });

  it("does not inherit the card's SOURCE ELECTION — a strict pin cannot fake dormancy", () => {
    // The divergence this read exists for. The sleep card resolves ONE origin per
    // profile so two devices cannot double-count a night, and a `strict` pin makes
    // that election exclusive. With the pinned device silent for 200 days and a second
    // one still reporting nightly, the card's model is 200 days old — but the DOMAIN
    // is arriving, and calling it dormant would be a claim about the record that the
    // record contradicts. Both halves asserted, because only the pair is the point.
    const p = mkProfile();
    const on = today(p);
    seedNight(p, shiftDateStr(on, -200), "oura");
    seedNight(p, shiftDateStr(on, -1), "health-connect");
    setMetricSourcePriorityEntry(p, "sleep_min", "oura", true);
    expect(getLastNightSummary(p)?.wakeDay).toBe(shiftDateStr(on, -200));
    expect(getLastSleepRecordDate(p)).toBe(shiftDateStr(on, -1));
    expect(
      dormancyState({
        lastRecordDate: getLastSleepRecordDate(p),
        today: on,
        domain: "sleep",
      })
    ).toBe("current");
  });

  it("a domain that really did stop is dormant, however far back it goes", () => {
    const p = mkProfile();
    const on = today(p);
    const night = shiftDateStr(on, -400);
    seedNight(p, night);
    expect(getLastSleepRecordDate(p)).toBe(night);
    expect(
      dormancyState({
        lastRecordDate: getLastSleepRecordDate(p),
        today: on,
        domain: "sleep",
      })
    ).toBe("dormant");
  });

  it("a night inside the interval keeps the domain awake", () => {
    const p = mkProfile();
    const on = today(p);
    seedNight(p, shiftDateStr(on, -10));
    expect(
      dormancyState({
        lastRecordDate: getLastSleepRecordDate(p),
        today: on,
        domain: "sleep",
      })
    ).toBe("current");
  });
});
