import { describe, it, expect } from "vitest";
import {
  isCarePlanItemOpen,
  carePlanItemToUpcomingItem,
  carePlanUpcomingItems,
  type CarePlanItemLike,
} from "../care-plan-upcoming";

function mk(over: Partial<CarePlanItemLike> = {}): CarePlanItemLike {
  return {
    id: 1,
    description: "Repeat screening colonoscopy",
    category: "procedure",
    planned_date: "2026-09-01",
    status: "planned",
    provider_name: "Dr Test",
    ...over,
  };
}

describe("isCarePlanItemOpen", () => {
  it("treats a null/blank/unknown status as open", () => {
    expect(isCarePlanItemOpen(null)).toBe(true);
    expect(isCarePlanItemOpen(undefined)).toBe(true);
    expect(isCarePlanItemOpen("")).toBe(true);
    expect(isCarePlanItemOpen("unknown")).toBe(true);
  });

  it("treats planned/active/scheduled/in-progress/on-hold as open", () => {
    for (const s of [
      "planned",
      "active",
      "scheduled",
      "in-progress",
      "not-started",
      "on-hold",
      "draft",
    ]) {
      expect(isCarePlanItemOpen(s)).toBe(true);
    }
  });

  it("treats completed/cancelled/stopped variants as closed (case-insensitive)", () => {
    for (const s of [
      "completed",
      "Completed",
      "COMPLETE",
      "done",
      "cancelled",
      "canceled",
      "stopped",
      "revoked",
      "entered-in-error",
      "not-done",
      "rejected",
      "  completed  ",
    ]) {
      expect(isCarePlanItemOpen(s)).toBe(false);
    }
  });
});

describe("carePlanItemToUpcomingItem", () => {
  it("maps to a date-banded careplan item carrying its id", () => {
    const item = carePlanItemToUpcomingItem(mk({ id: 42 }));
    expect(item.domain).toBe("careplan");
    expect(item.key).toBe("careplan:42");
    expect(item.carePlanItemId).toBe(42);
    expect(item.href).toBe("/records/care/overview");
    expect(item.title).toBe("Repeat screening colonoscopy");
    // Real planned_date rides the generic date-banding (no explicit band/dueText).
    expect(item.dueDate).toBe("2026-09-01");
    expect(item.band).toBeUndefined();
    expect(item.dueText).toBeUndefined();
    // Detail names category + ordering clinician.
    expect(item.detail).toBe("procedure · Dr Test");
  });

  it("falls back to a neutral detail when category/provider are absent", () => {
    const item = carePlanItemToUpcomingItem(
      mk({ category: null, provider_name: null })
    );
    expect(item.detail).toBe("Planned care");
  });
});

describe("carePlanUpcomingItems", () => {
  it("keeps only open, dated items", () => {
    const items = carePlanUpcomingItems([
      mk({ id: 1, status: "planned", planned_date: "2026-09-01" }),
      mk({ id: 2, status: "completed", planned_date: "2026-09-02" }), // closed
      mk({ id: 3, status: "active", planned_date: null }), // undated
      mk({ id: 4, status: "cancelled", planned_date: "2026-09-04" }), // closed
      mk({ id: 5, status: null, planned_date: "2026-09-05" }), // open, dated
    ]);
    expect(items.map((i) => i.key)).toEqual(["careplan:1", "careplan:5"]);
  });

  it("returns [] for an empty list", () => {
    expect(carePlanUpcomingItems([])).toEqual([]);
  });
});
