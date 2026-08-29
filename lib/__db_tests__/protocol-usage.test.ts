// DB INTEGRATION TIER — protocol practice/usage reads (issue #344).
//
// getProtocolUsage (usage-during-window: activity/practice events or food-serving
// totals within [start, end??today]),
// getProtocolPractice (the configured type + per-week), and getProtocolAdherence
// (the SAME weekly-count computation the routine widget uses) against the real
// schema. The db singleton is a per-file temp DB (setup.ts); profile 1 exists.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { createEquipment } from "@/lib/equipment";
import {
  getProtocol,
  getProtocols,
  getProtocolUsage,
  getProtocolUsageByDay,
  getProtocolHeatmap,
  getProtocolHeatmaps,
  getProtocolPractice,
  getProtocolAdherence,
} from "@/lib/queries";

function insertTypeTarget(profileId: number, type: string, perWeek: number) {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
         VALUES (?, 'type', ?, ?)`
      )
      .run(profileId, type, perWeek).lastInsertRowid
  );
}

function insertProtocol(
  profileId: number,
  opts: {
    start: string;
    end?: string | null;
    equipment_id?: number | null;
    frequency_target_id?: number | null;
    intake_item_id?: number | null;
  }
) {
  return Number(
    db
      .prepare(
        `INSERT INTO protocols
           (profile_id, name, start_date, end_date, equipment_id,
            frequency_target_id, intake_item_id)
         VALUES (?, 'P', ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.start,
        opts.end ?? null,
        opts.equipment_id ?? null,
        opts.frequency_target_id ?? null,
        opts.intake_item_id ?? null
      ).lastInsertRowid
  );
}

function insertIntakeItem(
  profileId: number,
  name: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, active, condition, obligation)
         VALUES (?, ?, 'supplement', 1, 'daily', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 g', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function insertDoseLog(
  dose: { itemId: number; doseId: number },
  date: string,
  status: "taken" | "skipped" = "taken"
) {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
     VALUES (?, ?, ?, ?)`
  ).run(dose.doseId, dose.itemId, date, status);
}

function insertActivity(
  profileId: number,
  date: string,
  type: string,
  equipment_id: number | null
) {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, equipment_id)
     VALUES (?, ?, ?, 'Session', ?)`
  ).run(profileId, date, type, equipment_id);
}

describe("getProtocolUsage / getProtocolPractice / getProtocolAdherence", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM practice_logs WHERE profile_id = 1").run();
    db.prepare("DELETE FROM food_daily_totals WHERE profile_id = 1").run();
    db.prepare("DELETE FROM activities WHERE profile_id = 1").run();
    db.prepare("DELETE FROM protocols WHERE profile_id = 1").run();
    db.prepare("DELETE FROM frequency_targets WHERE profile_id = 1").run();
    db.prepare("DELETE FROM equipment WHERE profile_id = 1").run();
    db.prepare("DELETE FROM intake_items WHERE profile_id = 1").run();
  });

  it("counts in-window activity events, including multiple sessions on one day", () => {
    const sauna = createEquipment(1, {
      name: "Sauna",
      weight_kg: null,
      category: "Sauna",
    });
    const tid = insertTypeTarget(1, "cardio", 4);
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      equipment_id: sauna.id,
      frequency_target_id: tid,
    });

    // In-window, gear-linked (counts).
    insertActivity(1, "2026-06-03", "sport", sauna.id);
    // In-window, practice type cardio (counts).
    insertActivity(1, "2026-06-10", "cardio", null);
    // Same day, gear-linked AND cardio — a second event is a second session.
    insertActivity(1, "2026-06-10", "cardio", sauna.id);
    // Out of window (before start) — excluded.
    insertActivity(1, "2026-05-20", "cardio", sauna.id);
    // Out of window (after end) — excluded.
    insertActivity(1, "2026-07-05", "cardio", null);
    // Unrelated type, no gear — excluded.
    insertActivity(1, "2026-06-15", "strength", null);

    const p = getProtocol(1, pid)!;
    const usage = getProtocolUsage(1, p, "2026-07-31");
    expect(usage.sessions).toBe(3);
    expect(usage.lastUsed).toBe("2026-06-10");
    expect(getProtocolUsageByDay(1, p, "2026-07-31")).toEqual([
      { date: "2026-06-03", count: 1 },
      { date: "2026-06-10", count: 2 },
    ]);
  });

  it("counts practice-log rows across identity variants and excludes outside-window sessions", () => {
    const tid = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (1, 'practice', 'Sauna', 'sauna', 3)`
        )
        .run().lastInsertRowid
    );
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      frequency_target_id: tid,
    });
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date)
       VALUES (1, 'sauna', '2026-06-10'),
              (1, ' SAUNA ', '2026-06-10'),
              (1, 'Sauna', '2026-05-31'),
              (1, 'Sauna', '2026-07-01')`
    ).run();

    const protocol = getProtocol(1, pid)!;
    expect(getProtocolUsage(1, protocol, "2026-07-31")).toEqual({
      sessions: 2,
      lastUsed: "2026-06-10",
    });
    expect(getProtocolUsageByDay(1, protocol, "2026-07-31")).toEqual([
      { date: "2026-06-10", count: 2 },
    ]);
    const cells = getProtocolHeatmap(
      1,
      protocol,
      "2026-07-31",
      0
    ).columns.flat();
    expect(cells.find((cell) => cell.date === "2026-06-10")).toMatchObject({
      count: 2,
      level: 2,
      outside: false,
    });
  });

  it("sums food servings across the protocol window", () => {
    const tid = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, per_week)
           VALUES (1, 'food_group', 'fatty_fish', 2)`
        )
        .run().lastInsertRowid
    );
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      frequency_target_id: tid,
    });
    db.prepare(
      `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
       VALUES (1, '2026-06-08', 'fatty_fish', 2),
              (1, '2026-06-09', 'fatty_fish', 1),
              (1, '2026-06-10', 'fatty_fish', 0),
              (1, '2026-07-01', 'fatty_fish', 1)`
    ).run();
    const protocol = getProtocol(1, pid)!;
    expect(getProtocolUsage(1, protocol, "2026-07-31")).toEqual({
      sessions: 3,
      lastUsed: "2026-06-09",
    });
    expect(getProtocolUsageByDay(1, protocol, "2026-07-31")).toEqual([
      { date: "2026-06-08", count: 2 },
      { date: "2026-06-09", count: 1 },
    ]);
  });

  it("uses today as the window end for an ongoing protocol", () => {
    const tid = insertTypeTarget(1, "cardio", 3);
    const pid = insertProtocol(1, {
      start: "2000-01-01",
      end: null,
      frequency_target_id: tid,
    });
    insertActivity(1, today(1), "cardio", null);
    const p = getProtocol(1, pid)!;
    const usage = getProtocolUsage(1, p, today(1));
    expect(usage.sessions).toBe(1);
  });

  it("returns zero usage when neither gear nor practice is linked", () => {
    const pid = insertProtocol(1, { start: "2026-06-01" });
    const p = getProtocol(1, pid)!;
    expect(getProtocolUsage(1, p, "2026-07-01")).toEqual({
      sessions: 0,
      lastUsed: null,
    });
  });

  // #2797: a supplement N-of-1 links the intake item and nothing else. Before the
  // fourth ledger branch it matched no scope and reported 0 forever, so the app's
  // own Creatine/NMN showcases rendered as abandoned experiments.
  it("counts confirmed doses per day for a protocol linked only by intake_item_id", () => {
    const creatine = insertIntakeItem(1, "Creatine Monohydrate");
    const other = insertIntakeItem(1, "Vitamin D3");
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      intake_item_id: creatine.itemId,
    });

    insertDoseLog(creatine, "2026-06-03");
    // Two confirmed doses on one day are two events, as everywhere else here.
    insertDoseLog(creatine, "2026-06-10");
    insertDoseLog(creatine, "2026-06-10");
    // Skipped is a logged NON-event.
    insertDoseLog(creatine, "2026-06-12", "skipped");
    // Out of window on both sides.
    insertDoseLog(creatine, "2026-05-31");
    insertDoseLog(creatine, "2026-07-01");
    // A different item the protocol does not link.
    insertDoseLog(other, "2026-06-10");

    const protocol = getProtocol(1, pid)!;
    expect(getProtocolUsage(1, protocol, "2026-07-31")).toEqual({
      sessions: 3,
      lastUsed: "2026-06-10",
    });
    expect(getProtocolUsageByDay(1, protocol, "2026-07-31")).toEqual([
      { date: "2026-06-03", count: 1 },
      { date: "2026-06-10", count: 2 },
    ]);
    const cells = getProtocolHeatmap(
      1,
      protocol,
      "2026-07-31",
      0
    ).columns.flat();
    expect(cells.find((cell) => cell.date === "2026-06-10")).toMatchObject({
      count: 2,
      outside: false,
    });
  });

  it("keeps a gear-linked protocol on the activity ledger even when it also names an intake item", () => {
    const sauna = createEquipment(1, {
      name: "Sauna",
      weight_kg: null,
      category: "Sauna",
    });
    const nmn = insertIntakeItem(1, "Nicotinamide Mononucleotide");
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      equipment_id: sauna.id,
      intake_item_id: nmn.itemId,
    });
    insertActivity(1, "2026-06-05", "sport", sauna.id);
    insertDoseLog(nmn, "2026-06-06");

    const protocol = getProtocol(1, pid)!;
    expect(getProtocolUsage(1, protocol, "2026-07-31")).toEqual({
      sessions: 1,
      lastUsed: "2026-06-05",
    });
  });

  // #2797 review caveat 1. An UNMEASURABLE frequency target has already answered
  // "what does this protocol measure" — with "not a session ledger". Acquiring the
  // dose ledger instead would report a substance CAP as usage, which is the
  // adherence misread PROTOCOL_USAGE_LEDGER's own comment declines to create.
  it("keeps reporting nothing when the frequency target is an unmeasurable scope", () => {
    const substanceTargetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, per_week)
           VALUES (1, 'substance', 'alcohol', 3)`
        )
        .run().lastInsertRowid
    );
    const item = insertIntakeItem(1, "Creatine Monohydrate");
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      frequency_target_id: substanceTargetId,
      intake_item_id: item.itemId,
    });
    insertDoseLog(item, "2026-06-05");
    insertDoseLog(item, "2026-06-06");

    expect(getProtocolUsage(1, getProtocol(1, pid)!, "2026-07-31")).toEqual({
      sessions: 0,
      lastUsed: null,
    });
  });

  // #2797 review caveat 2. `intake_item_logs.item_id` is a NULLABLE denormalized
  // shortcut (migration 011 finding #2); `intake_item_doses.item_id` is NOT NULL and
  // FK-enforced. Reading the shortcut would silently drop a log that left it null and
  // would disagree with every other reader of this ledger about who owns the row.
  it("counts a dose whose log left the denormalized item_id null", () => {
    const item = insertIntakeItem(1, "Creatine Monohydrate");
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      intake_item_id: item.itemId,
    });
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, NULL, '2026-06-07', 'taken')`
    ).run(item.doseId);

    expect(getProtocolUsage(1, getProtocol(1, pid)!, "2026-07-31")).toEqual({
      sessions: 1,
      lastUsed: "2026-06-07",
    });
  });

  it("does not tally another profile's doses through a leaked intake_item_id", () => {
    const otherProfile = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Neighbour')").run()
        .lastInsertRowid
    );
    const theirs = insertIntakeItem(otherProfile, "Creatine Monohydrate");
    insertDoseLog(theirs, "2026-06-10");
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      intake_item_id: theirs.itemId,
    });

    const protocol = getProtocol(1, pid)!;
    expect(getProtocolUsage(1, protocol, "2026-07-31")).toEqual({
      sessions: 0,
      lastUsed: null,
    });
  });

  it("slices per protocol when several intake protocols share one gather", () => {
    const creatine = insertIntakeItem(1, "Creatine Monohydrate");
    const nmn = insertIntakeItem(1, "Nicotinamide Mononucleotide");
    const creatineId = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-15",
      intake_item_id: creatine.itemId,
    });
    const nmnId = insertProtocol(1, {
      start: "2026-06-16",
      end: "2026-06-30",
      intake_item_id: nmn.itemId,
    });
    insertDoseLog(creatine, "2026-06-05");
    // In the NMN protocol's window, but the creatine protocol's item — neither
    // protocol may claim it.
    insertDoseLog(creatine, "2026-06-20");
    insertDoseLog(nmn, "2026-06-20");
    // In the creatine window, NMN's item — likewise unclaimed.
    insertDoseLog(nmn, "2026-06-05");

    const heatmaps = getProtocolHeatmaps(
      1,
      getProtocols(1).filter((p) => p.id === creatineId || p.id === nmnId),
      "2026-07-31",
      0
    );
    expect(heatmaps[creatineId].totalSessions).toBe(1);
    expect(heatmaps[nmnId].totalSessions).toBe(1);
    expect(heatmaps[creatineId].unit).toBe("dose");
    expect(heatmaps[nmnId].unit).toBe("dose");
  });

  it("getProtocolPractice resolves the type + per-week; adherence reuses the weekly count", () => {
    const tid = insertTypeTarget(1, "cardio", 4);
    const pid = insertProtocol(1, {
      start: "2000-01-01",
      end: null,
      frequency_target_id: tid,
    });
    const p = getProtocol(1, pid)!;
    expect(getProtocolPractice(1, p)).toEqual({
      scopeKind: "type",
      value: "cardio",
      perWeek: 4,
      perWeekMax: null,
    });

    // A cardio activity this week counts toward the SAME frequency-target progress.
    insertActivity(1, today(1), "cardio", null);
    const adherence = getProtocolAdherence(1, p);
    expect(adherence?.target.id).toBe(tid);
    expect(adherence?.per_week).toBe(4);
    expect(adherence?.count).toBeGreaterThanOrEqual(1);
  });

  it("practice/adherence are null when unlinked", () => {
    const pid = insertProtocol(1, { start: "2026-06-01" });
    const p = getProtocol(1, pid)!;
    expect(getProtocolPractice(1, p)).toBeNull();
    expect(getProtocolAdherence(1, p)).toBeNull();
  });
});

describe("the protocol list's batched heatmap gather (#1655)", () => {
  const ASOF = "2026-07-31";

  beforeEach(() => {
    db.prepare("DELETE FROM practice_logs WHERE profile_id = 1").run();
    db.prepare("DELETE FROM food_daily_totals WHERE profile_id = 1").run();
    db.prepare("DELETE FROM activities WHERE profile_id = 1").run();
    db.prepare("DELETE FROM protocols WHERE profile_id = 1").run();
    db.prepare("DELETE FROM frequency_targets WHERE profile_id = 1").run();
    db.prepare("DELETE FROM equipment WHERE profile_id = 1").run();
  });

  // The interventions and the ledger rows they measure — created once per test.
  function seedLedgers() {
    const sauna = createEquipment(1, {
      name: "Sauna",
      weight_kg: null,
      category: "Sauna",
    });
    const scopes = {
      equipmentId: sauna.id,
      typeTarget: insertTypeTarget(1, "cardio", 4),
      practiceTarget: Number(
        db
          .prepare(
            `INSERT INTO frequency_targets
               (profile_id, scope_kind, scope_value, scope_identity, per_week)
             VALUES (1, 'practice', 'Sauna', 'sauna', 3)`
          )
          .run().lastInsertRowid
      ),
      foodTarget: Number(
        db
          .prepare(
            `INSERT INTO frequency_targets
               (profile_id, scope_kind, scope_value, per_week)
             VALUES (1, 'food_group', 'fatty_fish', 2)`
          )
          .run().lastInsertRowid
      ),
    };
    insertActivity(1, "2020-03-04", "cardio", sauna.id);
    insertActivity(1, "2026-06-10", "cardio", null);
    insertActivity(1, "2026-06-10", "strength", sauna.id);
    insertActivity(1, "2026-07-05", "cardio", sauna.id);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date)
       VALUES (1, 'sauna', '2020-03-05'),
              (1, ' SAUNA ', '2026-06-11'),
              (1, 'Sauna', '2026-06-11'),
              (1, 'Sauna', '2026-07-06')`
    ).run();
    db.prepare(
      `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
       VALUES (1, '2020-03-06', 'fatty_fish', 2),
              (1, '2026-06-12', 'fatty_fish', 3),
              (1, '2026-06-12', 'other_group', 9),
              (1, '2026-07-07', 'fatty_fish', 1)`
    ).run();
    return scopes;
  }

  // One protocol of EVERY scope per window — the list the /longevity section actually
  // renders for someone who has been running experiments for years.
  function addProtocols(
    scopes: ReturnType<typeof seedLedgers>,
    windows: readonly { start: string; end: string | null }[]
  ) {
    for (const w of windows) {
      insertProtocol(1, { ...w, equipment_id: scopes.equipmentId });
      insertProtocol(1, { ...w, frequency_target_id: scopes.typeTarget });
      insertProtocol(1, { ...w, frequency_target_id: scopes.practiceTarget });
      insertProtocol(1, { ...w, frequency_target_id: scopes.foodTarget });
      insertProtocol(1, w); // unlinked — the "none" scope
    }
  }

  function prepareCount(run: () => void): number {
    const spy = vi.spyOn(db, "prepare");
    try {
      run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it("returns exactly what asking protocol by protocol would have", () => {
    const scopes = seedLedgers();
    addProtocols(scopes, [
      { start: "2020-03-01", end: "2020-04-01" },
      { start: "2026-06-01", end: "2026-06-30" },
      { start: "2026-07-01", end: null },
    ]);
    const protocols = getProtocols(1);
    expect(protocols.length).toBe(15);

    const batched = getProtocolHeatmaps(1, protocols, ASOF, 0);
    const one = Object.fromEntries(
      protocols.map((p) => [p.id, getProtocolHeatmap(1, p, ASOF, 0)])
    );
    expect(batched).toEqual(one);
    // …and it really is carrying counts, not an all-empty agreement — on the LONG
    // ENDED window as much as on the ongoing one.
    const ended = protocols.filter((p) => p.end_date === "2020-04-01");
    expect(ended.some((p) => batched[p.id].totalSessions > 0)).toBe(true);
    expect(
      protocols.some(
        (p) => p.end_date === null && batched[p.id].totalSessions > 0
      )
    ).toBe(true);
  });

  it("does not read more as the profile's protocol history grows", () => {
    const scopes = seedLedgers();
    addProtocols(scopes, [{ start: "2026-06-01", end: "2026-06-30" }]);
    const few = getProtocols(1);
    const fewQueries = prepareCount(() => {
      getProtocolHeatmaps(1, few, ASOF, 0);
    });

    // Six years of finished experiments later…
    addProtocols(
      scopes,
      ["2020", "2021", "2022", "2023", "2024", "2025"].map((year) => ({
        start: `${year}-01-01`,
        end: `${year}-06-30`,
      }))
    );
    const many = getProtocols(1);
    expect(many.length).toBeGreaterThan(few.length * 5);
    const manyQueries = prepareCount(() => {
      getProtocolHeatmaps(1, many, ASOF, 0);
    });

    // The gather is one read per LEDGER (plus the target and spelling lookups), so the
    // count is a function of the scopes in play, never of how many protocols the
    // profile has ever created.
    expect(manyQueries).toBe(fewQueries);
    expect(manyQueries).toBeLessThan(10);

    // The old per-protocol shape, for contrast: it grows with the history.
    const perProtocol = prepareCount(() => {
      for (const p of many) getProtocolHeatmap(1, p, ASOF, 0);
    });
    expect(perProtocol).toBeGreaterThan(manyQueries * 5);
  });
});
