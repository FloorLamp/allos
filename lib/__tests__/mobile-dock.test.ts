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
    expect(dockSlots().map((s) => s.id)).toEqual([
      "home",
      "training",
      "trends",
      "more",
    ]);
  });

  it("is always exactly four slots — the puck's two-either-side layout", () => {
    expect(dockSlots()).toHaveLength(DOCK_SLOT_COUNT);
  });

  it("uses Timeline instead of Training through early childhood", () => {
    expect(dockSlots(false).map((s) => s.id)).toEqual([
      "home",
      "timeline",
      "trends",
      "more",
    ]);
    expect(dockSlots(false)).toHaveLength(DOCK_SLOT_COUNT);
  });

  it("gives every slot but More a destination, and More none", () => {
    for (const slot of dockSlots()) {
      if (slot.id === "more") expect(slot.href).toBeNull();
      else expect(slot.href).not.toBeNull();
    }
  });

  it("labels every slot (the caption IS the accessible name)", () => {
    for (const slot of dockSlots()) {
      expect(slot.label.length).toBeGreaterThan(0);
    }
  });
});

describe("activeDockSlotId", () => {
  const slots: readonly DockSlot[] = dockSlots();

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
});
