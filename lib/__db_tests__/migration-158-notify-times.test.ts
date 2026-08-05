// DB INTEGRATION TIER — migration 158 (#2121): the six notification slot-time
// settings convert from integer hours to minute-of-day "HH:MM" values.
//
// The constraint under test is the issue's own: "a stored integer hour must keep
// meaning HH:00 through the migration; no user's existing reminder time may
// move." Three properties pin it:
//   1. CONVERT — every integer 0–23 across all six keys becomes "HH:00", and the
//      resolved schedule (getNotifySchedule) is identical before and after.
//   2. SENTINELS SURVIVE — "auto" and "" (and absence) are byte-identical after
//      the migration; wake-following and off slots must not be frozen or moved.
//   3. REPLAY IS A NO-OP — the converted "HH:MM" format never matches the
//      integer guard again, so running up() twice equals running it once. A
//      corrupt value is left alone (the reader falls back, as it always did).
//
// The migration is driven directly (up() on the already-migrated test DB): its
// only effect is a data UPDATE over profile_settings, so the direct call is the
// same statement the runner would execute inside its transaction. Synthetic
// data only; no PHI.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { up } from "@/lib/migrations/versions/158-notify-times-minute-grain";
import { getNotifySchedule, setProfileSetting } from "@/lib/settings";

let p: number;

function stored(key: string): string | undefined {
  const row = db
    .prepare(
      "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
    )
    .get(p, key) as { value: string } | undefined;
  return row?.value;
}

function allSix(): Record<string, string | undefined> {
  return {
    morning: stored("notify_supp_morning_hour"),
    midday: stored("notify_supp_midday_hour"),
    evening: stored("notify_supp_evening_hour"),
    bedtime: stored("notify_supp_bedtime_hour"),
    digest: stored("notify_digest_hour"),
    recap: stored("notify_recap_hour"),
  };
}

beforeAll(() => {
  p = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Mig158')").run()
      .lastInsertRowid
  );
});

describe("migration 158 — hour values become HH:MM; sentinels survive; replay no-ops", () => {
  it("converts every stored integer hour to HH:00 without moving any time", () => {
    // The pre-migration state: five manual integer hours, a wake-following
    // morning, and an untouched (absent) bedtime.
    setProfileSetting(p, "notify_supp_morning_hour", "auto");
    setProfileSetting(p, "notify_supp_midday_hour", "13");
    setProfileSetting(p, "notify_supp_evening_hour", "0"); // midnight edge
    // bedtime left ABSENT — no row, nothing to convert
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'notify_supp_bedtime_hour'"
    ).run(p);
    setProfileSetting(p, "notify_digest_hour", ""); // explicitly off
    setProfileSetting(p, "notify_recap_hour", "23"); // range edge

    // What the schedule resolves to BEFORE (the legacy-integer read path).
    const before = getNotifySchedule(p);

    up(db);

    expect(allSix()).toEqual({
      morning: "auto", // sentinel byte-identical
      midday: "13:00",
      evening: "00:00",
      bedtime: undefined, // still absent
      digest: "", // off byte-identical
      recap: "23:00",
    });

    // No user's reminder time moved: the resolved schedule is identical.
    expect(getNotifySchedule(p)).toEqual(before);
  });

  it("replays as a byte-for-byte no-op, and leaves corrupt values alone", () => {
    // A corrupt value the reader has always fallback-ed on: out of range. The
    // migration must not invent a time for it.
    setProfileSetting(p, "notify_recap_hour", "99");

    const first = allSix();
    up(db);
    expect(allSix()).toEqual(first); // converted values never re-match

    up(db); // and a second replay too
    expect(allSix()).toEqual(first);
    expect(stored("notify_recap_hour")).toBe("99"); // corrupt → untouched
  });

  it("does NOT touch the hour-typed settings that stay hourly (waking window)", () => {
    // #2121 constraint: notify_waking_start/_end keep their 0-23 meaning and
    // their stored bytes — only the slot-time keys convert.
    setProfileSetting(p, "notify_waking_start", "8");
    setProfileSetting(p, "notify_waking_end", "21");
    up(db);
    expect(stored("notify_waking_start")).toBe("8");
    expect(stored("notify_waking_end")).toBe("21");
  });
});
