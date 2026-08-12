// DB INTEGRATION TIER (#2578 defect 2): what an unmet weekly FLOOR target IS on the
// Upcoming page.
//
// `frequency_targets` is scope-generic machinery, and the Upcoming builder used to
// read a row's presence in it as "a training target" — so the live page showed
// "Berries — Weekly training target" with a barbell glyph and a /training link. The
// SCOPE is what the row is about, so the scope decides the domain, the detail line and
// the destination. Exercised against the real schema because the identity is derived
// from a stored `scope_kind`, and the thing that went wrong was a fall-through over
// that column's values.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { trainingItems, trainingPaceLine } from "@/lib/queries/upcoming/plans";
import { practiceIdentity } from "@/lib/practice";
import { setWeekMode } from "@/lib/settings";
import { trainingSignalKey } from "@/lib/workout-nudge";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Rolling window, so the week the targets are measured over never depends on which
  // weekday the suite happens to run.
  setWeekMode(profileId, "rolling");
  return { profileId, anchor: today(profileId) };
}

function addTarget(
  profileId: number,
  scopeKind: string,
  scopeValue: string,
  perWeek: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, per_week, scope_identity)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        scopeKind,
        scopeValue,
        perWeek,
        // Only the practice scope requires one (#123's unique index); the others
        // store null, exactly as their own write paths do.
        scopeKind === "practice" ? practiceIdentity(scopeValue) : null
      ).lastInsertRowid
  );
}

describe("weekly floor targets carry their SCOPE's identity (#2578)", () => {
  it("a food_group target is a nutrition target, on the Nutrition food tab", () => {
    const { profileId } = makeProfile("wti-food");
    const id = addTarget(profileId, "food_group", "berries", 4);

    const item = trainingItems(profileId).find(
      (i) => i.key === trainingSignalKey(id)
    );
    expect(item).toBeDefined();
    expect(item!.title).toBe("Berries");
    expect(item!.detail).toBe("Weekly nutrition target");
    expect(item!.domain).toBe("nutrition-target");
    // Its home is the weekly-habits card on the Nutrition Food tab; /training holds
    // nothing about it.
    expect(item!.href).toBe("/nutrition");
    // Nothing logged this week, so the progress due-text is the honest 0/4.
    expect(item!.dueText).toBe("0/4 this week");
    expect(item!.band).toBe("week");
  });

  it("a mobility_region target is a mobility target, keeping the Training hub link", () => {
    const { profileId } = makeProfile("wti-mobility");
    const id = addTarget(profileId, "mobility_region", "Glutes", 3);

    const item = trainingItems(profileId).find(
      (i) => i.key === trainingSignalKey(id)
    );
    expect(item).toBeDefined();
    expect(item!.detail).toBe("Weekly mobility target");
    expect(item!.domain).toBe("mobility-target");
    // The mobility card genuinely lives on the Training hub, so only the identity was
    // wrong here — mobilizing a region is not training it (#482).
    expect(item!.href).toBe("/training");
  });

  it("a strength/cardio scope is unchanged — still the training identity", () => {
    const { profileId } = makeProfile("wti-training");
    const region = addTarget(profileId, "region", "Back", 2);
    const type = addTarget(profileId, "type", "cardio", 3);

    const items = trainingItems(profileId);
    for (const id of [region, type]) {
      const item = items.find((i) => i.key === trainingSignalKey(id));
      expect(item).toBeDefined();
      expect(item!.domain).toBe("training");
      expect(item!.detail).toBe("Weekly training target");
      expect(item!.href).toBe("/training");
    }
  });

  it("the key namespace is UNCHANGED for every scope, so stored dismissals still bind", () => {
    // Re-keying would orphan every row already in upcoming_dismissals, and the key is
    // also the workout nudge's suppression handle (#245). Identity was wrong; the key
    // never was.
    const { profileId } = makeProfile("wti-keys");
    const food = addTarget(profileId, "food_group", "leafy_greens", 5);
    const mobility = addTarget(profileId, "mobility_region", "Glutes", 3);

    const keys = new Set(trainingItems(profileId).map((i) => i.key));
    expect(keys.has(trainingSignalKey(food))).toBe(true);
    expect(keys.has(trainingSignalKey(mobility))).toBe(true);
  });

  it("the digest's pace line counts the TRAINING scopes only, matching the band it replaces", () => {
    // The digest swaps this phrase in for the `training` band's per-domain count, so
    // its denominator has to be the set that count covers. Before the identity split
    // the phrase said "3 training targets" over a set that included berries.
    const { profileId } = makeProfile("wti-pace");
    addTarget(profileId, "region", "Back", 2);
    addTarget(profileId, "region", "Chest", 2);
    addTarget(profileId, "food_group", "berries", 4);
    addTarget(profileId, "mobility_region", "Glutes", 3);

    const line = trainingPaceLine(profileId);
    expect(line).toContain("of 2 training targets");
    expect(line).not.toContain("Berries");
    // All four still reach the page — identity, not filtering.
    expect(trainingItems(profileId)).toHaveLength(4);
  });

  it("a wellness-practice target still gets no row here (practiceItems owns it)", () => {
    const { profileId } = makeProfile("wti-practice");
    const id = addTarget(profileId, "practice", "Sauna", 3);
    expect(
      trainingItems(profileId).some((i) => i.key === trainingSignalKey(id))
    ).toBe(false);
  });

  it("a substance cap never reaches this floor reader (#998 anti-nudge)", () => {
    // A cap target's per_week is a CEILING. A floor reader would render "0/3 this
    // week" and nudge toward more drinking, which is exactly what direction: "floor"
    // exists to prevent — proven here rather than assumed.
    const { profileId } = makeProfile("wti-substance");
    const id = addTarget(profileId, "substance", "alcohol", 3);
    expect(
      trainingItems(profileId).some((i) => i.key === trainingSignalKey(id))
    ).toBe(false);
  });
});
