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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setActiveSituations, setTimezone } from "@/lib/settings";
import {
  getDisplayFormatPrefs,
  setDisplayFormatPrefs,
} from "@/lib/settings/display";
import { doseLogDays, isDoseDateAccepted } from "@/lib/dose-log-window";
import { markDoseTaken } from "@/lib/queries";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import { getActiveSituations, getTimezone } from "@/lib/settings";
import { setProfileSetting } from "@/lib/settings";
import { effectiveSituationResolver } from "@/lib/queries/derived-situations";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import {
  intakeAdherenceStrip,
  indexTakenByDose,
  type AdherenceDot,
} from "@/lib/intake-adherence";
import { travelExcusalResolver } from "@/lib/travel-excusal";
import {
  getIntakeItems,
  getIntakeAdherenceEvidence,
  getActivityDates,
  getActivitiesByDate,
  isPredictedWorkoutDay,
} from "@/lib/queries";
import { getIntakeDoses } from "@/lib/queries/intake/schedule";
import { getDayDoseLedger } from "@/lib/queries/day-ledger";
import {
  addIntakeItem,
  resolveDayDoses,
  setDoseStatus,
  updateIntakeItem,
} from "@/app/(app)/nutrition/intake-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

// 10:30 UTC on the 28th is 00:30 on the 29th in Kiritimati (+14) and 23:30 on the 27th
// in Midway (−11). One instant, three different profile-local todays — which is what
// makes the two zones DISCRIMINATING rather than decorative: 2026-08-26 is inside the
// window for Midway and outside it for Kiritimati.
async function readyQuickEntry(...args: Parameters<typeof loadQuickEntry>) {
  const result = await loadQuickEntry(...args);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("quick-entry read was refused");
  return result.data;
}

const NOW_ISO = "2026-08-28T10:30:00Z";
const ZONES = [
  {
    tz: "Pacific/Kiritimati",
    localToday: "2026-08-29",
    statedPastInstant: "2026-08-27T17:05:00Z",
  },
  {
    tz: "Pacific/Midway",
    localToday: "2026-08-27",
    statedPastInstant: "2026-08-26T18:05:00Z",
  },
] as const;

beforeEach(() => vi.setSystemTime(new Date(NOW_ISO)));

function seedDose(
  profileId: number,
  name: string,
  opts: {
    timeOfDay?: string;
    active?: number;
    stack?: string | null;
    condition?: string;
    situation?: string | null;
    createdDaysAgo?: number;
  } = {}
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, stack, situation)
         VALUES (?, ?, 'supplement', ?, 'should', ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        opts.active ?? 1,
        opts.condition ?? "daily",
        opts.stack ?? null,
        opts.situation ?? null
      ).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 scoop', ?, 'any', 0)`
      )
      .run(itemId, opts.timeOfDay ?? "morning").lastInsertRowid
  );
  // THE LIFETIME BOUND HAS A DEFAULT, and every fixture has a position relative to it.
  // A row inserted here defaults to `created_at = now`, i.e. TODAY — so before the
  // #430/#1442 clamp landed in `pendingDayDoses` these fixtures were all describing an
  // item that did not exist on the days they then asserted about, and they only passed
  // because nothing was checking. Fixtures that are not ABOUT the boundary are aged
  // well behind it so they test what they claim; the two that ARE about it set their
  // own timestamp explicitly.
  const born = `${shiftDateStr(today(profileId), -(opts.createdDaysAgo ?? 30))} 09:00:00`;
  db.prepare(`UPDATE intake_items SET created_at = ? WHERE id = ?`).run(
    born,
    itemId
  );
  db.prepare(`UPDATE intake_item_doses SET created_at = ? WHERE id = ?`).run(
    born,
    doseId
  );
  return doseId;
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

// A REAL training session: ended, so `isDraftActivityRow` cannot call it a husk.
function seedSession(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, title, type, start_time, end_time)
     VALUES (?, ?, 'Session', 'cardio', '09:00', '10:00')`
  ).run(profileId, date);
}

// A DRAFT HUSK (#3189): create-at-start wrote the row at the session's first second
// and nothing was ever logged into it — no end, no duration, no sets, no note, no
// distance, and no import source. It carries a `date` like any other row, which is
// precisely why the two activity readers are not interchangeable.
function seedDraftHusk(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, title, type, start_time)
     VALUES (?, ?, 'Abandoned', 'cardio', '09:00')`
  ).run(profileId, date);
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

// The composed action each row on a day records having been written by (#4328).
// DISTINCT, because the claim is that one bulk tap left ONE bundle across its rows.
function bundlesOn(profileId: number, date: string): (string | null)[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT l.bundle_id FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE s.profile_id = ? AND l.date = ?`
      )
      .all(profileId, date) as { bundle_id: string | null }[]
  ).map((r) => r.bundle_id);
}

function occurredAt(doseId: number, date: string): string | null {
  return (
    db
      .prepare(
        "SELECT occurred_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { occurred_at: string | null }
  ).occurred_at;
}

// The immutable capture stamp. A flip is an edit of an existing row, so this must not
// move: `recorded_at` is not in the UPDATE's SET list and must never join it.
function recordedAt(doseId: number, date: string): string {
  return (
    db
      .prepare(
        "SELECT recorded_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { recorded_at: string }
  ).recorded_at;
}

function resolve(
  date: string,
  status: "taken" | "skipped",
  doseIds: readonly number[]
) {
  return resolveDayDoses(fd({ date, status, dose_ids: doseIds.join(",") }));
}

it("records the amount in force on the selected past day", async () => {
  vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
  const login = createLogin();
  const profile = createProfile("historical-amount", login.id);
  actAs(login, profile);
  setTimezone(profile.id, "UTC");
  await addIntakeItem(
    fd({
      name: "Historical amount",
      doses: JSON.stringify([
        {
          amount: "500 mg",
          time_of_day: "Morning",
          food_timing: "any",
          weekdays: [],
          start_date: "",
          end_date: "",
        },
      ]),
    })
  );
  const itemId = Number(
    (
      db.prepare("SELECT MAX(id) AS id FROM intake_items").get() as {
        id: number;
      }
    ).id
  );
  const doseId = Number(
    (
      db
        .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id
  );

  vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
  await updateIntakeItem(
    fd({
      id: itemId,
      name: "Historical amount",
      doses: JSON.stringify([
        {
          id: doseId,
          amount: "1000 mg",
          time_of_day: "Morning",
          food_timing: "any",
          weekdays: [],
          start_date: "",
          end_date: "",
        },
      ]),
    })
  );

  const date = "2026-08-27";
  expect(await resolve(date, "taken", [doseId])).toMatchObject({ ok: true });
  expect(
    (
      db
        .prepare(
          "SELECT amount FROM intake_item_logs WHERE dose_id = ? AND date = ?"
        )
        .get(doseId, date) as { amount: string }
    ).amount
  ).toBe("500 mg");
});

it("returns the ordinary Dose body when there is nothing yet to confirm (#3203)", async () => {
  const login = createLogin();
  const profile = createProfile("Empty dose body", login.id);
  actAs(login, profile);
  setTimezone(profile.id, "UTC");

  const data = await readyQuickEntry("dose");
  expect(data.form).toBe("dose");
  if (data.form !== "dose") return;
  expect(data.doses).toEqual([]);
  expect(data.pastDays.every((day) => day.slots.length === 0)).toBe(true);
  expect(data.prn?.meds).toEqual([]);
});

describe.each(ZONES)("in $tz", ({ tz, localToday, statedPastInstant }) => {
  it("resolves the profile's local today and offers exactly the accepted days", async () => {
    const { profile } = seedProfile(`offer-${tz}`, tz);
    expect(today(profile.id)).toBe(localToday);
    // The instant's UTC day is the 28th; neither zone agrees with it, which is the
    // whole point of running the rest of this file twice.
    expect(localToday).not.toBe(NOW_ISO.slice(0, 10));
    const data = await readyQuickEntry("dose");
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

  it("groups a past day by declared bucket, newest day first", async () => {
    const { doses } = seedProfile(`slots-${tz}`, tz);
    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    const yesterday = data.pastDays[0]!;
    expect(yesterday.date).toBe(shiftDateStr(localToday, -1));
    // The bucket is what the row's chip says (#5753 leg 1) — the day's own name is the
    // switcher's, and this payload carries no second spelling of it.
    expect(
      yesterday.slots.map((slot) => [
        slot.bucket,
        slot.doses.map((d) => d.doseId),
      ])
    ).toEqual([
      ["Morning", [doses.creatine, doses.collagen]],
      ["Before sleep", [doses.melatonin]],
    ]);
  });

  it("writes taken and skipped doses on selected past days, never today", async () => {
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
    // ONE BULK TAP, ONE BUNDLE (#4328). The two rows above are what makes this a claim
    // about sharing rather than about a single row: the ledger's Take-all is a composed
    // action and records itself, instead of leaving a reader to infer the composition
    // from the minute the rows happened to land in.
    const taken = bundlesOn(profile.id, day);
    expect(taken).toHaveLength(1);
    expect(taken[0]).not.toBeNull();
    // The day the tap happened on stays untouched: a backdated write is about the day
    // it names and no other.
    expect(logsOn(profile.id, localToday)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT occurred_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
        )
        .get(doses.creatine, day)
    ).toEqual({ occurred_at: null });
    expect(
      getDayDoseLedger(profile.id, day).find(
        (row) => row.doseId === doses.creatine
      )?.clockKind
    ).toBe("logged");

    const skippedDay = shiftDateStr(localToday, -2);
    const skipped = await resolve(skippedDay, "skipped", [doses.melatonin]);
    expect(skipped.ok).toBe(true);
    expect(logsOn(profile.id, skippedDay)).toEqual([
      { dose_id: doses.melatonin, status: "skipped" },
    ]);
    // A SKIP CARRIES NO BUNDLE. It is its own statement, with its own reason, and the
    // ledger never folds one into a collapsed row — so there is nothing for a bundle to
    // record and the taken arm is the only one that stamps.
    expect(bundlesOn(profile.id, skippedDay)).toEqual([null]);
  });

  it("keeps today's one-tap administration stamp", async () => {
    const { doses } = seedProfile(`today-stamp-${tz}`, tz);
    await resolve(localToday, "taken", [doses.creatine]);
    const row = db
      .prepare(
        "SELECT occurred_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doses.creatine, localToday) as { occurred_at: string | null };
    expect(row.occurred_at).not.toBeNull();
  });

  it("gives unstated row and bulk taps the same instant semantics", async () => {
    const { doses } = seedProfile(`instant-pair-${tz}`, tz);
    const past = shiftDateStr(localToday, -1);

    expect(
      await setDoseStatus(
        fd({ dose_id: doses.creatine, date: past, status: "taken" })
      )
    ).toMatchObject({ ok: true });
    expect(await resolve(past, "taken", [doses.collagen])).toMatchObject({
      ok: true,
    });
    expect(occurredAt(doses.creatine, past)).toBeNull();
    expect(occurredAt(doses.collagen, past)).toBeNull();

    expect(
      await setDoseStatus(
        fd({ dose_id: doses.creatine, date: localToday, status: "taken" })
      )
    ).toMatchObject({ ok: true });
    expect(await resolve(localToday, "taken", [doses.collagen])).toMatchObject({
      ok: true,
    });
    expect(occurredAt(doses.creatine, localToday)).toBe(NOW_ISO);
    expect(occurredAt(doses.collagen, localToday)).toBe(NOW_ISO);

    expect(
      await setDoseStatus(
        fd({
          dose_id: doses.melatonin,
          date: past,
          status: "taken",
          at: "07:05",
        })
      )
    ).toMatchObject({ ok: true });
    expect(occurredAt(doses.melatonin, past)).toBe(statedPastInstant);
  });

  // ── THE SKIPPED→TAKEN FLIP (#4779, folded into #4686) ─────────────────────
  //
  // The UPDATE arm ignored `opts.takenAt` entirely and bound a bare `instantNow()`, so
  // un-skipping yesterday's dose stamped it with TODAY's instant — and the arming reads
  // then coalesced onto `recorded_at`, which on a flip is the instant of the SKIP. A
  // caregiver who skipped the 8pm ibuprofen and gave it at 01:30 was pushed "Redose
  // window open" at 02:10, forty minutes after the dose.
  //
  // The flip is now the SAME expression the insert arm on the same day is: nothing
  // stated on a past day writes nothing, a stated minute is kept, and today's flip
  // keeps the tap instant. That last case is the one no test in the tree asserted, and
  // it is the limb every mounted flip actually takes.
  describe("a skipped→taken flip states what the tap states, not when it happened", () => {
    async function skipThenTake(
      doseId: number,
      date: string,
      at?: string
    ): Promise<void> {
      expect(
        await setDoseStatus(fd({ dose_id: doseId, date, status: "skipped" }))
      ).toMatchObject({ ok: true });
      expect(
        await setDoseStatus(
          fd({ dose_id: doseId, date, status: "taken", ...(at ? { at } : {}) })
        )
      ).toMatchObject({ ok: true });
    }

    it("on a PAST day with nothing stated, writes no instant — as the insert arm does", async () => {
      const { doses } = seedProfile(`flip-past-${tz}`, tz);
      const past = shiftDateStr(localToday, -1);
      await skipThenTake(doses.creatine, past);
      expect(occurredAt(doses.creatine, past)).toBeNull();
    });

    it("on a PAST day with a stated minute, keeps the minute", async () => {
      const { doses } = seedProfile(`flip-stated-${tz}`, tz);
      const past = shiftDateStr(localToday, -1);
      await skipThenTake(doses.melatonin, past, "07:05");
      expect(occurredAt(doses.melatonin, past)).toBe(statedPastInstant);
    });

    // CONTROL C4b. Hoisting a plausible TWO-way (`opts.takenAt ? resolve(...) : null`)
    // passes both cases above and type-checks, while making every flip on today write
    // NULL — which with the arming union leaves the family permanently unplaced, so a
    // caregiver who un-skips a dose they just gave gets no redose notice for it. This
    // is the case that reds on that shape.
    it("on TODAY with nothing stated, keeps the tap instant", async () => {
      const { doses } = seedProfile(`flip-today-${tz}`, tz);
      await skipThenTake(doses.creatine, localToday);
      expect(occurredAt(doses.creatine, localToday)).toBe(NOW_ISO);
    });

    it("leaves the capture stamp where the skip put it", async () => {
      const { doses } = seedProfile(`flip-capture-${tz}`, tz);
      const past = shiftDateStr(localToday, -1);
      expect(
        await setDoseStatus(
          fd({ dose_id: doses.creatine, date: past, status: "skipped" })
        )
      ).toMatchObject({ ok: true });
      const captured = recordedAt(doses.creatine, past);
      vi.setSystemTime(new Date("2026-08-28T14:00:00Z"));
      expect(
        await setDoseStatus(
          fd({ dose_id: doses.creatine, date: past, status: "taken" })
        )
      ).toMatchObject({ ok: true });
      expect(recordedAt(doses.creatine, past)).toBe(captured);
      vi.setSystemTime(new Date(NOW_ISO));
    });
  });

  it("refuses a day past the window, and the CORE would refuse it too", async () => {
    const { profile, doses } = seedProfile(`window-${tz}`, tz);
    const tooFar = shiftDateStr(localToday, -3);
    expect(isDoseDateAccepted(localToday, tooFar)).toBe(false);

    // Since F4 the action refuses it at the OFFER bound, before a core is reached —
    // the day is an upper bound like the ids. Nothing is written either way.
    const result = await resolve(tooFar, "taken", [doses.creatine]);
    expect(result).toEqual({ ok: false, error: "Couldn't log those doses." });
    expect(logsOn(profile.id, tooFar)).toEqual([]);

    // AND THE BOUND DID NOT REPLACE THE GATE, which is the thing worth pinning: the
    // core still refuses the same day on its own terms, so the window is still enforced
    // in ONE place and the action's bound is only about what this surface offers.
    expect(
      markDoseTaken(profile.id, doses.creatine, null, tooFar, "quick-log")
    ).toBe("stale-dose");
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

// ── F1: a past day is judged by the situations active THAT day ───────────────
//
// Found by an adversarial pass, and it was the first past-date caller of
// `getEffectiveActiveSituations` that made the gap reachable: that function
// date-resolves only its DERIVED half, and its declared half is a bare
// "WHERE active = 1" read of current state. Both directions were silent, and the
// second one defeats the feature's whole purpose, so both are pinned here.
describe("a past day is scored against the situations active THAT day (#654)", () => {
  function seedTravelItem(label: string) {
    const login = createLogin();
    const profile = createProfile(label, login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const doseId = seedDose(profile.id, `Electrolytes ${label}`, {
      condition: "situational",
      situation: "Travel",
    });
    return { profile, doseId, yesterday: shiftDateStr(today(profile.id), -1) };
  }

  async function offeredOn(date: string): Promise<number[]> {
    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") return [];
    const day = data.pastDays.find((d) => d.date === date);
    return (day?.slots ?? []).flatMap((slot) =>
      slot.doses.map((d) => d.doseId)
    );
  }

  it("does NOT fabricate: a situation declared TODAY leaves the past days as they were", async () => {
    const { profile, doseId, yesterday } = seedTravelItem("fabricate");
    expect(await offeredOn(yesterday)).toEqual([]);

    // Turn Travel on today. Yesterday you were not travelling, so yesterday still
    // owes nothing — and a tap must not write `taken` (and decrement on-hand supply)
    // for a dose that was never due.
    setActiveSituations(profile.id, ["Travel"]);
    expect(await offeredOn(yesterday)).toEqual([]);
    const result = await resolve(yesterday, "taken", [doseId]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doses).toEqual([]);
    expect(logsOn(profile.id, yesterday)).toEqual([]);

    // TODAY, on the other hand, genuinely does owe it — the same call, one day over,
    // proving the guard above is about the DAY and not about the item being invisible.
    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    expect(data.doses.map((d) => d.doseId)).toContain(doseId);
  });

  it("does NOT conceal: a situation that has ENDED still owes the days it was on", async () => {
    const { profile, doseId, yesterday } = seedTravelItem("conceal");
    // Ill/travelling yesterday…
    setActiveSituations(profile.id, ["Travel"]);
    const events = [{ date: yesterday, situation: "Travel", change: "start" }];
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'situation_events', ?)
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(profile.id, JSON.stringify(events));
    // …and recovered today.
    setActiveSituations(profile.id, []);

    // THE POINT OF THE FEATURE. The doses most likely to be missed are exactly the
    // ones tied to a situation that has since ended; a switcher that hides them is
    // worse than no switcher, because it answers "nothing to log" for a day that owes.
    expect(await offeredOn(yesterday)).toEqual([doseId]);
    const result = await resolve(yesterday, "taken", [doseId]);
    expect(result.ok).toBe(true);
    expect(logsOn(profile.id, yesterday)).toEqual([
      { dose_id: doseId, status: "taken" },
    ]);
  });
});

// ── F2: the bucket is the one the dose sat in ON that day ────────────────────
describe("a moved dose is filed under the slot it occupied that day (#1973)", () => {
  it("groups by the schedule version in force then, not the current row", async () => {
    const login = createLogin();
    const profile = createProfile("moved-dose", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const doseId = seedDose(profile.id, "Magnesium moved", {
      timeOfDay: "evening",
    });
    const todayStr = today(profile.id);
    const yesterday = shiftDateStr(todayStr, -1);

    // The dose moved evening -> morning TODAY. Yesterday it was an evening dose, and
    // the day's dueness is already judged by that same effective-dated history — so
    // the heading has to agree with the rule, or the bulk row's label names a slot
    // that never held it.
    db.prepare(
      `INSERT INTO intake_dose_schedule_versions (dose_id, effective_from, time_of_day)
       VALUES (?, ?, 'evening'), (?, ?, 'morning')`
    ).run(doseId, shiftDateStr(todayStr, -30), doseId, todayStr);
    db.prepare(
      `UPDATE intake_item_doses SET time_of_day = 'morning' WHERE id = ?`
    ).run(doseId);

    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    const day = data.pastDays.find((d) => d.date === yesterday)!;
    expect(day.slots.map((slot) => slot.bucket)).toEqual(["Evening"]);
    expect(day.slots[0]!.doses.map((d) => d.doseId)).toEqual([doseId]);
  });
});

// ── F4: the DAY is an upper bound too, not just the ids ──────────────────────
describe("the submitted day is bounded by the days the sheet offers", () => {
  it("refuses tomorrow while accepting every day the sheet offers", async () => {
    const { profile, doses } = seedProfile("forward", "UTC");
    const tomorrow = shiftDateStr(today(profile.id), 1);
    // The cores' own window is symmetric — a late Telegram tap may land either side of
    // its reminder's day — so `isDoseDateAccepted` says YES here. The offer is the past
    // half only, and a forged POST must not reach a day no surface ever offered.
    expect(isDoseDateAccepted(today(profile.id), tomorrow)).toBe(true);
    expect(doseLogDays(today(profile.id))).not.toContain(tomorrow);

    expect(await resolve(tomorrow, "taken", [doses.creatine])).toEqual({
      ok: false,
      error: "Couldn't log those doses.",
    });
    expect(logsOn(profile.id, tomorrow)).toEqual([]);

    for (const day of doseLogDays(today(profile.id))) {
      const r = await resolve(day, "taken", [doses.creatine, doses.collagen]);
      expect(r.ok).toBe(true);
    }
    expect(
      logsOn(profile.id, shiftDateStr(today(profile.id), -2))
    ).toHaveLength(2);
  });
});

// ── THE AGREEMENT TEST, against the strip ITSELF ─────────────────────────────
//
// The first version of this compared `isDueOn` against `situationsActiveOn` — the same
// resolver the code under test calls — so it was agreement with itself, and it passed
// over three separate defects (today's situations on a past day, no lifetime clamp, no
// travel excusal). Structural agreement by construction is a restatement, not a check.
//
// This one runs `intakeAdherenceStrip` — the app's canonical historical dueness answer,
// the one #3674's missed-day offer reads through `missedDoseDays` — and compares its
// VERDICT per day against what the sheet offers. The contract is the #221 one: two
// catch-up surfaces, one question, one answer.
//
//   strip "na"      → the day asks nothing of this dose  → the sheet must NOT offer it
//   strip "excused" → the clock made the slot impossible → the sheet must NOT offer it
//   strip "missed"  → the day owes it and nothing is logged → the sheet MUST offer it
// EVERY INPUT PAIRED WITH THE ONE THE SUBJECT READS. Two readers six lines apart —
// one here, one in `pendingDayDoses` — is how the draft-husk instances stayed hidden
// through two review rounds, so the pairing is written down rather than assumed:
//
//   dates            doseLogDays(today)      ← the switcher's own three days
//   workoutDays      getActivityDates        ← husk-free list, both sides (#3189)
//   situationsOn     effectiveSituationResolver ← declared AND derived, both sides
//                                                 (#654/#3993)
//   takenByDose      full history            ← see EVIDENCE below
//   tz               getTimezone             ← both sides
//   isExcused        travelExcusalResolver   ← both sides (#3263)
//
// EVIDENCE, AND IT IS NO LONGER A DIVERGENCE (#3988). `intakeAdherenceStrip` does not
// own its lifetime evidence — its CALLER hands it `takenByDose`. Every production
// caller used to hand it the span it DRAWS, so a dose whose only proof of existence
// was an older log scored `na` on days it existed, and this file recorded the sheet
// and the strip disagreeing for that reason. They now share one evidence builder,
// `getIntakeAdherenceEvidence`, which is what this helper uses too — so the comparison
// below is about the RULE and the two sides are given the same facts to apply it to.
const ALL_HISTORY_DAYS = 3650;
function stripFor(
  profileId: number,
  itemId: number,
  evidenceDays = ALL_HISTORY_DAYS
): AdherenceDot[] {
  const item = getIntakeItems(profileId).find((i) => i.id === itemId)!;
  const doses = getIntakeDoses(profileId).filter((d) => d.item_id === itemId);
  const dates = [...doseLogDays(today(profileId))].reverse();
  return intakeAdherenceStrip(
    item,
    doses,
    dates,
    new Set(getActivityDates(profileId)),
    effectiveSituationResolver(profileId, {
      from: dates[0],
      to: dates[dates.length - 1],
    }),
    indexTakenByDose(getIntakeAdherenceEvidence(profileId, evidenceDays)),
    getTimezone(profileId),
    travelExcusalResolver(profileId)
  );
}

describe("the sheet's offer agrees with the adherence strip, day for day", () => {
  async function offeredByDay(): Promise<Map<string, number[]>> {
    const data = await readyQuickEntry("dose");
    const out = new Map<string, number[]>();
    if (data.form !== "dose") return out;
    out.set(
      data.today,
      data.doses.map((d) => d.doseId)
    );
    for (const past of data.pastDays) {
      out.set(
        past.date,
        past.slots.flatMap((slot) => slot.doses.map((d) => d.doseId))
      );
    }
    return out;
  }

  // Each case shapes ONE profile so a past day lands on a different strip verdict, then
  // asserts the sheet reads that same day the same way. Table-driven: the cases differ
  // only in how the day is shaped and what the strip should then say.
  it.each([
    {
      name: "a day BEFORE the item existed is 'na' and is not offered",
      // Created TODAY, so it did not exist on `day` — the phantom obligation every
      // newly added item used to grow.
      createdDaysAgo: 0,
      expected: "na" as const,
    },
    {
      name: "a day the item existed for and owes is 'missed' and IS offered",
      createdDaysAgo: 30,
      expected: "missed" as const,
    },
  ])("$name", async ({ createdDaysAgo, expected }) => {
    const login = createLogin();
    const profile = createProfile(`agree-${expected}`, login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const doseId = seedDose(profile.id, `Magnesium ${expected}`, {
      createdDaysAgo,
    });
    const itemId = (
      db
        .prepare("SELECT item_id AS id FROM intake_item_doses WHERE id = ?")
        .get(doseId) as { id: number }
    ).id;
    const day = shiftDateStr(today(profile.id), -1);

    const dot = stripFor(profile.id, itemId).find((d) => d.date === day)!;
    expect(dot.state).toBe(expected);

    const offered = (await offeredByDay()).get(day) ?? [];
    // THE contract, stated as the relationship rather than as two literals: the sheet
    // offers a dose on a day exactly when the strip says that day still owes it.
    expect(offered.includes(doseId)).toBe(expected === "missed");
  });

  // THE CASE THIS TABLE WAS MISSING, and its absence is why the strip and the sheet
  // could drift apart under #3993 while all twelve cases above stayed green: every one
  // of them seeds DECLARED context, so both sides agreed no matter which resolver they
  // were given. A day is owed here for a reason nobody declared — the night ending it
  // was rough — and the contract is the same one: the strip says the day owes it, so
  // the sheet must offer it.
  it("a day owed for a DERIVED reason is 'missed' and IS offered (#3993)", async () => {
    const login = createLogin();
    const profile = createProfile("agree-derived", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const doseId = seedDose(profile.id, "Magnesium derived", {
      condition: "situational",
      situation: "Poor sleep",
      createdDaysAgo: 30,
    });
    const itemId = (
      db
        .prepare("SELECT item_id AS id FROM intake_item_doses WHERE id = ?")
        .get(doseId) as { id: number }
    ).id;
    const day = shiftDateStr(today(profile.id), -1);

    // Healthy 8h nights back to day-8, then a 5h night ENDING `day`. Poor sleep was
    // never declared, so the ONLY thing that can make this day owe the dose is the
    // derived verdict for that day.
    const nights: NormMetricSample[] = [];
    for (let d = 8; d >= 2; d -= 1) {
      const wake = shiftDateStr(today(profile.id), -d);
      nights.push({
        metric: "sleep_min",
        date: wake,
        started_at: `${shiftDateStr(wake, -1)}T23:00:00Z`,
        ended_at: `${wake}T08:00:00Z`,
        value: 480,
      });
    }
    nights.push({
      metric: "sleep_min",
      date: day,
      started_at: `${shiftDateStr(day, -1)}T23:00:00Z`,
      ended_at: `${day}T05:00:00Z`,
      value: 300,
    });
    upsertMetricSamples(profile.id, nights, "health-connect");
    expect(getActiveSituations(profile.id)).toEqual([]);

    const dot = stripFor(profile.id, itemId).find((d) => d.date === day)!;
    expect(dot.state).toBe("missed");
    expect((await offeredByDay()).get(day) ?? []).toContain(doseId);
  });

  it("a day the clock made impossible is 'excused' and is not offered (#3263)", async () => {
    const login = createLogin();
    const profile = createProfile("agree-excused", login.id);
    actAs(login, profile);
    // The profile has FLOWN: it is on Tokyo now, and the switch below is the seam it
    // left in its own wall clock. The zone must be the post-switch one or the history
    // does not connect (connectedTimezoneSwitchHistory).
    setTimezone(profile.id, "Asia/Tokyo");
    const doseId = seedDose(profile.id, "Magnesium excused", {
      timeOfDay: "midday",
    });
    const itemId = (
      db
        .prepare("SELECT item_id AS id FROM intake_item_doses WHERE id = ?")
        .get(doseId) as { id: number }
    ).id;
    const day = shiftDateStr(today(profile.id), -1);
    // An EASTWARD jump on `day`: 10:00 UTC becomes 19:00 Tokyo, so the wall clock
    // between them never occurred — and the midday slot (13:00, the shipped default)
    // sits inside the span that vanished. The person could not have taken it.
    setProfileSetting(
      profile.id,
      "timezone_switches",
      JSON.stringify([
        { at: `${day}T10:00:00Z`, from: "UTC", to: "Asia/Tokyo" },
      ])
    );

    const dot = stripFor(profile.id, itemId).find((d) => d.date === day)!;
    // Guard the guard: if this profile does not actually reach `excused`, the assertion
    // below would pass for the wrong reason (a day nothing was offered on anyway).
    expect(dot.state).toBe("excused");
    expect((await offeredByDay()).get(day) ?? []).not.toContain(doseId);
  });
});

// Found by the seam audit, not by a review round: `conditionAppliesOn` reads
// `predictedWorkoutDay ?? isWorkoutDay`, and the prediction is a weekday rhythm
// inferred from a trailing window ending TODAY. On a closed day that lets a guess made
// now overrule the training already on the record — the same "a past date reached an
// input written for today" shape as the situations bug, in a third input.
describe("a closed day's training is what the record says, not what a pattern predicts", () => {
  it("offers a rest_day dose for a predicted training day the person did NOT train on", async () => {
    const login = createLogin();
    const profile = createProfile("rest-day-past", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const doseId = seedDose(profile.id, "Recovery blend", {
      condition: "rest_day",
    });
    const day = shiftDateStr(today(profile.id), -1);

    // A HABITUAL weekday: six sessions on the same weekday as `day`, one a week, and
    // deliberately NOT on `day` itself. `rhythmMinDates(8)` is 4, so this clears the
    // gate and `isPredictedWorkoutDay(day)` returns TRUE while the record for that day
    // is empty. Without the fix the two disagree and the guard below cannot pass.
    // REAL sessions, not husks. The first version of this seeded start-time-only rows,
    // which `isDraftActivityRow` calls drafts — it worked only because the rhythm
    // inference reads raw rows, and it would have gone on "passing" while describing a
    // history of abandoned sessions.
    for (let week = 1; week <= 6; week += 1) {
      seedSession(profile.id, shiftDateStr(day, -7 * week));
    }
    // The precondition, asserted rather than assumed — if the rhythm did not infer,
    // both branches would fall back to `isWorkoutDay` and this test would pass for the
    // wrong reason.
    expect(isPredictedWorkoutDay(profile.id, day)).toBe(true);
    expect(getActivitiesByDate(profile.id, day)).toEqual([]);

    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    const offered = (
      data.pastDays.find((d) => d.date === day)?.slots ?? []
    ).flatMap((slot) => slot.doses.map((d) => d.doseId));
    // It WAS a rest day — nothing was logged — so the rest-day dose was owed and the
    // sheet must offer it. Reading the prediction withholds it, and the adherence
    // strip (which passes no prediction) would call the day missed either way.
    expect(offered).toContain(doseId);
  });
});

// ── The draft-husk split: two activity readers, and only one is right here ────
//
// `getActivitiesByDate` is the raw row read (today's reader everywhere in the repo);
// `getActivityDates` drops draft husks (#3189) and is what every windowed consumer
// uses, the adherence strip included. Taking the today reader to a closed day produced
// BOTH harms this PR exists to fix, from one abandoned session.
describe("an abandoned draft is not a training day on a closed day (#3189)", () => {
  async function offeredOn(date: string): Promise<number[]> {
    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") return [];
    const day = data.pastDays.find((d) => d.date === date);
    return (day?.slots ?? []).flatMap((slot) =>
      slot.doses.map((d) => d.doseId)
    );
  }

  it("neither conceals a rest-day dose nor offers a pre-workout dose", async () => {
    const login = createLogin();
    const profile = createProfile("husk-conditions", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const restDose = seedDose(profile.id, "Rest-day dose", {
      condition: "rest_day",
    });
    const preWorkoutDose = seedDose(profile.id, "Pre-workout dose", {
      condition: "pre_workout",
    });
    const day = shiftDateStr(today(profile.id), -1);
    seedDraftHusk(profile.id, day);

    // The husk made the day look like training, so the rest-day dose read as not due
    // and the sheet said the day had nothing to log.
    expect(getActivitiesByDate(profile.id, day)).toHaveLength(1);
    expect(getActivityDates(profile.id)).not.toContain(day);
    const offered = await offeredOn(day);
    expect(offered).toContain(restDose);
    // The other direction, and the worse one: a tap here writes `taken` and decrements
    // real stock for a day that asked nothing.
    expect(offered).not.toContain(preWorkoutDose);
  });
});

// ── The lifetime bound's WIDENING, which nothing was guarding ────────────────
//
// `doseWindowSince` extends the bound backwards past `created_at` when the dose's own
// logs prove it existed earlier — a med reconciled off a document, a course re-entered
// after a move, a backfilled history all land as a same-day `created_at` carrying real
// adherence. Deleting that half left every test green, which made it the one new
// mechanism in this change nothing could see.
describe("a logged dose proves it existed, and the clamp gives way to it", () => {
  it("offers the day and agrees with both strip spans when proof predates the drawn window (#3988)", async () => {
    const login = createLogin();
    const profile = createProfile("evidence-window", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    // Created TODAY — the cold-start shape the clamp exists for…
    const doseId = seedDose(profile.id, "Evidence-window dose", {
      createdDaysAgo: 0,
    });
    const itemId = (
      db
        .prepare("SELECT item_id AS id FROM intake_item_doses WHERE id = ?")
        .get(doseId) as { id: number }
    ).id;
    const day = shiftDateStr(today(profile.id), -1);
    // The proof is 60 days old — outside the 14-day span the strip DRAWS. That used to
    // decide the answer: the same rule over two evidence sets gave `na` here and
    // `missed` on full history, and the sheet's deliberate choice of the second was
    // recorded as a divergence. The lifetime bound now has its own evidence, so the
    // window a surface draws no longer narrows what it is allowed to know.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status, recorded_at, logged_via)
       VALUES (?, ?, ?, 'taken', ?, 'page')`
    ).run(
      doseId,
      itemId,
      shiftDateStr(today(profile.id), -60),
      `${shiftDateStr(today(profile.id), -60)} 09:00:00`
    );

    // One rule, one answer, at BOTH drawn spans — 14 is what the shipped surfaces use.
    expect([
      stripFor(profile.id, itemId, 14).find((d) => d.date === day)!.state,
      stripFor(profile.id, itemId).find((d) => d.date === day)!.state,
    ]).toEqual(["missed", "missed"]);

    // And the sheet offers it, as it always did: a log IS proof the dose existed, and
    // clamping the day away would CONCEAL a dose that was genuinely owed.
    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    const offered = (
      data.pastDays.find((d) => d.date === day)?.slots ?? []
    ).flatMap((slot) => slot.doses.map((d) => d.doseId));
    expect(offered).toContain(doseId);
  });
});

// ── THE "EVERYTHING ELSE" FOLD (#5808, owner ruling 2026-09-10) ──────────────
//
// The fold's whole job is REACH: the body's three sources are all about what is owed
// or offered right now, so an active item that is simply not due had no row at all.
// What can go wrong here is quiet in both directions — a fold that double-lists a due
// item, and a fold that renders with a count nobody can expand into — so the claim is
// asserted as a SET DIFFERENCE against the very lists the same payload carries.
describe("the dose body's fold reaches every item the body does not show", () => {
  // An item whose dose states NO time is never due (#5285) and therefore never
  // appears in `doses`. It is exactly the owner's Magnesium Glycinate / NAC case, and
  // the reason the fold exists rather than something being made due to hold it.
  function seedUnscheduled(profileId: number, name: string): number {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
           VALUES (?, ?, 'supplement', 1, 'should', 'daily')`
        )
        .run(profileId, name).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', NULL, 'any', 0)`
    ).run(itemId);
    return itemId;
  }

  function seedPrnMed(profileId: number, name: string): number {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
           VALUES (?, ?, 'medication', 1, 'may', 'daily')`
        )
        .run(profileId, name).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '200 mg', NULL, 'any', 0)`
    ).run(itemId);
    return itemId;
  }

  async function doseBody(label: string, tz: string) {
    vi.setSystemTime(new Date(NOW_ISO));
    const login = createLogin();
    const profile = createProfile(label, login.id);
    actAs(login, profile);
    setTimezone(profile.id, tz);
    return { login, profile };
  }

  it("lists an unscheduled item the due list can never hold, with the day's amount", async () => {
    const { profile } = await doseBody("fold-unscheduled", "UTC");
    // Due today, so it belongs to the body ABOVE the fold.
    seedDose(profile.id, "Creatine fold", { timeOfDay: "morning" });
    const magnesium = seedUnscheduled(profile.id, "Magnesium Glycinate");

    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    const day = today(profile.id);
    const fold = data.others!.byDate[day]!;

    expect(fold.map((row) => row.name)).toEqual(["Magnesium Glycinate"]);
    expect(fold[0]).toMatchObject({
      itemId: magnesium,
      detail: "400 mg",
      takenAt: null,
    });
    // The row can be written: `logHistoricalDose` takes a dose id, and an item with
    // none would be an offer with no write behind it.
    expect(fold[0]!.doseId).toBeGreaterThan(0);
  });

  it("never double-lists an item the body already shows, on any offered day", async () => {
    const { profile } = await doseBody("fold-exclusions", "UTC");
    const dueDoseId = seedDose(profile.id, "Creatine due", {
      timeOfDay: "morning",
    });
    const prn = seedPrnMed(profile.id, "Ibuprofen prn");
    seedUnscheduled(profile.id, "NAC");

    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    const dueItemId = (
      db
        .prepare("SELECT item_id AS id FROM intake_item_doses WHERE id = ?")
        .get(dueDoseId) as { id: number }
    ).id;

    // TODAY: the due item is in `doses`, the PRN med is in `prn` — neither may also
    // be in the fold, and the one item in neither list is.
    const todayFold = data.others!.byDate[today(profile.id)]!;
    expect(todayFold.map((row) => row.itemId)).not.toContain(dueItemId);
    expect(todayFold.map((row) => row.itemId)).not.toContain(prn);
    expect(todayFold.map((row) => row.name)).toEqual(["NAC"]);

    // EVERY OFFERED DAY GETS A FOLD, and the as-needed list is drawn on all of them,
    // so its ids are subtracted everywhere. A past day's own unresolved doses are
    // subtracted from that day's fold and no other.
    for (const past of data.pastDays) {
      const fold = data.others!.byDate[past.date]!;
      expect(fold.map((row) => row.itemId)).not.toContain(prn);
      const shown = past.slots.flatMap((slot) =>
        slot.doses.map((dose) => dose.doseId)
      );
      if (shown.includes(dueDoseId)) {
        expect(fold.map((row) => row.itemId)).not.toContain(dueItemId);
      }
    }
  });

  it("keeps an item taken today in the fold, with the clock it was taken at", async () => {
    const { login, profile } = await doseBody("fold-taken", "UTC");
    // The fact reads in the LOGIN's own clock convention, like every other time this
    // sheet prints — the ruling's "taken 8:15am" is the 12h spelling of it.
    setDisplayFormatPrefs(login.id, {
      ...getDisplayFormatPrefs(login.id),
      timeFormat: "12h",
    });
    const itemId = seedUnscheduled(profile.id, "NAC taken");
    const doseId = (
      db
        .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id;
    const day = today(profile.id);
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status, occurred_at, recorded_at, logged_via)
       VALUES (?, ?, ?, 'taken', ?, ?, 'page')`
    ).run(doseId, itemId, day, `${day}T08:15:00.000Z`, `${day} 08:15:00`);

    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    // STILL LISTED — a dose already taken is exactly the case a second dose is one
    // tap away from, so dropping it would cost the reach this row exists for.
    expect(data.others!.byDate[day]).toMatchObject([
      { itemId, takenAt: "8:15am" },
    ]);
  });

  it("offers no fold at all when every item is already due or as-needed", async () => {
    const { profile } = await doseBody("fold-empty", "UTC");
    seedDose(profile.id, "Creatine only", { timeOfDay: "morning" });
    seedPrnMed(profile.id, "Ibuprofen only");

    const data = await readyQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    // ZERO IS THE CASE THAT FAILS QUIETLY: an empty list renders no fold, and the
    // count the summary prints is this same array's length, so the two cannot drift.
    expect(data.others!.byDate[today(profile.id)]).toEqual([]);
  });
});
