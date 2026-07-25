// DB INTEGRATION TIER — issue #1458: the interval-only PRN config.
//
// The sick-kid scenario: a caregiver quick-adds "Acetaminophen 160 mg", ticks As
// needed, fills in "Minimum hours between doses = 6", and leaves the OPTIONAL
// "Maximum doses per day" blank — it is the field a parent is least likely to know
// offhand. Before this fix both med-data gathers ANDed the two fields together, so a
// stored 6-hour interval produced no redose guidance at all: the single number wanted
// at 2am was computable, stored, and never shown.
//
// The pure tier can pin redoseWindowStatus/redoseCardLabel with a null max, but the
// defect lived in the GATHER's input gate — exactly the #448 blind spot — so this
// fixture drives the real loader and asserts the emitted `redoseLine` on BOTH surfacing
// paths it feeds: the med card (`current[].prnRedoseLine`) and the Today panel
// (`prnToday[].redoseLine`, the same read the dashboard PRN widget consumes).
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { utcSqlString } from "@/lib/date";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A PRN medication + its primary dose row, with the redose fields as given.
function seedPrnMed(
  profileId: number,
  name: string,
  opts: { minInterval: number | null; maxDaily: number | null; amount?: string }
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed,
            min_interval_hours, max_daily_count)
         VALUES (?, ?, 1, 'medication', 'daily', 'high', 1, ?, ?)`
      )
      .run(profileId, name, opts.minInterval, opts.maxDaily).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, ?, 'anytime', 'any', 0)`
      )
      .run(itemId, opts.amount ?? "160 mg").lastInsertRowid
  );
  return { itemId, doseId };
}

function logAdministration(
  itemId: number,
  doseId: number,
  date: string,
  hoursAgo: number
): void {
  const givenAt = utcSqlString(new Date(Date.now() - hoursAgo * 3_600_000));
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status)
     VALUES (?, ?, ?, ?, 'taken')`
  ).run(doseId, itemId, date, givenAt);
}

// The redose line for an item on each of the two gathers the loader emits.
function redoseLines(profileId: number, itemId: number) {
  const data = loadMedicationsData(profileId);
  return {
    card: data.byId.get(itemId)?.prnRedoseLine ?? null,
    todayPanel: data.prnToday.find((m) => m.id === itemId)?.redoseLine ?? null,
  };
}

describe("PRN redose guidance with the daily max left blank (#1458)", () => {
  it("shows the countdown from the interval alone, on both surfacing gathers", () => {
    const p = newProfile("IntervalOnly");
    const { itemId, doseId } = seedPrnMed(p, "Acetaminophen", {
      minInterval: 6,
      maxDaily: null,
    });
    logAdministration(itemId, doseId, today(p), 1);

    const lines = redoseLines(p, itemId);
    // The regression: both were null before the fix.
    expect(lines.card).not.toBeNull();
    expect(lines.todayPanel).not.toBeNull();
    // 6h interval, dosed an hour ago → ~5h to go, and the count fragment degrades to
    // a bare "1 today" rather than inventing a ceiling.
    expect(lines.card).toBe("Next dose in ~5h · 1 today");
    expect(lines.todayPanel).toBe(lines.card);
  });

  it("opens the window once the interval passes, and never claims a max is reached", () => {
    const p = newProfile("IntervalOnlyOpen");
    const { itemId, doseId } = seedPrnMed(p, "Acetaminophen", {
      minInterval: 6,
      maxDaily: null,
    });
    const date = today(p);
    // Three administrations, the newest 7h ago — well past any plausible ceiling had
    // one been configured. An unconfigured maximum is not a reached one.
    logAdministration(itemId, doseId, date, 20);
    logAdministration(itemId, doseId, date, 13);
    logAdministration(itemId, doseId, date, 7);

    const lines = redoseLines(p, itemId);
    expect(lines.card).toBe("Redose OK — min interval passed · 3 today");
    expect(lines.card).not.toContain("Max reached");
    expect(lines.todayPanel).toBe(lines.card);
  });

  it("still says nothing without an interval, or before anything is logged", () => {
    const p = newProfile("IntervalOnlyNegatives");
    // No interval at all — nothing to count down to, even with a max on file.
    const noInterval = seedPrnMed(p, "Diphenhydramine", {
      minInterval: null,
      maxDaily: 6,
    });
    logAdministration(noInterval.itemId, noInterval.doseId, today(p), 1);
    // Interval on file but never dosed — the window is unarmed.
    const neverDosed = seedPrnMed(p, "Ondansetron", {
      minInterval: 8,
      maxDaily: null,
    });

    expect(redoseLines(p, noInterval.itemId).card).toBeNull();
    expect(redoseLines(p, noInterval.itemId).todayPanel).toBeNull();
    expect(redoseLines(p, neverDosed.itemId).card).toBeNull();
    expect(redoseLines(p, neverDosed.itemId).todayPanel).toBeNull();
  });

  it("keeps the confirmed max when one member of the family carries it (#1027)", () => {
    // Same ingredient family, one member with a max and one without: the widened math
    // takes the most conservative CONFIRMED max rather than degrading to null.
    const p = newProfile("IntervalOnlyFamily");
    const rx = seedPrnMed(p, "Ibuprofen 800 mg", {
      minInterval: 6,
      maxDaily: null,
      amount: "800 mg",
    });
    const otc = seedPrnMed(p, "Ibuprofen", {
      minInterval: 6,
      maxDaily: 4,
      amount: "200 mg",
    });
    db.prepare(
      "UPDATE intake_items SET rxcui_ingredients = ? WHERE id IN (?, ?)"
    ).run(JSON.stringify(["5640"]), rx.itemId, otc.itemId);
    logAdministration(otc.itemId, otc.doseId, today(p), 1);

    // The max-less Rx item inherits the family's confirmed ceiling, and the sibling's
    // dose arms its clock.
    expect(redoseLines(p, rx.itemId).card).toBe(
      "Next dose in ~5h · 1 of 4 today across 2 items"
    );
  });
});
