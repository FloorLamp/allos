// DB INTEGRATION TIER (issue #2021 — the #448 builder-fixture rule).
//
// The gap: the app printed "Avoid all alcohol during treatment and for 3 days after" on a
// metronidazole row and then watched the user log an alcohol serving in silence, because
// `matchFoodInteractions` takes an ITEM and never touches `food_log`. These builders are
// the join, so they carry a DB-tier fixture asserting the END-TO-END output the pure tier
// cannot see: the SQL gather (items + their dose windows + the food log), the finding, the
// Upcoming item it becomes, its registered tier, and the shared-bus dismissal.
//
// The acceptance cases are the issue's own: alcohol logged during a metronidazole course
// fires on the day AND through the tail but not after; the same serving with no
// alcohol-ruled item active fires nothing; a dairy rule (mapped to a real group, excluded
// because it is a separation window) never fires; the warfarin vitamin-K variance fires on
// a swing week and stays silent on a steady one.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileBirthdate } from "@/lib/settings";
import {
  buildFoodDrugEventFindings,
  buildFoodDrugVarianceFindings,
  foodDrugEventItems,
  foodDrugLedgerFor,
} from "@/lib/food-drug-ledger-findings";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import {
  FOOD_DRUG_EVENT_PREFIX,
  FOOD_DRUG_VARIANCE_PREFIX,
} from "@/lib/food-drug-ledger";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // The alcohol rules are adult-gated (#851 item 4); give the profile an adult age so
  // the matcher does not drop them.
  setProfileBirthdate(id, "1986-04-02");
  return id;
}

// A medication with one dose row carrying an inclusive course window (the #1602 columns a
// taper is expressed in). `end` null = an open-ended prescription.
function addMedication(
  profileId: number,
  name: string,
  window: { start?: string | null; end?: string | null } = {},
  active = 1
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
         VALUES (?, ?, 'medication', ?, 'must')`
      )
      .run(profileId, name, active).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, start_date, end_date)
     VALUES (?, '1 tab', 'morning', ?, ?)`
  ).run(itemId, window.start ?? null, window.end ?? null);
  return itemId;
}

function logServing(
  profileId: number,
  group: string,
  date: string,
  servings = 1
) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  ).run(profileId, date, group, servings);
}

describe("food–drug EVENT findings (#2021)", () => {
  it("alcohol logged during a metronidazole course fires end-to-end", () => {
    const p = newProfile("fd-event-course");
    const t = today(p);
    const itemId = addMedication(p, "Flagyl (metronidazole)", {
      start: shiftDateStr(t, -2),
      end: shiftDateStr(t, 4),
    });
    logServing(p, "alcohol", t, 2);

    const findings = buildFoodDrugEventFindings(p, t);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(
      `${FOOD_DRUG_EVENT_PREFIX}${itemId}:alcohol-metronidazole:${t}`
    );
    expect(f.title).toBe(
      "Alcohol logged today while taking Flagyl (metronidazole)"
    );
    expect(f.evidence).toBe("2 servings of alcohol in today's food log.");
    // The medication row's OWN sentence, its citation, and the informational tail.
    expect(f.detail).toContain(
      "Avoid all alcohol during treatment and for 3 days after"
    );
    expect(f.detail).toContain("Informational, not medical advice.");
    // Guardable + registered CARE tier (#448/#449).
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("care");

    // It reaches the care surfaces: an Upcoming item banded "today" (→ the hero), with
    // self-contained detail, under the SAME dedupeKey.
    const item = foodDrugEventItems(p, t).find((i) => i.key === f.dedupeKey);
    expect(item).toBeTruthy();
    expect(item!.domain).toBe("food-drug-event");
    expect(item!.band).toBe("today");
    expect(item!.detail).toContain("2 servings of alcohol");
    expect(collectUpcoming(p, t).some((i) => i.key === f.dedupeKey)).toBe(true);
  });

  it("fires through the label's stated 3-day tail, and stops after it", () => {
    const inTail = newProfile("fd-event-tail");
    const t = today(inTail);
    addMedication(inTail, "Metronidazole", {
      start: shiftDateStr(t, -9),
      end: shiftDateStr(t, -3),
    });
    logServing(inTail, "alcohol", t);
    const tailFindings = buildFoodDrugEventFindings(inTail, t);
    expect(tailFindings).toHaveLength(1);
    expect(tailFindings[0].title).toBe(
      "Alcohol logged today, 3 days after finishing Metronidazole"
    );

    const after = newProfile("fd-event-after-tail");
    const t2 = today(after);
    addMedication(after, "Metronidazole", {
      start: shiftDateStr(t2, -10),
      end: shiftDateStr(t2, -4), // tail ended yesterday
    });
    logServing(after, "alcohol", t2);
    expect(buildFoodDrugEventFindings(after, t2)).toEqual([]);
    expect(
      collectUpcoming(after, t2).some((i) =>
        i.key.startsWith(FOOD_DRUG_EVENT_PREFIX)
      )
    ).toBe(false);
  });

  it("the same serving with no alcohol-ruled item active fires nothing", () => {
    const p = newProfile("fd-event-no-rule");
    const t = today(p);
    // A statin: its only food rule is grapefruit, which is EXCLUDED from the ledger
    // because grapefruit collapses into the broad `fruit` group.
    addMedication(p, "Simvastatin", { start: shiftDateStr(t, -30) });
    logServing(p, "alcohol", t, 3);
    logServing(p, "fruit", t, 2);
    expect(buildFoodDrugEventFindings(p, t)).toEqual([]);
  });

  it("a mapped-but-excluded rule (dairy separation window) never fires", () => {
    const p = newProfile("fd-event-dairy");
    const t = today(p);
    addMedication(p, "Cipro", { start: shiftDateStr(t, -3) });
    logServing(p, "dairy", t, 2);
    // `dairy` IS a catalog group and IS mapped on the entry, but the rule is a
    // separation window — it needs an eating time the day log does not carry (#2019).
    expect(buildFoodDrugEventFindings(p, t)).toEqual([]);
  });

  it("logging nothing from the mapped group stays silent during the course", () => {
    const p = newProfile("fd-event-silent");
    const t = today(p);
    addMedication(p, "Flagyl", {
      start: shiftDateStr(t, -1),
      end: shiftDateStr(t, 3),
    });
    logServing(p, "leafy_greens", t, 2);
    expect(buildFoodDrugEventFindings(p, t)).toEqual([]);
  });

  it("a stopped item with no recorded course end cannot fire (silence over a guess)", () => {
    const p = newProfile("fd-event-unknown-end");
    const t = today(p);
    addMedication(p, "Metronidazole", { start: shiftDateStr(t, -20) }, 0);
    logServing(p, "alcohol", t);
    expect(buildFoodDrugEventFindings(p, t)).toEqual([]);
  });

  it("a dismissal silences it everywhere through the shared bus", () => {
    const p = newProfile("fd-event-dismiss");
    const t = today(p);
    addMedication(p, "Flagyl", {
      start: shiftDateStr(t, -1),
      end: shiftDateStr(t, 2),
    });
    logServing(p, "alcohol", t);
    const [f] = buildFoodDrugEventFindings(p, t);
    expect(collectUpcoming(p, t).some((i) => i.key === f.dedupeKey)).toBe(true);
    dismissFinding(p, f.dedupeKey);
    expect(collectUpcoming(p, t).some((i) => i.key === f.dedupeKey)).toBe(
      false
    );
  });
});

describe("food–drug VARIANCE findings (#2021)", () => {
  // Warfarin's advice is "keep vitamin K steady", so the signal is a SWING, not a serving.
  function seedWarfarin(name: string): { p: number; t: string } {
    const p = newProfile(name);
    const t = today(p);
    addMedication(p, "Coumadin (warfarin)", { start: shiftDateStr(t, -60) });
    return { p, t };
  }

  it("a swing week yields a calm coaching finding quoting the steadiness advice", () => {
    const { p, t } = seedWarfarin("fd-variance-swing");
    for (let i = 7; i < 14; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 0.5);
    for (let i = 0; i < 7; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 2);

    const findings = buildFoodDrugVarianceFindings(p, t);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey.startsWith(FOOD_DRUG_VARIANCE_PREFIX)).toBe(true);
    expect(f.title).toBe("Leafy greens up this week — Coumadin (warfarin)");
    expect(f.evidence).toBe(
      "14 servings in the last 7 days vs 3.5 servings in the 7 before."
    );
    expect(f.detail).toContain("Keep vitamin K intake steady");
    // States what it counted and what it did not (the coverage rule).
    expect(f.detail).toContain("cruciferous");
    expect(f.detail).toContain("Informational, not medical advice.");

    // COACHING tier: registered so, and it reaches no Upcoming/hero surface at all.
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(
      collectUpcoming(p, t).some((i) =>
        i.key.startsWith(FOOD_DRUG_VARIANCE_PREFIX)
      )
    ).toBe(false);
  });

  it("a steady week yields nothing", () => {
    const { p, t } = seedWarfarin("fd-variance-steady");
    for (let i = 0; i < 14; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 2);
    expect(buildFoodDrugVarianceFindings(p, t)).toEqual([]);
  });

  it("a brand-new logger is not a swing (the adoption guard)", () => {
    const { p, t } = seedWarfarin("fd-variance-new");
    // Nothing at all before this week, then a full week of greens: that is someone who
    // started logging, not someone who changed their diet.
    for (let i = 0; i < 7; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 2);
    expect(buildFoodDrugVarianceFindings(p, t)).toEqual([]);
  });

  it("the same swing without warfarin yields nothing", () => {
    const p = newProfile("fd-variance-no-med");
    const t = today(p);
    for (let i = 7; i < 14; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 0.5);
    for (let i = 0; i < 7; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 2);
    expect(buildFoodDrugVarianceFindings(p, t)).toEqual([]);
  });
});

// ---- ONE gather behind both shapes (#2060) ----
//
// The event finding (care tier, via rawUpcoming) and the variance finding (coaching
// tier) are read by different surfaces that one page renders together, and each used to
// re-run the whole gather: every intake item matched through `matchFoodInteractions`,
// plus the food-log range read. They now share `foodDrugLedgerFor`, wrapped in the
// request-scoped cache() shim.
//
// The DEDUPE itself is not observable here — outside a server request React's cache()
// has no dispatcher and calls straight through (lib/request-cache.ts says so), which is
// also why this tier can assert the gather's CONTRACT instead: one input, both shapes
// derived from it, and no food-log read at all when nothing matched.
describe("the shared ledger gather (#2060)", () => {
  it("is the single input both finding shapes are formatted from", () => {
    const p = newProfile("fd-gather-shared");
    const t = today(p);
    // One profile carrying BOTH signals at once: an open-ended warfarin course with a
    // greens swing (variance) and a metronidazole course with alcohol logged today
    // (event) — the co-render the issue is about.
    addMedication(p, "Coumadin (warfarin)", { start: shiftDateStr(t, -60) });
    addMedication(p, "Flagyl (metronidazole)", {
      start: shiftDateStr(t, -2),
      end: shiftDateStr(t, 4),
    });
    for (let i = 7; i < 14; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 0.5);
    for (let i = 0; i < 7; i++)
      logServing(p, "leafy_greens", shiftDateStr(t, -i), 2);
    logServing(p, "alcohol", t, 2);

    const ledger = foodDrugLedgerFor(p, t);
    expect(ledger.items.map((i) => i.name).sort()).toEqual([
      "Coumadin (warfarin)",
      "Flagyl (metronidazole)",
    ]);
    // Both courses' windows come from the dose rows, and the servings cover today back
    // through the two variance windows the detectors read.
    expect(
      ledger.servings.some((s) => s.group === "alcohol" && s.date === t)
    ).toBe(true);
    expect(
      ledger.servings.filter((s) => s.group === "leafy_greens")
    ).toHaveLength(14);

    // Both shapes still fire, unchanged, off that one gather.
    expect(buildFoodDrugEventFindings(p, t).map((f) => f.title)).toContain(
      "Alcohol logged today while taking Flagyl (metronidazole)"
    );
    expect(buildFoodDrugVarianceFindings(p, t).map((f) => f.title)).toEqual([
      "Leafy greens up this week — Coumadin (warfarin)",
    ]);
  });

  it("skips the food-log read entirely when no item matched a rule", () => {
    const p = newProfile("fd-gather-no-item");
    const t = today(p);
    addMedication(p, "Simvastatin", { start: shiftDateStr(t, -30) });
    logServing(p, "alcohol", t, 3);
    // Simvastatin's only rule (grapefruit) is excluded from the ledger, so nothing
    // matches — and with no item to detect against, the day's servings are never read.
    expect(foodDrugLedgerFor(p, t)).toEqual({ items: [], servings: [] });
  });
});
