// PURE TIER — the shared window derivation (issues #950, #2019). `foodEventWindow` is
// the ONE precedence deciding which food window a ledger event belongs to: an explicit
// meal_slot, then a captured eating instant (#2019), then the legacy tap instant.
//
// The count half this file used to pin (`slotServingCounts` / `foodEventsInWindow`, the
// #1016 slot-scoped nudge suffix) was retired by #2019 and deleted in #2227 — the
// Telegram buttons read the DAY total, and the ranking weights by proximity. The
// per-window TALLY properties (day scoping, multi-tap accumulation, correction moves)
// are pinned in the DB tier against the meal grouping the web surface actually renders
// (getFoodMealDays.slotCounts), which is the live consumer of this derivation.

import { describe, it, expect } from "vitest";
import { foodEventWindow } from "@/lib/food-slot-count";
import { foodSlotBoundaries } from "@/lib/food-slot";

const TZ = "UTC";
// Default 11:00 / 15:00 splits: <11:00 Morning, 11:00–15:00 Midday, ≥15:00 Evening.
const BOUNDS = foodSlotBoundaries({
  morning: null,
  midday: null,
  evening: null,
});
const DAY = "2026-07-13";

describe("foodEventWindow", () => {
  it("buckets a tap by its recorded_at instant in the profile's tz + boundaries", () => {
    expect(foodEventWindow(`${DAY}T08:00:00Z`, TZ, BOUNDS)).toBe("Morning");
    expect(foodEventWindow(`${DAY}T12:30:00Z`, TZ, BOUNDS)).toBe("Midday");
    expect(foodEventWindow(`${DAY}T19:00:00Z`, TZ, BOUNDS)).toBe("Evening");
  });

  it("puts a boundary-time (11:00) tap in Midday", () => {
    expect(foodEventWindow(`${DAY}T11:00:00Z`, TZ, BOUNDS)).toBe("Midday");
  });

  it("prefers a captured eating instant over the tap instant (#2019)", () => {
    // Tapped at 23:40, eaten at 19:00 — the dinner derives to the window it was EATEN
    // in, which is what makes an eating-time correction MOVE a legacy-slot row (#2227).
    expect(
      foodEventWindow(`${DAY}T23:40:00Z`, TZ, BOUNDS, null, `${DAY}T19:00:00Z`)
    ).toBe("Evening");
    // And absent a statement, the tap instant remains the honest last resort.
    expect(foodEventWindow(`${DAY}T12:30:00Z`, TZ, BOUNDS, null, null)).toBe(
      "Midday"
    );
    expect(foodEventWindow(`${DAY}T08:00:00Z`, TZ, BOUNDS, null, null)).toBe(
      "Morning"
    );
  });

  it("an explicit meal_slot wins over BOTH instants — a declaration, not a guess", () => {
    // The #1704 property, re-pointed from the retired count onto the derivation
    // itself: a backfill that asserted Morning stays Morning for every consumer,
    // however late the tap landed and whatever the eating instant says.
    expect(foodEventWindow(`${DAY}T12:30:00Z`, TZ, BOUNDS, "Morning")).toBe(
      "Morning"
    );
    expect(
      foodEventWindow(
        `${DAY}T12:30:00Z`,
        TZ,
        BOUNDS,
        "Morning",
        `${DAY}T19:00:00Z`
      )
    ).toBe("Morning");
    expect(foodEventWindow(`${DAY}T19:00:00Z`, TZ, BOUNDS, "Morning")).toBe(
      "Morning"
    );
  });
});
