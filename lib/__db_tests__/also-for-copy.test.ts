// DB INTEGRATION TIER — the "Also for" copy (#5230). The write re-reads membership,
// duplicate eligibility and the recipient's dose basis under the write lock, derives a
// per-subject amount from that person's own weight/age, and opens a medication course
// with an UNKNOWN start. None of that is visible to the pure tier, which only sees
// pre-gathered arrays.

import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import {
  alsoForCardModel,
  copyPoolMemberPlan,
} from "@/lib/queries/intake/also-for";
import {
  createSharedSupply,
  getIntakeDoses,
  getMedicationCourses,
  getSharedSupply,
  linkItemToPool,
  unlinkItemFromPool,
} from "@/lib/queries";
import { collectRecentChanges } from "@/lib/queries/recent-changes";
import { setProfileBirthdate } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";

// A bare profile: this feature is about people, bottles and schedules, and the shared
// seeded world would only add rows every case here has to look past.
function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function recordWeight(profileId: number, kg: number, date: string): void {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
  ).run(profileId, date, kg);
}

// The source member: a real product name so the curated label resolves, a schedule
// worth copying, and an amount that must NOT travel.
function seedMember(
  profileId: number,
  supplyId: number | null,
  over: {
    name?: string;
    obligation?: string;
    amount?: string;
    times?: string[];
    cadenceKind?: string;
    intervalDays?: number | null;
    anchor?: string | null;
  } = {}
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, supply_id,
            cadence_kind, cadence_interval_days, cadence_anchor_date, source)
         VALUES (?, ?, 1, 'medication', 'daily', ?, ?, ?, ?, ?, 'manual')`
      )
      .run(
        profileId,
        over.name ?? "Ibuprofen",
        over.obligation ?? "must",
        supplyId,
        over.cadenceKind ?? "daily",
        over.intervalDays ?? null,
        over.anchor ?? null
      ).lastInsertRowid
  );
  (over.times ?? ["morning", "evening"]).forEach((time, i) => {
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, ?, ?, 'with_food', ?)`
    ).run(itemId, over.amount ?? "400 mg", time, i);
  });
  return itemId;
}

function itemsOf(profileId: number): {
  id: number;
  name: string;
  supply_id: number | null;
  quantity_on_hand: number | null;
  obligation: string;
  cadence_kind: string | null;
  cadence_interval_days: number | null;
  cadence_anchor_date: string | null;
}[] {
  return db
    .prepare(
      `SELECT id, name, supply_id, quantity_on_hand, obligation, cadence_kind,
              cadence_interval_days, cadence_anchor_date
         FROM intake_items WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as ReturnType<typeof itemsOf>;
}

let source: number;
let sourceItem: number;
let supplyId: number;

function makeBottle(): void {
  source = newProfile("AF Source");
  supplyId = createSharedSupply(
    { name: "Ibuprofen", strength: "200 mg", form: "tablet", lowSupplyDays: null, notes: null },
    60
  );
  sourceItem = seedMember(source, supplyId);
}

beforeEach(() => {
  makeBottle();
});

describe("one tap copies the plan and derives the recipient's own dose", () => {
  it("gives an adult the label's adult dose, never the source's amount", () => {
    const target = newProfile("AF Adult");
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis: basisFor(target),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [item] = itemsOf(target);
    // Membership, not a second count.
    expect(item).toMatchObject({
      name: "Ibuprofen",
      supply_id: supplyId,
      quantity_on_hand: null,
      // The source's obligation travelled; the source's amount did not.
      obligation: "must",
    });
    const doses = getIntakeDoses(target).filter((d) => d.item_id === item.id);
    expect(doses.map((d) => d.time_of_day)).toEqual(["morning", "evening"]);
    expect(doses.map((d) => d.food_timing)).toEqual(["with_food", "with_food"]);
    expect(new Set(doses.map((d) => d.amount))).toEqual(new Set(["200 mg"]));
    expect(res.receipt).toContain("200 mg");

    // The bottle's stock is untouched: a copy moves no units.
    expect(getSharedSupply(supplyId)?.quantity_on_hand).toBe(60);
  });

  it("gives a child the band from THEIR weight, and no invented start", () => {
    const child = newProfile("AF Child");
    const td = today(child);
    setProfileBirthdate(child, shiftDateStr(td, -365 * 5));
    recordWeight(child, 18, shiftDateStr(td, -3));

    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: child,
      targetName: "Ada",
      basis: basisFor(child),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [item] = itemsOf(child);
    const doses = getIntakeDoses(child).filter((d) => d.item_id === item.id);
    expect(doses).toHaveLength(2);
    // A child's band, not the adult figure and not the source's 400 mg.
    expect(doses[0].amount).not.toBe("200 mg");
    expect(doses[0].amount).not.toBe("400 mg");
    expect(res.receipt).toContain("label band");

    // A copy states nothing about when this child started.
    const courses = getMedicationCourses(child);
    expect(courses).toHaveLength(1);
    expect(courses[0].started_on).toBeNull();
    const changes = collectRecentChanges(child, { sinceDays: 1, today: td });
    expect(changes.lines.join("\n")).not.toContain("Started Ibuprofen");
  });

  it("lands dose-less, with the band's reason, on a stale weight", () => {
    const child = newProfile("AF Stale");
    const td = today(child);
    setProfileBirthdate(child, shiftDateStr(td, -365 * 5));
    recordWeight(child, 18, shiftDateStr(td, -400));

    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: child,
      targetName: "Ada",
      basis: basisFor(child),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt).toContain("no dose yet");
    expect(res.receipt).toMatch(/weight/i);

    const [item] = itemsOf(child);
    expect(item.supply_id).toBe(supplyId);
    // ZERO dose rows — never a due-time placeholder with a blank amount, which is
    // what would put an unstated dose back on the due surfaces (#5285).
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM intake_item_doses WHERE item_id = ?")
        .get(item.id)
    ).toEqual({ n: 0 });
    expect(getIntakeDoses(child).filter((d) => d.item_id === item.id)).toEqual(
      []
    );
  });

  it("copies the interval phase so the household keeps one rhythm", () => {
    const other = newProfile("AF Interval Source");
    const bottle = createSharedSupply(
      { name: "Ibuprofen", strength: "200 mg", form: "tablet", lowSupplyDays: null, notes: null },
      30
    );
    const item = seedMember(other, bottle, {
      cadenceKind: "interval",
      intervalDays: 3,
      anchor: "2026-01-05",
      times: ["morning"],
    });
    const target = newProfile("AF Interval Target");
    const model = alsoForCardModel({
      pool: { id: bottle, name: "Ibuprofen", strength: "200 mg" },
      visibleMembers: [{ itemId: item, profileId: other, name: "Mira" }],
      memberProfileIds: [other],
      candidates: [{ id: target, name: "Ada" }],
    });
    const res = copyPoolMemberPlan({
      supplyId: bottle,
      sourceProfileId: other,
      sourceItemId: item,
      targetProfileId: target,
      targetName: "Ada",
      basis: model.offers[0].basisBySource[item],
    });
    expect(res.ok).toBe(true);
    expect(itemsOf(target)[0]).toMatchObject({
      cadence_kind: "interval",
      cadence_interval_days: 3,
      cadence_anchor_date: "2026-01-05",
    });
  });
});

describe("the offer is derived per person", () => {
  it("names every readable member as a source and offers only the eligible", () => {
    const second = newProfile("AF Second Member");
    const secondItem = seedMember(second, supplyId, { times: ["morning"] });
    const target = newProfile("AF Candidate");
    const allergic = newProfile("AF Allergic");
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'Ibuprofen', 'active')`
    ).run(allergic);
    const duplicate = newProfile("AF Duplicate");
    seedMember(duplicate, null, { amount: "200 mg", times: ["morning"] });

    const model = alsoForCardModel({
      pool: { id: supplyId, name: "Ibuprofen", strength: "200 mg" },
      visibleMembers: [
        { itemId: sourceItem, profileId: source, name: "Mira" },
        { itemId: secondItem, profileId: second, name: "Dune" },
      ],
      memberProfileIds: [source, second],
      candidates: [
        { id: target, name: "Ada" },
        { id: allergic, name: "Bo" },
        { id: duplicate, name: "Cy" },
        { id: source, name: "Mira" },
      ],
    });
    expect(model.sources.map((s) => s.personName)).toEqual(["Mira", "Dune"]);
    // Two members, two schedules, two distinct labels to choose between.
    expect(model.sources[0].scheduleLabel).not.toBe(
      model.sources[1].scheduleLabel
    );
    // Offered: the writable non-member with no conflict. Not offered: the allergic
    // person, the one already keeping the same product unpooled, and the member.
    expect(model.offers.map((o) => o.name)).toEqual(["Ada"]);
    // Each source gives that person its OWN basis, so a tap can only mean one plan.
    expect(model.offers[0].basisBySource[sourceItem]).not.toBe(
      model.offers[0].basisBySource[secondItem]
    );
  });

  it("offers nothing when no member is readable", () => {
    const target = newProfile("AF No Source");
    expect(
      alsoForCardModel({
        pool: { id: supplyId, name: "Ibuprofen", strength: "200 mg" },
        visibleMembers: [],
        memberProfileIds: [source],
        candidates: [{ id: target, name: "Ada" }],
      })
    ).toEqual({ sources: [], offers: [] });
  });
});

describe("a stale intent refuses instead of copying a different plan", () => {
  it("refuses the second of two taps, leaving exactly one item", () => {
    const target = newProfile("AF Double");
    const basis = basisFor(target);
    const first = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(first.ok).toBe(true);
    const second = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(second.ok).toBe(false);
    expect(itemsOf(target)).toHaveLength(1);
  });

  it("refuses when the source left the bottle before the tap", () => {
    const target = newProfile("AF Gone Source");
    const basis = basisFor(target);
    unlinkItemFromPool(source, sourceItem);
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(res.ok).toBe(false);
    expect(itemsOf(target)).toEqual([]);
    // …and re-linking makes the SAME offer good again, so the refusal is about the
    // stale intent rather than a one-way door.
    linkItemToPool(source, sourceItem, supplyId);
    expect(
      copyPoolMemberPlan({
        supplyId,
        sourceProfileId: source,
        sourceItemId: sourceItem,
        targetProfileId: target,
        targetName: "Ada",
        basis,
      }).ok
    ).toBe(true);
  });

  it("refuses when the source's schedule changed under the offer", () => {
    const target = newProfile("AF Changed");
    const basis = basisFor(target);
    db.prepare(
      "UPDATE intake_item_doses SET time_of_day = 'midday' WHERE item_id = ?"
    ).run(sourceItem);
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(res.ok).toBe(false);
    expect(itemsOf(target)).toEqual([]);
  });

  it("refuses an offer with no stated basis at all", () => {
    const target = newProfile("AF No Basis");
    expect(
      copyPoolMemberPlan({
        supplyId,
        sourceProfileId: source,
        sourceItemId: sourceItem,
        targetProfileId: target,
        targetName: "Ada",
        basis: "",
      }).ok
    ).toBe(false);
  });
});

// The basis the card would have shown for this person, from the same model the page
// renders — so a case posts what a real tap posts.
function basisFor(targetProfileId: number): string {
  const model = alsoForCardModel({
    pool: { id: supplyId, name: "Ibuprofen", strength: "200 mg" },
    visibleMembers: [{ itemId: sourceItem, profileId: source, name: "Mira" }],
    memberProfileIds: [source],
    candidates: [{ id: targetProfileId, name: "Ada" }],
  });
  return model.offers[0]?.basisBySource[sourceItem] ?? "";
}
