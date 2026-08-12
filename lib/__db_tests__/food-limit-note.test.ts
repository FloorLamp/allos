// DB INTEGRATION TIER (issue #2377) — the GATHER behind the curated limit direction at
// the log tap and in the digest.
//
// The pure tier (lib/__tests__/food-limit-note.test.ts) takes pre-gathered arrays and
// therefore cannot see the input layer at all. Everything this file asserts is exactly
// what the gather adds: which flagged readings reach the engine, the ACTIVATION date the
// arming gate is measured from (the reading's own collection date, read off real
// medical_records rows), the food_log read behind "first serving since the limit became
// active", the cap-direction exclusion pulled out of frequency_targets and the substance
// catalog, and the shared suppression bus — a `food-reduce:` family dismissed on the
// biomarker page must not be resurrected by a log tap.
//
// It also carries the case #2572's own DB fixture carries one domain over: a profile with
// BOTH halves of the forbidden sentence on file (a logged pattern and a flagged result)
// and a digest line that joins neither.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on the profile's
// own today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileBirthdate, setTimezone } from "@/lib/settings";
import { dismissFinding } from "@/lib/queries";
import { foodLimitDigestHead } from "@/lib/food-limit-note";
import {
  getFoodLimitDayObservations,
  getFoodLimitTapNote,
} from "@/lib/queries/food-limit";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  // The alcohol food–drug rules are adult-gated (#851 item 4).
  setProfileBirthdate(id, "1986-04-02");
  return id;
}

// A flagged lab reading collected on `date` — the row whose DATE is what arms the note.
function insertReading(
  profileId: number,
  opts: { name: string; flag: string; date: string; value?: string }
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, flag)
     VALUES (?, ?, 'lab', ?, ?, 'mg/dL', ?, ?)`
  ).run(
    profileId,
    opts.date,
    opts.name,
    opts.value ?? "180",
    opts.name,
    opts.flag
  );
}

function logServing(
  profileId: number,
  group: string,
  date: string,
  servings = 1
): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  ).run(profileId, date, group, servings);
}

function addMedication(
  profileId: number,
  name: string,
  window: { start?: string | null; end?: string | null } = {}
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
         VALUES (?, ?, 'medication', 1, 'must')`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, start_date, end_date)
     VALUES (?, '1 tab', 'morning', ?, ?)`
  ).run(itemId, window.start ?? null, window.end ?? null);
  return itemId;
}

describe("getFoodLimitTapNote — the dietary half (#2377)", () => {
  it("speaks on the first serving of a limited group since the flag was collected", () => {
    const p = newProfile("limit-tap-basic");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -3),
    });
    logServing(p, "fried_food", t);

    const note = getFoodLimitTapNote(p, "fried_food", t, 0);
    expect(note?.kind).toBe("dietary");
    expect(note?.title).toContain("LDL Cholesterol");
    expect(note?.hold).toBe(false);
  });

  it("says nothing at all for a profile with no flagged result", () => {
    const p = newProfile("limit-tap-unflagged");
    const t = today(p);
    logServing(p, "fried_food", t);
    expect(getFoodLimitTapNote(p, "fried_food", t, 0)).toBeNull();
  });

  it("says nothing for a group no live limit names", () => {
    const p = newProfile("limit-tap-other-group");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -3),
    });
    logServing(p, "berries", t);
    expect(getFoodLimitTapNote(p, "berries", t, 0)).toBeNull();
  });

  it("is silent on the day's second serving — at most one note per group per day", () => {
    const p = newProfile("limit-tap-repeat");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -3),
    });
    logServing(p, "fried_food", t, 2);
    expect(getFoodLimitTapNote(p, "fried_food", t, 1)).toBeNull();
  });

  it("is silent once the group has been logged since the flag — one per ACTIVATION", () => {
    const p = newProfile("limit-tap-spent");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -10),
    });
    // A serving on an earlier day, AFTER the reading was collected: the note has been
    // shown once already and logging again does not re-show it.
    logServing(p, "fried_food", shiftDateStr(t, -4));
    logServing(p, "fried_food", t);
    expect(getFoodLimitTapNote(p, "fried_food", t, 0)).toBeNull();
  });

  it("is NOT spent by servings logged BEFORE the flag was collected", () => {
    const p = newProfile("limit-tap-prior-history");
    const t = today(p);
    // A long habit that predates the result. The limit became active three days ago and
    // this is the first serving since — the moment the note is for.
    for (const back of [30, 20, 12, 5])
      logServing(p, "fried_food", shiftDateStr(t, -back));
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -3),
    });
    logServing(p, "fried_food", t);
    expect(getFoodLimitTapNote(p, "fried_food", t, 0)?.kind).toBe("dietary");
  });

  it("re-arms exactly once when a NEW result arrives", () => {
    const p = newProfile("limit-tap-rearm");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -30),
    });
    logServing(p, "fried_food", shiftDateStr(t, -20));
    // Spent against the old result.
    logServing(p, "fried_food", shiftDateStr(t, -2));
    expect(
      getFoodLimitTapNote(p, "fried_food", shiftDateStr(t, -2), 0)
    ).toBeNull();

    // A newer reading of the same family replaces it as the CURRENT one, and its own
    // collection date is a clean slate for the arming gate.
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -1),
      value: "190",
    });
    logServing(p, "fried_food", t);
    expect(getFoodLimitTapNote(p, "fried_food", t, 0)?.kind).toBe("dietary");
  });

  it("retires with the result — a newer NORMAL reading ends the limit", () => {
    const p = newProfile("limit-tap-resolved");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -10),
    });
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "normal",
      date: shiftDateStr(t, -1),
      value: "90",
    });
    logServing(p, "fried_food", t);
    expect(getFoodLimitTapNote(p, "fried_food", t, 0)).toBeNull();
  });

  it("honours a dismissal made on another surface — one bus, every surface (#39)", () => {
    const p = newProfile("limit-tap-dismissed");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -3),
    });
    logServing(p, "fried_food", t);
    expect(getFoodLimitTapNote(p, "fried_food", t, 0)).not.toBeNull();

    dismissFinding(p, "food-reduce:ldl-apob");
    expect(getFoodLimitTapNote(p, "fried_food", t, 0)).toBeNull();
  });

  it("defers to the cap vocabulary for a cap-governed group (#998)", () => {
    const p = newProfile("limit-tap-cap");
    const t = today(p);
    // A high urate makes alcohol a curated limit — and alcohol's food_log counter IS the
    // substance ledger, so getCapDirectionFoodGroups excludes it unconditionally.
    insertReading(p, {
      name: "Uric Acid",
      flag: "high",
      date: shiftDateStr(t, -3),
      value: "9",
    });
    logServing(p, "alcohol", t);
    expect(getFoodLimitTapNote(p, "alcohol", t, 0)).toBeNull();
    // The same profile's non-capped group from the SAME entry still speaks, so the
    // silence above is the exclusion and not an inert limit.
    logServing(p, "sugary_drinks", t);
    expect(getFoodLimitTapNote(p, "sugary_drinks", t, 0)?.kind).toBe("dietary");
  });
});

describe("getFoodLimitTapNote — the interaction half, and the ranking (#2377)", () => {
  it("answers with the ledger's own finding, and holds", () => {
    const p = newProfile("limit-tap-interaction");
    const t = today(p);
    addMedication(p, "Flagyl (metronidazole)", {
      start: shiftDateStr(t, -2),
      end: shiftDateStr(t, 4),
    });
    logServing(p, "alcohol", t);

    const note = getFoodLimitTapNote(p, "alcohol", t, 0);
    expect(note?.kind).toBe("interaction");
    expect(note?.title).toContain("Flagyl");
    expect(note?.body).toMatch(/alcohol/i);
    expect(note?.hold).toBe(true);
  });

  it("speaks for a cap-governed group where the dietary half would not", () => {
    // Alcohol is cap-governed, so the dietary claim is refused for it — and the
    // interaction is not, because that is the case the whole #2021 ledger exists for.
    const p = newProfile("limit-tap-interaction-cap");
    const t = today(p);
    insertReading(p, {
      name: "Uric Acid",
      flag: "high",
      date: shiftDateStr(t, -3),
      value: "9",
    });
    addMedication(p, "Flagyl (metronidazole)", {
      start: shiftDateStr(t, -2),
      end: shiftDateStr(t, 4),
    });
    logServing(p, "alcohol", t);
    expect(getFoodLimitTapNote(p, "alcohol", t, 0)?.kind).toBe("interaction");
  });

  it("outranks a dietary note that would otherwise have fired on the same tap", () => {
    const p = newProfile("limit-tap-ranking");
    const t = today(p);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -3),
    });
    // Alcohol is the group both halves genuinely reach on one profile: the metronidazole
    // EVENT rule names it, and a high urate makes it a curated limit. The dietary claim
    // would be refused here for the cap anyway; what this pins is that the interaction
    // is what arrives, and exactly one note does.
    insertReading(p, {
      name: "Uric Acid",
      flag: "high",
      date: shiftDateStr(t, -3),
      value: "9",
    });
    addMedication(p, "Flagyl (metronidazole)", {
      start: shiftDateStr(t, -2),
      end: shiftDateStr(t, 4),
    });
    logServing(p, "alcohol", t);
    const note = getFoodLimitTapNote(p, "alcohol", t, 0);
    expect(note?.kind).toBe("interaction");
  });
});

describe("getFoodLimitDayObservations — the digest half (#2377)", () => {
  it("names the day's logged groups a live limit covers", () => {
    const p = newProfile("limit-digest-basic");
    const t = today(p);
    const y = shiftDateStr(t, -1);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -5),
    });
    logServing(p, "fried_food", y, 2);
    logServing(p, "berries", y);

    const out = getFoodLimitDayObservations(p, y);
    expect(out.map((o) => o.groupKey)).toEqual(["fried_food"]);
    expect(foodLimitDigestHead(out)).toBe(
      "Foods to limit, logged yesterday: fried / fast food."
    );
  });

  it("is silent when the day logged nothing a limit names", () => {
    const p = newProfile("limit-digest-quiet");
    const t = today(p);
    const y = shiftDateStr(t, -1);
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -5),
    });
    logServing(p, "berries", y);
    expect(getFoodLimitDayObservations(p, y)).toEqual([]);
  });

  it("is silent for a profile with no live limit at all", () => {
    const p = newProfile("limit-digest-no-limit");
    const t = today(p);
    const y = shiftDateStr(t, -1);
    logServing(p, "fried_food", y, 3);
    expect(getFoodLimitDayObservations(p, y)).toEqual([]);
  });

  it("honours the shared bus and drops a cap-governed group", () => {
    const p = newProfile("limit-digest-bus-and-cap");
    const t = today(p);
    const y = shiftDateStr(t, -1);
    insertReading(p, {
      name: "Uric Acid",
      flag: "high",
      date: shiftDateStr(t, -5),
      value: "9",
    });
    logServing(p, "alcohol", y, 3);
    logServing(p, "sugary_drinks", y);
    // Alcohol never appears: #998's language owns it.
    expect(getFoodLimitDayObservations(p, y).map((o) => o.groupKey)).toEqual([
      "sugary_drinks",
    ]);

    dismissFinding(p, "food-reduce:urate");
    expect(getFoodLimitDayObservations(p, y)).toEqual([]);
  });

  // ── The case #2572's own fixture carries, one domain over ────────────────────
  it("joins a pattern to no result, on a profile that has both halves on file", () => {
    const p = newProfile("limit-digest-no-juxtaposition");
    const t = today(p);
    const y = shiftDateStr(t, -1);
    // Both halves of the sentence #2397 forbids: a real logged pattern over many days,
    // and a flagged result the curated map connects to that very food.
    insertReading(p, {
      name: "LDL Cholesterol",
      flag: "high",
      date: shiftDateStr(t, -20),
      value: "205",
    });
    for (let back = 1; back <= 14; back++)
      logServing(p, "fried_food", shiftDateStr(t, -back));

    const head = foodLimitDigestHead(getFoodLimitDayObservations(p, y))!;
    expect(head).toBe("Foods to limit, logged yesterday: fried / fast food.");
    // No marker, no reading, no count of days, no flag word — the line states a
    // membership in a curated list and stops.
    expect(head).not.toContain("LDL");
    expect(head).not.toMatch(/\d/);
    expect(head.toLowerCase()).not.toMatch(
      /high|flag|cholesterol|result|marker/
    );
  });
});
