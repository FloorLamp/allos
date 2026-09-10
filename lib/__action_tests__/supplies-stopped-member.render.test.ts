// SERVER-COMPONENT RENDER TIER — the cabinet page's TWO uses of one member list
// (#5230 owner ruling 8).
//
// WHY THIS FILE EXISTS. `app/(app)/supplies/page.tsx` builds `stamped` once and feeds it
// to two places: the rendered member ROSTER, and the "Also for" SOURCE OPTIONS. Ruling 8
// says a stopped link is not membership, so the source options must drop a stopped
// member — and the roster must not, because a stopped member still draws their history
// from that bottle and the card has always listed them.
//
// FILTERING THE WRONG ONE IS INVISIBLE EVERYWHERE ELSE. `alsoForCardModel` receives
// whatever list the page hands it, so the pure and db tiers cannot tell a filter applied
// at the shared `stamped` from one applied at `visibleMembers` — both make the source
// options correct, and only one of them silently deletes a shipped display. This tier is
// the only one that sees both props of the same render.
//
// The page is an async server component, so it is awaited directly and the React tree it
// returns is walked. The client card is never invoked; it is a plain element carrying its
// props, which is exactly what "did the page hand it these members" asks.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { seedActor, createProfile } from "./harness";
import SuppliesPage from "@/app/(app)/supplies/page";
import { createSharedSupply } from "@/lib/queries";

interface Node {
  name: string;
  props: Record<string, unknown>;
}

function nameOf(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function")
    return (type as { name?: string }).name || "anonymous";
  return "";
}

function collect(node: unknown, into: Node[]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, into);
    return;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return;
  const name = nameOf(el.type);
  if (name) into.push({ name, props: el.props });
  collect(el.props.children, into);
}

interface CardPool {
  id: number;
  members: { itemId: number; label: string }[];
  alsoFor: {
    sources: { itemId: number; personName: string }[];
    offers: { profileId: number }[];
  };
}

let supplyId = 0;
let stoppedItem = 0;
let liveItem = 0;
let newcomer = 0;

function link(profileId: number, active: 0 | 1): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, supply_id, source)
         VALUES (?, 'Ibuprofen', ?, 'medication', 'daily', 'must', ?, 'manual')`
      )
      .run(profileId, active, supplyId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', 'morning', 'any', 0)`
  ).run(id);
  return id;
}

let pool: CardPool;

beforeAll(async () => {
  const { login, profile } = seedActor({ profileName: "Mira cabinet" });
  const stoppedPerson = createProfile("Dune cabinet", login.id);
  newcomer = createProfile("Ada cabinet", login.id).id;
  supplyId = createSharedSupply(
    {
      name: "Ibuprofen",
      strength: "200 mg",
      form: "tablet",
      lowSupplyDays: null,
      notes: null,
    },
    60
  );
  liveItem = link(profile.id, 1);
  stoppedItem = link(stoppedPerson.id, 0);

  const found: Node[] = [];
  collect(await SuppliesPage(), found);
  const card = found.find((n) => n.name === "SharedSupplyCard");
  expect(card).toBeTruthy();
  pool = (card?.props as { pool: CardPool }).pool;
});

describe("a stopped link leaves the roster alone and the source list without it", () => {
  // Rules out filtering `stamped` where it is built: that array feeds the roster, and a
  // stopped member would vanish from a display that has always shown them.
  it("still lists the stopped member on the card", () => {
    expect(pool.members.map((m) => m.itemId).sort()).toEqual(
      [liveItem, stoppedItem].sort()
    );
  });

  // Rules out leaving the source options unfiltered: a stopped link is not a plan
  // anybody is on, so it is not a plan to copy.
  it("does not offer the stopped member as a source", () => {
    expect(pool.alsoFor.sources.map((s) => s.itemId)).toEqual([liveItem]);
  });

  // …and the offer itself still stands, so the filter did not empty the feature out.
  it("still offers the bottle to a writable non-member", () => {
    expect(pool.alsoFor.offers.map((o) => o.profileId)).toContain(newcomer);
  });
});
