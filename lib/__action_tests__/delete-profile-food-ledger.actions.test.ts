// SERVER-ACTION TIER — deleteProfile clears the food-log event ledger (#950).
//
// food_log_events is a profile-OWNED table (lib/owned-tables.ts), so deleteProfile's
// OWNED_TABLES sweep removes its rows by profile_id (the row-ops side-state rule — the
// ledger is cleared alongside its food_log counter). This pins that the deleted
// profile's ledger is gone while a bystander's survives.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { logFoodServingCore } from "@/lib/food-log-write";
import { createLogin, createProfile, actAs, fd } from "./harness";

function ledgerCount(profileId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id = ?`)
      .get(profileId) as { n: number }
  ).n;
}

describe("deleteProfile clears food_log_events (#950)", () => {
  it("removes the deleted profile's ledger but leaves a bystander's", async () => {
    const admin = createLogin({ role: "admin" });
    const acting = createProfile("Acting Admin");
    const victim = createProfile("Test Patient");
    const bystander = createProfile("Ada Lovelace");
    actAs(admin, acting);

    logFoodServingCore(victim.id, "fatty_fish", "2026-07-08");
    logFoodServingCore(victim.id, "berries", "2026-07-08");
    logFoodServingCore(bystander.id, "fatty_fish", "2026-07-08");
    expect(ledgerCount(victim.id)).toBe(2);

    const res = await deleteProfile(fd({ id: victim.id }));
    expect(res.ok).toBe(true);

    expect(ledgerCount(victim.id)).toBe(0);
    expect(ledgerCount(bystander.id)).toBe(1); // bystander untouched
  });
});
