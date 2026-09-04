// DB INTEGRATION TIER — a day gets ONE dueness answer, on the surfaces a person acts on
// AND on the surfaces that summarise those days back to them (#3993).
//
// The seam this pins used to be drawn between them: the reminder rebuild, the catch-up
// sheet and the strips beside them asked a DATED resolver (declared ∪ derived, as of the
// day), while the weekly recap, the demotion evidence, the adherence patterns and the
// morning digest asked a DECLARED-ONLY one. The split was a measured cost, not a claim
// that the surfaces mean different things, and it had two consequences the app could
// state to a person:
//
//   • THE PAUSE DIRECTION. A `daily` `must` medication held by Poor sleep (#1296) is
//     REMOVED from a rough day by every acting surface — and the summaries, blind to the
//     derived context, called that day due and missed. What the person reads is
//     "💊 Medications: 0/1 taken", pushed to a phone, about a dose the app itself would
//     not have offered and no surface can clear.
//   • THE SITUATIONAL DIRECTION. A situational item goes due on a rough day, the
//     catch-up sheet offers it, the person taps it — and the summaries score the day
//     `na`, which discards the log: `intakeAdherenceStrip` returns `na` before it
//     consults the log, and `windowAdherence` builds `dueIds` first and intersects the
//     taken set second.
//
// So both directions are asserted here, and each is asserted ACROSS the two sides of the
// old seam at once rather than one surface at a time — a literal can be wrong on both
// sides and still agree with itself, so every case carries a control day whose answer
// the fixture makes the opposite.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { lastNDates, shiftDateStr, weekdayOfDateStr } from "@/lib/date";
import {
  getTimezone,
  setTimezone,
  setWeekMode,
  setWeekStart,
  type WeekStart,
} from "@/lib/settings";
import { resolveSituationId } from "@/lib/settings/profile-attrs";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { collectWindowDoses } from "@/lib/notifications/intake";
import { pendingDayDoses } from "@/lib/queries/usual-routine";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { gatherRecapInput } from "@/lib/notifications/recap-data";
import { getIntakeHistory } from "@/lib/intake-history";
import { DEMOTION_WINDOW_DAYS } from "@/lib/supplement-demotion";
import {
  intakeAdherenceStrip,
  indexTakenByDose,
  stripWithoutTrailingPending,
  STRIP_DAYS,
  type AdherenceDot,
} from "@/lib/intake-adherence";
import { effectiveSituationResolver } from "@/lib/queries/derived-situations";
import { travelExcusalResolver, profileDayZone } from "@/lib/travel-excusal";
import {
  getIntakeItems,
  getIntakeDoses,
  getIntakeAdherenceEvidence,
  getActivityDates,
} from "@/lib/queries";
import { BUILTIN_POOR_SLEEP_SITUATION } from "@/lib/derived-situations";

let seq = 0;

// A calendar-week profile for whom TODAY is day 3 of its week, so yesterday and the day
// before are COMPLETED days inside the recap's in-progress window (#4228 A's walk stops
// before today). Without that the window a recap covers depends on which weekday the
// suite runs on, and the day this fixture is about could fall outside it.
function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Dated Summary ${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  setWeekMode(id, "calendar");
  setWeekStart(id, weekdayOfDateStr(shiftDateStr(today(id), -2)) as WeekStart);
  return id;
}

// One Morning dose, aged well past every day read below so #430/#1442's lifetime clamp
// is a no-op and the situation set is the only rule left to disagree about.
// `paused-by` is #1296's hold (a plain `daily` item the situation REMOVES);
// `due-on` is the situational item the situation ADDS.
function seedItem(
  profileId: number,
  name: string,
  how: "due-on" | "paused-by",
  kind: "medication" | "supplement",
  obligation: "must" | "should",
  ageDays = 60
): number {
  const sid = resolveSituationId(profileId, BUILTIN_POOR_SLEEP_SITUATION)!;
  const on = how === "due-on";
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active,
            situation, situation_id, pause_situation_id)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        kind,
        on ? "situational" : "daily",
        obligation,
        on ? BUILTIN_POOR_SLEEP_SITUATION : null,
        on ? sid : null,
        on ? null : sid
      ).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tab', 'Morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const born = `${shiftDateStr(today(profileId), -ageDays)}T00:00:00Z`;
  db.prepare("UPDATE intake_items SET created_at = ? WHERE id = ?").run(
    born,
    itemId
  );
  db.prepare("UPDATE intake_item_doses SET created_at = ? WHERE id = ?").run(
    born,
    doseId
  );
  return doseId;
}

// A main-sleep session ending on `wakeDay`, stored as UTC instants so wall clock ==
// instant under the UTC profile above.
function night(wakeDay: string, minutes: number): NormMetricSample {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return {
    metric: "sleep_min",
    date: wakeDay,
    started_at: `${shiftDateStr(wakeDay, -1)}T23:00:00Z`,
    ended_at: `${wakeDay}T${h}:${m}:00Z`,
    value: minutes,
  };
}

// A healthy 8h night on every day of the trailing window except `roughOffsets`, which get
// 5h — under the absolute floor, so the verdict fires on the night itself rather than on
// a baseline the other rough nights could drag down.
function seedNights(
  profileId: number,
  days: number,
  roughOffsets: readonly number[]
): void {
  const anchor = today(profileId);
  const rough = new Set(roughOffsets);
  const samples: NormMetricSample[] = [];
  for (let i = days; i >= 0; i--)
    samples.push(night(shiftDateStr(anchor, -i), rough.has(i) ? 300 : 480));
  upsertMetricSamples(profileId, samples, "health-connect");
}

// THE ACTING STRIP, BUILT THE WAY THE PAGE BUILDS IT (the discipline
// lib/__action_tests__/past-dose-day.actions.test.ts writes down): every input is the
// one `app/(app)/medications/med-data.ts` and `app/(app)/nutrition/ManageTab.tsx` pass,
// so what this asserts is the arrangement that ships rather than one assembled to agree
// with the gather beside it.
function pageStrip(profileId: number, itemName: string, days: number) {
  const item = getIntakeItems(profileId).find((i) => i.name === itemName)!;
  const doses = getIntakeDoses(profileId).filter((d) => d.item_id === item.id);
  const dates = lastNDates(today(profileId), days);
  return stripWithoutTrailingPending(
    intakeAdherenceStrip(
      item,
      doses,
      dates,
      new Set(getActivityDates(profileId)),
      effectiveSituationResolver(profileId, {
        from: dates[0],
        to: dates[dates.length - 1],
      }),
      indexTakenByDose(getIntakeAdherenceEvidence(profileId, days)),
      profileDayZone(profileId),
      travelExcusalResolver(profileId)
    )
  );
}

// The SUMMARY strip — the demotion evidence, the digest's delta classifier and the
// dashboard history all read this one gather.
function evidenceStrip(
  profileId: number,
  itemName: string,
  days: number
): AdherenceDot[] {
  return (
    getIntakeHistory(profileId, today(profileId), days).find(
      (e) => e.item.name === itemName
    )?.strip ?? []
  );
}

const cellOn = (strip: AdherenceDot[], date: string): string =>
  strip.find((d) => d.date === date)?.state ?? "absent";

const takeOn = (doseId: number, date: string): void => {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, 'taken')`
  ).run(doseId, date);
};

// Every surface's answer for one day, in one object — so a case asserts the WHOLE set
// at once and a fix that moves three of five is not readable as a pass.
function everySurfaceOn(
  profileId: number,
  date: string,
  itemName: string
): Record<string, unknown> {
  const recapDay = gatherRecapInput(
    profileId,
    "kg",
    "week",
    false
  ).adherenceDays.find((d) => d.date === date);
  return {
    reminderRebuild: collectWindowDoses(profileId, "Morning", date).map(
      (e) => e.item.name
    ),
    catchUpSheet: pendingDayDoses(profileId, date).map((d) => d.name),
    pageStrip: cellOn(pageStrip(profileId, itemName, STRIP_DAYS), date),
    evidenceStrip: cellOn(
      evidenceStrip(profileId, itemName, DEMOTION_WINDOW_DAYS),
      date
    ),
    recapDay: recapDay ?? null,
    digestYesterday: gatherDigestInput(profileId, "Digest").adherence,
  };
}

describe("a PAUSED day is removed everywhere, not missed on the summaries (#1296/#3993)", () => {
  it("the rough day the app itself would not have offered is never reported as a miss", () => {
    const p = newProfile();
    seedItem(p, "Lisinopril", "paused-by", "medication", "must");
    const yd = shiftDateStr(today(p), -1);
    // 8h nights across the window, 5h on the night ending yesterday.
    seedNights(p, DEMOTION_WINDOW_DAYS + 2, [1]);

    // THE CONTROL COMES FIRST, because "removed" is the flattering answer and an item
    // that never came due anywhere would satisfy it on every day. The day before
    // yesterday had a healthy night, so it is owed — and unlogged, so it is a miss —
    // on every one of the same six readers.
    const control = shiftDateStr(today(p), -2);
    expect(everySurfaceOn(p, control, "Lisinopril")).toEqual({
      reminderRebuild: ["Lisinopril"],
      catchUpSheet: ["Lisinopril"],
      pageStrip: "missed",
      evidenceStrip: "missed",
      recapDay: { date: control, due: 1, taken: 0, skipped: 0 },
      digestYesterday: null,
    });

    // Yesterday: the pause held, so no surface offered the dose — and none of the three
    // summaries may call it due, least of all the digest, which states it in a push.
    expect(everySurfaceOn(p, yd, "Lisinopril")).toEqual({
      reminderRebuild: [],
      catchUpSheet: [],
      pageStrip: "na",
      evidenceStrip: "na",
      recapDay: null,
      digestYesterday: null,
    });
  });
});

describe("a dose the sheet OFFERED and the person logged is counted (#3993)", () => {
  it("no summary discards a log for a day it scored itself", () => {
    const p = newProfile();
    const doseId = seedItem(p, "Magnesium", "due-on", "supplement", "should");
    const yd = shiftDateStr(today(p), -1);
    seedNights(p, DEMOTION_WINDOW_DAYS + 2, [1]);

    // THE OFFER — the surface that invites the person into the discard. Asserted before
    // the log, because a sheet that offered nothing makes everything below vacuous.
    expect(pendingDayDoses(p, yd).map((d) => d.name)).toEqual(["Magnesium"]);
    takeOn(doseId, yd);

    expect(everySurfaceOn(p, yd, "Magnesium")).toEqual({
      // The rebuild still names the dose the day OWED (it is the unfiltered gather, and
      // the message carries the answered state); the sheet, which offers only what is
      // still open, has nothing left.
      reminderRebuild: ["Magnesium"],
      catchUpSheet: [],
      pageStrip: "taken",
      evidenceStrip: "taken",
      recapDay: { date: yd, due: 1, taken: 1, skipped: 0 },
      digestYesterday: { taken: 1, skipped: 0, due: 1 },
    });

    // And the healthy day beside it is `na` rather than a miss: the situational item was
    // never owed on it. Same fixture, opposite answer, so the row above is a reading of
    // the day rather than of the item.
    const control = shiftDateStr(today(p), -2);
    expect([
      cellOn(pageStrip(p, "Magnesium", STRIP_DAYS), control),
      cellOn(evidenceStrip(p, "Magnesium", DEMOTION_WINDOW_DAYS), control),
    ]).toEqual(["na", "na"]);
  });
});

describe("the demotion evidence and the strip above it are the same days (#3993)", () => {
  // lib/supplement-demotion.ts states this outright: the evidence is "the same per-day
  // aggregation the Supplements page renders, so the suggestion can never disagree with
  // the strip the user is looking at". `<DemotionSuggestions>` carries a one-tap Accept
  // that demotes the item's obligation, so the two are on ONE screen and one of them is
  // behind a button.
  it("a month of rough nights moves both strips or neither", () => {
    const p = newProfile();
    seedItem(p, "Atorvastatin", "paused-by", "medication", "must");
    const rough = [1, 4, 9, 16, 23];
    seedNights(p, DEMOTION_WINDOW_DAYS + 2, rough);

    const page = pageStrip(p, "Atorvastatin", DEMOTION_WINDOW_DAYS);
    const evidence = evidenceStrip(p, "Atorvastatin", DEMOTION_WINDOW_DAYS);
    const states = (s: AdherenceDot[]) =>
      Object.fromEntries(s.map((d) => [d.date, d.state]));

    // NOT VACUOUS: the fixture has to contain both answers, or "the two agree" is a
    // statement about a strip with one state in it.
    const counts = page.reduce<Record<string, number>>((acc, d) => {
      acc[d.state] = (acc[d.state] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts.na).toBe(rough.filter((r) => r >= 1).length);
    expect(counts.missed).toBe(page.length - counts.na);

    expect(states(evidence)).toEqual(states(page));
  });
});
