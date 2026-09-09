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
    amount?: string | null;
    times?: string[];
    cadenceKind?: string;
    intervalDays?: number | null;
    anchor?: string | null;
    rxcui?: string | null;
    endDate?: string | null;
  } = {}
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, supply_id,
            cadence_kind, cadence_interval_days, cadence_anchor_date, rxcui, source)
         VALUES (?, ?, 1, 'medication', 'daily', ?, ?, ?, ?, ?, ?, 'manual')`
      )
      .run(
        profileId,
        over.name ?? "Ibuprofen",
        over.obligation ?? "must",
        supplyId,
        over.cadenceKind ?? "daily",
        over.intervalDays ?? null,
        over.anchor ?? null,
        over.rxcui ?? null
      ).lastInsertRowid
  );
  (over.times ?? ["morning", "evening"]).forEach((time, i) => {
    db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, end_date)
       VALUES (?, ?, ?, 'with_food', ?, ?)`
    ).run(
      itemId,
      over.amount === undefined ? "400 mg" : over.amount,
      time,
      i,
      over.endDate ?? null
    );
  });
  return itemId;
}

// The card model for one bottle offered to one person — the same model the page
// renders, so a case asks the question the cabinet asks.
function modelFor(
  bottleId: number,
  bottleName: string,
  strength: string | null,
  member: { itemId: number; profileId: number },
  candidate: { id: number; name: string }
) {
  return alsoForCardModel({
    pool: { id: bottleId, name: bottleName, strength },
    visibleMembers: [
      { itemId: member.itemId, profileId: member.profileId, name: "Mira" },
    ],
    candidates: [candidate],
  });
}

function recordAllergy(
  profileId: number,
  substance: string,
  code: string | null = null
): void {
  db.prepare(
    `INSERT INTO allergies (profile_id, substance, status, substance_code, substance_code_system)
     VALUES (?, ?, 'active', ?, ?)`
  ).run(profileId, substance, code, code ? "RxNorm" : null);
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
    {
      name: "Ibuprofen",
      strength: "200 mg",
      form: "tablet",
      lowSupplyDays: null,
      notes: null,
    },
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
        .prepare(
          "SELECT COUNT(*) AS n FROM intake_item_doses WHERE item_id = ?"
        )
        .get(item.id)
    ).toEqual({ n: 0 });
    expect(getIntakeDoses(child).filter((d) => d.item_id === item.id)).toEqual(
      []
    );
  });

  it("copies the interval phase so the household keeps one rhythm", () => {
    const other = newProfile("AF Interval Source");
    const bottle = createSharedSupply(
      {
        name: "Ibuprofen",
        strength: "200 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
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
    candidates: [{ id: targetProfileId, name: "Ada" }],
  });
  return model.offers[0]?.basisBySource[sourceItem] ?? "";
}

// ── THE FALSIFYING PASS'S OWN CASES (#5230 repair round 1) ───────────────────
//
// Four findings, each reproduced here as the reviewer measured it, so a regression
// fails on the case that found it rather than on a paraphrase.

describe("allergy is a GATE, judged by the canonical drug-allergy model", () => {
  // Each of these was OFFERED and TAPPED successfully before the fix, after which the
  // app's own crossCheckDrugAllergies flagged the row the offer had just created.
  it.each([
    ["a class match", "Penicillin", "Amoxicillin"],
    ["a documented cross-class match", "Aspirin", "Ibuprofen"],
    ["a brand-name bottle", "Ibuprofen", "Advil"],
  ])("withholds the bottle on %s", (_label, allergen, bottleName) => {
    const owner = newProfile(`AF Src ${bottleName}`);
    const bottleId = createSharedSupply(
      {
        name: bottleName,
        strength: "200 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const item = seedMember(owner, bottleId, { name: bottleName });
    const target = newProfile(`AF Allergic ${bottleName}`);
    recordAllergy(target, allergen);

    const model = modelFor(
      bottleId,
      bottleName,
      "200 mg",
      { itemId: item, profileId: owner },
      { id: target, name: "Ada" }
    );
    expect(model.offers).toEqual([]);

    // …and the write refuses too, so a forged post cannot land what the card withheld.
    const res = copyPoolMemberPlan({
      supplyId: bottleId,
      sourceProfileId: owner,
      sourceItemId: item,
      targetProfileId: target,
      targetName: "Ada",
      basis: "anything",
    });
    expect(res.ok).toBe(false);
    expect(itemsOf(target)).toEqual([]);
  });

  it("still offers a bottle no recorded allergy touches", () => {
    const target = newProfile("AF Unrelated Allergy");
    recordAllergy(target, "Penicillin");
    expect(basisFor(target)).not.toBe("");
  });

  it("uses the recorded RxNorm code when the names do not meet", () => {
    const owner = newProfile("AF Coded Src");
    const bottleId = createSharedSupply(
      {
        name: "Household painkiller",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    // The bottle's name says nothing; its membership carries the code (#4717's
    // RxCUI-first leg, which the bottle side could not reach before the fix).
    const item = seedMember(owner, bottleId, {
      name: "Household painkiller",
      rxcui: "5640",
    });
    const target = newProfile("AF Coded Allergic");
    recordAllergy(target, "ibuprofen", "5640");

    expect(
      modelFor(
        bottleId,
        "Household painkiller",
        null,
        { itemId: item, profileId: owner },
        { id: target, name: "Ada" }
      ).offers
    ).toEqual([]);
  });
});

describe("the duplicate gate asks about the product, not a dose amount", () => {
  // A person taking two 200 mg tablets records a "400 mg" dose row. Reading that as a
  // product strength said they did not have the bottle, and handed them a SECOND
  // active ibuprofen — two reminder streams for one drug.
  it.each([
    ["a dose amount that is not the bottle's strength", "400 mg", "200 mg"],
    ["a row with no dose amount at all", null, "200 mg"],
    ["a bottle with no strength", "400 mg", null],
  ])(
    "withholds when the target already tracks it — %s",
    (_l, amount, strength) => {
      const owner = newProfile(`AF Dup Src ${_l}`);
      const bottleId = createSharedSupply(
        {
          name: "Ibuprofen",
          strength,
          form: "tablet",
          lowSupplyDays: null,
          notes: null,
        },
        30
      );
      const item = seedMember(owner, bottleId);
      const target = newProfile(`AF Dup Target ${_l}`);
      seedMember(target, null, { amount, times: ["morning"] });

      expect(
        modelFor(
          bottleId,
          "Ibuprofen",
          strength,
          { itemId: item, profileId: owner },
          { id: target, name: "Ada" }
        ).offers
      ).toEqual([]);
      expect(itemsOf(target)).toHaveLength(1);
    }
  );
});

describe("a source with nothing still in force is not a source", () => {
  it("is not offered, so no receipt can claim a dose the copy never wrote", () => {
    const owner = newProfile("AF Elapsed Src");
    const bottleId = createSharedSupply(
      {
        name: "Ibuprofen",
        strength: "200 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const td = today(owner);
    const item = seedMember(owner, bottleId, {
      times: ["morning"],
      endDate: shiftDateStr(td, -30),
    });
    const target = newProfile("AF Elapsed Target");

    const model = modelFor(
      bottleId,
      "Ibuprofen",
      "200 mg",
      { itemId: item, profileId: owner },
      { id: target, name: "Ada" }
    );
    expect(model.sources).toEqual([]);
    expect(model.offers).toEqual([]);
    expect(itemsOf(target)).toEqual([]);
  });

  it("tells the truth in the receipt if one is copied anyway", () => {
    // Windows that close between render and tap: the card offered a schedule, the
    // write finds nothing in force. The row is honest about having no dose.
    const owner = newProfile("AF Closing Src");
    const bottleId = createSharedSupply(
      {
        name: "Ibuprofen",
        strength: "200 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const td = today(owner);
    const item = seedMember(owner, bottleId, {
      times: ["morning"],
      endDate: shiftDateStr(td, 3),
    });
    const target = newProfile("AF Closing Target");
    const model = modelFor(
      bottleId,
      "Ibuprofen",
      "200 mg",
      { itemId: item, profileId: owner },
      { id: target, name: "Ada" }
    );
    const basis = model.offers[0].basisBySource[item];
    // The window closes before the tap.
    db.prepare(
      "UPDATE intake_item_doses SET end_date = ? WHERE item_id = ?"
    ).run(shiftDateStr(td, -1), item);
    const res = copyPoolMemberPlan({
      supplyId: bottleId,
      sourceProfileId: owner,
      sourceItemId: item,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    // The schedule changed under the offer, so the honest answer is a refusal.
    expect(res.ok).toBe(false);
    expect(itemsOf(target)).toEqual([]);
  });
});

describe("the basis binds every field the copy carries off the source", () => {
  it.each([
    ["kind", "UPDATE intake_items SET kind = 'supplement' WHERE id = ?"],
    ["RxNorm identity", "UPDATE intake_items SET rxcui = '11289' WHERE id = ?"],
    ["brand", "UPDATE intake_items SET brand = 'Motrin' WHERE id = ?"],
    [
      "product",
      "UPDATE intake_items SET product = 'warfarin 5 mg tablet' WHERE id = ?",
    ],
  ])(
    "refuses when the source's %s changed between render and tap",
    (_l, sql) => {
      const target = newProfile(`AF Swap ${_l}`);
      const basis = basisFor(target);
      db.prepare(sql).run(sourceItem);
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
    }
  );
  // The RxNorm leg needs its own case: the BOTTLE's identity is read off the lowest-id
  // coded member, so a change to a LATER member moves what the copy writes without
  // moving the product the card named. Only the source-identity term catches it.
  it("refuses when a later source member's RxNorm identity changed", () => {
    db.prepare("UPDATE intake_items SET rxcui = '5640' WHERE id = ?").run(
      sourceItem
    );
    const second = newProfile("AF Swap Second");
    const secondItem = seedMember(second, supplyId, {
      times: ["morning"],
      rxcui: "5640",
    });
    const target = newProfile("AF Swap Cui Target");
    const model = alsoForCardModel({
      pool: { id: supplyId, name: "Ibuprofen", strength: "200 mg" },
      visibleMembers: [{ itemId: secondItem, profileId: second, name: "Dune" }],
      candidates: [{ id: target, name: "Ada" }],
    });
    const basis = model.offers[0].basisBySource[secondItem];
    db.prepare("UPDATE intake_items SET rxcui = '11289' WHERE id = ?").run(
      secondItem
    );
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: second,
      sourceItemId: secondItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(res.ok).toBe(false);
    expect(itemsOf(target)).toEqual([]);
  });
});
