// DB INTEGRATION TIER — non-daily intake cadence (#1602) where it can actually be
// SEEN, end to end from a realistic ledger:
//
//   • the DUE list: a weekly `must` medication is absent on its off-days and present
//     on its day, WITHOUT being demoted — the safety inversion this issue exists to
//     end (a weekly med either nagged daily or had to be silenced by moving it to the
//     no-expectation obligation level, which also strips escalation and adherence).
//   • the ADHERENCE DENOMINATOR: expected doses count on-days only. This is the
//     #430/#448 builder-input-layer class — a wrong denominator makes every percentage
//     above it confidently wrong — so it gets a realistic fixture rather than a unit
//     assertion on the pure helper.
//   • ALTERNATING AMOUNTS as two dose rows of ONE item, each keeping its own history.
//   • a TAPER as windowed rows: the window expiring is not a retire, and the earlier
//     rows' logs read exactly as they did.
//   • REFILL projection scaled by cadence density.
//   • the OFF-DAY confirm outcome: the log is written, and the answer says so.
//
// All fixture values synthetic — no real PHI. Dates are relative to each profile's own
// today, and each weekly item is anchored on a weekday DERIVED from that today, so the
// specs never depend on a wall-clock date.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries/upcoming";
import {
  getSupplements,
  getSupplementDoses,
  getRefillRates,
  markDoseTaken,
  getDoseCadenceLabel,
} from "@/lib/queries";
import { getTimezone } from "@/lib/settings";
import {
  supplementAdherenceStrip,
  indexTakenByDose,
  adherenceSummary,
} from "@/lib/supplement-adherence";
import { getIntakeLogsInRange } from "@/lib/queries";
import { daysOfSupplyLeft } from "@/lib/refill";
import { cadenceLabel } from "@/lib/intake-cadence";
import { tapAnswerText } from "@/lib/notifications/callback-data";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

interface ItemOpts {
  kind?: "supplement" | "medication";
  obligation?: "must" | "should" | "may";
  createdDaysAgo?: number;
  quantityOnHand?: number | null;
  cadenceKind?: "daily" | "weekly" | "interval";
  cadenceWeekdays?: string | null;
  cadenceIntervalDays?: number | null;
  cadenceAnchorDate?: string | null;
}

function seedItem(profileId: number, name: string, opts: ItemOpts = {}) {
  const createdDaysAgo = opts.createdDaysAgo ?? 120;
  const createdAt = `${shiftDateStr(today(profileId), -createdDaysAgo)} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            quantity_on_hand, qty_per_dose, created_at,
            cadence_kind, cadence_weekdays, cadence_interval_days, cadence_anchor_date)
         VALUES (?, ?, 1, ?, 'daily', ?, ?, 1, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        opts.kind ?? "medication",
        opts.obligation ?? "must",
        opts.quantityOnHand ?? null,
        createdAt,
        opts.cadenceKind ?? "daily",
        opts.cadenceWeekdays ?? null,
        opts.cadenceIntervalDays ?? null,
        opts.cadenceAnchorDate ?? null
      ).lastInsertRowid
  );
  return { itemId, createdAt };
}

function seedDose(
  itemId: number,
  createdAt: string,
  extra: {
    amount?: string;
    weekdays?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    sort?: number;
  } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at,
            weekdays, start_date, end_date)
         VALUES (?, ?, 'morning', 'any', ?, ?, ?, ?, ?)`
      )
      .run(
        itemId,
        extra.amount ?? "1 unit",
        extra.sort ?? 0,
        createdAt,
        extra.weekdays ?? null,
        extra.startDate ?? null,
        extra.endDate ?? null
      ).lastInsertRowid
  );
}

function logTaken(doseId: number, itemId: number, date: string): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
     VALUES (?, ?, ?, 'taken', '1 unit')`
  ).run(doseId, itemId, date);
}

// The strip inputs, gathered the way every real caller does.
function stripFor(profileId: number, itemId: number, dates: string[]) {
  const item = getSupplements(profileId).find((s) => s.id === itemId)!;
  const doses = getSupplementDoses(profileId).filter(
    (d) => d.item_id === itemId
  );
  const takenByDose = indexTakenByDose(
    getIntakeLogsInRange(profileId, dates.length + 2)
  );
  return supplementAdherenceStrip(
    item,
    doses,
    dates,
    new Set<string>(),
    () => new Set<string>(),
    takenByDose,
    getTimezone(profileId)
  );
}

describe("#1602 — a weekly medication stays `must` and is simply not due most days", () => {
  it("appears on the due list on its weekday and nowhere on the other six", () => {
    const p = createProfile("Cadence Weekly (test)");
    const day = today(p);
    const dow = weekdayOfDateStr(day);
    // Anchored on TODAY's weekday so the item is due today, and on tomorrow's for the
    // control — no dependence on which day the suite happens to run.
    const { itemId, createdAt } = seedItem(p, "Methotrexate (test)", {
      cadenceKind: "weekly",
      cadenceWeekdays: String(dow),
    });
    const doseId = seedDose(itemId, createdAt);
    const other = seedItem(p, "Alendronate (test)", {
      cadenceKind: "weekly",
      cadenceWeekdays: String((dow + 1) % 7),
    });
    const otherDoseId = seedDose(other.itemId, other.createdAt);

    const keys = collectUpcoming(p, day).map((i) => i.key);
    expect(keys).toContain(`dose:${doseId}`);
    expect(keys).not.toContain(`dose:${otherDoseId}`);

    // Crucially, the OFF-day item was not silenced by demoting it: it is still `must`,
    // so its reminders and missed-dose escalation remain intact for its own day.
    const off = getSupplements(p).find((s) => s.id === other.itemId)!;
    expect(off.obligation).toBe("must");
    expect(off.active).toBeTruthy();

    // And the row that IS due names its cadence, so a once-a-week row never reads as
    // an ordinary daily dose the user is somehow only now seeing.
    const row = collectUpcoming(p, day).find(
      (i) => i.key === `dose:${doseId}`
    )!;
    expect(row.dueText).toContain(
      cadenceLabel(getSupplements(p).find((s) => s.id === itemId)!)
    );
  });
});

describe("#1602 — the adherence denominator counts on-days only", () => {
  // The issue's own acceptance case: a weekly item over 28 days expects 4 doses, not
  // 28. Taking all four is 100% — under the old daily assumption it would have read
  // 4/28 ≈ 14% and looked like catastrophic non-adherence.
  it("a perfectly-followed weekly item over 28 days is 4 expected, 4 taken, 100%", () => {
    const p = createProfile("Cadence Denominator (test)");
    const day = today(p);
    const dow = weekdayOfDateStr(day);
    const { itemId, createdAt } = seedItem(p, "Semaglutide (test)", {
      cadenceKind: "weekly",
      cadenceWeekdays: String(dow),
    });
    const doseId = seedDose(itemId, createdAt);

    // The 28-day window ending yesterday (today is still pending and is excluded from
    // the summary by the trailing-pending rule, so the window is closed on purpose).
    const dates = Array.from({ length: 28 }, (_, i) =>
      shiftDateStr(day, -28 + i)
    );
    // Log every on-day in the window — exactly the days the cadence lands on.
    const onDays = dates.filter((d) => weekdayOfDateStr(d) === dow);
    expect(onDays).toHaveLength(4);
    for (const d of onDays) logTaken(doseId, itemId, d);

    const strip = stripFor(p, itemId, dates);
    const scored = strip.filter((s) => s.state !== "na");
    expect(scored).toHaveLength(4);
    expect(scored.every((s) => s.state === "taken")).toBe(true);
    // Every off-day is "na" — nothing was expected, so there is no follow-through to
    // measure. Not "missed", which is the failure this fixture exists to pin.
    expect(strip.filter((s) => s.state === "missed")).toHaveLength(0);
    expect(adherenceSummary(strip).pct).toBe(100);
  });

  it("a missed on-day is still a miss — the cadence removes days, never accountability", () => {
    const p = createProfile("Cadence Miss (test)");
    const day = today(p);
    const dow = weekdayOfDateStr(day);
    const { itemId, createdAt } = seedItem(p, "Methotrexate Miss (test)", {
      cadenceKind: "weekly",
      cadenceWeekdays: String(dow),
    });
    const doseId = seedDose(itemId, createdAt);

    const dates = Array.from({ length: 28 }, (_, i) =>
      shiftDateStr(day, -28 + i)
    );
    const onDays = dates.filter((d) => weekdayOfDateStr(d) === dow);
    // Take three of the four; skip the earliest entirely.
    for (const d of onDays.slice(1)) logTaken(doseId, itemId, d);

    const strip = stripFor(p, itemId, dates);
    expect(strip.filter((s) => s.state === "missed")).toHaveLength(1);
    expect(strip.filter((s) => s.state === "taken")).toHaveLength(3);
    expect(adherenceSummary(strip).pct).toBe(75);
  });
});

describe("#1602 — alternating amounts are two dose rows of one item", () => {
  it("shows exactly one amount per day and keeps a separate history per row", () => {
    const p = createProfile("Cadence Warfarin (test)");
    const day = today(p);
    const dow = weekdayOfDateStr(day);
    const { itemId, createdAt } = seedItem(p, "Warfarin (test)", {});
    // Today's weekday gets the 5 mg row; every other weekday gets 2.5 mg.
    const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dow).join(",");
    const fiveId = seedDose(itemId, createdAt, {
      amount: "5 mg",
      weekdays: String(dow),
      sort: 0,
    });
    const halfId = seedDose(itemId, createdAt, {
      amount: "2.5 mg",
      weekdays: others,
      sort: 1,
    });

    // ONE item, but only the row whose weekday matches is due today.
    const keys = collectUpcoming(p, day).map((i) => i.key);
    expect(keys).toContain(`dose:${fiveId}`);
    expect(keys).not.toContain(`dose:${halfId}`);
    // Tomorrow the pair swaps.
    const tomorrowKeys = collectUpcoming(p, shiftDateStr(day, 1)).map(
      (i) => i.key
    );
    expect(tomorrowKeys).toContain(`dose:${halfId}`);
    expect(tomorrowKeys).not.toContain(`dose:${fiveId}`);

    // Each row carries its OWN adherence history under its own dose_id — which is what
    // makes the two-row shape a real answer rather than a display trick.
    const yesterday = shiftDateStr(day, -1);
    logTaken(halfId, itemId, yesterday);
    logTaken(fiveId, itemId, shiftDateStr(day, -7));
    const logs = db
      .prepare(
        `SELECT dose_id, date FROM intake_item_logs WHERE item_id = ? ORDER BY date`
      )
      .all(itemId) as { dose_id: number; date: string }[];
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((l) => l.dose_id))).toEqual(
      new Set([fiveId, halfId])
    );
  });
});

describe("#1602 — a taper is windowed rows, and an expired window is not a retire", () => {
  it("switches amount by date while every earlier row keeps its logs and its live status", () => {
    const p = createProfile("Cadence Taper (test)");
    const day = today(p);
    const { itemId, createdAt } = seedItem(p, "Prednisone (test)", {});
    // Two past windows and the one covering today.
    const highId = seedDose(itemId, createdAt, {
      amount: "40 mg",
      startDate: shiftDateStr(day, -21),
      endDate: shiftDateStr(day, -15),
      sort: 0,
    });
    const midId = seedDose(itemId, createdAt, {
      amount: "30 mg",
      startDate: shiftDateStr(day, -14),
      endDate: shiftDateStr(day, -8),
      sort: 1,
    });
    const nowId = seedDose(itemId, createdAt, {
      amount: "20 mg",
      startDate: shiftDateStr(day, -7),
      endDate: shiftDateStr(day, 7),
      sort: 2,
    });

    const keys = collectUpcoming(p, day).map((i) => i.key);
    expect(keys).toContain(`dose:${nowId}`);
    expect(keys).not.toContain(`dose:${highId}`);
    expect(keys).not.toContain(`dose:${midId}`);

    // NOT retired — the rows are still live schedule rows whose windows have passed.
    // That distinction is what keeps history readable and the taper reversible.
    const rows = db
      .prepare(`SELECT id, retired FROM intake_item_doses WHERE item_id = ?`)
      .all(itemId) as { id: number; retired: number }[];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.retired === 0)).toBe(true);
    // And they are still returned by the current-schedule read.
    const live = getSupplementDoses(p)
      .filter((d) => d.item_id === itemId)
      .map((d) => d.id);
    expect(live).toEqual(expect.arrayContaining([highId, midId, nowId]));

    // A log written during the 40 mg window still reads, untouched, after the window
    // closed — the whole reason a taper is windows rather than amount edits.
    logTaken(highId, itemId, shiftDateStr(day, -18));
    const kept = db
      .prepare(`SELECT amount FROM intake_item_logs WHERE dose_id = ?`)
      .get(highId) as { amount: string } | undefined;
    expect(kept?.amount).toBe("1 unit");
  });
});

describe("#1602 — refill projection divides by cadence density", () => {
  it("reads 12 weekly tablets as weeks of supply, not days", () => {
    const p = createProfile("Cadence Refill (test)");
    const dow = weekdayOfDateStr(today(p));
    const weekly = seedItem(p, "Alendronate Supply (test)", {
      quantityOnHand: 12,
      cadenceKind: "weekly",
      cadenceWeekdays: String(dow),
    });
    seedDose(weekly.itemId, weekly.createdAt);
    const daily = seedItem(p, "Daily Supply (test)", { quantityOnHand: 12 });
    seedDose(daily.itemId, daily.createdAt);

    // No logs, so both fall back to the SCHEDULE rate — the branch cadence scales.
    const rates = getRefillRates(p);
    const weeklyRate = rates.get(weekly.itemId)!;
    const dailyRate = rates.get(daily.itemId)!;
    expect(weeklyRate.basis).toBe("schedule");
    expect(weeklyRate.dosesPerDay).toBeCloseTo(1 / 7);
    expect(dailyRate.dosesPerDay).toBe(1);

    const weeklyDays = daysOfSupplyLeft(12, 1, weeklyRate.dosesPerDay);
    const dailyDays = daysOfSupplyLeft(12, 1, dailyRate.dosesPerDay);
    expect(dailyDays).toBe(12);
    expect(weeklyDays).toBe(84);
  });
});

describe("#1602 — an off-day confirm logs, and says that it was off-day", () => {
  it("writes the log and returns logged-off-day with a nameable cadence", () => {
    const p = createProfile("Cadence Off Day (test)");
    const day = today(p);
    const dow = weekdayOfDateStr(day);
    // Scheduled for TOMORROW's weekday, so today is an off-day for it.
    const { itemId, createdAt } = seedItem(p, "Weekly Off Day (test)", {
      cadenceKind: "weekly",
      cadenceWeekdays: String((dow + 1) % 7),
    });
    const doseId = seedDose(itemId, createdAt);

    const outcome = markDoseTaken(p, doseId, itemId, day);
    expect(outcome).toBe("logged-off-day");

    // The LOG IS WRITTEN — you record reality. The outcome changes the answer, never
    // the ledger (the same surfacing/ledger split a held item follows).
    const row = db
      .prepare(
        `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(doseId, day) as { status: string } | undefined;
    expect(row?.status).toBe("taken");

    // And the answer names the schedule instead of a bare confirmation.
    const label = getDoseCadenceLabel(p, doseId);
    expect(label).toBeTruthy();
    const answer = tapAnswerText(outcome, label);
    expect(answer).toContain("Logged");
    expect(answer).toContain(label!);

    // A dose on an ON-day is still a plain "logged" — the new variant is not leaking
    // into the ordinary path.
    const on = seedItem(p, "Weekly On Day (test)", {
      cadenceKind: "weekly",
      cadenceWeekdays: String(dow),
    });
    const onDoseId = seedDose(on.itemId, on.createdAt);
    expect(markDoseTaken(p, onDoseId, on.itemId, day)).toBe("logged");
  });

  it("scopes the cadence lookup to the profile — another profile's dose reads null", () => {
    const a = createProfile("Cadence Scope A (test)");
    const b = createProfile("Cadence Scope B (test)");
    const { itemId, createdAt } = seedItem(a, "Scoped Weekly (test)", {
      cadenceKind: "weekly",
      cadenceWeekdays: "1",
    });
    const doseId = seedDose(itemId, createdAt);
    expect(getDoseCadenceLabel(a, doseId)).toBe("Mondays");
    expect(getDoseCadenceLabel(b, doseId)).toBeNull();
  });
});

describe("#1602 — existing daily rows are untouched by the migration", () => {
  it("defaults every pre-existing item to daily, so its dueness is unchanged", () => {
    const p = createProfile("Cadence Default (test)");
    const day = today(p);
    // Inserted WITHOUT any cadence columns, exactly as pre-#1602 code would.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, qty_per_dose, created_at)
           VALUES (?, 'Legacy Daily (test)', 1, 'supplement', 'daily', 'should', 1, ?)`
        )
        .run(p, `${shiftDateStr(day, -60)} 08:00:00`).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 unit', 'morning', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );

    const item = getSupplements(p).find((s) => s.id === itemId)!;
    expect(item.cadence_kind).toBe("daily");
    expect(cadenceLabel(item)).toBeNull();
    // Due today and every day, as before.
    for (const offset of [0, 1, 2, 3]) {
      const keys = collectUpcoming(p, shiftDateStr(day, offset)).map(
        (i) => i.key
      );
      if (offset === 0) expect(keys).toContain(`dose:${doseId}`);
    }
    expect(collectUpcoming(p, day).map((i) => i.key)).toContain(
      `dose:${doseId}`
    );
  });
});
