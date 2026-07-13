// DB INTEGRATION TIER (issue #635). getDietaryLimitWarnings is the DB half over the
// pure stackUlWarnings — a CARE-TIER findings gather (it reaches Upcoming, the
// non-hideable "Needs attention" hero, and the digest push), so it earns a #448
// fixture. The bug: the gather summed EVERY active item's dose as a DAILY UL total,
// ignoring PRN (as_needed) and workout/rest/situational items that aren't taken
// every day — a standing false "above the upper limit" alarm. This seeds those
// non-daily items above the UL and asserts they no longer contribute, while a plain
// daily item above the UL still flags. Runs via `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getDietaryLimitWarnings } from "@/lib/queries";
import type { SupplementCondition } from "@/lib/types";

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
  opts: { condition?: SupplementCondition; asNeeded?: 0 | 1 } = {}
): void {
  const item = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
         VALUES (?, ?, 1, 'medication', ?, 'low', ?)`
      )
      .run(profileId, name, opts.condition ?? "daily", opts.asNeeded ?? 0)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, ?, 'morning', 'any', 0)`
  ).run(item, amount);
}

describe("getDietaryLimitWarnings — schedule-aware UL sum (#635)", () => {
  it("does NOT flag a PRN iron over the UL", () => {
    const profileId = makeAdultProfile("ul-prn");
    addSupp(profileId, "Iron", "65 mg", { asNeeded: 1 });

    expect(
      getDietaryLimitWarnings(profileId).some((w) => w.key === "iron")
    ).toBe(false);
  });

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

  it("counts only the daily contributor when a daily and a PRN item stack", () => {
    const profileId = makeAdultProfile("ul-mixed");
    addSupp(profileId, "Iron", "50 mg", { condition: "daily" }); // over UL 45 alone
    addSupp(profileId, "Iron", "65 mg", { asNeeded: 1 }); // PRN, excluded

    const iron = getDietaryLimitWarnings(profileId).find(
      (w) => w.key === "iron"
    );
    expect(iron).toBeTruthy();
    // The PRN 65 mg is NOT added to the daily total (else it would read 115).
    expect(iron!.total).toBe(50);
  });
});
