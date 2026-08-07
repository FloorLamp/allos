import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { resolveSituationId, setProfileSetting } from "@/lib/settings";
import {
  serializeSituationEvents,
  type SituationEvent,
} from "@/lib/trend-annotations";
import { logTemperatureCore } from "@/lib/temperature-log";
import { logSymptomCore } from "@/lib/symptom-log-write";
import {
  assembleIllnessEpisode,
  episodeForProfileDate,
} from "@/lib/illness-episode";
import { schoolReturnStatusFor } from "@/lib/school-return-data";
import { staleEpisodeNudgeFor, ackStaleNudge } from "@/lib/stale-episode-data";
import { updateHistoricalDose } from "@/lib/queries";

// DB-tier gather tests for the school-return countdown (#859 item 2) and the
// stale-open-episode nudge (#859 item 1) — the input layer the pure tier can't see.

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function makeSick(p: number, startDaysAgo: number) {
  resolveSituationId(p, "Illness");
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(p);
  const events: SituationEvent[] = [
    {
      date: shiftDateStr(today(p), -startDaysAgo),
      situation: "Illness",
      change: "start",
    },
  ];
  setProfileSetting(
    p,
    "situation_events",
    serializeSituationEvents([], events)
  );
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(p, shiftDateStr(today(p), -startDaysAgo));
}

// Insert a taken PRN administration of a named item at a fixed UTC given_at.
// Returns the ids so a test can drive the real amend path against the log row.
function addAntipyretic(
  p: number,
  name: string,
  date: string,
  givenAtUtc: string
): { itemId: number; logId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', datetime('now'))`
      )
      .run(p, name).lastInsertRowid
  );
  const dose = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '200 mg', 'any', 'any', 0, datetime('now'))`
      )
      .run(itemId).lastInsertRowid
  );
  const logId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, given_at, status)
         VALUES (?, ?, ?, '200 mg', ?, 'taken')`
      )
      .run(dose, itemId, date, givenAtUtc).lastInsertRowid
  );
  return { itemId, logId };
}

describe("schoolReturnStatusFor — gather (#859 item 2)", () => {
  it("returns null before any fever-range reading exists", () => {
    const p = newProfile("sr-nofever");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 1);
    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, today(p))!);
    expect(schoolReturnStatusFor(p, ep)).toBeNull();
  });

  it("computes fever-free + antipyretic clocks, antipyretic class from the #798 dataset", () => {
    const p = newProfile("sr-fever");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 2);
    const td = today(p);
    // Fever reading at 09:00 UTC today; ibuprofen at 06:00 UTC today.
    logTemperatureCore(p, 101.5, "F", td, "09:00");
    addAntipyretic(p, "Ibuprofen", td, `${td} 06:00:00`);

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const nowMs = Date.parse(`${td}T20:00:00Z`);
    const s = schoolReturnStatusFor(p, ep, nowMs);
    expect(s).not.toBeNull();
    expect(s!.feverFreeHours).toBe(11); // 20:00 - 09:00
    expect(s!.hoursSinceAntipyretic).toBe(14); // 20:00 - 06:00
    // Cleared clock runs from the LATER event (the fever reading at 09:00).
    expect(s!.clearedForHours).toBe(11);
    expect(s!.met).toBe(false);
    expect(s!.lastAntipyreticName).toBe("Ibuprofen");
    // #2228 decision 4: nobody stated an intake time (`occurred_at` is unwritten),
    // so the note's clock is the RECORD chain and says so — "last ibuprofen
    // recorded 6:00am", never a bare clock claiming an administration time.
    expect(s!.lastAntipyreticClockLabel).toBe("recorded 6:00am");
  });

  it("a stated occurred_at renders the note's clock unmarked (#2228)", () => {
    const p = newProfile("sr-stated");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 1);
    const td = today(p);
    logTemperatureCore(p, 101.5, "F", td, "09:00");
    addAntipyretic(p, "Ibuprofen", td, `${td} 07:15:00`);
    // The caregiver stated when it was actually given; the filing stamp stays put.
    db.prepare(
      `UPDATE intake_item_logs SET occurred_at = ? WHERE date = ?`
    ).run(`${td}T06:00:00Z`, td);

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T20:00:00Z`));
    expect(s).not.toBeNull();
    expect(s!.hoursSinceAntipyretic).toBe(14); // measured from the STATED instant
    expect(s!.lastAntipyreticClockLabel).toBe("6:00am");
  });

  it("a caregiver's stated time moves the clearance clock — end to end through the amend path (#2228)", () => {
    const p = newProfile("sr-amend");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 2);
    const td = today(p);
    // Everything on YESTERDAY so no stated wall time can read as future whatever
    // real hour the tier runs at; the countdown's `now` is injected anyway.
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 101.5, "F", yd, "09:00");
    const { itemId, logId } = addAntipyretic(
      p,
      "Ibuprofen",
      yd,
      `${yd} 07:00:00`
    );

    const nowMs = Date.parse(`${yd}T20:00:00Z`);
    const ep = () => assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const before = schoolReturnStatusFor(p, ep(), nowMs)!;
    // Nobody has stated an intake time: the clock runs from the filing stamp and
    // the note SAYS so.
    expect(before.hoursSinceAntipyretic).toBe(13); // 20:00 − 07:00
    expect(before.lastAntipyreticClockLabel).toBe("recorded 7:00am");

    // The caregiver amends the dose, stating it was actually given at 04:00 —
    // the real write path (#2228 decision 1), not a hand-set column.
    expect(
      updateHistoricalDose(
        p,
        itemId,
        logId,
        yd,
        new Date(`${yd}T04:00:00Z`),
        null
      )
    ).toEqual({ kind: "logged", date: yd });

    // The clearance clock now measures from the STATED instant (the correct
    // clinical reading — bestKnownInstant prefers the event), and the note's
    // clock renders unmarked. The filing stamp itself is untouched history.
    const after = schoolReturnStatusFor(p, ep(), nowMs)!;
    expect(after.hoursSinceAntipyretic).toBe(16); // 20:00 − 04:00
    expect(after.lastAntipyreticClockLabel).toBe("4:00am");
    expect(
      db
        .prepare(`SELECT given_at FROM intake_item_logs WHERE id = ?`)
        .get(logId)
    ).toEqual({ given_at: `${yd} 07:00:00` });
  });

  it("a NON-antipyretic PRN doesn't count as a fever reducer", () => {
    const p = newProfile("sr-nonanti");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 1);
    const td = today(p);
    logTemperatureCore(p, 101.5, "F", td, "09:00");
    addAntipyretic(p, "Benadryl", td, `${td} 06:00:00`); // antihistamine

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T20:00:00Z`));
    expect(s).not.toBeNull();
    expect(s!.hoursSinceAntipyretic).toBeNull(); // Benadryl isn't a fever reducer
    expect(s!.lastAntipyreticName).toBeNull();
  });
});

describe("staleEpisodeNudgeFor — gather (#859 item 1)", () => {
  it("a quiet open episode yields a nudge; an active one does not", () => {
    const quiet = newProfile("stale-quiet");
    makeSick(quiet, 7);
    logSymptomCore(quiet, "cough", 2, shiftDateStr(today(quiet), -5));
    const nudge = staleEpisodeNudgeFor(quiet);
    expect(nudge).not.toBeNull();
    expect(nudge!.lastActivityDate).toBe(shiftDateStr(today(quiet), -5));
    expect(nudge!.quietDays).toBe(5);

    const active = newProfile("stale-active");
    makeSick(active, 7);
    logSymptomCore(active, "cough", 2, today(active)); // logged today
    expect(staleEpisodeNudgeFor(active)).toBeNull();
  });

  it("a dismissed nudge stays silenced for that episode", () => {
    const p = newProfile("stale-ack");
    makeSick(p, 7);
    logSymptomCore(p, "cough", 2, shiftDateStr(today(p), -5));
    const nudge = staleEpisodeNudgeFor(p);
    expect(nudge).not.toBeNull();
    ackStaleNudge(p, nudge!.episodeId);
    expect(staleEpisodeNudgeFor(p)).toBeNull();
  });

  it("respects a custom quiet threshold", () => {
    const p = newProfile("stale-threshold");
    makeSick(p, 7);
    logSymptomCore(p, "cough", 2, shiftDateStr(today(p), -2)); // 2 quiet days
    expect(staleEpisodeNudgeFor(p, 2)).not.toBeNull();
    expect(staleEpisodeNudgeFor(p, 3)).toBeNull();
  });
});
