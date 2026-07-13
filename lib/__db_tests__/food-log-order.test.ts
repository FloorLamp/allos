// DB INTEGRATION TIER (issue #591): the frequency/recency-ranked food-group log order.
// getFoodGroupLogOrder reuses the activity-picker machinery (#195) — a profile-scoped
// scan over the trailing food_log window, each row weighted by servings × decayedWeight
// (60-day half-life), ranked by rankByFrequency over the curated catalog. Proves a
// profile's staples lead WITHIN their tier while the tier sectioning (encourage →
// neutral → limit, applied by FoodLogBar) is preserved, and that a fresh profile keeps
// the curated catalog order.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getFoodGroupLogOrder } from "@/lib/queries";
import { FOOD_GROUPS, foodGroupSlugs } from "@/lib/food-groups";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
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

describe("getFoodGroupLogOrder (#591)", () => {
  it("returns the curated catalog order for a fresh profile", () => {
    const { profileId } = makeProfile("food-order-fresh");
    const order = getFoodGroupLogOrder(profileId).map((g) => g.slug);
    expect(order).toEqual(foodGroupSlugs());
    // Every catalog group appears exactly once.
    expect(order.length).toBe(FOOD_GROUPS.length);
    expect(new Set(order).size).toBe(order.length);
  });

  it("ranks a heavily-logged group first WITHIN its tier, preserving tier sections", () => {
    const { profileId, anchor } = makeProfile("food-order-heavy");

    // leafy_greens is NOT the first encourage group in the catalog (fatty_fish is),
    // so heavy recent logging must float it to the front of the encourage tier.
    for (let i = 0; i < 10; i++) {
      logServing(profileId, "leafy_greens", shiftDateStr(anchor, -i));
    }

    const order = getFoodGroupLogOrder(profileId);
    const encourage = order.filter((g) => g.tier === "encourage");
    expect(encourage[0].slug).toBe("leafy_greens");

    // Tier sectioning is preserved once FoodLogBar sections it: the flat order still
    // contains every group once, and each tier retains all its members.
    expect(new Set(order.map((g) => g.slug)).size).toBe(FOOD_GROUPS.length);
    const encourageCount = FOOD_GROUPS.filter(
      (g) => g.tier === "encourage"
    ).length;
    expect(encourage.length).toBe(encourageCount);
  });

  it("weights recent servings above stale ones (recency decay)", () => {
    const { profileId, anchor } = makeProfile("food-order-recency");

    // whole_grains: a single serving today. legumes: three servings ~120 days ago
    // (two half-lives → each ≈0.25, total ≈0.75 < 1.0). The recent single log should
    // outrank the larger-but-stale one within the encourage tier.
    logServing(profileId, "whole_grains", anchor);
    logServing(profileId, "legumes", shiftDateStr(anchor, -120), 3);

    const order = getFoodGroupLogOrder(profileId).map((g) => g.slug);
    expect(order.indexOf("whole_grains")).toBeLessThan(
      order.indexOf("legumes")
    );
  });

  it("is profile-scoped — one profile's logs don't reorder another's", () => {
    const a = makeProfile("food-order-scope-a");
    const b = makeProfile("food-order-scope-b");
    for (let i = 0; i < 8; i++) {
      logServing(a.profileId, "berries", shiftDateStr(a.anchor, -i));
    }
    // b logged nothing → still curated order (berries not first in its tier).
    const bOrder = getFoodGroupLogOrder(b.profileId).map((g) => g.slug);
    expect(bOrder).toEqual(foodGroupSlugs());
  });
});
