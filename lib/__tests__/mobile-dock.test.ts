import { describe, expect, it } from "vitest";
import {
  activeDockSlotId,
  dockSlots,
  DOCK_SLOT_COUNT,
  type DockSlot,
} from "@/lib/mobile-dock";

// The dock is fixed-position chrome that only renders below `md`, which is
// exactly the shape whose wrong branch nobody notices. Its two decisions are pure
// and tested here; the component only wires them to usePathname().

describe("dockSlots", () => {
  it("is Home · Training · Trends · More for an ordinary profile", () => {
    expect(dockSlots(false).map((s) => s.id)).toEqual([
      "home",
      "training",
      "trends",
      "more",
    ]);
  });

  it("substitutes Timeline for Training on an age-restricted profile", () => {
    const slots = dockSlots(true);
    expect(slots.map((s) => s.id)).toEqual([
      "home",
      "timeline",
      "trends",
      "more",
    ]);
    // The substitution replaces rather than removes: a restricted profile gets a
    // full row, not a gap where Training used to be.
    expect(slots).toHaveLength(DOCK_SLOT_COUNT);
  });

  it("is always exactly four slots — the puck's two-either-side layout", () => {
    for (const restricted of [false, true]) {
      expect(dockSlots(restricted)).toHaveLength(DOCK_SLOT_COUNT);
    }
  });

  it("gives every slot but More a destination, and More none", () => {
    for (const slot of dockSlots(false)) {
      if (slot.id === "more") expect(slot.href).toBeNull();
      else expect(slot.href).not.toBeNull();
    }
  });

  it("labels every slot (the caption IS the accessible name)", () => {
    for (const slot of [...dockSlots(false), ...dockSlots(true)]) {
      expect(slot.label.length).toBeGreaterThan(0);
    }
  });
});

describe("activeDockSlotId", () => {
  const slots: readonly DockSlot[] = dockSlots(false);

  it("lights Home only on the dashboard itself", () => {
    expect(activeDockSlotId(slots, "/")).toBe("home");
    expect(activeDockSlotId(slots, "/trends")).not.toBe("home");
  });

  it("lights a slot from a nested route under it", () => {
    expect(activeDockSlotId(slots, "/training/log/2026-08-13")).toBe(
      "training"
    );
    expect(activeDockSlotId(slots, "/trends")).toBe("trends");
  });

  it("follows the sidebar's registry-parent map", () => {
    // /equipment has no nav row of its own and declares Training as its parent
    // (lib/nav.ts). The dock inherits that for free because it asks the same
    // predicate — which is the entire reason it does not own a second one.
    expect(activeDockSlotId(slots, "/equipment")).toBe("training");
  });

  it("lights NOTHING for a route that lives behind More", () => {
    // Not "more": that button opens a drawer, and marking it aria-current would
    // claim the drawer is the page.
    expect(activeDockSlotId(slots, "/medications")).toBeNull();
    expect(activeDockSlotId(slots, "/settings/notifications")).toBeNull();
  });

  it("lights Timeline on a restricted profile's substituted slot", () => {
    expect(activeDockSlotId(dockSlots(true), "/timeline")).toBe("timeline");
    // …and Training is not even a slot there, so /training lights nothing.
    expect(activeDockSlotId(dockSlots(true), "/training")).toBeNull();
  });
});
