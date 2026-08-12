// DB INTEGRATION TIER (issue #635). getDietaryLimitWarnings is the DB half over the
// pure stackUlWarnings — a CARE-TIER findings gather (it reaches Upcoming, the
// non-hideable "Needs attention" hero, and the digest push), so it earns a #448
// fixture. The original bug: the gather summed EVERY active item's dose as a DAILY UL
// total, ignoring workout/rest/situational items that aren't taken every day — a
// standing false "above the upper limit" alarm. This seeds those non-daily items above
// the UL and asserts they don't contribute, while a plain daily item above the UL
// still flags.
//
// #1505 narrowed that exclusion to the SCHEDULE. The #635 gate also used to drop
// `as_needed` items, which was sound while `as_needed` asserted "no standing daily
// intake". Obligation's `may` asserts only "don't push me about this", so a daily-
// scheduled item the user demoted still contributes its full amount here (the UL is a
// risk number, and an obligation may never shrink one) and the warning LABELS that it
// did. This file pins both halves of that boundary: schedule still excludes, obligation
// no longer does. See findings.md §5a. Runs via `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getDietaryLimitWarnings, getDietaryAdequacy } from "@/lib/queries";
import { ulWarningDetail } from "@/lib/dri";
import type { IntakeCondition } from "@/lib/types";

function makeAdultProfile(name: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
  ).run(profileId);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1985-01-01')`
  ).run(profileId);
  return profileId;
}

// Iron adult UL is 45 mg, so 65 mg is over it.
function addSupp(
  profileId: number,
  name: string,
  amount: string,
  opts: {
    condition?: IntakeCondition;
    obligation?: "must" | "should" | "may";
  } = {}
): void {
  const item = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'medication', ?, ?)`
      )
      .run(
        profileId,
        name,
        opts.condition ?? "daily",
        opts.obligation ?? "should"
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, ?, 'morning', 'any', 0)`
  ).run(item, amount);
}

describe("getDietaryLimitWarnings — schedule-aware UL sum (#635)", () => {
  it("does NOT flag a situational (non-daily) iron over the UL", () => {
    const profileId = makeAdultProfile("ul-situational");
    addSupp(profileId, "Iron", "65 mg", { condition: "situational" });

    expect(
      getDietaryLimitWarnings(profileId).some((w) => w.key === "iron")
    ).toBe(false);
  });

  it("still flags a plain DAILY iron over the UL", () => {
    const profileId = makeAdultProfile("ul-daily");
    addSupp(profileId, "Iron", "65 mg", { condition: "daily" });

    const iron = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "iron"
    );
    expect(iron).toBeTruthy();
    expect(iron!.total).toBe(65);
    expect(iron!.ul).toBe(45);
  });

  it("excludes a non-daily item even from a stack that also has a daily one", () => {
    const profileId = makeAdultProfile("ul-mixed-schedule");
    addSupp(profileId, "Iron", "50 mg", { condition: "daily" }); // over UL 45 alone
    addSupp(profileId, "Iron", "65 mg", { condition: "situational" });

    const iron = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "iron"
    );
    expect(iron).toBeTruthy();
    // The situational 65 mg is NOT added (else it would read 115): the item simply
    // isn't taken every day, which is a fact about the schedule.
    expect(iron!.total).toBe(50);
  });
});

describe("getDietaryLimitWarnings — obligation-blind at full weight (#1505)", () => {
  it("flags a daily `may` iron over the UL, and says the total counts it", () => {
    // The regression this pins. Before #1505 this row was excluded, because
    // `as_needed` claimed the item had no standing daily intake. `may` claims only
    // that the user wants no reminders — the iron is still on a daily schedule, so
    // its exposure is real and the warning must fire. A user who demoted an item is
    // the LEAST likely to notice a silent exceedance, so this is where the number
    // matters most.
    const profileId = makeAdultProfile("ul-may");
    addSupp(profileId, "Iron", "65 mg", { obligation: "may" });

    const iron = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "iron"
    );
    expect(iron).toBeTruthy();
    expect(iron!.total).toBe(65);
    expect(iron!.includesOptional).toBe(true);
    // Label, don't drop: the line tells the user what it counted.
    expect(ulWarningDetail(iron!)).toContain("including as-needed items");
  });

  it("sums a daily `may` item together with a committed one at full weight", () => {
    const profileId = makeAdultProfile("ul-mixed-obligation");
    addSupp(profileId, "Iron", "50 mg", { obligation: "should" });
    addSupp(profileId, "Iron", "65 mg", { obligation: "may" });

    const iron = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "iron"
    );
    expect(iron!.total).toBe(115);
  });

  it("obligation alone can carry a stack OVER the UL", () => {
    // 40 mg committed is under the 45 mg UL; the on-demand 20 mg crosses it. Under the
    // old exclusion there was no warning here at all.
    const profileId = makeAdultProfile("ul-crossed-by-may");
    addSupp(profileId, "Iron", "40 mg", { obligation: "must" });
    addSupp(profileId, "Iron", "20 mg", { obligation: "may" });

    const iron = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "iron"
    );
    expect(iron).toBeTruthy();
    expect(iron!.total).toBe(60);
  });

  it("no as-needed disclosure when every contributor is committed", () => {
    const profileId = makeAdultProfile("ul-all-committed");
    addSupp(profileId, "Iron", "65 mg", { obligation: "must" });

    const iron = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "iron"
    );
    expect(iron!.includesOptional).toBe(false);
    expect(ulWarningDetail(iron!)).not.toContain("as-needed");
  });

  it("the adequacy share moves the OTHER way for the same item", () => {
    // Same profile, same rows, opposite direction (findings.md §5a): adequacy is a
    // reassurance figure, so the `may` amount is excluded from the share and named
    // beside it. Asserting both reads off ONE fixture is the point — a future change
    // that "unifies" the two directions has to break this test to do it.
    const profileId = makeAdultProfile("adequacy-vs-ul");
    // Adult male magnesium RDA is 420 mg, UL 350 mg supplemental.
    addSupp(profileId, "Magnesium Glycinate", "200 mg", {
      obligation: "should",
    });
    addSupp(profileId, "Magnesium Citrate", "200 mg", { obligation: "may" });

    const mag = getDietaryAdequacy(profileId).find(
      (a) => a.key === "magnesium"
    );
    expect(mag).toBeTruthy();
    expect(mag!.total).toBe(200); // committed only
    expect(mag!.optionalTotal).toBe(200); // disclosed, not folded in
    expect(mag!.sharePct).toBe(48);

    // …while the UL read over the very same rows counts all 400.
    const ul = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "magnesium"
    );
    expect(ul).toBeTruthy();
    expect(ul!.total).toBe(400);
  });
});
