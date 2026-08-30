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

  // #3343 Q5, owner 2026-08-29: `trainingRelevant ? TRAINING : HISTORY`. The slot
  // was Timeline's until #3958 phase 2 retired that route; the record absorbed its
  // content, so it is the literal successor. Pinned as the whole slot LIST rather
  // than as one id, because the ruling's other half is that NO OTHER SLOT CHANGES
  // and the dock stays at four — an assertion about the second slot alone would
  // pass on a dock that had quietly gained or reordered the rest.
  it("uses History instead of Training through early childhood", () => {
    expect(dockSlots(false).map((s) => s.id)).toEqual([
      "home",
      "history",
      "trends",
      "more",
    ]);
    expect(dockSlots(false)).toHaveLength(DOCK_SLOT_COUNT);
  });

  // The successor is a DESTINATION, which is the half an id comparison cannot see:
  // a slot whose href had not moved with its id would light nothing and navigate to
  // a route that no longer exists.
  it("points the inherited slot at the record", () => {
    expect(dockSlots(false)[1]).toMatchObject({
      id: "history",
      label: "History",
      href: "/history",
    });
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
