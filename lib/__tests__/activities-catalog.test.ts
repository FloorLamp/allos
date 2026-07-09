import { describe, expect, it } from "vitest";
import { resolveActivityType } from "@/lib/activity-meta";
import { CARDIO_ACTIVITIES, SPORTS } from "@/lib/activities-catalog";
import type { ActivityType } from "@/lib/types";

// The curated suggestion catalog and the keyword classifier
// (resolveActivityType) are two hand-maintained sources for an activity's
// type. resolveActivityType consults the catalog first, so every catalog entry
// must classify as its catalog type — this guards against the two drifting
// apart (e.g. a curated sport the cardio keywords would otherwise claim, or a
// curated cardio name that collides with a lift).
describe("catalog ⇄ keyword classifier consistency", () => {
  const cases: [string, ActivityType][] = [
    ...CARDIO_ACTIVITIES.map((n) => [n, "cardio"] as [string, ActivityType]),
    ...SPORTS.map((n) => [n, "sport"] as [string, ActivityType]),
  ];

  it.each(cases)("classifies curated %s as its catalog type", (name, type) => {
    expect(resolveActivityType(name)).toBe(type);
  });
});
