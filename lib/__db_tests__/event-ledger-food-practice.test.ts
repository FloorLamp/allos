import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getFoodLedgerPage } from "@/lib/queries/nutrition";
import {
  getPracticeLedgerOptions,
  getPracticeLedgerPage,
} from "@/lib/queries/wellness";
import { getTimelineDates, getTimelineEvents } from "@/lib/timeline";

function profile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function food(profileId: number, key: string, date: string, minute: number) {
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(
    profileId,
    key,
    date,
    `2026-08-20T12:${String(minute).padStart(2, "0")}:00.000Z`
  );
}

describe("food and practice event-ledger completion (#3484)", () => {
  it("rolls food and substance into separate per-day Timeline events with working filters", () => {
    const owner = profile("ledger timeline owner");
    const stranger = profile("ledger timeline stranger");
    food(owner, "berries", "2026-08-20", 1);
    food(owner, "berries", "2026-08-20", 2);
    food(owner, "leafy_greens", "2026-08-20", 3);
    food(owner, "alcohol", "2026-08-20", 4);
    food(owner, "__protein__", "2026-08-20", 5);
    food(owner, "__protein__", "2026-08-19", 7);
    food(stranger, "fruit", "2026-08-20", 6);
    db.prepare(
      `INSERT INTO substance_daily_totals (profile_id, substance, date, units)
       VALUES (?, 'nicotine', '2026-08-20', 2), (?, 'cannabis', '2026-08-20', 1)`
    ).run(owner, stranger);

    const all = getTimelineEvents(owner, {
      startDate: "2026-08-20",
      endDate: "2026-08-20",
    });
    const foodEvent = all.find((event) => event.id === "food:2026-08-20");
    const substanceEvent = all.find(
      (event) => event.id === "substance:2026-08-20"
    );
    expect(foodEvent).toMatchObject({
      category: "food",
      title: "3 servings logged",
    });
    expect(foodEvent?.detailItems).toEqual([
      { label: "Berries", value: "2 servings" },
      { label: "Leafy greens", value: "1 serving" },
    ]);
    expect(substanceEvent).toMatchObject({
      category: "substance",
      title: "3 substance uses logged",
    });
    expect(substanceEvent?.detailItems).toEqual([
      { label: "Alcohol", value: "1 standard drink" },
      { label: "Nicotine", value: "2 uses" },
    ]);
    expect(
      getTimelineEvents(owner, { category: "food" }).map(
        (event) => event.category
      )
    ).toEqual(["food"]);
    expect(
      getTimelineEvents(owner, { category: "substance" }).map(
        (event) => event.category
      )
    ).toEqual(["substance"]);
    expect(getTimelineDates(owner)).toContain("2026-08-20");
    expect(getTimelineDates(owner)).not.toContain("2026-08-19");
  });

  it("pages and filters serving rows without crossing profile scope", () => {
    const owner = profile("food ledger owner");
    const stranger = profile("food ledger stranger");
    for (let i = 0; i < 11; i++)
      food(owner, i % 2 ? "berries" : "fruit", "2026-08-20", i);
    food(owner, "__protein__", "2026-08-20", 30);
    food(stranger, "berries", "2026-08-20", 31);
    const first = getFoodLedgerPage(owner, "2026-01-01", {}, 1, 10);
    expect(first.total).toBe(11);
    expect(first.rows).toHaveLength(10);
    expect(getFoodLedgerPage(owner, "2026-01-01", {}, 2, 10).rows).toHaveLength(
      1
    );
    expect(getFoodLedgerPage(owner, "2026-01-01", {}, 99, 10).page).toBe(2);
    expect(
      getFoodLedgerPage(owner, "2026-01-01", { groupKey: "berries" }, 1, 10)
        .total
    ).toBe(5);
  });

  it("pages practice rows and folds an item filter across stored spellings", () => {
    const owner = profile("practice ledger owner");
    const stranger = profile("practice ledger stranger");
    const insert = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time)
       VALUES (?, ?, '2026-08-20', ?)`
    );
    insert.run(owner, "Sauna", "08:00");
    insert.run(owner, "sauna", "09:00");
    insert.run(owner, "Meditation", "10:00");
    insert.run(stranger, "Sauna", "11:00");
    const all = getPracticeLedgerPage(owner, "2026-01-01", {}, 1, 10);
    expect(all.total).toBe(3);
    const sauna = getPracticeLedgerPage(
      owner,
      "2026-01-01",
      { practice: "SAUNA" },
      1,
      1
    );
    expect(sauna.total).toBe(2);
    expect(sauna.rows).toHaveLength(1);
    expect(sauna.rows[0].practice.toLowerCase()).toBe("sauna");
    expect(getPracticeLedgerPage(owner, "2026-01-01", {}, 99, 2).page).toBe(2);
    expect(getPracticeLedgerOptions(owner)).toEqual([
      { identity: "meditation", name: "Meditation" },
      { identity: "sauna", name: "sauna" },
    ]);
  });
});
