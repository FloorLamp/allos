// SERVER-ACTION TIER — the record's cross-profile corrections (#4009 item 1, #2106).
//
// `/history?view=everyone` merges every in-view member's rows, and #3958 rules that
// "⋯ additionally requires write access on the row's profile (#2106), re-checked
// server-side". Phase 1 met only the safety half: it rendered other members' rows
// read-only, because every correction action resolved its subject from the session.
//
// THE ACCEPTANCE THIS FILE EXISTS FOR IS THE REFUSAL, NOT THE ABSENCE. #4009 states it
// exactly: "a test proves a forged submit for a profile this login cannot write is
// refused — not merely that the button is absent." A missing ⋯ is a claim about the
// RENDERER; it is satisfied by a page that draws nothing and by a page whose action
// would happily have written. Only a post that reaches the action can tell those apart,
// so every case below builds the FormData a forged submit would carry and calls the
// real exported action, with a real DB behind it and only auth mocked.
//
// Three positions per action, because a one-sided gate is the failure mode: an
// UNGRANTED profile is refused, a READ-ONLY-granted profile is refused, and a
// WRITE-granted profile LANDS on the target rather than on the acting profile. The
// third is not a formality — a gate that refused everything would pass the first two
// and would have taken the capability away instead of granting it.
//
// SYMPTOM AND CYCLE JOIN THE TABLE IN PHASE 2D, and they arrive from the other
// direction. Phase 2b put them on the record and found all three of their cores
// resolving the subject from the SESSION, so it CONTAINED the gap — the ⋯ was drawn
// only on the acting profile's own symptom and cycle rows — and proved the containment
// in its own file. #3958's multiprofile clause asks for the capability, not the
// containment, so those cores now take the row's subject like the other ten and that
// file is folded in here: the containment case it held is this table's third arm with
// the same fixture and the opposite verdict.
//
// ITS TWO LOAD-BEARING PROPERTIES SURVIVE THE FOLD, because both are what make a
// green here mean anything. BOTH profiles are granted to the acting login in every
// case that must LAND, so a refusal can only come from the action's own scoping and
// never from the login lacking access. And every assertion reads THE STORE rather than
// the return value — three of these actions answer a `{kind:"not-found"}` union
// instead of throwing, so the promise's shape cannot tell a refusal from a write that
// landed on the wrong person.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { setStoredAge } from "@/lib/settings/profile-attrs";
import { setTimezone } from "@/lib/settings";
import {
  deleteAdministration,
  updateHistoricalDose,
} from "@/app/(app)/nutrition/intake-actions";
import {
  deleteFoodLogEvent,
  updateFoodLogEvent,
} from "@/app/(app)/nutrition/actions";
import {
  editPracticeSession,
  removePracticeSession,
} from "@/app/(app)/wellness/actions";
import {
  deleteSubstanceDailyTotalAction,
  updateSubstanceDailyTotalAction,
} from "@/app/(app)/medical/substance-use/actions";
import {
  deleteMetricReading,
  updateMetricReading,
} from "@/app/(app)/trends/reading-actions";
import { editSymptom, removeSymptom } from "@/app/(app)/symptom-actions";
import {
  deleteCycleAction,
  saveCycleAction,
} from "@/app/(app)/medical/cycles/actions";
import { setSymptomSeverityCore } from "@/lib/symptom-log-write";
import { createCycleRow } from "@/lib/cycle-store";
import { createLogin, createProfile, actAs, fd } from "./harness";

// ── Seeds: one correctable row per kind, owned by `profileId` ─────────────────
// Each returns the id the row's ⋯ would post back, plus a `count` the assertions read.

function seedDoseLog(profileId: number, date: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, condition, obligation, active, source)
         VALUES (?, 'Vitamin D', 'daily', 'should', 1, 'manual')`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '2000 IU', '08:00', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_logs (item_id, dose_id, date, status)
         VALUES (?, ?, ?, 'taken')`
      )
      .run(itemId, doseId, date).lastInsertRowid
  );
}

const doseLogCount = (logId: number) =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM intake_item_logs WHERE id = ?")
      .get(logId) as { n: number }
  ).n;

// The amend posts the ids `HistoricalDoseForm` renders — the ITEM and the DOSE, not
// just the log — so the table resolves them from the one id `seed` hands back.
const doseIdsOf = (logId: number) =>
  db
    .prepare(
      "SELECT item_id AS itemId, dose_id AS doseId FROM intake_item_logs WHERE id = ?"
    )
    .get(logId) as { itemId: number; doseId: number };

const doseAmountOf = (logId: number) =>
  (
    db
      .prepare("SELECT amount FROM intake_item_logs WHERE id = ?")
      .get(logId) as { amount: string | null } | undefined
  )?.amount ?? null;

function seedFoodEvent(profileId: number, date: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO food_log_events (profile_id, date, group_key, meal_slot)
         VALUES (?, ?, 'berries', 'Morning')`
      )
      .run(profileId, date).lastInsertRowid
  );
}

const foodGroupOf = (eventId: number) =>
  (
    db
      .prepare("SELECT group_key FROM food_log_events WHERE id = ?")
      .get(eventId) as { group_key: string } | undefined
  )?.group_key ?? null;

function seedPractice(profileId: number, date: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO practice_logs (profile_id, date, practice, duration_min)
         VALUES (?, ?, 'Breathwork', 10)`
      )
      .run(profileId, date).lastInsertRowid
  );
}

const practiceDurationOf = (id: number) =>
  (
    db
      .prepare("SELECT duration_min FROM practice_logs WHERE id = ?")
      .get(id) as { duration_min: number | null } | undefined
  )?.duration_min ?? null;

function seedSubstanceDay(profileId: number, date: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO substance_daily_totals (profile_id, date, substance, units)
         VALUES (?, ?, 'caffeine', 2)`
      )
      .run(profileId, date).lastInsertRowid
  );
}

const substanceAmountOf = (id: number) =>
  (
    db
      .prepare("SELECT units FROM substance_daily_totals WHERE id = ?")
      .get(id) as { units: number } | undefined
  )?.units ?? null;

// `body_metrics` is one row per (profile, day) holding up to three measures, and the
// action addresses a CELL: `body_metrics:<rowId>:<column>` is the wire target
// `bodyMetricMeasures` emits and `parseReadingTarget` reads.
// SYMPTOMS ARE ADDRESSED BY (profile, symptom, date) AND NOT BY A ROW ID —
// `symptom_logs` is UNIQUE on that triple and every core in lib/symptom-log-write.ts
// takes exactly it. So the seed hands back the row id for `present`, and the reads key
// on the pair the way the `body` kind's do.
function seedSymptomDay(profileId: number, date: string): number {
  setSymptomSeverityCore(profileId, "headache", 2, date, "page", "member note");
  return Number(
    (
      db
        .prepare(
          "SELECT id FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = 'headache'"
        )
        .get(profileId, date) as { id: number }
    ).id
  );
}

const symptomSeverityOf = (profileId: number, date: string) =>
  (
    db
      .prepare(
        "SELECT severity FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = 'headache'"
      )
      .get(profileId, date) as { severity: number } | undefined
  )?.severity ?? null;

function seedCyclePeriod(profileId: number, date: string): number {
  return createCycleRow(profileId, date, null, null, "member note");
}

const cycleEndOf = (id: number) =>
  (
    db.prepare("SELECT period_end FROM cycles WHERE id = ?").get(id) as
      { period_end: string | null } | undefined
  )?.period_end ?? null;

const cycleExists = (id: number) =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM cycles WHERE id = ?").get(id) as {
      n: number;
    }
  ).n === 1;

function seedBodyMetric(profileId: number, date: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 70)"
      )
      .run(profileId, date).lastInsertRowid
  );
}

const bodyWeightOf = (profileId: number, date: string) =>
  (
    db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(profileId, date) as { weight_kg: number | null } | undefined
  )?.weight_kg ?? null;

// ── The five kinds, as a table ────────────────────────────────────────────────
//
// Each case seeds ONE correctable row on the SUBJECT and describes the post the row's
// ⋯ would make. `correct` mutates a field and `remove` deletes; `changed` reads back
// the thing the correction was supposed to move, so "refused" is asserted as the row
// being UNTOUCHED rather than as the promise's shape. That distinction matters here:
// three of these actions answer a `{ kind: "not-found" }` union rather than throwing,
// so an action that had silently written to the ACTING profile could return the same
// value a refusal does.

interface Kind {
  name: string;
  seed: (profileId: number, date: string) => number;
  /** The value the correction moves, read back from the SUBJECT's row. */
  read: (id: number, profileId: number, date: string) => unknown;
  /** What that value must become when the correction is allowed to land. */
  corrected: unknown;
  /** The forged/legitimate correction post, minus `profile_id`. */
  correct: (id: number, date: string) => Record<string, string | number>;
  correctFn: (form: FormData) => Promise<unknown>;
  /**
   * The delete post, minus `profile_id`. It takes the SUBJECT as well as the row id
   * because one of these seven actions spells the subject differently: `removeSymptom`
   * is a symptom-BAR action (#858) as well as the record's delete, and reads
   * `profileId` where the other six read `profile_id` through `gateItemProfile`. Both
   * resolve to requireProfileWriteAccess(target); only the field name differs, and the
   * record's ⋯ posts whichever one its row's action reads.
   */
  remove: (id: number, profileId: number) => Record<string, string | number>;
  removeFn: (form: FormData) => Promise<unknown>;
  /** Whether the row still exists, for the delete half. */
  present: (id: number, profileId: number, date: string) => boolean;
}

const KINDS: Kind[] = [
  {
    name: "dose",
    seed: seedDoseLog,
    // The dose row's ⋯ offers Edit (updateHistoricalDose, through the medication
    // domain's own HistoricalDoseForm) and Delete (deleteAdministration). BOTH are
    // driven here. They were not: the amend sat out behind a `correctFn` stub and a
    // comment claiming it was "covered below", and there was no below — so the tenth
    // of these ten actions had no action-tier coverage at all while the file said it
    // did. The amend posts the row's `date` with no `time`, which is the amendment
    // that states nothing about the intake instant and moves the AMOUNT alone.
    read: (id) => doseAmountOf(id),
    corrected: "250 mg",
    correct: (id, date) => ({
      log_id: id,
      id: doseIdsOf(id).itemId,
      dose_id: doseIdsOf(id).doseId,
      date,
      time: "",
      amount: "250 mg",
    }),
    correctFn: (form) => updateHistoricalDose(form),
    remove: (id) => ({ log_id: id }),
    removeFn: (form) => deleteAdministration(form),
    present: (id) => doseLogCount(id) === 1,
  },
  {
    name: "food",
    seed: seedFoodEvent,
    read: (id) => foodGroupOf(id),
    corrected: "leafy_greens",
    correct: (id, date) => ({
      event_id: id,
      group_key: "leafy_greens",
      date,
      meal_slot: "Morning",
    }),
    correctFn: (form) => updateFoodLogEvent(form),
    remove: (id) => ({ event_id: id }),
    removeFn: (form) => deleteFoodLogEvent(form),
    present: (id) => foodGroupOf(id) != null,
  },
  {
    name: "practice",
    seed: seedPractice,
    read: (id) => practiceDurationOf(id),
    corrected: 25,
    correct: (id, date) => ({ id, date, duration_min: 25, notes: "" }),
    correctFn: (form) => editPracticeSession(form),
    remove: (id) => ({ id }),
    removeFn: (form) => removePracticeSession(form),
    present: (id) => practiceDurationOf(id) != null,
  },
  {
    name: "substance",
    seed: seedSubstanceDay,
    read: (id) => substanceAmountOf(id),
    corrected: 5,
    correct: (id, date) => ({ id, substance: "caffeine", date, amount: 5 }),
    correctFn: (form) => updateSubstanceDailyTotalAction(form),
    remove: (id) => ({ id, substance: "caffeine" }),
    removeFn: (form) => deleteSubstanceDailyTotalAction(form),
    present: (id) => substanceAmountOf(id) != null,
  },
  {
    name: "body",
    // The reading is read back by (profile, day) — the row is one per day — while the
    // WRITE addresses the cell by row id, which is why `read`/`present` take all three.
    seed: (profileId, date) => seedBodyMetric(profileId, date),
    read: (_id, profileId, date) => bodyWeightOf(profileId, date),
    corrected: 80,
    correct: (id) => ({
      kind: "weight",
      target: `body_metrics:${id}:weight_kg`,
      value: 80,
    }),
    correctFn: (form) => updateMetricReading(form),
    remove: (id) => ({
      kind: "weight",
      target: `body_metrics:${id}:weight_kg`,
    }),
    removeFn: (form) => deleteMetricReading(form),
    present: (_id, profileId, date) => bodyWeightOf(profileId, date) != null,
  },
  {
    name: "symptom",
    seed: seedSymptomDay,
    read: (_id, profileId, date) => symptomSeverityOf(profileId, date),
    corrected: 4,
    // No date field on the record's symptom form — the store is UNIQUE on
    // (profile, date, symptom), so moving a day is a delete plus a re-log — but the
    // post carries the row's own date because that is half of its address.
    correct: (_id, date) => ({
      symptom: "headache",
      severity: 4,
      date,
      note: "corrected",
    }),
    correctFn: (form) => editSymptom(form),
    remove: (_id, profileId) => ({
      symptom: "headache",
      date: DATE,
      profileId,
    }),
    removeFn: (form) => removeSymptom(form),
    present: (_id, profileId, date) =>
      symptomSeverityOf(profileId, date) != null,
  },
  {
    name: "cycle",
    seed: seedCyclePeriod,
    // The correction closes an open period: `period_end` is the INCLUSIVE last
    // bleeding day and NULL means ongoing, so this moves a real column with a value
    // the plausibility gate accepts (a past date, no overlap, its own row excluded).
    read: (id) => cycleEndOf(id),
    corrected: "2026-08-24",
    correct: (id, date) => ({
      id,
      period_start: date,
      period_end: "2026-08-24",
    }),
    correctFn: (form) => saveCycleAction(form),
    remove: (id) => ({ id }),
    removeFn: (form) => deleteCycleAction(form),
    present: (id) => cycleExists(id),
  },
];

const DATE = "2026-08-20";

describe("the record's corrections gate the ROW's profile (#4009 item 1)", () => {
  // THE REFUSAL — the acceptance criterion in its own words. A forged post naming a
  // profile this login cannot write must be refused SERVER-SIDE, whatever the page
  // rendered. `requireProfileWriteAccess` answers with redirect(), which throws
  // NEXT_REDIRECT, so the action aborts before any core runs — and the row is read back
  // to prove nothing was written on the way to the throw.
  describe.each(KINDS)("$name", (kind) => {
    it("refuses a correction forged for an UNGRANTED profile", async () => {
      const login = createLogin({ role: "member" });
      const acting = createProfile(`acting ${kind.name} 1`, login.id);
      const stranger = createProfile(`stranger ${kind.name} 1`);
      actAs(login, acting);
      const id = kind.seed(stranger.id, DATE);
      const before = kind.read(id, stranger.id, DATE);

      await expect(
        kind.correctFn(
          fd({ ...kind.correct(id, DATE), profile_id: stranger.id })
        )
      ).rejects.toThrow();
      await expect(
        kind.removeFn(
          fd({ ...kind.remove(id, stranger.id), profile_id: stranger.id })
        )
      ).rejects.toThrow();

      // NOT MERELY THAT IT THREW: the subject's row is byte-identical and still there.
      expect(kind.read(id, stranger.id, DATE)).toEqual(before);
      expect(kind.present(id, stranger.id, DATE)).toBe(true);
    });

    it("refuses a correction forged for a READ-ONLY-granted profile", async () => {
      const login = createLogin({ role: "member" });
      const acting = createProfile(`acting ${kind.name} 2`, login.id);
      const ro = createProfile(`readonly ${kind.name} 2`);
      db.prepare(
        "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
      ).run(login.id, ro.id);
      actAs(login, acting);
      const id = kind.seed(ro.id, DATE);
      const before = kind.read(id, ro.id, DATE);

      // BOTH VERBS, not just the delete. A mutation that reverted only the CORRECT
      // half of one kind's gate left this case green while the ungranted one went
      // red — the read-only arm was driving the delete alone, so it could not see
      // half of what it claims to cover.
      await expect(
        kind.correctFn(fd({ ...kind.correct(id, DATE), profile_id: ro.id }))
      ).rejects.toThrow();
      await expect(
        kind.removeFn(fd({ ...kind.remove(id, ro.id), profile_id: ro.id }))
      ).rejects.toThrow();

      expect(kind.read(id, ro.id, DATE)).toEqual(before);
      expect(kind.present(id, ro.id, DATE)).toBe(true);
    });

    // THE CAPABILITY HALF, and it is why the two refusals above are not enough on
    // their own: a gate that refused every cross-profile write would satisfy them and
    // would have shipped phase 1's blanket denial with extra machinery. This asserts
    // the correction LANDS — on the SUBJECT, and not on the acting profile.
    it("lands a correction on a WRITE-granted member's row", async () => {
      const login = createLogin({ role: "member" });
      const acting = createProfile(`acting ${kind.name} 3`, login.id);
      const target = createProfile(`target ${kind.name} 3`, login.id);
      actAs(login, acting);
      const id = kind.seed(target.id, DATE);

      await kind.correctFn(
        fd({ ...kind.correct(id, DATE), profile_id: target.id })
      );
      expect(kind.read(id, target.id, DATE)).toEqual(kind.corrected);

      await kind.removeFn(
        fd({ ...kind.remove(id, target.id), profile_id: target.id })
      );
      expect(kind.present(id, target.id, DATE)).toBe(false);
    });
  });

  // THE SYMPTOM CORRECTION HAS NO REFUSAL TO OBSERVE WHEN IT MISSES, which is why it
  // gets a case of its own on top of the table's three arms. `setSymptomSeverityCore`
  // is keyed on (profile, symptom, date) rather than on a row id, so an action that
  // ignored the posted subject would not fail to find anything — it would UPSERT the
  // acting profile's own day for that symptom and answer `{ ok: true }`. Phase 2b
  // measured exactly that and gated the ⋯ off the screen because of it. So the table's
  // "lands on the target" arm is necessary and not sufficient here: the other half of
  // the claim is that the caregiver's own record did not silently grow a row.
  it("corrects the member's symptom-day without writing the acting profile's", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("acting symptom subject", login.id);
    const member = createProfile("member symptom subject", login.id);
    actAs(login, acting);
    seedSymptomDay(member.id, DATE);

    expect(
      await editSymptom(
        fd({
          symptom: "headache",
          severity: 4,
          date: DATE,
          note: "corrected",
          profile_id: member.id,
        })
      )
    ).toMatchObject({ ok: true });

    expect(symptomSeverityOf(member.id, DATE)).toBe(4);
    // The acting profile has no headache row at all — not a row with the old
    // severity, none. A `toBe(2)` here would have passed on a tree that wrote both.
    expect(symptomSeverityOf(acting.id, DATE)).toBeNull();
  });

  // WITHOUT A SUBJECT, NOTHING MOVED. Every single-view form in the app posts no
  // `profile_id`, so the fallback arm is the one carrying the whole existing surface —
  // if it had shifted, the regression would be app-wide rather than on this page.
  it("falls back to the acting profile when no subject is posted", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("acting fallback", login.id);
    actAs(login, acting);
    const id = seedPractice(acting.id, DATE);

    await editPracticeSession(fd({ id, date: DATE, duration_min: 30 }));
    expect(practiceDurationOf(id)).toBe(30);
  });

  // THE SUBSTANCE AGE GATE MOVES WITH THE SUBJECT (#1174/#1279). lib/history.ts gates
  // the substance READ on the SUBJECT's age, and the correction asked `isMinor()` of
  // the ACTING profile — so a caregiver acting as an adult could have corrected a minor
  // member's substance row through a surface that never showed it to them. The two
  // questions have to be asked of the same profile or the page and the write disagree.
  // A STATED TIME IS A WALL CLOCK ON THE SUBJECT'S CALENDAR (#4009 item 1). Both
  // correction actions that collect one re-anchor it with `getTimezone(profileId)` —
  // the GATED profile — and until this test nothing in the repo noticed when they
  // stopped: reverting both sites to the acting profile left the whole suite green.
  //
  // The zones are chosen to make the two answers land on DIFFERENT DAYS, because a
  // pair an hour apart is satisfied by a rounding accident: Pacific/Kiritimati is
  // UTC+14 and Pacific/Niue is UTC−11, 25 hours apart, so 09:30 on the subject's
  // 2026-08-20 is 20:30Z that day while the caregiver's zone makes it 19:30Z the day
  // BEFORE. Measured against the reverted tree: at THAT gap the day-pair rule catches
  // it and the correction refuses outright ("That time isn't on the selected day"), so
  // the stored instant stays null. The assertion is on the STORED VALUE rather than on
  // the outcome anyway, because a caregiver only a few hours off would resolve to a
  // wrong instant that is still on the right day, and that one saves silently.
  it.each([
    [
      "food",
      (subjectId: number) => {
        const eventId = seedFoodEvent(subjectId, DATE);
        return {
          form: fd({
            event_id: eventId,
            group_key: "berries",
            meal_slot: "Morning",
            date: DATE,
            occurred_at: "09:30",
            profile_id: subjectId,
          }),
          run: updateFoodLogEvent,
          stored: () =>
            (
              db
                .prepare("SELECT occurred_at FROM food_log_events WHERE id = ?")
                .get(eventId) as { occurred_at: string | null }
            ).occurred_at,
        };
      },
    ],
    [
      "dose",
      (subjectId: number) => {
        const logId = seedDoseLog(subjectId, DATE);
        const { itemId, doseId } = doseIdsOf(logId);
        return {
          form: fd({
            log_id: logId,
            id: itemId,
            dose_id: doseId,
            date: DATE,
            time: "09:30",
            profile_id: subjectId,
          }),
          run: updateHistoricalDose,
          stored: () =>
            (
              db
                .prepare(
                  "SELECT occurred_at FROM intake_item_logs WHERE id = ?"
                )
                .get(logId) as { occurred_at: string | null }
            ).occurred_at,
        };
      },
    ],
  ])(
    "%s states the corrected time on the SUBJECT's calendar, not the caregiver's",
    async (_name, build) => {
      const login = createLogin({ role: "member" });
      const acting = createProfile("carer ahead", login.id);
      const subject = createProfile("member behind", login.id);
      setTimezone(acting.id, "Pacific/Kiritimati"); // UTC+14
      setTimezone(subject.id, "Pacific/Niue"); // UTC−11
      actAs(login, acting);

      const { form, run, stored } = build(subject.id);
      await run(form);

      // The subject's 09:30 on DATE. The acting zone would have written
      // "2026-08-19T19:30:00Z" — a real instant, on the wrong day, saved silently.
      expect(stored()).toBe("2026-08-20T20:30:00Z");
    }
  );

  // BOTH VERBS, for the same reason the read-only arm above drives both: the delete
  // carries the identical `isMinor(getProfileAge(profileId))` gate and nothing tested
  // it, and a delete is the half where a miss is unrecoverable. Its `{ kind:
  // "not-found" }` is ALSO what deleting a row that was never there answers, so the
  // shape is the weaker assertion — the row still holding its 2 units is the one that
  // can tell a refusal from a write that went somewhere else.
  it.each([
    [
      "correction",
      (id: number, minorId: number) =>
        updateSubstanceDailyTotalAction(
          fd({
            id,
            substance: "caffeine",
            date: DATE,
            amount: 9,
            profile_id: minorId,
          })
        ),
      { kind: "not-found" },
    ],
    [
      "delete",
      (id: number, minorId: number) =>
        deleteSubstanceDailyTotalAction(
          fd({ id, substance: "caffeine", profile_id: minorId })
        ),
      { kind: "not-found", undoId: null, error: "Couldn't find that entry." },
    ],
  ])(
    "refuses a substance %s on a MINOR member, even with write access",
    async (_verb, run, refusal) => {
      const login = createLogin({ role: "member" });
      const acting = createProfile(`adult carer ${_verb}`, login.id);
      const minor = createProfile(`young member ${_verb}`);
      // Age is a profile SETTING (`getStoredAge`), not a profiles column.
      setStoredAge(minor.id, 9);
      db.prepare(
        "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
      ).run(login.id, minor.id);
      actAs(login, acting);
      const id = seedSubstanceDay(minor.id, DATE);

      expect(await run(id, minor.id)).toEqual(refusal);
      expect(substanceAmountOf(id)).toBe(2);
    }
  );
});
