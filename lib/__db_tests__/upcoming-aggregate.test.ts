// DB INTEGRATION TIER — the denominator behind the Upcoming dose aggregate
// (issue #1504).
//
// The collapsed dose row prints "12 doses left · 9 of 21 taken". That fraction is
// only honest if its denominator comes from the SAME due evaluation the rows do, so
// these assert doseDayProgress against doseItems on one real schedule: the same
// obligation gate (#1505 — a `may` item is in neither number) and the same calendar
// gate (#1602 — an off-cadence day is in neither), plus the per-member cross-profile
// map the page sums.
//
// Fixtures are this file's own synthetic rows (obviously-fictional names) — no PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  doseDayProgress,
  collectMultiProfileDoseProgress,
} from "@/lib/queries";
import { doseItems } from "@/lib/queries/upcoming/intake-safety";
import { goalItems } from "@/lib/queries/upcoming/plans";
import { collectUpcoming } from "@/lib/queries";
import { groupUpcoming } from "@/lib/upcoming";
import {
  aggregateLabel,
  aggregateNearestDueDate,
  planBandRender,
} from "@/lib/upcoming-aggregate";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";

let seq = 0;

function mkProfile(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`AGG${++seq}`)
      .lastInsertRowid
  );
}

interface ItemOpts {
  obligation?: "must" | "should" | "may";
  cadenceKind?: "daily" | "weekly";
  cadenceWeekdays?: string | null;
}

function mkItem(profileId: number, name: string, opts: ItemOpts = {}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            cadence_kind, cadence_weekdays)
         VALUES (?, ?, 1, 'supplement', 'daily', ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        opts.obligation ?? "must",
        opts.cadenceKind ?? "daily",
        opts.cadenceWeekdays ?? null
      ).lastInsertRowid
  );
}

function mkDose(itemId: number, sort = 0): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 cap', 'morning', 'any', ?)`
      )
      .run(itemId, sort).lastInsertRowid
  );
}

function logTaken(doseId: number, itemId: number, date: string): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?, ?, ?, 'taken')`
  ).run(doseId, itemId, date);
}

describe("doseDayProgress (#1504)", () => {
  it("counts the day's scheduled doses and the taken ones, reconciling with the rows", () => {
    const profileId = mkProfile();
    const day = today(profileId);
    const a = mkItem(profileId, "Aggregate Vitamin D");
    const b = mkItem(profileId, "Aggregate Magnesium");
    const c = mkItem(profileId, "Aggregate Zinc");
    const doseA = mkDose(a);
    mkDose(b);
    mkDose(c);
    logTaken(doseA, a, day);

    const progress = doseDayProgress(profileId, day);
    expect(progress).toEqual({ scheduled: 3, taken: 1 });

    // THE invariant: what the summary says and what the disclosure shows are two
    // readings of one evaluation — pending + taken is exactly the scheduled count.
    const pending = doseItems(profileId, day);
    expect(pending).toHaveLength(2);
    expect(pending.length + progress.taken).toBe(progress.scheduled);
  });

  it("leaves a `may` item out of BOTH numbers (#1505)", () => {
    const profileId = mkProfile();
    const day = today(profileId);
    const owed = mkItem(profileId, "Aggregate Owed", { obligation: "must" });
    mkDose(owed);
    const offered = mkItem(profileId, "Aggregate Offered", {
      obligation: "may",
    });
    mkDose(offered);

    // Availability is not work: it is neither a due row nor part of the fraction,
    // so folding it here could never double-count what the collapsed "available"
    // disclosure already shows.
    expect(doseDayProgress(profileId, day)).toEqual({
      scheduled: 1,
      taken: 0,
    });
    expect(doseItems(profileId, day).map((i) => i.title)).toEqual([
      "Aggregate Owed",
    ]);
  });

  it("leaves an off-cadence weekly dose out of BOTH numbers (#1602)", () => {
    const profileId = mkProfile();
    const day = today(profileId);
    const dow = weekdayOfDateStr(day);
    const offDay = String((dow + 3) % 7);
    const onDay = String(dow);

    const weeklyOff = mkItem(profileId, "Aggregate Methotrexate", {
      cadenceKind: "weekly",
      cadenceWeekdays: offDay,
    });
    mkDose(weeklyOff);
    const weeklyOn = mkItem(profileId, "Aggregate Weekly B12", {
      cadenceKind: "weekly",
      cadenceWeekdays: onDay,
    });
    mkDose(weeklyOn);

    // The aggregate consumes the existing cadence gate rather than re-deriving one:
    // a weekly item on its six off-days is simply not part of today at all.
    expect(doseDayProgress(profileId, day)).toEqual({
      scheduled: 1,
      taken: 0,
    });
    expect(doseItems(profileId, day).map((i) => i.title)).toEqual([
      "Aggregate Weekly B12",
    ]);
  });

  it("counts a taken dose of an inactive item as neither scheduled nor taken", () => {
    const profileId = mkProfile();
    const day = today(profileId);
    const gone = mkItem(profileId, "Aggregate Retired");
    const doseId = mkDose(gone);
    logTaken(doseId, gone, day);
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(gone);

    expect(doseDayProgress(profileId, day)).toEqual({
      scheduled: 0,
      taken: 0,
    });
  });
});

describe("collectMultiProfileDoseProgress (#1504 × #1096)", () => {
  it("reports each in-view member's own day, with no bleed between profiles", () => {
    const a = mkProfile();
    const b = mkProfile();
    const dayA = today(a);
    const dayB = today(b);

    const a1 = mkItem(a, "Aggregate A One");
    const a1Dose = mkDose(a1);
    const a2 = mkItem(a, "Aggregate A Two");
    mkDose(a2);
    logTaken(a1Dose, a1, dayA);

    const b1 = mkItem(b, "Aggregate B One");
    mkDose(b1);

    const map = collectMultiProfileDoseProgress([a, b]);
    expect(map.get(a)).toEqual({ scheduled: 2, taken: 1 });
    expect(map.get(b)).toEqual({ scheduled: 1, taken: 0 });

    // A single-profile view sees only its own day — the by-person section prints a
    // fraction over exactly the rows it renders.
    expect([...collectMultiProfileDoseProgress([b]).keys()]).toEqual([b]);
    expect(doseDayProgress(b, dayB)).toEqual({ scheduled: 1, taken: 0 });
  });
});

// ── The goal fold, end to end (#2579-A) ──
//
// The pure tier proves planBandRender folds three `goal` rows. This proves the thing
// the pure tier cannot: that the rows REACHING it from a real profile are goal rows
// with real deadlines, that the fold is what the Later band actually renders, and
// that a folded goal keeps the identity the suppression bus writes against — the
// #1496 discipline (rendering aggregates; identity does not) asserted against the
// store rather than against a literal.
//
// Fictional goal titles, no PHI.
function mkGoal(profileId: number, title: string, targetDate: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO goals (profile_id, title, status, archived, target_date)
         VALUES (?, ?, 'active', 0, ?)`
      )
      .run(profileId, title, targetDate).lastInsertRowid
  );
}

describe("goal deadlines through the fold (#2579-A)", () => {
  it("folds a real profile's Later goals and keeps every one present and counted", () => {
    const profileId = mkProfile();
    const day = today(profileId);
    // Four deadlines, all past the This-week boundary (day 8+), deliberately NOT in
    // date order so the nearest-date claim cannot pass by reading the first row.
    const ids = [
      mkGoal(
        profileId,
        "Aggregate goal — ride a century",
        shiftDateStr(day, 200)
      ),
      mkGoal(
        profileId,
        "Aggregate goal — deadlift bodyweight",
        shiftDateStr(day, 40)
      ),
      mkGoal(profileId, "Aggregate goal — swim a mile", shiftDateStr(day, 120)),
      mkGoal(
        profileId,
        "Aggregate goal — hold a handstand",
        shiftDateStr(day, 300)
      ),
    ];

    const items = goalItems(profileId);
    expect(items.map((i) => i.key).sort()).toEqual(
      ids.map((id) => `goal:${id}`).sort()
    );

    const later = groupUpcoming(items, day).find((g) => g.band === "later");
    expect(later).toBeDefined();
    const nodes = planBandRender(later!.items);
    // ONE disclosure, holding all four. Completeness is the charter: no horizon
    // dropped a goal, and the fold hid none of them from the count.
    expect(nodes).toHaveLength(1);
    expect(nodes[0].node).toBe("aggregate");
    if (nodes[0].node !== "aggregate") return;
    expect(nodes[0].kind).toBe("goal");
    expect(nodes[0].items).toHaveLength(4);

    // The headline the collapsed row states, over the same four rows.
    expect(aggregateNearestDueDate(nodes[0].items)).toBe(shiftDateStr(day, 40));
    expect(
      aggregateLabel("goal", nodes[0].items.length, { nearestLabel: "Sep 26" })
    ).toBe("4 goal deadlines · nearest Sep 26");
  });

  it("keeps the suppression identity of every folded row", () => {
    const profileId = mkProfile();
    const day = today(profileId);
    const keep = [
      mkGoal(profileId, "Aggregate goal — walk daily", shiftDateStr(day, 60)),
      mkGoal(profileId, "Aggregate goal — sleep by ten", shiftDateStr(day, 90)),
      mkGoal(profileId, "Aggregate goal — read more", shiftDateStr(day, 150)),
    ];
    const dismissed = mkGoal(
      profileId,
      "Aggregate goal — learn to skate",
      shiftDateStr(day, 45)
    );

    const before = collectUpcoming(profileId, day).filter(
      (i) => i.domain === "goal"
    );
    expect(before).toHaveLength(4);

    // Dismiss ONE folded row by its own key. The fold never re-keyed it, so the bus
    // reaches it exactly as it would an unfolded row.
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
         VALUES (?, ?, datetime('now'))`
    ).run(profileId, `goal:${dismissed}`);

    const after = collectUpcoming(profileId, day).filter(
      (i) => i.domain === "goal"
    );
    expect(after.map((i) => i.key).sort()).toEqual(
      keep.map((id) => `goal:${id}`).sort()
    );

    // …and the remaining three still fold: the dismissal changed the count, not the
    // class. The nearest deadline moves with it, which is the whole reason the
    // headline is recomputed from the items rather than cached.
    const later = groupUpcoming(after, day).find((g) => g.band === "later");
    const nodes = planBandRender(later!.items);
    expect(nodes).toHaveLength(1);
    if (nodes[0].node !== "aggregate") throw new Error("expected an aggregate");
    expect(nodes[0].kind).toBe("goal");
    expect(nodes[0].items).toHaveLength(3);
    expect(aggregateNearestDueDate(nodes[0].items)).toBe(shiftDateStr(day, 60));
  });

  it("leaves an arranging errand at full height beside the fold", () => {
    // The defect the fold exists to fix: a colonoscopy to book buried under goal
    // deadlines. The appointment is a row; the goals are one line.
    const profileId = mkProfile();
    const day = today(profileId);
    for (const [title, offset] of [
      ["Aggregate goal — climb a 5.11", 30],
      ["Aggregate goal — run a marathon", 75],
      ["Aggregate goal — cut sugar", 110],
    ] as const) {
      mkGoal(profileId, title, shiftDateStr(day, offset));
    }
    const appointment = {
      key: "appointment:9001",
      domain: "appointment" as const,
      title: "Aggregate appointment — colonoscopy",
      href: "/upcoming" as const,
      dueDate: shiftDateStr(day, 50),
    };

    const later = groupUpcoming(
      [...goalItems(profileId), appointment],
      day
    ).find((g) => g.band === "later");
    const kinds = planBandRender(later!.items).map((n) =>
      n.node === "item" ? n.item.key : `aggregate:${n.kind}`
    );
    expect(kinds).toEqual(["aggregate:goal", "appointment:9001"]);
  });
});
