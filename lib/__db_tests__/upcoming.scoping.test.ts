// DB INTEGRATION TIER — runtime profile-scoping check for the Upcoming
// aggregation. collectUpcoming() fans out across many existing
// reads; this seeds TWO profiles with distinct, tagged rows and proves that one
// profile's aggregated due-list never surfaces the other's data. The static
// source scan (lib/__tests__/profile-scoping.test.ts) can't see across the
// helper calls collectUpcoming makes, so this is the dynamic guard.

import { describe, it, expect, beforeAll } from "vitest";
import { collectUpcoming } from "@/lib/queries";
import { seedProfile, type SeededProfile } from "./fixtures";

let a: SeededProfile;
let b: SeededProfile;

beforeAll(() => {
  // The fixture seeds, per profile: an active med with a pending dose (→ a
  // dose-due item) and a tracked supplement at 8 units / 10-day threshold (→ a
  // low-refill item). Every title carries the tag, so a leak is unmistakable.
  a = seedProfile("AAA");
  b = seedProfile("BBB");
});

describe("collectUpcoming is scoped to the querying profile", () => {
  it("returns only the querying profile's items — no cross-profile bleed", () => {
    // Per-profile signals carry the tag (dose/refill); generic schedule signals
    // (e.g. an Influenza "due" from the age-agnostic immunization assessment) are
    // shared and untagged. The bleed check is directional: A's list must never
    // contain B's tagged data, and vice-versa.
    const itemsA = collectUpcoming(a.profileId, a.todayStr);
    expect(itemsA.length).toBeGreaterThanOrEqual(2);
    expect(itemsA.some((i) => i.title.startsWith("AAA"))).toBe(true);
    expect(itemsA.some((i) => i.title.includes("BBB"))).toBe(false);

    const itemsB = collectUpcoming(b.profileId, b.todayStr);
    expect(itemsB.some((i) => i.title.startsWith("BBB"))).toBe(true);
    expect(itemsB.some((i) => i.title.includes("AAA"))).toBe(false);
  });

  it("surfaces the pending med dose (with a mark-taken action) and the low refill", () => {
    const itemsA = collectUpcoming(a.profileId, a.todayStr);
    const dose = itemsA.find((i) => i.domain === "dose");
    expect(dose?.title).toBe("AAA Lisinopril");
    expect(dose?.doseId).toBeGreaterThan(0); // drives the inline mark-taken form

    const refill = itemsA.find((i) => i.domain === "refill");
    expect(refill?.title).toBe("AAA Vitamin D");
    // 8 units, 1/day → ≈8 days of supply left.
    expect(refill?.detail).toContain("8 days");
  });

  it("surfaces the open, dated care-plan item (with a mark-done action) (issue #84)", () => {
    const itemsA = collectUpcoming(a.profileId, a.todayStr);
    const careplan = itemsA.find((i) => i.domain === "careplan");
    expect(careplan?.title).toBe("AAA Colonoscopy");
    expect(careplan?.key).toBe(`careplan:${a.carePlanItemId}`);
    expect(careplan?.carePlanItemId).toBe(a.carePlanItemId); // inline mark-done form
    expect(careplan?.dueDate).toBe(a.todayStr); // real planned date → date-banded
  });
});
