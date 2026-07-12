// DB INTEGRATION TIER (issue #578). The RDA-adequacy gather (getDietaryAdequacy) is
// the thin DB half over the pure stackRdaAdequacy — this seeds a real stack + age/sex
// and asserts the end-to-end read: an under-RDA supplemented nutrient reports its
// share, an at/above-RDA one does not, and the read is profile-scoped. Runs via
// `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getDietaryAdequacy } from "@/lib/queries";

function makeAdultProfile(name: string, sex: "male" | "female"): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', ?)`
  ).run(profileId, sex);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1985-01-01')`
  ).run(profileId);
  return profileId;
}

function addSupp(profileId: number, name: string, amount: string): void {
  const item = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
         VALUES (?, ?, 1, 'supplement', 'daily', 'low', 0)`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, ?, 'morning', 'any', 0)`
  ).run(item, amount);
}

describe("getDietaryAdequacy (#578)", () => {
  it("reports an under-RDA supplemented nutrient with its share", () => {
    const profileId = makeAdultProfile("adequacy-under", "male");
    addSupp(profileId, "Calcium", "500 mg"); // adult RDA 1000 → 50%

    const rows = getDietaryAdequacy(profileId);
    const calcium = rows.find((r) => r.key === "calcium");
    expect(calcium).toBeTruthy();
    expect(calcium!.total).toBe(500);
    expect(calcium!.rda).toBe(1000);
    expect(calcium!.sharePct).toBe(50);
  });

  it("does NOT report a nutrient the stack meets on its own", () => {
    const profileId = makeAdultProfile("adequacy-met", "male");
    addSupp(profileId, "Calcium", "1200 mg"); // >= adult RDA

    expect(getDietaryAdequacy(profileId).some((r) => r.key === "calcium")).toBe(
      false
    );
  });

  it("is profile-scoped — one profile's stack never leaks into another's read", () => {
    const a = makeAdultProfile("adequacy-a", "male");
    const b = makeAdultProfile("adequacy-b", "male");
    addSupp(a, "Calcium", "500 mg");

    expect(getDietaryAdequacy(a).some((r) => r.key === "calcium")).toBe(true);
    expect(getDietaryAdequacy(b)).toEqual([]);
  });
});
