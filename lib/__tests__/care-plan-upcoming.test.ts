import { describe, it, expect } from "vitest";
import {
  isCarePlanItemOpen,
  isRecognizedCarePlanStatus,
  carePlanItemToUpcomingItem,
  carePlanUpcomingItems,
  CARE_PLAN_CATEGORIES,
  CARE_PLAN_CATEGORY_LABELS,
  CARE_PLAN_CLOSED_STATUS_LIST,
  CARE_PLAN_OPEN_STATUSES,
  type CarePlanItemLike,
} from "../care-plan-upcoming";
import { CARE_PLAN_ELEMENTS } from "../cda/constants";

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

// The entry vocabularies the status/category pickers offer (#1676). The pickers exist
// because a hand-typed status the module doesn't recognize left the item nudging
// forever; these pin what the pickers may offer and what the unrecognized case does.
describe("the care-plan entry vocabularies (#1676)", () => {
  it("every offered status is one isCarePlanItemOpen actually decides by name", () => {
    for (const s of CARE_PLAN_OPEN_STATUSES) {
      expect(isRecognizedCarePlanStatus(s)).toBe(true);
      expect(isCarePlanItemOpen(s)).toBe(true);
    }
    for (const s of CARE_PLAN_CLOSED_STATUS_LIST) {
      expect(isRecognizedCarePlanStatus(s)).toBe(true);
      expect(isCarePlanItemOpen(s)).toBe(false);
    }
  });

  it("offers no status in both groups", () => {
    const open = new Set(CARE_PLAN_OPEN_STATUSES);
    for (const s of CARE_PLAN_CLOSED_STATUS_LIST)
      expect(open.has(s)).toBe(false);
  });

  // DECISION PINNED: an unrecognized status stays OPEN and keeps nudging. That is
  // unchanged by #1676 — importers depend on it — so the form says so out loud
  // instead of the user discovering it weeks later.
  it("an unrecognized status is unrecognized AND still open", () => {
    for (const s of ["finished", "wrapped up", "Done — 3 of 4"]) {
      expect(isRecognizedCarePlanStatus(s)).toBe(false);
      expect(isCarePlanItemOpen(s)).toBe(true);
    }
  });

  it("blank is neither recognized nor closed", () => {
    expect(isRecognizedCarePlanStatus("")).toBe(false);
    expect(isRecognizedCarePlanStatus(null)).toBe(false);
    expect(isCarePlanItemOpen("")).toBe(true);
  });

  it("the category vocabulary covers every bucket the CDA importer writes", () => {
    const offered = new Set<string>(CARE_PLAN_CATEGORIES);
    for (const element of CARE_PLAN_ELEMENTS)
      expect(offered.has(element.category)).toBe(true);
  });

  it("every category has a label that says what the bucket means", () => {
    for (const c of CARE_PLAN_CATEGORIES) {
      expect(CARE_PLAN_CATEGORY_LABELS[c]).toContain(" — ");
    }
  });
});
