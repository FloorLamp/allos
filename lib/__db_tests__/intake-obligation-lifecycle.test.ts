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
import { collectUpcoming, offeredItems } from "@/lib/queries/upcoming";
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
import {
  buildDemotionSuggestionFindings,
  demotionCandidateItemIds,
} from "@/lib/rule-findings";
import { buildSupplementReminder } from "@/lib/notifications/supplements";
import { activeFindings } from "@/lib/findings";
import { dismissFinding, getFindingSuppressions } from "@/lib/queries";
import { demoteIntakeObligation } from "@/lib/intake-obligation-write";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { getOfferedIntakeForSlot } from "@/lib/queries/intake";
import type { IntakeObligation } from "@/lib/types";
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
  obligation?: IntakeObligation;
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
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose, created_at)
         VALUES (?, ?, ?, ?, 'daily', ?, ?, 1, ?)`
      )
      .run(
        profileId,
        name,
        opts.active ?? 1,
        opts.kind ?? "supplement",
        opts.obligation ?? "should",
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

describe("#1505 part 1 — a `may` item is tracked, never pushed", () => {
  it("is absent from the DUE list and the adherence fraction, and present in the AVAILABLE disclosure", () => {
    const p = createProfile("Lifecycle Reach (test)");
    const day = today(p);
    const low = seedItem(p, "Ashwagandha (test)", { obligation: "may" });
    const high = seedItem(p, "Creatine (test)", { obligation: "should" });

    // DUE: the `may` item has no dueness at all, so no Upcoming row; the `should`
    // one is there as before.
    const keys = collectUpcoming(p, day).map((i) => i.key);
    expect(keys).not.toContain(`dose:${low.doseId}`);
    expect(keys).toContain(`dose:${high.doseId}`);

    // TRACKED: the item and its dose are untouched — nothing was deleted, and the
    // slot survives as an access hint.
    const item = getSupplements(p).find((s) => s.id === low.itemId)!;
    expect(item.active).toBeTruthy();
    expect(item.obligation).toBe("may");
    expect(getSupplementDoses(p).some((d) => d.id === low.doseId)).toBe(true);
    // …but it is NOT due: no dueness means no miss, which is the whole point.
    expect(
      isDueOn(item, { date: "2026-03-04", isWorkoutDay: false, activeSituations: new Set() })
    ).toBe(false);

    // COLLAPSED, NOT REMOVED: it is present in the availability disclosure, so an
    // accepted demotion reads as a move into a quieter section rather than a
    // deletion.
    expect(offeredItems(p, day).map((i) => i.title)).toContain(
      "Ashwagandha (test)"
    );
    expect(offeredItems(p, day).map((i) => i.title)).not.toContain(
      "Creatine (test)"
    );

    // The adherence x/y counts ONLY the pushed tier now (#1505): a `may` item has no
    // occurrences, so it cannot drag an honest fraction down.
    const adherence = supplementAdherenceToday(
      getSupplementDoses(p),
      new Map(
        getSupplements(p)
          .filter((s) => s.active)
          .map((s) => [s.id, s])
      ),
      { date: "2026-03-04",
        isWorkoutDay: getActivitiesByDate(p, day).length > 0,
        activeSituations: new Set(getActiveSituations(p)),
      },
      getTakenDoseIds(p, day)
    );
    expect(adherence.due).toBe(1);
  });

  it("a `must` MEDICATION stays on every push surface; a `may` one does not (obligation decides, not kind)", () => {
    const p = createProfile("Lifecycle Med (test)");
    const scheduled = seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      obligation: "must",
    });
    // A PRN med — `may` since the collapse — is NOT pushed, which is the behavior
    // change kind used to hide: before #1505 the medication carve-out pushed it.
    const prn = seedItem(p, "Testoprim PRN (test med)", {
      kind: "medication",
      obligation: "may",
    });
    const keys = collectUpcoming(p, today(p)).map((i) => i.key);
    expect(keys).toContain(`dose:${scheduled.doseId}`);
    expect(keys).not.toContain(`dose:${prn.doseId}`);
  });

  it("the refill nudge follows the same predicate: `may` out, must/should in — either kind", () => {
    const p = createProfile("Lifecycle Refill (test)");
    const day = today(p);
    // All three are down to a single unit on hand with a daily dose, so all three
    // would be "low supply" if obligation didn't gate the nudge.
    seedItem(p, "Ashwagandha (test)", {
      obligation: "may",
      quantityOnHand: 1,
    });
    seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      obligation: "must",
      quantityOnHand: 1,
    });
    seedItem(p, "Creatine (test)", { obligation: "should", quantityOnHand: 1 });

    const refills = collectUpcoming(p, day)
      .filter((i) => i.domain === "refill")
      .map((i) => i.title);
    expect(refills).toContain("Testoprim (test med)");
    expect(refills).toContain("Creatine (test)");
    expect(refills).not.toContain("Ashwagandha (test)");
  });

  it("SAFETY is obligation-BLIND: an interaction warning still names a `may` member", () => {
    const p = createProfile("Lifecycle Safety (test)");
    // Ginkgo (a `may` supplement, so never pushed) alongside warfarin: the
    // interaction fires on the PAIR regardless of either item's obligation. This is
    // the pinned boundary — the safety engines never consult the field.
    seedItem(p, "Ginkgo biloba", { obligation: "may" });
    seedItem(p, "Warfarin", { kind: "medication", obligation: "should" });

    const hits = getInteractionWarnings(p);
    expect(hits.length).toBeGreaterThan(0);
    const names = hits.flatMap((h) => [h.aName, h.bName]);
    expect(names).toContain("Ginkgo biloba");
  });
});

// ---- Part 2: the demotion suggestion --------------------------------------

describe("#1505 part 2 — the demotion suggestion builder", () => {
  // A `should` supplement taken on only 2 of its last 30 scheduled days.
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

  it("fires for an abandoned should-tier supplement, under its REGISTERED coaching-tier prefix", () => {
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

  it("accepting is the only obligation write, and it reports refusals honestly", () => {
    const p = createProfile("Demotion Accept (test)");
    const { itemId, doseId } = seedAbandoned(p, "Ashwagandha (test)");
    const day = today(p);
    // Before: pushed. The suggestion has NOT changed anything on its own.
    expect(getSupplements(p).find((s) => s.id === itemId)!.obligation).toBe(
      "should"
    );
    expect(collectUpcoming(p, day).map((i) => i.key)).toContain(
      `dose:${doseId}`
    );

    expect(demoteIntakeObligation(p, itemId)).toBe("demoted");
    expect(getSupplements(p).find((s) => s.id === itemId)!.obligation).toBe(
      "may"
    );
    // After: it has left the push tier and MOVED into the availability disclosure —
    // the two parts joined up, and the move is visible rather than a disappearance.
    expect(collectUpcoming(p, day).map((i) => i.key)).not.toContain(
      `dose:${doseId}`
    );
    expect(offeredItems(p, day).map((i) => i.title)).toContain(
      "Ashwagandha (test)"
    );
    // …and the suggestion is gone, because a low item is never a candidate.
    expect(buildDemotionSuggestionFindings(p, day)).toEqual([]);

    // A second tap (a stale card, a double submit) refuses rather than lying.
    expect(demoteIntakeObligation(p, itemId)).toBe("already-may");
    expect(demoteIntakeObligation(p, itemId + 99999)).toBe("not-found");
  });

  it("appears on the item's OWN reminder as a third button, only past the threshold", () => {
    const p = createProfile("Demotion Button (test)");
    const abandoned = seedAbandoned(p, "Ashwagandha (test)");
    const steady = seedItem(p, "Creatine (test)");
    // A steadily-taken item: no candidate, so no button.
    const day = today(p);
    for (let back = 1; back <= 20; back++) {
      logTaken(steady.doseId, steady.itemId, shiftDateStr(day, -back));
    }
    const ids = demotionCandidateItemIds(p, day);
    expect(ids.has(abandoned.itemId)).toBe(true);
    expect(ids.has(steady.itemId)).toBe(false);

    // The reminder carries ⤓ May for the candidate and NOT for the steady item —
    // ride-the-nag, zero extra sends.
    const msg = buildSupplementReminder(p, "Morning");
    expect(msg).not.toBeNull();
    const demoteButtons = (msg!.actions ?? []).filter((a) =>
      a.data?.startsWith("demote:")
    );
    expect(demoteButtons).toHaveLength(1);
    expect(demoteButtons[0].data).toContain(`:${abandoned.itemId}:`);
  });

  it("a page dismissal hides the CARD but never the reminder button", () => {
    const p = createProfile("Demotion Dismiss (test)");
    const { itemId } = seedAbandoned(p, "Ashwagandha (test)");
    const day = today(p);
    const key = buildDemotionSuggestionFindings(p, day)[0].dedupeKey;
    dismissFinding(p, key);

    // The card is gone from the bus-filtered set the page renders…
    const suppressions = getFindingSuppressions(p);
    expect(
      activeFindings(buildDemotionSuggestionFindings(p, day), suppressions, day)
    ).toEqual([]);
    // …while the reminder button, governed solely by detection state, survives.
    expect(demotionCandidateItemIds(p, day).has(itemId)).toBe(true);
  });

  it("refuses a paused item, and never crosses profiles", () => {
    const p = createProfile("Demotion Paused (test)");
    const other = createProfile("Demotion Other (test)");
    const { itemId } = seedItem(p, "Ashwagandha (test)", { active: 0 });
    expect(demoteIntakeObligation(p, itemId)).toBe("inactive");
    // Another profile can't reach it even with the right id.
    expect(demoteIntakeObligation(other, itemId)).toBe("not-found");
  });
});

// ---- Part 3: the digest deltas --------------------------------------------

describe("#1505 part 3 — the digest reports state changes", () => {
  it("names a broken streak among must+should, and stays silent about a `may` one", () => {
    const p = createProfile("Deltas Missed (test)");
    const day = today(p);
    const mag = seedItem(p, "Magnesium (test)", { obligation: "should" });
    const ash = seedItem(p, "Ashwagandha (test)", { obligation: "may" });
    // Both: taken on days -13..-4, missed -3..-1. Today is still pending and is
    // dropped, so each strip ends on a 3-occurrence miss run after a 10-day streak.
    for (let back = 13; back >= 4; back--) {
      const d = shiftDateStr(day, -back);
      logTaken(mag.doseId, mag.itemId, d);
      logTaken(ash.doseId, ash.itemId, d);
    }

    const input = gatherDigestInput(p, "Deltas Missed (test)");
    expect(input.intakeDeltaLine).toBe("Missed: Magnesium (test) (3 days)");
    // The `may` item's identical log history is NOT news: it has no dueness, so it
    // has no misses, so there is no state change to report. Its administrations are
    // still in the ledger — this is a reporting boundary, not a data one.
    expect(input.intakeDeltaLine).not.toContain("Ashwagandha");
  });

  it("names a resumption after a real lapse", () => {
    const p = createProfile("Deltas Resumed (test)");
    const day = today(p);
    const d3 = seedItem(p, "Vitamin D (test)", { obligation: "should" });
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
    const item = seedItem(p, "Creatine (test)", { obligation: "should" });
    for (let back = 13; back >= 1; back--) {
      logTaken(item.doseId, item.itemId, shiftDateStr(day, -back));
    }
    expect(
      gatherDigestInput(p, "Deltas Quiet (test)").intakeDeltaLine
    ).toBeNull();
  });
});

// ---- Part 1, class 3: the guaranteed access path ---------------------------

describe("#1505 — the digest's offer tail", () => {
  it("exposes a `may` item IN its hinted slot and not outside it", () => {
    const p = createProfile("Tail Slot (test)");
    const bedtime = seedItem(p, "Magnesium (test)", { obligation: "may" });
    db.prepare(
      "UPDATE intake_item_doses SET time_of_day = 'Before sleep' WHERE item_id = ?"
    ).run(bedtime.itemId);
    // A hint-less `may` item — the aspirin case — is offered in EVERY slot.
    const anytime = seedItem(p, "Aspirin (test)", {
      kind: "medication",
      obligation: "may",
    });
    db.prepare(
      "UPDATE intake_item_doses SET time_of_day = NULL WHERE item_id = ?"
    ).run(anytime.itemId);

    const atBreakfast = getOfferedIntakeForSlot(p, "08:00").map((i) => i.name);
    expect(atBreakfast).not.toContain("Magnesium (test)");
    expect(atBreakfast).toContain("Aspirin (test)");

    const atBedtime = getOfferedIntakeForSlot(p, "22:30").map((i) => i.name);
    expect(atBedtime).toContain("Magnesium (test)");
    expect(atBedtime).toContain("Aspirin (test)");
  });

  it("never offers a must/should item — the tail is the `may` path, not a second dose list", () => {
    const p = createProfile("Tail Scope (test)");
    seedItem(p, "Creatine (test)", { obligation: "should" });
    expect(getOfferedIntakeForSlot(p, "08:00")).toEqual([]);
  });

  it("gives an all-`may` regimen a tail-only digest rather than silence", () => {
    const p = createProfile("Tail Minimal (test)");
    const item = seedItem(p, "Magnesium (test)", { obligation: "may" });
    db.prepare(
      "UPDATE intake_item_doses SET time_of_day = NULL WHERE item_id = ?"
    ).run(item.itemId);

    const input = gatherDigestInput(p, "Tail Minimal (test)");
    expect(input.offerCount).toBe(1);
    expect(input.offerTail).not.toBeNull();
    // The digest is NOT suppressed: for a tap-only user this button is its job.
    const model = buildDigest(input);
    expect(model).not.toBeNull();
    const msg = renderDigestMessage(model!);
    expect(msg.actions?.[0]?.data).toContain("offer:");
    // Channels that cannot expand a keyboard still learn the count.
    expect(msg.body).toContain("1 available");
  });
});
