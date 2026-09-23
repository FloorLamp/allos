// DB INTEGRATION TIER (issue #1632): the Trends digest's practice cadence series, end
// to end against the real schema. A moved cadence surfaces as a neutral series; an
// UNTRACKED practice has no range, so it is not in the digest at all.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import { logPracticeSession } from "@/lib/queries";
import { practiceIdentity } from "@/lib/practice";
import { buildPracticeDigestSeries } from "@/lib/trends-series";
import { summarizeTrends } from "@/lib/trends-digest";
import { practiceDigestKey } from "@/lib/trends-practices";

// A Wednesday, so rolling mode's week window is simply the trailing seven days and
// every offset below reads as "N days ago".
const NOW = new Date("2026-06-17T12:00:00Z");

const PRACTICE = "Sauna";
const CEILING = 4;
const FLOOR = 2;

function makeProfile(name: string): number {
  const pid = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Rolling mode makes each completed week an exact 7-day block counted back from
  // today, so the fixture's offsets map to weeks without touching week_start.
  setWeekMode(pid, "rolling");
  return pid;
}

function dayBack(pid: number, back: number): string {
  return shiftDateStr(today(pid), -back);
}

// `created_at` is set explicitly: the column defaults to SQLite's own clock, which
// the fake JS clock does not move, so a defaulted row reads as younger than the
// window and would fail the existed-whole-window check.
function makeTarget(
  profileId: number,
  value: string,
  floor: number,
  ceiling: number | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week,
            per_week_max, created_at)
         VALUES (?, 'practice', ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        value,
        practiceIdentity(value),
        floor,
        ceiling,
        `${dayBack(profileId, 200)} 08:00:00`
      ).lastInsertRowid
  );
}

function logAt(
  profileId: number,
  spelling: string,
  back: number,
  durationMin?: number
): void {
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, duration_min)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, spelling, dayBack(profileId, back), durationMin ?? null);
}

// The fixture ledger, four completed weeks deep (oldest first):
//   week 0 (28–34 days back): nothing            → under floor
//   week 1 (21–27):           three logged days  → floor met (spellings folded)
//   week 2 (14–20):           four logged days   → AT CEILING
//   week 3 (7–13):            three logged days  → floor met (one day logged twice)
// plus two sessions in the CURRENT week, which the ledger must not see.
function seedLedger(profileId: number): void {
  makeTarget(profileId, PRACTICE, FLOOR, CEILING);
  for (const back of [21, 23]) logAt(profileId, PRACTICE, back);
  // A different stored spelling of the same identity — it must count.
  logAt(profileId, " sauna ", 25);
  for (const back of [14, 16, 18, 20]) logAt(profileId, PRACTICE, back);
  logAt(profileId, PRACTICE, 7, 15);
  // One DAY logged twice: day-distinct counting means this is still one day, and
  // the duration for that day is the mean of the two sessions.
  logAt(profileId, PRACTICE, 9, 20);
  logAt(profileId, PRACTICE, 9, 30);
  logAt(profileId, PRACTICE, 11);
  // The in-progress week.
  logAt(profileId, PRACTICE, 2, 40);
  logAt(profileId, PRACTICE, 1);
}

describe("the Trends practice digest (#1632)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers a moved cadence to the digest as a NEUTRAL series", () => {
    const pid = makeProfile("lens-digest");
    seedLedger(pid);

    // Four weeks of window — the same four the ledger above walks.
    const range = { from: dayBack(pid, 27), to: today(pid) };
    const [series] = buildPracticeDigestSeries(pid, range, today(pid));
    expect(series.key).toBe(practiceDigestKey(practiceIdentity(PRACTICE)));
    expect(series.label).toBe(`${PRACTICE} cadence`);
    // No reference range: a coaching-tier chip must never take a crossing colour.
    expect(series.range).toBeUndefined();
    expect(series.points.map((p) => p.value)).toEqual([0, 3, 4, 3]);

    // The fixture's cadence really moved (0 → 3 days a week), so it surfaces.
    const [item] = summarizeTrends([series], { limit: 5 });
    expect(item.key).toBe(series.key);
    expect(item.direction).toBe("up");
    expect(item.rangeShift).toBeNull();
  });

  it("keeps an untracked practice out of the digest too", () => {
    const pid = makeProfile("lens-digest-untracked");
    for (const back of [8, 15, 22, 29]) {
      logPracticeSession(pid, "Breathwork", dayBack(pid, back), "page");
    }
    expect(
      buildPracticeDigestSeries(
        pid,
        { from: dayBack(pid, 34), to: today(pid) },
        today(pid)
      )
    ).toEqual([]);
  });
});
