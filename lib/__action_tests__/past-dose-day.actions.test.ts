// SERVER-ACTION TIER — recent-past dose logging (issue #3936).
//
// The whole feature turns on ONE relationship: the days the quick-log sheet OFFERS
// must be exactly the days the write cores ACCEPT. Two computations, one constant, and
// the failure mode is silent — an offer one day too wide reads as a working control
// that refuses on tap, and one day too narrow reads as a day that simply "had nothing".
//
// SO EVERY CASE HERE RUNS ON BOTH SIDES OF UTC, from a single frozen instant that puts
// three profiles on three different calendar days at once. A run pinned to UTC proves
// nothing about a profile in Kiritimati, and this repo has paid for that four times
// this week (#3573, #3836, #3901, #3884): "yesterday" is a profile-local day, never
// `Date.now() - 86400000`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { doseLogDays, isDoseDateAccepted } from "@/lib/dose-log-window";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import { resolveDayDoses } from "@/app/(app)/nutrition/intake-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

// 10:30 UTC on the 28th is 00:30 on the 29th in Kiritimati (+14) and 23:30 on the 27th
// in Midway (−11). One instant, three different profile-local todays — which is what
// makes the two zones DISCRIMINATING rather than decorative: 2026-08-26 is inside the
// window for Midway and outside it for Kiritimati.
const NOW_ISO = "2026-08-28T10:30:00Z";
const ZONES = [
  { tz: "Pacific/Kiritimati", localToday: "2026-08-29" },
  { tz: "Pacific/Midway", localToday: "2026-08-27" },
] as const;

let priorNow: string | undefined;
beforeAll(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = NOW_ISO;
});
afterAll(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function seedDose(
  profileId: number,
  name: string,
  opts: { timeOfDay?: string; active?: number; stack?: string | null } = {}
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, stack)
         VALUES (?, ?, 'supplement', ?, 'should', 'daily', ?)`
      )
      .run(profileId, name, opts.active ?? 1, opts.stack ?? null)
      .lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 scoop', ?, 'any', 0)`
      )
      .run(itemId, opts.timeOfDay ?? "morning").lastInsertRowid
  );
}

// A profile in `tz` with a morning stack of two and one bedtime dose, nothing logged.
function seedProfile(label: string, tz: string) {
  const login = createLogin();
  const profile = createProfile(label, login.id);
  actAs(login, profile);
  setTimezone(profile.id, tz);
  return {
    profile,
    doses: {
      creatine: seedDose(profile.id, `Creatine ${label}`, {
        timeOfDay: "morning",
        stack: "Morning stack",
      }),
      collagen: seedDose(profile.id, `Collagen ${label}`, {
        timeOfDay: "morning",
        stack: "Morning stack",
      }),
      melatonin: seedDose(profile.id, `Melatonin ${label}`, {
        timeOfDay: "before sleep",
      }),
    },
  };
}

function logsOn(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT l.dose_id, l.status FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? ORDER BY l.dose_id`
    )
    .all(profileId, date) as { dose_id: number; status: string }[];
}

function resolve(
  date: string,
  status: "taken" | "skipped",
  doseIds: readonly number[]
) {
  return resolveDayDoses(fd({ date, status, dose_ids: doseIds.join(",") }));
}

describe.each(ZONES)("in $tz", ({ tz, localToday }) => {
  it("resolves the profile's OWN today, not the run's UTC day", () => {
    const { profile } = seedProfile(`tz-${tz}`, tz);
    expect(today(profile.id)).toBe(localToday);
    // The instant's UTC day is the 28th; neither zone agrees with it, which is the
    // whole point of running the rest of this file twice.
    expect(localToday).not.toBe(NOW_ISO.slice(0, 10));
  });

  it("offers exactly the days the write cores accept, and no more", async () => {
    seedProfile(`offer-${tz}`, tz);
    const data = await loadQuickEntry("dose");
    expect(data.form).toBe("dose");
    if (data.form !== "dose") return;

    const offered = [data.today, ...data.pastDays.map((d) => d.date)];
    expect(offered).toEqual(doseLogDays(localToday));
    for (const day of offered) {
      expect(isDoseDateAccepted(localToday, day)).toBe(true);
    }
    // One day further back is refused — the assertion an "at most three" inequality
    // could not make, and the one a four-day offer would fail.
    expect(
      isDoseDateAccepted(localToday, shiftDateStr(offered.at(-1)!, -1))
    ).toBe(false);
  });

  it("groups a past day by declared bucket and labels the first one Yesterday", async () => {
    const { doses } = seedProfile(`slots-${tz}`, tz);
    const data = await loadQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    const yesterday = data.pastDays[0]!;
    expect(yesterday.date).toBe(shiftDateStr(localToday, -1));
    expect(yesterday.label).toBe("Yesterday");
    expect(
      yesterday.slots.map((slot) => [
        slot.bucket,
        slot.doses.map((d) => d.doseId),
      ])
    ).toEqual([
      ["Morning", [doses.creatine, doses.collagen]],
      ["Before sleep", [doses.melatonin]],
    ]);
    // The stack label the bulk row's promise compresses to (#3098) travels with the
    // dose rather than being re-read from the item by the client.
    expect(yesterday.slots[0]!.doses.map((d) => d.stack)).toEqual([
      "Morning stack",
      "Morning stack",
    ]);
  });

  it("writes the whole bucket on the selected past day, and nothing on today", async () => {
    const { profile, doses } = seedProfile(`stack-${tz}`, tz);
    const day = shiftDateStr(localToday, -1);
    const result = await resolve(day, "taken", [
      doses.creatine,
      doses.collagen,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doses.map((d) => d.outcome)).toEqual(["logged", "logged"]);
    expect(logsOn(profile.id, day)).toEqual([
      { dose_id: doses.creatine, status: "taken" },
      { dose_id: doses.collagen, status: "taken" },
    ]);
    // The day the tap happened on stays untouched: a backdated write is about the day
    // it names and no other.
    expect(logsOn(profile.id, localToday)).toEqual([]);
  });

  it("skips a single past dose through the same core", async () => {
    const { profile, doses } = seedProfile(`skip-${tz}`, tz);
    const day = shiftDateStr(localToday, -2);
    const result = await resolve(day, "skipped", [doses.melatonin]);
    expect(result.ok).toBe(true);
    expect(logsOn(profile.id, day)).toEqual([
      { dose_id: doses.melatonin, status: "skipped" },
    ]);
  });

  it("refuses a day past the window through the cores' own gate, writing nothing", async () => {
    const { profile, doses } = seedProfile(`window-${tz}`, tz);
    const tooFar = shiftDateStr(localToday, -3);
    expect(isDoseDateAccepted(localToday, tooFar)).toBe(false);
    const result = await resolve(tooFar, "taken", [doses.creatine]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The refusal is the CORE's typed answer, not a second validation in the action.
    expect(result.doses.map((d) => d.outcome)).toEqual(["stale-dose"]);
    expect(logsOn(profile.id, tooFar)).toEqual([]);
  });
});

// Zone-independent contract checks — the intersection rule the whole design rests on.
// One zone is enough here: these are about WHICH ids may be written, not about which
// day it is.
describe("the named ids are an upper bound, never an instruction", () => {
  it("writes only the still-unresolved intersection, and refuses a stale second tap", async () => {
    const { profile, doses } = seedProfile("intersect", "UTC");
    const day = shiftDateStr(today(profile.id), -1);
    // Collagen was already confirmed from another device.
    await resolve(day, "taken", [doses.collagen]);

    const again = await resolve(day, "taken", [doses.creatine, doses.collagen]);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // Collagen is simply ABSENT — it is no longer in the day's pending set, so it was
    // never named to a core. Nothing double-logs and nothing is reported that was not
    // written.
    expect(again.doses.map((d) => d.doseId)).toEqual([doses.creatine]);
    expect(logsOn(profile.id, day)).toEqual([
      { dose_id: doses.creatine, status: "taken" },
      { dose_id: doses.collagen, status: "taken" },
    ]);
  });

  it("silently drops a paused item, another profile's dose and a forged id", async () => {
    // Seeded FIRST so the later seed leaves the acting session on `mine`.
    const stranger = seedProfile("stranger", "UTC");
    const mine = seedProfile("forged", "UTC");
    const paused = seedDose(mine.profile.id, "Zinc forged", { active: 0 });
    const day = shiftDateStr(today(mine.profile.id), -1);

    const result = await resolve(day, "taken", [
      paused,
      stranger.doses.creatine,
      9_900_001,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // None of the three is in the acting profile's pending set, so none reaches a
    // core and none is reported — reporting them would leak whether an id exists.
    expect(result.doses).toEqual([]);
    expect(logsOn(stranger.profile.id, day)).toEqual([]);
    expect(logsOn(mine.profile.id, day)).toEqual([]);
  });

  it("rejects a malformed day or status before any core is reached", async () => {
    seedProfile("malformed", "UTC");
    expect(await resolve("not-a-date", "taken", [1])).toEqual({
      ok: false,
      error: "Couldn't log those doses.",
    });
    expect(
      await resolveDayDoses(
        fd({ date: "2026-08-27", status: "clear", dose_ids: "1" })
      )
    ).toEqual({ ok: false, error: "Couldn't log those doses." });
  });
});
