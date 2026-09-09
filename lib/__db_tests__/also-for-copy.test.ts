// DB INTEGRATION TIER — the "Also for" copy (#5230). The write re-reads membership,
// the recipient's decline state, their own local day and their dose basis under the
// write lock, derives a per-subject amount from that person's own weight/age, and opens
// a medication course with an UNKNOWN start. None of that is visible to the pure tier,
// which only sees pre-gathered arrays.
//
// THE TWO GATES THAT RETIRED KEEP THEIR CASES, INVERTED (the 2026-09-09 rulings and the
// non-author review). They are the only coverage of what both falsifying passes
// measured, so the allergy and duplicate blocks below now assert that the chip IS
// offered, that the tap SUCCEEDS, and that the receipt names what the app knows.

import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import {
  alsoForCardModel,
  copyPoolMemberPlan,
  declineAlsoForOffer,
} from "@/lib/queries/intake/also-for";
import {
  alsoForRefusalRefreshes,
  decodeAlsoForBasis,
  encodeAlsoForBasis,
} from "@/lib/intake-also-for";
import { alsoForOfferKey } from "@/lib/dismissal-keys";
import {
  getFindingSuppressions,
  restoreFinding,
} from "@/lib/queries/upcoming/suppressions";
import {
  createSharedSupply,
  getIntakeDoses,
  getMedicationCourses,
  getSharedSupply,
  linkItemToPool,
  unlinkItemFromPool,
} from "@/lib/queries";
import { collectRecentChanges } from "@/lib/queries/recent-changes";
import { setProfileBirthdate, setProfileSetting } from "@/lib/settings";
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
      basis: model.offers[0].bySource[item].basis,
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
    // Offered: EVERY writable non-member. The allergic person and the person already
    // keeping their own ibuprofen are offered too — allergy warns through the receipt
    // and the duplicate question is not asked at all (the 2026-09-09 rulings). Only the
    // member is absent, which is the one fact this feature owns.
    expect(model.offers.map((o) => o.name)).toEqual(["Ada", "Bo", "Cy"]);
    // Each source gives that person its OWN basis, so a tap can only mean one plan.
    expect(model.offers[0].bySource[sourceItem].basis).not.toBe(
      model.offers[0].bySource[secondItem].basis
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
  return model.offers[0]?.bySource[sourceItem]?.basis ?? "";
}

// ── THE FALSIFYING PASS'S OWN CASES (#5230 repair round 1) ───────────────────
//
// Four findings, each reproduced here as the reviewer measured it, so a regression
// fails on the case that found it rather than on a paraphrase.

describe("allergy warns in the receipt, it never withholds the chip", () => {
  // Each of these was WITHHELD by round two's gate — silently, with the write refusing
  // as "stale" — and every one of them is a documented NOTE rather than a refusal. No
  // model in this app blocks a person's write on allergy grounds.
  it.each([
    ["a class match", "Penicillin", "Amoxicillin"],
    ["a documented cross-class match", "Aspirin", "Ibuprofen"],
    ["a brand-name bottle", "Ibuprofen", "Advil"],
  ])(
    "offers the bottle on %s, and the tap lands",
    (_label, allergen, bottleName) => {
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
      expect(model.offers.map((o) => o.name)).toEqual(["Ada"]);
      const res = copyPoolMemberPlan({
        supplyId: bottleId,
        sourceProfileId: owner,
        sourceItemId: item,
        targetProfileId: target,
        targetName: "Ada",
        basis: model.offers[0].bySource[item].basis,
      });
      expect(res.ok).toBe(true);
      expect(itemsOf(target)).toHaveLength(1);
    }
  );

  // THE CASE THAT MADE THE RULING NECESSARY. A supplement never reaches
  // getDrugAllergyWarnings (getIntakeSafetyContext filters to kind === "medication")
  // and crossCheckDrugAllergies carries no food cross-reactivity, so without this line
  // a shrimp-allergic person is offered krill oil and NOTHING anywhere says shrimp.
  it("names a shrimp allergy on a krill-oil bottle, in the receipt", () => {
    const owner = newProfile("AF Krill Src");
    const bottleId = createSharedSupply(
      {
        name: "Krill Oil",
        strength: null,
        form: "softgel",
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const item = seedMember(owner, bottleId, { name: "Krill Oil" });
    db.prepare("UPDATE intake_items SET kind = 'supplement' WHERE id = ?").run(
      item
    );
    const target = newProfile("AF Shrimp");
    recordAllergy(target, "Shrimp");

    const model = modelFor(
      bottleId,
      "Krill Oil",
      null,
      { itemId: item, profileId: owner },
      { id: target, name: "Ada" }
    );
    expect(model.offers).toHaveLength(1);
    const res = copyPoolMemberPlan({
      supplyId: bottleId,
      sourceProfileId: owner,
      sourceItemId: item,
      targetProfileId: target,
      targetName: "Ada",
      basis: model.offers[0].bySource[item].basis,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt).toContain("Shrimp allergy recorded");
    expect(res.receipt).toContain("krill");
  });

  it("says nothing about an allergy the bottle does not meet", () => {
    const target = newProfile("AF Unrelated Allergy");
    recordAllergy(target, "Penicillin");
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
    expect(res.receipt).not.toContain("allergy recorded");
  });

  // A STATED BEHAVIOUR, not an open decision: the receipt reads the non-resolved,
  // actionable set (getIntakeSafetyContext), so an allergy the person has had ruled out
  // is not read back to them.
  it("says nothing about a RESOLVED allergy", () => {
    const target = newProfile("AF Resolved Allergy");
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'Ibuprofen', 'resolved')`
    ).run(target);
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
    expect(res.receipt).not.toContain("allergy recorded");
  });
});

describe("the duplicate question is not asked, and the receipt says so", () => {
  // Round one withheld here by reading a "400 mg" dose row as a product strength, and
  // round two withheld here by folding Succinate into Tartrate. A bottle carries no
  // code, no code is derived from its members (#4717), so the question answers
  // "unknown" out loud instead of withholding on a guess.
  it.each([
    ["a person already taking 800 mg of their own", "Ibuprofen", "800 mg"],
    ["a different salt form", "Metoprolol Tartrate", "25 mg"],
    ["the very same product", "Ibuprofen", "200 mg"],
  ])("offers the bottle to %s", (_l, ownName, ownAmount) => {
    const target = newProfile(`AF Dup ${_l}`);
    seedMember(target, null, {
      name: ownName,
      amount: ownAmount,
      times: ["morning"],
    });
    const basis = basisFor(target);
    expect(basis).not.toBe("");
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Two ibuprofen items is the truth of that cabinet — and the receipt is honest
    // about not having been able to check.
    expect(itemsOf(target)).toHaveLength(2);
    expect(res.receipt).toContain(
      "we couldn’t check whether Ada already has this"
    );
  });
});

// ── THE PRODUCT'S LIFE STAGE: THE ONE GATE THAT STAYS, AND IT SPEAKS ──────────
describe("a curated adult-only product withholds with its reason on screen", () => {
  function aspirinBottle(): { bottleId: number; owner: number; item: number } {
    const owner = newProfile(`AF Aspirin Src ${Math.random()}`);
    const bottleId = createSharedSupply(
      {
        name: "Aspirin",
        strength: "325 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    return {
      bottleId,
      owner,
      item: seedMember(owner, bottleId, { name: "Aspirin" }),
    };
  }

  it("states the label's reason instead of removing the chip", () => {
    const { bottleId, owner, item } = aspirinBottle();
    const child = newProfile("AF Aspirin Child");
    setProfileBirthdate(child, shiftDateStr(today(child), -365 * 5));
    recordWeight(child, 18, today(child));

    const model = modelFor(
      bottleId,
      "Aspirin",
      "325 mg",
      { itemId: item, profileId: owner },
      { id: child, name: "Ada" }
    );
    // The person is STILL an offer — the card renders the sentence where the action
    // would be, rather than the offer vanishing without a word.
    expect(model.offers).toHaveLength(1);
    const withheld = model.offers[0].bySource[item].withheld;
    expect(withheld).toBeTruthy();
    expect(withheld).toMatch(/children/i);

    // …and the write refuses by NAME, carrying the label's own words.
    const res = copyPoolMemberPlan({
      supplyId: bottleId,
      sourceProfileId: owner,
      sourceItemId: item,
      targetProfileId: child,
      targetName: "Ada",
      basis: model.offers[0].bySource[item].basis,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("age-gated");
    expect(res.detail).toMatch(/children/i);
    expect(itemsOf(child)).toEqual([]);
  });

  // The asymmetry the ruling deliberately keeps: no curated entry means no life-stage
  // statement to make, so the copy lands dose-less rather than being withheld.
  it("still offers an UNCURATED adult-only product, dose-less", () => {
    const owner = newProfile("AF Uncurated Src");
    const bottleId = createSharedSupply(
      {
        name: "Household tonic (test)",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const item = seedMember(owner, bottleId, {
      name: "Household tonic (test)",
    });
    const child = newProfile("AF Uncurated Child");
    setProfileBirthdate(child, shiftDateStr(today(child), -365 * 5));
    recordWeight(child, 18, today(child));

    const model = modelFor(
      bottleId,
      "Household tonic (test)",
      null,
      { itemId: item, profileId: owner },
      { id: child, name: "Ada" }
    );
    expect(model.offers[0].bySource[item].withheld).toBeNull();
    const res = copyPoolMemberPlan({
      supplyId: bottleId,
      sourceProfileId: owner,
      sourceItemId: item,
      targetProfileId: child,
      targetName: "Ada",
      basis: model.offers[0].bySource[item].basis,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt).toContain("no dose yet");
    expect(
      getIntakeDoses(child).filter((d) => d.item_id === itemsOf(child)[0].id)
    ).toEqual([]);
  });
});

describe("a source with nothing still in force is still a source, and says so", () => {
  it("is offered, and the receipt refuses to claim a dose the copy never wrote", () => {
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

    // Dropping this member was a silent withhold answered in the SOURCE's day. It
    // stands as a source; the honesty moves to the receipt.
    const model = modelFor(
      bottleId,
      "Ibuprofen",
      "200 mg",
      { itemId: item, profileId: owner },
      { id: target, name: "Ada" }
    );
    expect(model.sources).toHaveLength(1);
    expect(model.offers).toHaveLength(1);
    const res = copyPoolMemberPlan({
      supplyId: bottleId,
      sourceProfileId: owner,
      sourceItemId: item,
      targetProfileId: target,
      targetName: "Ada",
      basis: model.offers[0].bySource[item].basis,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt).toContain("no dose yet");
    expect(res.receipt).not.toContain("200 mg from");
    expect(
      getIntakeDoses(target).filter((d) => d.item_id === res.itemId)
    ).toEqual([]);
  });

  // THE ATTACK: a source whose only dose row starts next month. The row TRAVELS — that
  // is the schedule saying what happens next — and the receipt must not claim a dose
  // the person has today. `doseOnDay` owns that second question.
  it("copies a step that starts next month without claiming a live dose", () => {
    const owner = newProfile("AF Future Src");
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
    const item = seedMember(owner, bottleId, { times: ["morning"] });
    const target = newProfile("AF Future Target");
    const starts = shiftDateStr(today(target), 30);
    db.prepare(
      "UPDATE intake_item_doses SET start_date = ? WHERE item_id = ?"
    ).run(starts, item);

    const model = modelFor(
      bottleId,
      "Ibuprofen",
      "200 mg",
      { itemId: item, profileId: owner },
      { id: target, name: "Ada" }
    );
    const res = copyPoolMemberPlan({
      supplyId: bottleId,
      sourceProfileId: owner,
      sourceItemId: item,
      targetProfileId: target,
      targetName: "Ada",
      basis: model.offers[0].bySource[item].basis,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The row travelled, with its future bound intact…
    expect(
      getIntakeDoses(target).filter((d) => d.item_id === res.itemId)[0]
    ).toMatchObject({
      start_date: starts,
    });
    // …and the receipt says nothing is due yet.
    expect(res.receipt).toContain("nothing due yet");
    expect(res.written.kind).toBe("pending");
  });

  it("refuses when a window closes between render and tap", () => {
    // Windows that close between render and tap: the card offered a schedule, the
    // write finds a different one. The refusal names the fact that moved.
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
    const basis = model.offers[0].bySource[item].basis;
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
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("source-changed");
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
  // NO BOTTLE CODE IS DERIVED FROM A MEMBER any more (#4717 owns bottle identity), so
  // the only RxNorm term in the basis is the CHOSEN SOURCE's own. A change to a
  // different member must therefore leave this offer alone — the answer must not depend
  // on which members the reader happens to see.
  it("ignores a DIFFERENT member's RxNorm identity entirely", () => {
    const second = newProfile("AF Other Member");
    const secondItem = seedMember(second, supplyId, {
      times: ["morning"],
      rxcui: "5640",
    });
    const target = newProfile("AF Other Cui Target");
    const basis = basisFor(target);
    db.prepare("UPDATE intake_items SET rxcui = '11289' WHERE id = ?").run(
      secondItem
    );
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(res.ok).toBe(true);
    expect(itemsOf(target)).toHaveLength(1);
  });
});

// ── WHOSE DAY THE OFFER LIVES IN, AND HOW A MIDNIGHT CROSSING RECOVERS ────────
//
// Round two called ONE function with TWO days — the card asked `today(sourceProfileId)`
// and the write asked `today(targetProfileId)` — so a household with a member abroad
// had a chip whose every tap answered "reload the cabinet and try again" over a state
// that was deterministic rather than stale. The day is now the RECIPIENT's, carried in
// the basis as data.
describe("the offer lives in the RECIPIENT's day", () => {
  it("carries each recipient's own day, not the reader's and not the source's", () => {
    const nz = newProfile("AF NZ");
    const la = newProfile("AF LA");
    setProfileSetting(nz, "timezone", "Pacific/Auckland");
    setProfileSetting(la, "timezone", "America/Los_Angeles");
    const model = alsoForCardModel({
      pool: { id: supplyId, name: "Ibuprofen", strength: "200 mg" },
      visibleMembers: [{ itemId: sourceItem, profileId: source, name: "Mira" }],
      candidates: [
        { id: nz, name: "Nia" },
        { id: la, name: "Lou" },
      ],
    });
    for (const offer of model.offers) {
      const basis = decodeAlsoForBasis(offer.bySource[sourceItem].basis);
      expect(basis?.day).toBe(today(offer.profileId));
    }
  });

  // A source on the far side of the date line does not move the recipient's day, so the
  // tap works — five consecutive re-renders, which is how round two's defect was
  // measured (every one of them refused).
  it("copies across the date line, re-render after re-render", () => {
    const abroad = newProfile("AF Abroad Src");
    setProfileSetting(abroad, "timezone", "Pacific/Auckland");
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
    const item = seedMember(abroad, bottleId, { times: ["morning"] });
    for (let i = 0; i < 5; i++) {
      const target = newProfile(`AF Home Target ${i}`);
      setProfileSetting(target, "timezone", "America/Los_Angeles");
      const model = modelFor(
        bottleId,
        "Ibuprofen",
        "200 mg",
        { itemId: item, profileId: abroad },
        { id: target, name: "Ada" }
      );
      expect(model.offers).toHaveLength(1);
      const res = copyPoolMemberPlan({
        supplyId: bottleId,
        sourceProfileId: abroad,
        sourceItemId: item,
        targetProfileId: target,
        targetName: "Ada",
        basis: model.offers[0].bySource[item].basis,
      });
      expect(res.ok).toBe(true);
    }
  });

  // Rendered at 23:59, tapped at 00:01. It must refuse — and it must NOT refuse
  // forever: the card re-reads and the very next tap lands.
  it("refuses a day-rolled offer by name, then refreshes into a working one", () => {
    const target = newProfile("AF Midnight");
    const shown = decodeAlsoForBasis(basisFor(target));
    expect(shown).not.toBeNull();
    if (!shown) return;
    const yesterday = encodeAlsoForBasis({
      ...shown,
      day: shiftDateStr(shown.day, -1),
    });
    const refused = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis: yesterday,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("day-rolled");
    expect(alsoForRefusalRefreshes(refused.reason)).toBe(true);
    expect(itemsOf(target)).toEqual([]);

    // THE RE-RENDER. The same card, read again, hands back an offer that works.
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis: basisFor(target),
    });
    expect(res.ok).toBe(true);
    expect(itemsOf(target)).toHaveLength(1);
  });
});

// ── THE DECLINE ──────────────────────────────────────────────────────────────
describe("a declined offer does not come back", () => {
  it("removes the chip, refuses a forged tap, and writes nothing but the suppression", () => {
    const target = newProfile("AF Declined");
    const basis = basisFor(target);
    expect(basis).not.toBe("");

    declineAlsoForOffer(supplyId, target);

    // Gone from the card…
    expect(basisFor(target)).toBe("");
    // …and the write refuses the basis the person was holding, by name.
    const res = copyPoolMemberPlan({
      supplyId,
      sourceProfileId: source,
      sourceItemId: sourceItem,
      targetProfileId: target,
      targetName: "Ada",
      basis,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("declined");
    // Nothing about the person's health or the bottle's membership moved.
    expect(itemsOf(target)).toEqual([]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM intake_items WHERE supply_id = ?")
        .get(supplyId)
    ).toMatchObject({ n: 1 });
    expect(getFindingSuppressions(target).has(alsoForOfferKey(supplyId))).toBe(
      true
    );
  });

  // "Dismissible WITHOUT RECURRENCE": the suppression is indefinite, and the only way
  // back is the person's own Restore in Snoozed & dismissed.
  it("comes back only when the person restores it", () => {
    const target = newProfile("AF Restored");
    declineAlsoForOffer(supplyId, target);
    expect(basisFor(target)).toBe("");
    restoreFinding(target, alsoForOfferKey(supplyId));
    expect(basisFor(target)).not.toBe("");
  });

  it("declines one person without touching another", () => {
    const declined = newProfile("AF Decl One");
    const other = newProfile("AF Decl Two");
    declineAlsoForOffer(supplyId, declined);
    const model = alsoForCardModel({
      pool: { id: supplyId, name: "Ibuprofen", strength: "200 mg" },
      visibleMembers: [{ itemId: sourceItem, profileId: source, name: "Mira" }],
      candidates: [
        { id: declined, name: "Ada" },
        { id: other, name: "Bo" },
      ],
    });
    expect(model.offers.map((o) => o.name)).toEqual(["Bo"]);
  });
});
