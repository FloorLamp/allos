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
import {
  schoolReturnCompactClause,
  schoolReturnCompactLabel,
} from "@/lib/school-return";
import { staleEpisodeNudgeFor, ackStaleNudge } from "@/lib/stale-episode-data";
import {
  cockpitSummaryLine,
  episodeCollapsedStatus,
} from "@/lib/illness-episode-format";
import { fmtTemp } from "@/lib/units";
import { updateHistoricalDose, setDoseStatusCore } from "@/lib/queries";
import { restampDoseLogsCore } from "@/lib/queries/intake/adherence";

// The clock is FROZEN for the whole tier (#4509), late on its own UTC day, so every
// wall time this file states has already happened and `logTemperatureCore` judges it
// against a fixed instant rather than against lunchtime. The per-file pin this used to
// carry is retired with the rest of them; the profiles here are UTC.

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

// Insert a PRN administration of a named item at a fixed UTC recorded_at — `taken` by
// default, `skipped` for the flip fixture below. Returns the ids so a test can drive
// the real amend and tri-state paths against the log row.
function addAntipyretic(
  p: number,
  name: string,
  date: string,
  recordedAtUtc: string,
  status: "taken" | "skipped" = "taken"
): { itemId: number; doseId: number; logId: number } {
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
        `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, recorded_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        dose,
        itemId,
        date,
        status === "taken" ? "200 mg" : null,
        recordedAtUtc,
        status
      ).lastInsertRowid
  );
  return { itemId, doseId: dose, logId };
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
    // Fever reading at 09:00 UTC today, a NORMAL one at 12:00 (the evidence the
    // clock starts on, #4685); ibuprofen STATED at 06:00 UTC today — the clock
    // computes from a stated administration time and from nothing else (#5688).
    logTemperatureCore(p, 101.5, "F", td, "page", "09:00");
    logTemperatureCore(p, 98.6, "F", td, "page", "12:00");
    const { logId } = addAntipyretic(p, "Ibuprofen", td, `${td} 07:30:00`);
    db.prepare(`UPDATE intake_item_logs SET occurred_at = ? WHERE id = ?`).run(
      `${td}T06:00:00Z`,
      logId
    );

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const nowMs = Date.parse(`${td}T20:00:00Z`);
    const s = schoolReturnStatusFor(p, ep, nowMs);
    expect(s).not.toBeNull();
    expect(s!.evidence).toBe("measured");
    expect(s!.hoursSinceFever).toBe(11); // 20:00 - 09:00
    expect(s!.hoursSinceAntipyretic).toBe(14); // 20:00 - 06:00, the STATED instant
    // Cleared clock runs from the LATER event (the normal reading at 12:00).
    expect(s!.clearedForHours).toBe(8);
    expect(s!.met).toBe(false);
    expect(s!.lastAntipyreticName).toBe("Ibuprofen");
    expect(s!.lastAntipyreticClockLabel).toBe("6:00am");
  });

  // THE SILENCE CASE (#4685), the owner's screenshot end to end: a fever reading and
  // nothing since. There IS a status — the episode has had a fever — but it carries no
  // fever-free claim, and no threshold can make one out of unmeasured hours.
  it("a fever with no reading since renders the honest state, and met stays false", () => {
    const p = newProfile("sr-silent");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 2);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 103.4, "F", yd, "page", "19:10");

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    // 09:16 the next morning — 14h of unmeasured night.
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T09:16:00Z`))!;
    expect(s.evidence).toBe("none");
    expect(s.hoursSinceFever).toBe(14);
    expect(s.clearedForHours).toBeNull();
    expect(s.met).toBe(false);
    expect(schoolReturnCompactClause(s)).toBe(
      "no reading since 103.4 °F (14h ago)"
    );
    // Two days of silence is still silence, not a met guideline.
    const later = schoolReturnStatusFor(
      p,
      ep,
      Date.parse(`${td}T09:16:00Z`) + 48 * 3_600_000
    )!;
    expect(later.met).toBe(false);
    expect(schoolReturnCompactClause(later)).not.toContain("fever-free");
  });

  // A HYPOTHERMIC READING IS NOT CLEARANCE. Skipping only the fever flag let 95.0 °F
  // start the fever-free clock — "Fever-free 24h/24h, met" off a reading that is its
  // own red flag. Evidence is a reading that is IN RANGE, in either direction.
  it("an out-of-range LOW reading does not start the fever-free clock", () => {
    const p = newProfile("sr-hypothermic");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 2);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 103.4, "F", yd, "page", "06:00");
    logTemperatureCore(p, 95.0, "F", yd, "page", "07:00");

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T09:16:00Z`))!;
    expect(s.evidence).toBe("none");
    expect(s.met).toBe(false);
    expect(schoolReturnCompactClause(s)).toContain("no reading since");

    // …and a genuinely in-range reading after it DOES, so the guard is not simply
    // refusing everything (the converse, from the same fixture).
    logTemperatureCore(p, 98.6, "F", yd, "page", "08:00");
    const after = schoolReturnStatusFor(
      p,
      assembleIllnessEpisode(p, episodeForProfileDate(p, td)!),
      Date.parse(`${td}T09:16:00Z`)
    )!;
    expect(after.evidence).toBe("measured");
  });

  // ORDERING MUST BE ESTABLISHED, NOT ASSUMED. An UNTIMED reading is anchored at local
  // noon so it has somewhere to sit on the clock — but noon is a placeholder, not a
  // measurement, so a same-day reading cannot be proven to have come after it. With a
  // fever row that states no time, a normal reading at 13:00 the same day beat noon and
  // cleared the child, even though the fever may well have been at 19:10.
  it("a same-day reading cannot outrank an UNTIMED fever", () => {
    const p = newProfile("sr-untimed-fever");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 2);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    // The fever states no time (the row type a past-day backfill produces).
    logTemperatureCore(p, 103.4, "F", yd, "page", null);
    logTemperatureCore(p, 98.6, "F", yd, "page", "13:00");

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T13:00:00Z`))!;
    expect(s.evidence).toBe("none");
    expect(s.met).toBe(false);

    // …and the converse: a reading on a LATER DAY is unambiguously after it, whatever
    // hour either row states, so it IS evidence.
    logTemperatureCore(p, 98.4, "F", td, "page", "08:00");
    const after = schoolReturnStatusFor(
      p,
      assembleIllnessEpisode(p, episodeForProfileDate(p, td)!),
      Date.parse(`${td}T13:00:00Z`)
    )!;
    expect(after.evidence).toBe("measured");
  });

  it("a same-day UNTIMED reading cannot outrank a timed fever either", () => {
    const p = newProfile("sr-untimed-normal");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 2);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 103.4, "F", yd, "page", "06:00");
    // Noon > 06:00 arithmetically, but the reading states no time at all.
    logTemperatureCore(p, 98.6, "F", yd, "page", null);

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T13:00:00Z`))!;
    expect(s.evidence).toBe("none");
  });

  // THE SELECTION, NOT THE COMPARISON. An UNTIMED fever sharing a day with a timed one
  // was never compared at all: noon arithmetic picked the timed 100.9 as "the last
  // fever", the 103.4 nobody could place dropped out, and the surface cleared the
  // child while quoting the lower reading back.
  it("an unplaced fever governs its day over a timed one", () => {
    const p = newProfile("sr-unplaced-fever");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 3);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    // The timed fever is LATER THAN NOON, so the retired arithmetic genuinely preferred
    // it over the unplaced 103.4 — without that the fixture cannot reach the state it
    // forbids, and passes for the wrong reason.
    logTemperatureCore(p, 100.9, "F", yd, "page", "19:00");
    logTemperatureCore(p, 103.4, "F", yd, "page", null); // unplaced, same day
    logTemperatureCore(p, 98.6, "F", yd, "page", "20:00");

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    // 24h after the 20:00 normal: the retired rule read "fever-free 24h/24h, met",
    // quoting 100.9 back as the last fever.
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T20:00:00Z`))!;
    // The unplaced 103.4 governs the ORDERING — so the 20:00 normal cannot be proven
    // later and there is no fever-free claim — while the QUOTED reading stays the
    // latest one somebody actually measured. A placeholder orders; it never speaks.
    expect(s.evidence).toBe("none");
    expect(s.met).toBe(false);
    expect(s.lastFeverDegF).toBe(100.9);
  });

  // AND THE PLACEHOLDER NEVER OUT-QUOTES A REAL READING. An unplaced 100.5 beside a
  // later, higher, placed 103.4 read "No reading since 100.5 °F (14h ago)": the lower
  // reading quoted back and the elapsed time doubled, both off a noon anchor, both in
  // the reassuring direction.
  it("quotes the last MEASURED fever, not the unplaced one", () => {
    const p = newProfile("sr-quoted-fever");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 3);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 100.5, "F", yd, "page", null); // unplaced → noon
    logTemperatureCore(p, 103.4, "F", yd, "page", "19:00"); // later, higher, measured

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T02:00:00Z`))!;
    expect(s.lastFeverDegF).toBe(103.4);
    expect(s.hoursSinceFever).toBe(7); // 02:00 − 19:00, not 14h off the placeholder
  });

  it("a stated occurred_at renders the note's clock unmarked (#2228)", () => {
    const p = newProfile("sr-stated");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 1);
    const td = today(p);
    logTemperatureCore(p, 101.5, "F", td, "page", "09:00");
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
    logTemperatureCore(p, 101.5, "F", yd, "page", "09:00");
    // The clock's evidence (#4685) — without a normal reading after the fever there is
    // no countdown for the hold to act on, and this test is about the countdown.
    logTemperatureCore(p, 98.6, "F", yd, "page", "10:00");
    const { itemId, logId } = addAntipyretic(
      p,
      "Ibuprofen",
      yd,
      `${yd} 07:00:00`
    );

    const nowMs = Date.parse(`${yd}T20:00:00Z`);
    const ep = () => assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const before = schoolReturnStatusFor(p, ep(), nowMs)!;
    // Nobody has stated an intake time, so there is no clock to run: the countdown is
    // HELD (#5688) and the note names the reducer with its filing stamp marked as one.
    expect(before.evidence).toBe("held");
    expect(before.hoursSinceAntipyretic).toBeNull();
    expect(before.met).toBe(false);
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
    expect(after.evidence).toBe("measured"); // the hold is released
    expect(after.hoursSinceAntipyretic).toBe(16); // 20:00 − 04:00
    expect(after.clearedForHours).toBe(10); // from the 10:00 normal reading
    expect(after.lastAntipyreticClockLabel).toBe("4:00am");
    expect(
      db
        .prepare(`SELECT recorded_at FROM intake_item_logs WHERE id = ?`)
        .get(logId)
    ).toEqual({ recorded_at: `${yd} 07:00:00` });
  });

  // ── THE CLOCK NEEDS A STATED ADMINISTRATION TIME (#5688) ───────────────────
  //
  // THE REPRODUCING CASE, end to end through the real tri-state write. A caregiver
  // skips yesterday's 07:00 ibuprofen, then flips that row to taken — and a PAST-DAY
  // flip states no minute (`takenAt: null`, #4428) while `recorded_at` deliberately
  // stays put as the SKIP's stamp. So the row's only instant is 07:00, hours BEFORE
  // the dose was actually given. The old clock counted from it and cleared the child.
  it("a past-day skipped→taken flip HOLDS the countdown instead of clearing early", () => {
    const p = newProfile("sr-flip");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 3);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 103.4, "F", yd, "page", "06:00");
    logTemperatureCore(p, 98.6, "F", yd, "page", "08:00"); // the clock's evidence
    const { doseId, logId } = addAntipyretic(
      p,
      "Ibuprofen",
      yd,
      `${yd} 07:00:00`,
      "skipped"
    );

    // The flip itself — the shipped path, not a hand-set column.
    setDoseStatusCore(p, doseId, yd, "taken", "page", { takenAt: null });
    expect(
      db
        .prepare(
          `SELECT status, occurred_at, recorded_at FROM intake_item_logs WHERE id = ?`
        )
        .get(logId)
    ).toEqual({
      status: "taken",
      occurred_at: null, // a past-day flip states no minute…
      recorded_at: `${yd} 07:00:00`, // …and the SKIP's stamp is what remains
    });

    // 25h after the normal reading, and the retired arithmetic read exactly that:
    // max(normal 08:00, "antipyretic" 07:00) = 08:00, 25h ≥ 24h, convention MET —
    // a clearance resting on a stamp the dose itself may postdate by hours.
    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T09:00:00Z`))!;
    expect(s.evidence).toBe("held");
    expect(s.met).toBe(false);
    expect(s.clearedForHours).toBeNull();
    expect(s.hoursSinceAntipyretic).toBeNull();
    expect(schoolReturnCompactClause(s)).toBe(
      "fever-free clock held — add the ibuprofen time in Dose history"
    );
  });

  // THE DISCRIMINATION THE FIX RESTS ON. Dropping an unstated dose would also keep the
  // filing stamp out of the arithmetic — and would be MORE permissive, because the
  // clock then runs from the normal reading and clears. The held state must therefore
  // be distinguishable from "no fever reducer was taken" on the same fixture.
  it("holding is not the same as having no fever reducer at all", () => {
    const make = (label: string, withDose: boolean) => {
      const p = newProfile(label);
      setProfileSetting(p, "timezone", "UTC");
      makeSick(p, 3);
      const td = today(p);
      const yd = shiftDateStr(td, -1);
      logTemperatureCore(p, 103.4, "F", yd, "page", "06:00");
      logTemperatureCore(p, 98.6, "F", yd, "page", "08:00");
      if (withDose) addAntipyretic(p, "Ibuprofen", yd, `${yd} 07:00:00`);
      const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
      return schoolReturnStatusFor(p, ep, Date.parse(`${td}T09:00:00Z`))!;
    };
    const held = make("sr-disc-held", true);
    const nothing = make("sr-disc-none", false);

    // With no reducer on record the clock genuinely runs, and at 25h it clears.
    expect(nothing.evidence).toBe("measured");
    expect(nothing.met).toBe(true);
    expect(schoolReturnCompactClause(nothing)).toBe("fever-free 25h of 24");

    // With an unstated one it does not — and says which dose is holding it.
    expect(held.evidence).toBe("held");
    expect(held.met).toBe(false);
    expect(held.lastAntipyreticName).toBe("Ibuprofen");
    expect(schoolReturnCompactClause(held)).not.toBe(
      schoolReturnCompactClause(nothing)
    );
  });

  // THE HOLD ENDS WHEN THE DOSE PROVABLY CANNOT MATTER. An unstated dose two days back
  // could have been given no later than the end of its day, which is past the
  // threshold, so it cannot be inside the fever-free window however it is placed and
  // the clock computes from the stated dose instead. This is what keeps the door
  // meaningful on a long episode.
  it("an unstated dose past the threshold no longer holds a later stated one", () => {
    const p = newProfile("sr-older-unstated");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 4);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    const dbd = shiftDateStr(td, -2);
    logTemperatureCore(p, 103.4, "F", dbd, "page", "06:00");
    logTemperatureCore(p, 98.6, "F", dbd, "page", "08:00");
    addAntipyretic(p, "Ibuprofen", dbd, `${dbd} 07:00:00`); // unstated, older
    const { logId } = addAntipyretic(p, "Ibuprofen", yd, `${yd} 20:30:00`);
    db.prepare(`UPDATE intake_item_logs SET occurred_at = ? WHERE id = ?`).run(
      `${yd}T20:00:00Z`,
      logId
    );

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T08:00:00Z`))!;
    expect(s.evidence).toBe("measured");
    expect(s.hoursSinceAntipyretic).toBe(12); // 08:00 − yesterday 20:00
    expect(s.clearedForHours).toBe(12); // the stated dose governs, not the stamp
    expect(s.met).toBe(false);
  });

  // THE SEAM OF THE HOLD RULE ITSELF. An unstated dose is bounded by the latest moment
  // it could have been given — the end of its schedule-owned day, or its capture stamp
  // if it was filed later. Inside the threshold of that bound it could still be
  // masking, so it holds; past it, it provably cannot be, so the clock computes. Both
  // sides of the same fixture, because a rule tested only where it fires is half tested.
  it("holds until the dose provably cannot be inside the fever-free window", () => {
    const p = newProfile("sr-bound");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 4);
    const td = today(p);
    const d0 = shiftDateStr(td, -2);
    const d1 = shiftDateStr(td, -1);
    logTemperatureCore(p, 103.4, "F", d0, "page", "00:00");
    logTemperatureCore(p, 98.6, "F", d0, "page", "00:30");
    addAntipyretic(p, "Ibuprofen", d0, `${d0} 01:00:00`);

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    // The dose could have been given as late as the end of d0 (= d1 00:00). At d1
    // 23:00 that is 23h ago — inside a 24h threshold, so it still holds.
    const inside = schoolReturnStatusFor(p, ep, Date.parse(`${d1}T23:00:00Z`))!;
    expect(inside.evidence).toBe("held");
    expect(inside.met).toBe(false);

    // An hour and a half later it is 24.5h ago: no placement of that dose puts it in
    // the window, so the countdown runs again — from the measured normal reading.
    const outside = schoolReturnStatusFor(
      p,
      ep,
      Date.parse(`${td}T00:30:00Z`)
    )!;
    expect(outside.evidence).toBe("measured");
    expect(outside.hoursSinceAntipyretic).toBeNull(); // still no stated time to count
    expect(outside.met).toBe(true);
  });

  // THE MIDNIGHT-CROSSING REPRODUCTION (#5688 falsifying pass). A dose's day is
  // SCHEDULE-OWNED (#614): `restampDoseLogsCore` moves `occurred_at` across midnight and
  // leaves `date` where the schedule put it, reporting `crossedMidnight` for exactly
  // this. So a dose dated TODAY can have been given YESTERDAY, and an earlier pass of
  // this fix — which scoped the hold to MAX(date) — dropped yesterday's unstated dose
  // as "not the last one" and cleared the child on a reducer nobody placed. That is the
  // same unearned clearance #5688 exists to close, so the bound is an INSTANT now.
  it("a dose dated today but GIVEN yesterday does not unscope the hold", () => {
    const p = newProfile("sr-crossing");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 3);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 103.4, "F", yd, "page", "00:00");
    logTemperatureCore(p, 98.6, "F", yd, "page", "00:30"); // the clock's evidence

    // A: yesterday's ibuprofen, never placed.
    addAntipyretic(p, "Ibuprofen", yd, `${yd} 01:00:00`);
    // B: confirmed TODAY with a stated time, then corrected back across midnight to
    // 00:05 YESTERDAY through the real correction path.
    const b = addAntipyretic(p, "Acetaminophen", td, `${td} 02:00:00`);
    db.prepare(`UPDATE intake_item_logs SET occurred_at = ? WHERE id = ?`).run(
      `${td}T02:00:00Z`,
      b.logId
    );
    const out = restampDoseLogsCore(
      p,
      b.logId,
      () => new Date(`${yd}T00:05:00Z`)
    );
    expect(out).toMatchObject({ kind: "restamped", crossedMidnight: true });
    expect(
      db
        .prepare(`SELECT date, occurred_at FROM intake_item_logs WHERE id = ?`)
        .get(b.logId)
    ).toEqual({ date: td, occurred_at: `${yd}T00:05:00Z` });

    // 24h after the normal reading. A MAX(date) hold scope put the "last" dose on
    // today (B, stated), dropped the unstated A as an earlier day's, and rendered
    // "fever-free 24h of 24" — while A could have been given as late as 23:59
    // yesterday, about an hour before the note claimed 24 fever-free hours.
    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T00:30:00Z`))!;
    expect(s.evidence).toBe("held");
    expect(s.met).toBe(false);
    expect(s.lastAntipyreticName).toBe("Ibuprofen");
  });

  // THE HELD CLAUSE AND THE DOSE CLAUSE MUST NOT CONTRADICT EACH OTHER. The cockpit
  // line prints the school-return clause beside the episode's last dose, and that dose
  // clause quoted the record-chain clock BARE — so the held arm rendered "add the
  // ibuprofen time in Dose history · last med Ibuprofen Yesterday, 07:00", asking for a
  // time while appearing to state one. `timeRecorded` is the flag the assembly already
  // sets; the collapsed line now marks the clock with it, like the timeline always has.
  it("the cockpit line does not quote a filing stamp beside the held clause", () => {
    const p = newProfile("sr-cockpit-held");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 3);
    const td = today(p);
    const yd = shiftDateStr(td, -1);
    logTemperatureCore(p, 103.4, "F", yd, "page", "06:00");
    logTemperatureCore(p, 98.6, "F", yd, "page", "08:00");
    addAntipyretic(p, "Ibuprofen", yd, `${yd} 07:00:00`);

    const ep = assembleIllnessEpisode(p, episodeForProfileDate(p, td)!);
    const s = schoolReturnStatusFor(p, ep, Date.parse(`${td}T09:00:00Z`))!;
    expect(s.evidence).toBe("held");

    const line = cockpitSummaryLine(episodeCollapsedStatus(ep, "F"), {
      clearedForHours: s.clearedForHours,
      thresholdHours: s.thresholdHours,
      met: s.met,
      label: schoolReturnCompactLabel(s, "F"),
      lastFeverLabel: fmtTemp(s.lastFeverDegF, "F"),
      noReadingSinceFever: s.evidence === "none",
    });
    expect(line).toContain("add the ibuprofen time in Dose history");
    // The dose's clock is still there, with its provenance — never a bare clock that
    // reads as the time it was given.
    expect(line).toContain("last med Ibuprofen recorded Yesterday, 07:00");
    expect(line).not.toContain("last med Ibuprofen Yesterday, 07:00");
    // And the held arm never borrows the silent arm's sentence.
    expect(line).not.toContain("No reading since");
  });

  it("a NON-antipyretic PRN doesn't count as a fever reducer", () => {
    const p = newProfile("sr-nonanti");
    setProfileSetting(p, "timezone", "UTC");
    makeSick(p, 1);
    const td = today(p);
    logTemperatureCore(p, 101.5, "F", td, "page", "09:00");
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
    logSymptomCore(quiet, "cough", 2, shiftDateStr(today(quiet), -5), "page");
    const nudge = staleEpisodeNudgeFor(quiet);
    expect(nudge).not.toBeNull();
    expect(nudge!.lastActivityDate).toBe(shiftDateStr(today(quiet), -5));
    expect(nudge!.quietDays).toBe(5);

    const active = newProfile("stale-active");
    makeSick(active, 7);
    logSymptomCore(active, "cough", 2, today(active), "page"); // logged today
    expect(staleEpisodeNudgeFor(active)).toBeNull();
  });

  it("a dismissed nudge stays silenced for that episode", () => {
    const p = newProfile("stale-ack");
    makeSick(p, 7);
    logSymptomCore(p, "cough", 2, shiftDateStr(today(p), -5), "page");
    const nudge = staleEpisodeNudgeFor(p);
    expect(nudge).not.toBeNull();
    ackStaleNudge(p, nudge!.episodeId);
    expect(staleEpisodeNudgeFor(p)).toBeNull();
  });

  it("respects a custom quiet threshold", () => {
    const p = newProfile("stale-threshold");
    makeSick(p, 7);
    logSymptomCore(p, "cough", 2, shiftDateStr(today(p), -2), "page"); // 2 quiet days
    expect(staleEpisodeNudgeFor(p, 2)).not.toBeNull();
    expect(staleEpisodeNudgeFor(p, 3)).toBeNull();
  });
});
