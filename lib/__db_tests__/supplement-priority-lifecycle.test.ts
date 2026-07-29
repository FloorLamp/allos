// DB INTEGRATION TIER — the supplement priority lifecycle (#1505), all three parts
// where they can actually be SEEN:
//
//   Part 1  the ONE shared push predicate's REACH: a low-priority supplement is off
//           Upcoming (and so off the hero/aggregate/digest) and off the refill nudge,
//           while still tracked on the page and in the adherence fraction. A low
//           MEDICATION is exempt everywhere, and the safety tier (an interaction
//           warning with a low member) is untouched.
//   Part 2  the demotion-suggestion builder end-to-end from a realistic ledger,
//           including its REGISTERED dedupe-key prefix and reach tier, plus the
//           accept write's typed outcomes.
//   Part 3  the digest carrying missed/resumed lines from a ledger fixture — and
//           saying nothing on a quiet one.
//
// All fixture values synthetic — no real PHI. Dates are relative to each profile's
// own today so the specs never depend on a wall-clock date.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries/upcoming";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getActivitiesByDate,
  getInteractionWarnings,
} from "@/lib/queries";
import { getActiveSituations } from "@/lib/settings";
import { supplementAdherenceToday } from "@/lib/household";
import { isDueOn } from "@/lib/supplement-schedule";
import { buildDemotionSuggestionFindings } from "@/lib/rule-findings";
import { demoteIntakePriority } from "@/lib/intake-priority-write";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import {
  DEMOTION_PREFIX,
  demotionItemIdFromKey,
} from "@/lib/supplement-demotion";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

interface SeedOpts {
  kind?: "supplement" | "medication";
  priority?: "mandatory" | "high" | "low";
  // Days before today the item (and its dose) was created — the lifetime clamp the
  // adherence strip and the demotion cold-start guard both read.
  createdDaysAgo?: number;
  quantityOnHand?: number | null;
  active?: 0 | 1;
}

// One daily item with a single morning dose. `createdDaysAgo` is written as a UTC
// SQL timestamp so the #1442 lifetime clamp sees a genuinely old item.
function seedItem(
  profileId: number,
  name: string,
  opts: SeedOpts = {}
): { itemId: number; doseId: number } {
  const createdDaysAgo = opts.createdDaysAgo ?? 90;
  const createdAt = `${shiftDateStr(today(profileId), -createdDaysAgo)} 08:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed,
            quantity_on_hand, qty_per_dose, created_at)
         VALUES (?, ?, ?, ?, 'daily', ?, 0, ?, 1, ?)`
      )
      .run(
        profileId,
        name,
        opts.active ?? 1,
        opts.kind ?? "supplement",
        opts.priority ?? "high",
        opts.quantityOnHand ?? null,
        createdAt
      ).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 unit', 'morning', 'any', 0, ?)`
      )
      .run(itemId, createdAt).lastInsertRowid
  );
  return { itemId, doseId };
}

function logTaken(doseId: number, itemId: number, date: string): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
     VALUES (?, ?, ?, 'taken', '1 unit')`
  ).run(doseId, itemId, date);
}

// ---- Part 1: the predicate's reach ----------------------------------------

describe("#1505 part 1 — a low supplement is tracked, never pushed", () => {
  it("is absent from Upcoming but present on the page's due list and in the adherence fraction", () => {
    const p = createProfile("Lifecycle Reach (test)");
    const day = today(p);
    const low = seedItem(p, "Ashwagandha (test)", { priority: "low" });
    const high = seedItem(p, "Creatine (test)", { priority: "high" });

    // PUSH: the low supplement is gone; the high one is there.
    const keys = collectUpcoming(p, day).map((i) => i.key);
    expect(keys).not.toContain(`dose:${low.doseId}`);
    expect(keys).toContain(`dose:${high.doseId}`);

    // TRACKED: the item and its dose are untouched, and the dose is still DUE —
    // the predicate gates pushability, never dueness.
    const item = getSupplements(p).find((s) => s.id === low.itemId)!;
    expect(item.active).toBeTruthy();
    expect(
      isDueOn(item, { isWorkoutDay: false, activeSituations: new Set() })
    ).toBe(true);
    expect(getSupplementDoses(p).some((d) => d.id === low.doseId)).toBe(true);

    // TRACKED: the adherence x/y still counts it — adherence answers "what did I
    // do", attention answers "what needs me". Two questions, two counts (#221).
    const adherence = supplementAdherenceToday(
      getSupplementDoses(p),
      new Map(
        getSupplements(p)
          .filter((s) => s.active)
          .map((s) => [s.id, s])
      ),
      {
        isWorkoutDay: getActivitiesByDate(p, day).length > 0,
        activeSituations: new Set(getActiveSituations(p)),
      },
      getTakenDoseIds(p, day)
    );
    expect(adherence.due).toBe(2);
  });

  it("a low MEDICATION stays on every push surface (kind decides, not priority)", () => {
    const p = createProfile("Lifecycle LowMed (test)");
    const med = seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      priority: "low",
    });
    expect(collectUpcoming(p, today(p)).map((i) => i.key)).toContain(
      `dose:${med.doseId}`
    );
  });

  it("the refill nudge follows the same predicate: low supplement out, low med in", () => {
    const p = createProfile("Lifecycle Refill (test)");
    const day = today(p);
    // Both are down to a single unit on hand with a daily dose, so both would be
    // "low supply" if priority didn't gate the nudge.
    seedItem(p, "Ashwagandha (test)", {
      priority: "low",
      quantityOnHand: 1,
    });
    seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      priority: "low",
      quantityOnHand: 1,
    });
    seedItem(p, "Creatine (test)", { priority: "high", quantityOnHand: 1 });

    const refills = collectUpcoming(p, day)
      .filter((i) => i.domain === "refill")
      .map((i) => i.title);
    expect(refills).toContain("Testoprim (test med)");
    expect(refills).toContain("Creatine (test)");
    expect(refills).not.toContain("Ashwagandha (test)");
  });

  it("SAFETY is untouched: an interaction warning still names a low-priority member", () => {
    const p = createProfile("Lifecycle Safety (test)");
    // Ginkgo (a low-priority supplement, so never pushed) alongside warfarin: the
    // interaction fires on the PAIR regardless of either item's priority.
    seedItem(p, "Ginkgo biloba", { priority: "low" });
    seedItem(p, "Warfarin", { kind: "medication", priority: "high" });

    const hits = getInteractionWarnings(p);
    expect(hits.length).toBeGreaterThan(0);
    const names = hits.flatMap((h) => [h.aName, h.bName]);
    expect(names).toContain("Ginkgo biloba");
  });
});

// ---- Part 2: the demotion suggestion --------------------------------------

describe("#1505 part 2 — the demotion suggestion builder", () => {
  // A high supplement taken on only 2 of its last 30 scheduled days.
  function seedAbandoned(
    p: number,
    name: string,
    opts: SeedOpts = {}
  ): { itemId: number; doseId: number } {
    const seeded = seedItem(p, name, opts);
    const day = today(p);
    for (const back of [29, 22]) {
      logTaken(seeded.doseId, seeded.itemId, shiftDateStr(day, -back));
    }
    return seeded;
  }

  it("fires for an abandoned high supplement, under its REGISTERED coaching-tier prefix", () => {
    const p = createProfile("Demotion Fires (test)");
    const { itemId } = seedAbandoned(p, "Ashwagandha (test)");

    const findings = buildDemotionSuggestionFindings(p, today(p));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey.startsWith(DEMOTION_PREFIX)).toBe(true);
    expect(demotionItemIdFromKey(f.dedupeKey)).toBe(itemId);
    // The registry binds the prefix to a reach tier; the guard tests assert the
    // builder matches, this asserts the shipped key actually resolves.
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.title).toContain("Ashwagandha (test)");
    expect(f.detail).toContain("2 of");
  });

  it("never fires for a MEDICATION with the identical ledger", () => {
    const p = createProfile("Demotion Med (test)");
    seedAbandoned(p, "Testoprim (test med)", { kind: "medication" });
    expect(buildDemotionSuggestionFindings(p, today(p))).toEqual([]);
  });

  it("never fires for an item younger than the window (the cold-start guard)", () => {
    const p = createProfile("Demotion Young (test)");
    // Twenty days old with NO logs at all: enough scored occurrences to clear the
    // minimum and a follow-through rate of zero, so ONLY the "started inside the
    // window" guard can be what holds it back. (Deliberately log-free — a logged
    // dose legitimately widens the judgeable window back past `created_at`, since a
    // log is proof the dose existed on its date; see doseWindowSince.)
    seedItem(p, "Ashwagandha (test)", { createdDaysAgo: 20 });
    expect(buildDemotionSuggestionFindings(p, today(p))).toEqual([]);
    // The same ledger on an item that HAS been around the whole window does fire —
    // so the assertion above is the guard, not an accident of the fixture.
    const q = createProfile("Demotion Old Enough (test)");
    seedItem(q, "Ashwagandha (test)", { createdDaysAgo: 90 });
    expect(buildDemotionSuggestionFindings(q, today(q))).toHaveLength(1);
  });

  it("stops firing once adherence recovers", () => {
    const p = createProfile("Demotion Recovered (test)");
    const { itemId, doseId } = seedAbandoned(p, "Ashwagandha (test)");
    expect(buildDemotionSuggestionFindings(p, today(p))).toHaveLength(1);
    // Two weeks of taking it again lifts the rate over the threshold.
    const day = today(p);
    for (let back = 1; back <= 14; back++) {
      logTaken(doseId, itemId, shiftDateStr(day, -back));
    }
    expect(buildDemotionSuggestionFindings(p, today(p))).toEqual([]);
  });

  it("accepting is the only priority write, and it reports refusals honestly", () => {
    const p = createProfile("Demotion Accept (test)");
    const { itemId, doseId } = seedAbandoned(p, "Ashwagandha (test)");
    const day = today(p);
    // Before: pushed. The suggestion has NOT changed anything on its own.
    expect(getSupplements(p).find((s) => s.id === itemId)!.priority).toBe(
      "high"
    );
    expect(collectUpcoming(p, day).map((i) => i.key)).toContain(
      `dose:${doseId}`
    );

    expect(demoteIntakePriority(p, itemId)).toBe("demoted");
    expect(getSupplements(p).find((s) => s.id === itemId)!.priority).toBe(
      "low"
    );
    // After: it has left the push tier — the two parts joined up.
    expect(collectUpcoming(p, day).map((i) => i.key)).not.toContain(
      `dose:${doseId}`
    );
    // …and the suggestion is gone, because a low item is never a candidate.
    expect(buildDemotionSuggestionFindings(p, day)).toEqual([]);

    // A second tap (a stale card, a double submit) refuses rather than lying.
    expect(demoteIntakePriority(p, itemId)).toBe("already-low");
    expect(demoteIntakePriority(p, itemId + 99999)).toBe("not-found");
  });

  it("refuses a paused item, and never crosses profiles", () => {
    const p = createProfile("Demotion Paused (test)");
    const other = createProfile("Demotion Other (test)");
    const { itemId } = seedItem(p, "Ashwagandha (test)", { active: 0 });
    expect(demoteIntakePriority(p, itemId)).toBe("inactive");
    // Another profile can't reach it even with the right id.
    expect(demoteIntakePriority(other, itemId)).toBe("not-found");
  });
});

// ---- Part 3: the digest deltas --------------------------------------------

describe("#1505 part 3 — the digest reports state changes", () => {
  it("names a broken streak among the pushed tier, and stays silent about a low one", () => {
    const p = createProfile("Deltas Missed (test)");
    const day = today(p);
    const mag = seedItem(p, "Magnesium (test)", { priority: "high" });
    const ash = seedItem(p, "Ashwagandha (test)", { priority: "low" });
    // Both: taken on days -13..-4, missed -3..-1. Today is still pending and is
    // dropped, so each strip ends on a 3-occurrence miss run after a 10-day streak.
    for (let back = 13; back >= 4; back--) {
      const d = shiftDateStr(day, -back);
      logTaken(mag.doseId, mag.itemId, d);
      logTaken(ash.doseId, ash.itemId, d);
    }

    const input = gatherDigestInput(p, "Deltas Missed (test)");
    expect(input.intakeDeltaLine).toBe("Missed: Magnesium (test) (3 days)");
    // The low supplement's identical lapse is NOT news — it can't push, so it
    // can't be reported on. Its adherence history is untouched.
    expect(input.intakeDeltaLine).not.toContain("Ashwagandha");
  });

  it("names a resumption after a real lapse", () => {
    const p = createProfile("Deltas Resumed (test)");
    const day = today(p);
    const d3 = seedItem(p, "Vitamin D (test)", { priority: "high" });
    // Taken -13..-5, missed -4..-2, taken again yesterday.
    for (let back = 13; back >= 5; back--) {
      logTaken(d3.doseId, d3.itemId, shiftDateStr(day, -back));
    }
    logTaken(d3.doseId, d3.itemId, shiftDateStr(day, -1));

    const input = gatherDigestInput(p, "Deltas Resumed (test)");
    expect(input.intakeDeltaLine).toBe("Resumed: Vitamin D (test) (3 days)");
  });

  it("says nothing on a quiet window — no state change, no line", () => {
    const p = createProfile("Deltas Quiet (test)");
    const day = today(p);
    const item = seedItem(p, "Creatine (test)", { priority: "high" });
    for (let back = 13; back >= 1; back--) {
      logTaken(item.doseId, item.itemId, shiftDateStr(day, -back));
    }
    expect(
      gatherDigestInput(p, "Deltas Quiet (test)").intakeDeltaLine
    ).toBeNull();
  });
});
