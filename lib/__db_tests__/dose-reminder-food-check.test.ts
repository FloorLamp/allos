// DB INTEGRATION TIER — the declared food timing reaches the REAL reminder as a live
// check (#2022), through the real gather and the real formatter rather than the pure
// predicate alone. The thread under test is:
//
//   buildSupplementReminder → gatherWindowDoses → getMinutesSinceLastFoodLog
//                           → foodTimingCheck → doseLine's tail
//
// and the properties that matter are the ones a pure test cannot see: that the ledger is
// actually consulted, that a serving written through the real write core silences the
// clause, that `eaten_at` beats `logged_at` end-to-end, and — the safety property — that
// none of it changes WHETHER the reminder fires.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { logFoodServingCore } from "@/lib/food-log-write";
import { buildSupplementReminder } from "@/lib/notifications/supplements";
import { WITH_FOOD_RECENT_MIN } from "@/lib/food-timing-check";
import type { FoodTiming } from "@/lib/types/intake";

// A scheduled daily medication with one pending Morning dose declaring `timing`. A
// medication rather than a supplement so the #1156 priority floor can never be what
// decides whether the line renders.
function seedDose(timing: FoodTiming): number {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES ('Food Check Fixture')")
      .run().lastInsertRowid
  );
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Levothyroxine', 1, 'medication', 'daily', 'must')`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '50 mcg', 'Morning', ?, 0)`
  ).run(itemId, timing);
  return profileId;
}

function reminderText(profileId: number): string {
  const msg = buildSupplementReminder(profileId, "Morning");
  expect(msg).not.toBeNull();
  return `${msg!.title}\n${msg!.body}`;
}

// A serving logged `minutesAgo` before now, through the real write core. `statedAgo`
// additionally attaches a STATED eating instant, which is the fact the check prefers.
function logServing(
  profileId: number,
  minutesAgo: number,
  statedAgo?: number
): void {
  const at = (mins: number) =>
    new Date(Date.now() - mins * 60_000).toISOString();
  logFoodServingCore(
    profileId,
    "nuts_seeds",
    today(profileId),
    at(minutesAgo),
    "Morning",
    statedAgo == null
      ? undefined
      : { eatenAt: at(statedAgo), source: "stated" as const }
  );
}

describe("the with_food ledger check on a real dose reminder (#2022)", () => {
  it("a morning with nothing logged carries the clause", () => {
    const profileId = seedDose("with_food");
    const text = reminderText(profileId);
    expect(text).toContain("with food");
    expect(text).toContain(
      `no food logged in the last ${WITH_FOOD_RECENT_MIN} min`
    );
  });

  it("the same reminder after a logged serving does NOT carry it", () => {
    const profileId = seedDose("with_food");
    logServing(profileId, 10);
    const text = reminderText(profileId);
    // The static declaration still renders — the check informs it, it does not replace it.
    expect(text).toContain("with food");
    expect(text).not.toContain("no food logged");
  });

  it("a serving older than the window is not recent enough to silence it", () => {
    const profileId = seedDose("with_fat");
    logServing(profileId, WITH_FOOD_RECENT_MIN + 30);
    expect(reminderText(profileId)).toContain("no food logged in the last");
  });
});

describe("the empty_stomach ledger check on a real dose reminder (#2022)", () => {
  it("names the recency when a serving landed inside the window", () => {
    const profileId = seedDose("empty_stomach");
    logServing(profileId, 20);
    const text = reminderText(profileId);
    expect(text).toContain("empty stomach");
    expect(text).toContain("food logged ~20 min ago");
  });

  it("says nothing when the ledger is empty", () => {
    const profileId = seedDose("empty_stomach");
    const text = reminderText(profileId);
    expect(text).toContain("empty stomach");
    expect(text).not.toContain("food logged");
    // And never the with_food clause — the two rows of the table are disjoint.
    expect(text).not.toContain("no food logged");
  });

  it("prefers a STATED eating instant over the tap stamp", () => {
    const profileId = seedDose("before_meal");
    // Tapped three hours late, stated as twenty minutes ago. The tap stamp alone would
    // put the serving outside every window and render nothing.
    logServing(profileId, 180, 20);
    expect(reminderText(profileId)).toContain("food logged ~20 min ago");
  });
});

describe("the check is informational, never a gate (#2022)", () => {
  it("an `any` dose's reminder carries no clause at all", () => {
    const profileId = seedDose("any");
    logServing(profileId, 15);
    const text = reminderText(profileId);
    expect(text).not.toContain("food logged");
    expect(text).not.toContain("no food logged");
  });

  it("the reminder still fires, with the same dose line, whatever the ledger says", () => {
    const hungry = seedDose("with_food");
    const fed = seedDose("with_food");
    logServing(fed, 5);
    for (const profileId of [hungry, fed]) {
      const msg = buildSupplementReminder(profileId, "Morning");
      expect(msg).not.toBeNull();
      expect(msg!.body).toContain("Levothyroxine");
      // Still a tappable dose send — the clause adds no button and removes none.
      expect(msg!.kind).toBe("dose");
      expect(msg!.actions?.some((a) => a.data?.startsWith("take:"))).toBe(true);
    }
  });
});
