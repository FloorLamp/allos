// SERVER-ACTION TIER — the effective-dated schedule WRITE path (#1973, issue #2065).
//
// The two existing suites for this feature both stop short of the code that actually
// runs when a person edits a dose: the pure tier drives `doseScheduleAsOf` /
// `unrecordedScheduleChangeOn` over literals, and the DB tier crafts version rows with
// raw INSERTs. Neither ever calls `updateIntakeItem`, so the half of the feature that
// decides WHETHER a version is written — `priorSchedules`, `doseScheduleDiffers`, the
// lazy pre-edit backfill and the `ON CONFLICT(dose_id, effective_from)` upsert — was
// reachable only through the form and asserted nowhere.
//
// That is the half with the blast radius. Wire `doseScheduleDiffers` to the wrong
// `prior`, or fire the backfill against the wrong dose id, and "editing a dose must not
// rewrite adherence history" quietly stops holding while every existing test stays
// green. So each case here goes through the REAL action with a REAL FormData payload
// and then asks the question a surface asks — `doseDueOn` / `doseBucketOn` about a
// PRE-EDIT day — rather than only counting rows.
//
// The clock is driven through the seam (lib/clock.ts) because `effective_from` is a
// profile-local calendar DAY: an add and an edit on the same day collapse into one
// version by design (the upsert), so a test about closing a version has to put real
// days between them.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addIntakeItem,
  updateIntakeItem,
} from "@/app/(app)/nutrition/intake-actions";
import { getIntakeDoses, getIntakeItems } from "@/lib/queries";
import { doseBucketOn, doseDueOn } from "@/lib/intake-schedule";
import { setTimezone } from "@/lib/settings";
import { seedActor, fd } from "./harness";

vi.mocked(revalidatePath);

let profileId = 0;
let priorNow: string | undefined;

beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  profileId = seedActor().profile.id;
  // UTC, so "the profile's day" and the frozen instant's day are the same string and
  // the assertions below are about versioning rather than about zone arithmetic.
  setTimezone(profileId, "UTC");
});

afterEach(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function setDay(dateISO: string): void {
  process.env.ALLOS_TEST_NOW = `${dateISO}T12:00:00Z`;
}

const dose = (extra: Record<string, unknown> = {}) => ({
  amount: "1 tab",
  time_of_day: "Morning",
  food_timing: "any",
  weekdays: [],
  start_date: "",
  end_date: "",
  ...extra,
});

function lastItemId(): number {
  return Number(
    (
      db.prepare("SELECT MAX(id) AS id FROM intake_items").get() as {
        id: number;
      }
    ).id
  );
}

function doseRows(itemId: number) {
  return db
    .prepare(
      `SELECT id, amount, time_of_day, weekdays, sort, retired
         FROM intake_item_doses WHERE item_id = ? ORDER BY sort, id`
    )
    .all(itemId) as {
    id: number;
    amount: string | null;
    time_of_day: string | null;
    weekdays: string | null;
    sort: number;
    retired: number;
  }[];
}

// The recorded history of one dose, oldest first, in the shape an assertion reads.
function versionsOf(doseId: number): [string, string | null, string | null][] {
  return (
    db
      .prepare(
        `SELECT effective_from, time_of_day, weekdays
           FROM intake_dose_schedule_versions
          WHERE dose_id = ? ORDER BY effective_from, id`
      )
      .all(doseId) as {
      effective_from: string;
      time_of_day: string | null;
      weekdays: string | null;
    }[]
  ).map((v) => [v.effective_from, v.time_of_day, v.weekdays]);
}

// The dose row as every SURFACE sees it — schedule history attached, so the pure
// resolvers answer about a past day exactly as a reminder or an adherence strip would.
function readDose(doseId: number) {
  const d = getIntakeDoses(profileId).find((r) => r.id === doseId);
  if (!d) throw new Error(`dose ${doseId} is not in the current schedule`);
  return d;
}

function dueOn(itemId: number, doseId: number, date: string): boolean {
  const supp = getIntakeItems(profileId).find((s) => s.id === itemId)!;
  return doseDueOn(supp, readDose(doseId), {
    date,
    isWorkoutDay: false,
    activeSituations: new Set<string>(),
  });
}

// ---- The edit that MOVES a boundary ----------------------------------------

describe("#1973 — a dueness-relevant edit appends a version and closes the old one", () => {
  it("re-times across days, collapses same-day edits, and invalidates the reader memo", async () => {
    setDay("2026-07-01");
    await addIntakeItem(
      fd({
        name: "Magnesium",
        doses: JSON.stringify([dose({ time_of_day: "Morning" })]),
      })
    );
    const itemId = lastItemId();
    const doseId = doseRows(itemId)[0].id;
    // Birth version, seeded by the add path so the first edit has something to close.
    expect(versionsOf(doseId)).toEqual([["2026-07-01", "Morning", null]]);
    // Prime the schedule memo before the edit, as the form-rendering page does.
    expect(doseBucketOn(readDose(doseId), "2026-07-01")).toBe("Morning");

    setDay("2026-07-20");
    await updateIntakeItem(
      fd({
        id: String(itemId),
        name: "Magnesium",
        doses: JSON.stringify([
          { id: doseId, ...dose({ time_of_day: "Evening" }) },
        ]),
      })
    );

    // APPENDED, not rewritten: the old rule is still on file with its own start day.
    expect(versionsOf(doseId)).toEqual([
      ["2026-07-01", "Morning", null],
      ["2026-07-20", "Evening", null],
    ]);
    // The live row is kept current, which is what "is it due today" reads.
    expect(doseRows(itemId)[0].time_of_day).toBe("Evening");
    // …and the question the feature exists for: a day before the edit is judged by the
    // rule that was in force THEN. This is the answer that used to be unrecoverable.
    expect(doseBucketOn(readDose(doseId), "2026-07-10")).toBe("Morning");
    expect(doseBucketOn(readDose(doseId), "2026-07-20")).toBe("Evening");
    // The boundary is the effective day itself, not the day after it.
    expect(doseBucketOn(readDose(doseId), "2026-07-19")).toBe("Morning");

    setDay("2026-07-25");
    await updateIntakeItem(
      fd({
        id: String(itemId),
        name: "Magnesium",
        doses: JSON.stringify([
          { id: doseId, ...dose({ time_of_day: "Midday" }) },
        ]),
      })
    );
    setDay("2026-07-30");
    for (const slot of ["Evening", "Before sleep"]) {
      await updateIntakeItem(
        fd({
          id: String(itemId),
          name: "Magnesium",
          doses: JSON.stringify([
            { id: doseId, ...dose({ time_of_day: slot }) },
          ]),
        })
      );
    }

    expect(versionsOf(doseId)).toEqual([
      ["2026-07-01", "Morning", null],
      ["2026-07-20", "Evening", null],
      ["2026-07-25", "Midday", null],
      ["2026-07-30", "Before sleep", null],
    ]);
    expect(doseBucketOn(readDose(doseId), "2026-07-24")).toBe("Evening");
    expect(doseBucketOn(readDose(doseId), "2026-07-27")).toBe("Midday");
  });

  it("narrowing to weekdays leaves the pre-edit days due, and the post-edit days not", async () => {
    setDay("2026-07-01");
    await addIntakeItem(
      fd({ name: "Alendronate", doses: JSON.stringify([dose()]) })
    );
    const itemId = lastItemId();
    const doseId = doseRows(itemId)[0].id;

    setDay("2026-07-20");
    await updateIntakeItem(
      fd({
        id: String(itemId),
        name: "Alendronate",
        // Mondays only from here on.
        doses: JSON.stringify([{ id: doseId, ...dose({ weekdays: [1] }) }]),
      })
    );
    expect(versionsOf(doseId)).toEqual([
      ["2026-07-01", "Morning", null],
      ["2026-07-20", "Morning", "1"],
    ]);

    // A Friday BEFORE the narrowing: it was a due day, and no edit may retroactively
    // turn it into a missed one.
    expect(dueOn(itemId, doseId, "2026-07-10")).toBe(true);
    // The same weekday AFTER it: correctly not due.
    expect(dueOn(itemId, doseId, "2026-07-24")).toBe(false);
    expect(dueOn(itemId, doseId, "2026-07-27")).toBe(true); // a Monday
  });
});

// ---- The lazy backfill -------------------------------------------------------

describe("#1973 — a dose with no recorded history gets its pre-edit rule backfilled once", () => {
  // The shape every importer insert, seeded row and pre-#1973 dose has: a live row with
  // no versions behind it. Without the backfill the first edit's version would be the
  // EARLIEST one, and the resolver's before-recorded-history fallback would judge every
  // past day by the NEW rule — the retroactive re-judgment the feature exists to stop.
  function stripHistory(doseId: number): void {
    db.prepare(
      "DELETE FROM intake_dose_schedule_versions WHERE dose_id = ?"
    ).run(doseId);
  }

  it("writes the pre-edit rule from the dose's birth, then never backfills again", async () => {
    setDay("2026-07-01");
    await addIntakeItem(
      fd({ name: "Legacy Zinc", doses: JSON.stringify([dose()]) })
    );
    const itemId = lastItemId();
    const doseId = doseRows(itemId)[0].id;
    stripHistory(doseId);
    expect(versionsOf(doseId)).toEqual([]);

    setDay("2026-07-20");
    await updateIntakeItem(
      fd({
        id: String(itemId),
        name: "Legacy Zinc",
        doses: JSON.stringify([
          { id: doseId, ...dose({ time_of_day: "Evening" }) },
        ]),
      })
    );
    // TWO rows from one edit: the pre-edit rule anchored at the dose's birth, and the
    // new rule from today. The anchor matches what migration 151 would have seeded, so
    // a backfilled history and a migrated one are indistinguishable.
    expect(versionsOf(doseId)).toEqual([
      ["2026-07-01", "Morning", null],
      ["2026-07-20", "Evening", null],
    ]);
    expect(doseBucketOn(readDose(doseId), "2026-07-05")).toBe("Morning");

    setDay("2026-07-25");
    await updateIntakeItem(
      fd({
        id: String(itemId),
        name: "Legacy Zinc",
        doses: JSON.stringify([
          { id: doseId, ...dose({ time_of_day: "Midday" }) },
        ]),
      })
    );
    // ONCE. The second edit appends only its own version — the birth row keeps the rule
    // it recorded, and is not re-backfilled with the now-stale "Evening".
    expect(versionsOf(doseId)).toEqual([
      ["2026-07-01", "Morning", null],
      ["2026-07-20", "Evening", null],
      ["2026-07-25", "Midday", null],
    ]);
  });

  it("backfills only the dose that changed, even when the form renumbers the rows", async () => {
    setDay("2026-07-01");
    await addIntakeItem(
      fd({
        name: "Renumber Rx",
        doses: JSON.stringify([
          dose({ amount: "5 mg", time_of_day: "Morning" }),
          dose({ amount: "10 mg", time_of_day: "Evening" }),
        ]),
      })
    );
    const itemId = lastItemId();
    const [morning, evening] = doseRows(itemId);
    stripHistory(morning.id);
    stripHistory(evening.id);

    setDay("2026-07-20");
    await updateIntakeItem(
      fd({
        id: String(itemId),
        name: "Renumber Rx",
        // The evening row is submitted FIRST (so both rows' `sort` changes), a brand new
        // row is added in the middle, and only the evening row's schedule moves. A
        // backfill keyed on position rather than on `d.id` would land on the wrong dose.
        doses: JSON.stringify([
          {
            id: evening.id,
            ...dose({ amount: "10 mg", time_of_day: "Before sleep" }),
          },
          dose({ amount: "2 mg", time_of_day: "Midday" }),
          {
            id: morning.id,
            ...dose({
              amount: "7.5 mg",
              time_of_day: "Morning",
              food_timing: "with_food",
            }),
          },
        ]),
      })
    );

    // The row that moved carries both its backfilled birth rule and the new one …
    expect(versionsOf(evening.id)).toEqual([
      ["2026-07-01", "Evening", null],
      ["2026-07-20", "Before sleep", null],
    ]);
    // … amount, food timing and order changed on the morning row, but none can move a
    // schedule boundary, so it stays historyless while its live values update …
    expect(versionsOf(morning.id)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT amount, food_timing FROM intake_item_doses WHERE id = ?"
        )
        .get(morning.id)
    ).toEqual({ amount: "7.5 mg", food_timing: "with_food" });
    // … and the dose born in this edit gets exactly one version, dated today.
    const added = doseRows(itemId).find(
      (d) => d.id !== morning.id && d.id !== evening.id
    )!;
    expect(versionsOf(added.id)).toEqual([["2026-07-20", "Midday", null]]);

    // The night before the move is still an Evening night — the bedtime attribution
    // (#1972) that the versions exist to keep honest.
    expect(doseBucketOn(readDose(evening.id), "2026-07-19")).toBe("Evening");
    expect(doseBucketOn(readDose(evening.id), "2026-07-21")).toBe(
      "Before sleep"
    );
  });
});
