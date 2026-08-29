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

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { setStoredAge } from "@/lib/settings/profile-attrs";
import { deleteAdministration } from "@/app/(app)/nutrition/intake-actions";
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
    db.prepare("SELECT duration_min FROM practice_logs WHERE id = ?").get(id) as
      | { duration_min: number | null }
      | undefined
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
  remove: (id: number) => Record<string, string | number>;
  removeFn: (form: FormData) => Promise<unknown>;
  /** Whether the row still exists, for the delete half. */
  present: (id: number, profileId: number, date: string) => boolean;
}

const KINDS: Kind[] = [
  {
    name: "dose",
    seed: seedDoseLog,
    // The dose row's ⋯ offers Edit (HistoricalDoseForm, its own action) and Delete.
    // The delete is the one this table drives; the amend is covered below, because it
    // posts through a different component and carries the subject's timezone with it.
    read: (id) => doseLogCount(id),
    corrected: 1,
    correct: (id) => ({ log_id: id }),
    correctFn: async () => undefined,
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
    remove: (id) => ({ kind: "weight", target: `body_metrics:${id}:weight_kg` }),
    removeFn: (form) => deleteMetricReading(form),
    present: (_id, profileId, date) => bodyWeightOf(profileId, date) != null,
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

      if (kind.correctFn !== KINDS[0].correctFn) {
        await expect(
          kind.correctFn(
            fd({ ...kind.correct(id, DATE), profile_id: stranger.id })
          )
        ).rejects.toThrow();
      }
      await expect(
        kind.removeFn(
          fd({ ...kind.remove(id), profile_id: stranger.id })
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
      if (kind.correctFn !== KINDS[0].correctFn) {
        await expect(
          kind.correctFn(fd({ ...kind.correct(id, DATE), profile_id: ro.id }))
        ).rejects.toThrow();
      }
      await expect(
        kind.removeFn(fd({ ...kind.remove(id), profile_id: ro.id }))
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

      if (kind.correctFn !== KINDS[0].correctFn) {
        await kind.correctFn(
          fd({ ...kind.correct(id, DATE), profile_id: target.id })
        );
        expect(kind.read(id, target.id, DATE)).toEqual(kind.corrected);
      }

      await kind.removeFn(
        fd({ ...kind.remove(id), profile_id: target.id })
      );
      expect(kind.present(id, target.id, DATE)).toBe(false);
    });
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
  it("refuses a substance correction on a MINOR member, even with write access", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("adult carer", login.id);
    const minor = createProfile("young member");
    // Age is a profile SETTING (`getStoredAge`), not a profiles column.
    setStoredAge(minor.id, 9);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(login.id, minor.id);
    actAs(login, acting);
    const id = seedSubstanceDay(minor.id, DATE);

    const outcome = await updateSubstanceDailyTotalAction(
      fd({ id, substance: "caffeine", date: DATE, amount: 9, profile_id: minor.id })
    );
    expect(outcome).toEqual({ kind: "not-found" });
    expect(substanceAmountOf(id)).toBe(2);
  });
});
