// PURE TIER — the activity-type VOCABULARY and the per-type maps that must answer for
// every member of it (issue #2272).
//
// The failure this pins is not "a value is missing" but "nothing FAILS when a value is
// missing". Before #2272 there was no `Record<ActivityType, …>` anywhere in the repo:
// `TYPE_FALLBACK` was keyed on `string` with a `?? "activity"`, the journal filter list
// was hand-maintained with a `.find(…) ?? null`, and the age gate's SQL list was three
// literals. Each of those silently absorbed a new type — a generic glyph, an
// unfilterable row, a session that vanished from three surfaces. The maps are now
// exhaustive Records, so `tsc` is the real guard; these tests pin the DECLARED ANSWERS
// so a future author cannot quiet the compiler with a placeholder nobody meant.

import { describe, it, expect } from "vitest";
import { ACTIVITY_TYPES, type ActivityType } from "@/lib/types";
import { pickActivityIconKey } from "@/lib/activity-icon";
import {
  DURATION_ACTIVITY_TYPES,
  isDurationActivityType,
  restrictedActivityTypeClause,
} from "@/lib/age-gate";
import { normalizeJournalFilters } from "@/lib/journal-filters";
import { equipmentKindsForActivityType } from "@/lib/activity-equipment";
import { metsForActivity } from "@/lib/calorie-estimate";
import { effortClass } from "@/lib/effort-class";
import { TYPE_SCOPES } from "@/lib/lifts";

describe("the declared ActivityType tuple (#2272)", () => {
  it("carries `unclassified` and stays the source both the type and the lists read", () => {
    expect(ACTIVITY_TYPES).toEqual([
      "strength",
      "cardio",
      "sport",
      "recovery",
      "unclassified",
    ]);
  });
});

describe("every per-type map answers for every type", () => {
  it("the icon fallback gives each type its own declared glyph", () => {
    // No title/component names, so each answer comes from the per-type fallback.
    const byType = Object.fromEntries(
      ACTIVITY_TYPES.map((t) => [t, pickActivityIconKey(t)])
    );
    expect(byType).toEqual({
      strength: "barbell",
      cardio: "run",
      sport: "medal",
      recovery: "stretch",
      // The generic glyph is the HONEST picture for a stated absence — a barbell or a
      // medal would re-assert the claim the type exists to withhold.
      unclassified: "activity",
    });
  });

  it("an unclassified import still icons off its title when the title says something", () => {
    expect(pickActivityIconKey("unclassified", "Afternoon Ride")).toBe("bike");
  });

  it("the equipment-kind map offers gear for every type", () => {
    for (const t of ACTIVITY_TYPES)
      expect(equipmentKindsForActivityType(t).length).toBeGreaterThan(0);
    // Nothing can be narrowed away for a session nobody classified, so it offers all.
    expect(equipmentKindsForActivityType("unclassified")).toEqual([
      "strength",
      "cardio",
      "recovery",
      "other",
    ]);
  });

  it("the MET dataset has a fallback tier for every type", () => {
    for (const t of ACTIVITY_TYPES) {
      const mets = metsForActivity("Some Coined Name", t, "moderate");
      expect(mets, `no MET default for ${t}`).not.toBeNull();
      expect(mets!).toBeGreaterThan(0);
    }
    // Deliberately the conditioning-exercise tiers, NOT sport's: the else-branch that
    // invented `sport` also inflated this estimate.
    expect(metsForActivity("Some Coined Name", "unclassified", "moderate")).toBe(
      metsForActivity("Some Coined Name", "strength", "moderate")
    );
  });

  it("the effort-class map settles or defers for every type", () => {
    // Only `recovery` is incidental BY TYPE; everything else defers to the name.
    for (const t of ACTIVITY_TYPES)
      expect(effortClass(t, "Bench press")).toBe(
        t === "recovery" ? "incidental" : "training"
      );
    // "Unspecified" is not "light": a provider that declined to name a session still
    // recorded one, so it counts as training unless the NAME says otherwise.
    expect(effortClass("unclassified", "Workout")).toBe("training");
    expect(effortClass("unclassified", "Dog walk")).toBe("incidental");
  });
});

describe("the journal filter vocabulary is the declared tuple", () => {
  it("accepts every declared type, so no type is silently unfilterable", () => {
    for (const t of ACTIVITY_TYPES)
      expect(normalizeJournalFilters({ type: t }).type).toBe(t);
  });

  it("still refuses a type that is not in the vocabulary", () => {
    expect(normalizeJournalFilters({ type: "sleeping" }).type).toBeNull();
  });
});

describe("the age gate's SQL list includes the unspecified session (#489/#2272)", () => {
  it("keeps an unclassified import visible to a restricted profile", () => {
    // This list RENDERS SQL shared by Timeline, the sidebar calendar and Search, so
    // omitting a type removes a restricted profile's own workout from three surfaces
    // at once with no error anywhere.
    expect(isDurationActivityType("unclassified")).toBe(true);
    expect(DURATION_ACTIVITY_TYPES).toEqual([
      "cardio",
      "sport",
      "unclassified",
    ]);
    expect(restrictedActivityTypeClause(true)).toContain("'unclassified'");
    expect(restrictedActivityTypeClause(true)).not.toContain("'strength'");
  });
});

describe("the narrower unions stay narrower on purpose", () => {
  it("a weekly TYPE target cannot be scoped to the unspecified", () => {
    // A "Cardio 2×/week" target is rightly unaffected by a session nobody said was
    // cardio — the ask (#2272 §3) is how it gets counted, not a silent inclusion.
    const scopes: readonly string[] = TYPE_SCOPES;
    expect(scopes).not.toContain("unclassified");
    expect(scopes).not.toContain("recovery");
  });
});

// A structural backstop for the compiler-guided sweep: whatever else changes, the
// tuple and the type must stay the same set, so a hand-written union can never drift
// back in beside them (that is exactly how scripts/gen-mets.ts's copy went stale).
describe("the tuple and the type cannot drift apart", () => {
  it("every tuple member is assignable to ActivityType and back", () => {
    const roundTrip: ActivityType[] = [...ACTIVITY_TYPES];
    expect(new Set(roundTrip).size).toBe(ACTIVITY_TYPES.length);
  });
});
