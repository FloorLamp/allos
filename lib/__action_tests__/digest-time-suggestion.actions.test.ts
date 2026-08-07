// SERVER-ACTION TIER — the digest time suggestion's three exits (#2217).
//
// One tap, one explicit write (constraint 1). Each action re-resolves the live
// suggestion server-side before it writes anything, so what these prove is not only
// "the write happened" but "the write is the one the detector currently proposes, and
// nothing else moved".

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  applyDigestTimeSuggestion,
  switchDigestToDynamic,
  dismissDigestTimeSuggestion,
} from "@/app/(app)/settings/profile/actions";
import { db } from "@/lib/db";
import { utcInstant, zonedWallTimeToUtc } from "@/lib/date";
import {
  getNotifySchedule,
  getProfileSetting,
  setProfileSetting,
  setSetting,
  setTimezone,
} from "@/lib/settings";
import { DIGEST_MODE_KEY } from "@/lib/settings/notifications";
import { getDigestTimeSuggestion } from "@/lib/queries/digest-time-suggestion";
import { createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

const PROVIDER = "health-connect";
const TZ = "UTC";
const FLOOR = 7 * 60;

const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// #2217's measured 13 nights (arrival clock time, lag behind the session's end).
const MEASURED: { date: string; arrival: number; lag: number }[] = [
  { date: "2026-07-24", arrival: 6 * 60 + 2, lag: 30 },
  { date: "2026-07-25", arrival: 6 * 60 + 6, lag: 35 },
  { date: "2026-07-26", arrival: 6 * 60 + 14, lag: 40 },
  { date: "2026-07-27", arrival: 6 * 60 + 26, lag: 45 },
  { date: "2026-07-28", arrival: 6 * 60 + 47, lag: 64 },
  { date: "2026-07-29", arrival: 6 * 60 + 50, lag: 55 },
  { date: "2026-07-30", arrival: 7 * 60 + 4, lag: 86 },
  { date: "2026-07-31", arrival: 7 * 60 + 11, lag: 86 },
  { date: "2026-08-01", arrival: 7 * 60 + 26, lag: 105 },
  { date: "2026-08-02", arrival: 7 * 60 + 26, lag: 80 },
  { date: "2026-08-03", arrival: 7 * 60 + 30, lag: 70 },
  { date: "2026-08-04", arrival: 7 * 60 + 42, lag: 65 },
  { date: "2026-08-05", arrival: 7 * 60 + 48, lag: 50 },
];

function night(
  profileId: number,
  date: string,
  arrivalMinute: number,
  lagMin: number
): void {
  const arrivedAt = zonedWallTimeToUtc(TZ, date, clock(arrivalMinute));
  const end = new Date(arrivedAt.getTime() - lagMin * 60_000);
  const start = new Date(end.getTime() - 420 * 60_000);
  const sampleId = Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
      )
      .run(profileId, PROVIDER, date, utcInstant(start), utcInstant(end))
      .lastInsertRowid
  );
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(profileId, PROVIDER, utcInstant(arrivedAt)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, sampleId, utcInstant(arrivedAt));
}

/** A login acting on a profile whose 07:00 Static digest is losing 7 mornings in 13. */
function seedActing(name: string): number {
  setSetting("notify_tick_interval_min", "5");
  const login = createLogin();
  const profile = createProfile(name, login.id);
  actAs(login, profile);
  setTimezone(profile.id, TZ);
  for (const n of MEASURED) night(profile.id, n.date, n.arrival, n.lag);
  setProfileSetting(profile.id, "notify_digest_hour", clock(FLOOR));
  setProfileSetting(profile.id, DIGEST_MODE_KEY, "static");
  return profile.id;
}

describe("applyDigestTimeSuggestion — one tap, one write", () => {
  it("writes exactly the proposed time and leaves the schedule otherwise intact", async () => {
    const p = seedActing("accept");
    const before = getNotifySchedule(p);

    const result = await applyDigestTimeSuggestion();

    expect(result).toEqual({ ok: true, minute: 7 * 60 + 40 });
    expect(getProfileSetting(p, "notify_digest_hour")).toBe("07:40");
    // The MODE is untouched — an accept is not a mode change.
    expect(getProfileSetting(p, DIGEST_MODE_KEY)).toBe("static");
    const after = getNotifySchedule(p);
    expect({ ...after, digestMinute: before.digestMinute }).toEqual(before);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
    // Accepting is not a dismissal: no suppression row is minted.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = ?"
        )
        .get(p)
    ).toEqual({ n: 0 });
    // And the suggestion stops firing on its own — the configured time now wins.
    expect(getDigestTimeSuggestion(p)).toBeNull();
  });

  it("REFUSES and writes nothing when the suggestion is no longer firing", async () => {
    const p = seedActing("stale");
    // Someone (another tab, the user, the other exit) already moved the time.
    setProfileSetting(p, "notify_digest_hour", "08:00");

    expect(await applyDigestTimeSuggestion()).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(getProfileSetting(p, "notify_digest_hour")).toBe("08:00");
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe("switchDigestToDynamic — the other exit", () => {
  it("writes the MODE and nothing else; the stored minute becomes the floor", async () => {
    const p = seedActing("dynamic");

    expect(await switchDigestToDynamic()).toEqual({ ok: true, minute: FLOOR });

    expect(getProfileSetting(p, DIGEST_MODE_KEY)).toBe("dynamic");
    expect(getProfileSetting(p, "notify_digest_hour")).toBe("07:00");
    const after = getNotifySchedule(p);
    expect(after.digestMode).toBe("dynamic");
    expect(after.digestMinute).toBe(FLOOR);
    // Silent in Dynamic: a floor that "loses" is doing its job.
    expect(getDigestTimeSuggestion(p)).toBeNull();
  });
});

describe("dismissDigestTimeSuggestion — declining is first class", () => {
  it("writes one suppression row and never touches the schedule", async () => {
    const p = seedActing("dismiss");
    const key = getDigestTimeSuggestion(p)!.dedupeKey;

    expect(await dismissDigestTimeSuggestion()).toEqual({
      ok: true,
      minute: FLOOR,
    });

    expect(
      db
        .prepare(
          "SELECT signal_key, dismissed_at IS NOT NULL AS dismissed FROM upcoming_dismissals WHERE profile_id = ?"
        )
        .all(p)
    ).toEqual([{ signal_key: key, dismissed: 1 }]);
    expect(getProfileSetting(p, "notify_digest_hour")).toBe("07:00");
    expect(getProfileSetting(p, DIGEST_MODE_KEY)).toBe("static");
    expect(getDigestTimeSuggestion(p)).toBeNull();
  });

  it("re-arms when the user later changes the configured time themselves", async () => {
    const p = seedActing("rearm");
    await dismissDigestTimeSuggestion();
    expect(getDigestTimeSuggestion(p)).toBeNull();

    // 06:30 is a NEW decision about this exact setting, so the question is fair again
    // — and it is still losing (the median is 07:04).
    setProfileSetting(p, "notify_digest_hour", "06:30");
    expect(getDigestTimeSuggestion(p)?.proposedMinute).toBe(7 * 60 + 40);
  });
});
