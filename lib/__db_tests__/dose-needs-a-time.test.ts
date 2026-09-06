// DB INTEGRATION TIER — no dueness until a dose is scheduled (#5285), from the shape the
// owner photographed in prod: a shared-bottle Ibuprofen added for a second household
// member, obligation `must`, carrying ONE dose row that states no time. Manage already
// said "Not scheduled" about that row while every due path treated it as owed daily and
// missed by evening, so the same item read two ways on two pages.
//
// The gate lives in `doseDueOn`, which is the ONE dueness question, so this asserts it
// where the surfaces actually read it rather than on the pure helper: the due list
// (`collectUpcoming` — Upcoming, the dashboard's Now rows and the quick-log sheet all
// read this), the reminder tick (`collectWindowDoses`), and the adherence strip behind
// the 14-day fraction and the calendar. The TIMED sibling in the same profile is the
// control: it proves each of those three can produce a row at all here, so a green is
// not the fixture simply being empty.
//
// All fixture values synthetic — no real PHI. Dates are relative to the profile's own
// today. Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { lastNDates, shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries/upcoming";
import { collectWindowDoses } from "@/lib/notifications/intake";
import {
  getIntakeDoses,
  getIntakeItems,
  getIntakeLogsInRange,
} from "@/lib/queries";
import { getTimezone } from "@/lib/settings";
import {
  adherenceSummary,
  indexTakenByDose,
  intakeAdherenceStrip,
} from "@/lib/intake-adherence";
import { stackSchedule } from "@/lib/intake-schedule";

function seedProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A `must` medication born 90 days ago, so no lifetime clamp is doing the work.
function seedMed(profileId: number, name: string) {
  const createdAt = `${shiftDateStr(today(profileId), -90)} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, qty_per_dose, created_at)
         VALUES (?, ?, 1, 'medication', 'daily', 'must', 1, ?)`
      )
      .run(profileId, name, createdAt).lastInsertRowid
  );
  return { itemId, createdAt };
}

function seedDose(
  itemId: number,
  createdAt: string,
  timeOfDay: string | null,
  amount: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, ?, ?, 'any', 0, ?)`
      )
      .run(itemId, amount, timeOfDay, createdAt).lastInsertRowid
  );
}

function stripFor(profileId: number, itemId: number, dates: string[]) {
  const item = getIntakeItems(profileId).find((s) => s.id === itemId)!;
  const doses = getIntakeDoses(profileId).filter((d) => d.item_id === itemId);
  return intakeAdherenceStrip(
    item,
    doses,
    dates,
    new Set<string>(),
    () => new Set<string>(),
    indexTakenByDose(getIntakeLogsInRange(profileId, dates.length + 2)),
    getTimezone(profileId)
  );
}

describe("#5285 — an untimed dose is not due on any surface", () => {
  it("is absent from the due list, the tick and the adherence denominator, while a timed sibling is not", () => {
    const p = seedProfile("Dose Needs A Time (test)");
    const day = today(p);

    const untimed = seedMed(p, "Ibuprofen shared (test)");
    // The reported row exactly: no time and no amount — the placeholder a new item
    // used to be minted with.
    const untimedDose = seedDose(untimed.itemId, untimed.createdAt, null, null);
    const timed = seedMed(p, "Levothyroxine (test)");
    const timedDose = seedDose(
      timed.itemId,
      timed.createdAt,
      "morning",
      "50 mcg"
    );

    // The one flag, and the one it now agrees with. Manage said this before dueness did.
    const item = getIntakeItems(p).find((s) => s.id === untimed.itemId)!;
    const row = getIntakeDoses(p).find((d) => d.id === untimedDose)!;
    expect(stackSchedule(item, row)).toEqual({
      scheduled: false,
      label: "Not scheduled",
    });

    // The due list behind Upcoming, the dashboard's Now rows and the quick-log sheet.
    const keys = collectUpcoming(p, day).map((i) => i.key);
    expect(keys).not.toContain(`dose:${untimedDose}`);
    expect(keys).toContain(`dose:${timedDose}`);

    // The reminder tick. An untimed dose bucketed to "Anytime", which sends in the
    // Morning window — the same window its timed sibling is gathered into here.
    const gathered = collectWindowDoses(p, "Morning", day).map(
      (e) => e.dose.id
    );
    expect(gathered).not.toContain(untimedDose);
    expect(gathered).toContain(timedDose);

    // The 14-day fraction and the adherence calendar. Every day is "na" — nothing was
    // ever owed — so the summary reads "no history yet" rather than 0% with a miss.
    const dates = lastNDates(day, 14);
    const strip = stripFor(p, untimed.itemId, dates);
    expect(strip.filter((d) => d.state !== "na")).toEqual([]);
    const summary = adherenceSummary(strip);
    expect(summary.applicableDays).toBe(0);
    expect(summary.pct).toBeNull();
    // The control's strip DOES score, so "all na" above is a verdict and not an
    // inability of this fixture to produce a scored day.
    expect(
      stripFor(p, timed.itemId, dates).filter((d) => d.state === "missed")
        .length
    ).toBeGreaterThan(0);
  });

  it("stating a time makes it due from that day and back-fills nothing", () => {
    const p = seedProfile("Dose Gains A Time (test)");
    const day = today(p);
    const yesterday = shiftDateStr(day, -1);

    const { itemId, createdAt } = seedMed(p, "Ibuprofen retimed (test)");
    const doseId = seedDose(itemId, createdAt, null, null);
    // The person sets a time today. The write path records a version from the day it
    // takes effect, which is what keeps the silent days silent: every earlier day
    // resolves to the untimed version and stays outside adherence entirely.
    db.prepare(
      `UPDATE intake_item_doses SET time_of_day = 'morning' WHERE id = ?`
    ).run(doseId);
    const addVersion = db.prepare(
      `INSERT INTO intake_dose_schedule_versions
         (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
       VALUES (?,?,?,NULL,NULL,NULL,?)`
    );
    addVersion.run(doseId, createdAt.slice(0, 10), null, createdAt);
    addVersion.run(doseId, day, "morning", `${day} 09:00:00`);

    const strip = stripFor(p, itemId, lastNDates(day, 14));
    expect(
      strip.filter((d) => d.date < day).every((d) => d.state === "na")
    ).toBe(true);
    expect(strip.find((d) => d.date === yesterday)!.state).toBe("na");
    // Today is due — it is in the tick's window and on the due list from this day on.
    expect(collectUpcoming(p, day).map((i) => i.key)).toContain(
      `dose:${doseId}`
    );
    expect(
      collectWindowDoses(p, "Morning", day).map((e) => e.dose.id)
    ).toContain(doseId);
  });
});
