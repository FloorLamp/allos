// DB INTEGRATION TIER — the preventive-care Upcoming slice (issue #82). Seeds a
// profile with a birthdate (so the assessor emits items), then proves the new
// query-layer reads/writers round-trip and that a mark-done / override each clears
// the corresponding due item from the profile-scoped Upcoming aggregation. The
// pure assessor + adapter are unit-tested in lib/__tests__; this exercises the
// real tables + query wiring.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { setUserBirthdate, setUserSex } from "@/lib/settings";
import {
  collectUpcoming,
  getPreventiveSatisfactions,
  getPreventiveOverrides,
  recordPreventiveDone,
  setPreventiveOverride,
  clearPreventiveOverride,
} from "@/lib/queries";

function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // A ~46-year-old male: past the adult-physical entry age (22, no visit on
  // record) and several screening entry ages (colorectal 45+, BP 18+, lipids 35+).
  setUserBirthdate(id, "1980-01-01");
  setUserSex(id, "male");
  return id;
}

let profileId: number;
let now: string;

beforeAll(() => {
  profileId = makeProfile("Preventive Test");
  now = today(profileId);
});

describe("preventive Upcoming integration", () => {
  it("surfaces due preventive visit + screening items for a demographics-known profile", () => {
    const items = collectUpcoming(profileId, now);
    expect(items.some((i) => i.domain === "visit")).toBe(true);
    expect(items.some((i) => i.domain === "screening")).toBe(true);
    // The adult physical is a due visit with no history and carries its rule key
    // (drives the inline mark-done / override forms).
    const visit = items.find((i) => i.key === "visit:adult_physical");
    expect(visit?.preventiveRuleKey).toBe("adult_physical");
    // No visit on record well past the entry age → an actionable (due/overdue) band.
    expect(["today", "overdue"]).toContain(visit?.band);
  });

  it("recordPreventiveDone writes an idempotent satisfaction that clears the item", () => {
    recordPreventiveDone(profileId, "adult_physical", now);
    // Idempotent: a repeat on the same day does not add a second row.
    recordPreventiveDone(profileId, "adult_physical", now);

    const sats = getPreventiveSatisfactions(profileId);
    expect(sats.filter((s) => s.ruleKey === "adult_physical")).toHaveLength(1);

    const items = collectUpcoming(profileId, now);
    expect(items.some((i) => i.key === "visit:adult_physical")).toBe(false);
  });

  it("a declined override hides a screening and clearing it restores the item", () => {
    const before = collectUpcoming(profileId, now);
    expect(before.some((i) => i.key === "screening:blood_pressure")).toBe(true);

    setPreventiveOverride(profileId, "blood_pressure", "declined");
    expect(
      getPreventiveOverrides(profileId).find(
        (o) => o.ruleKey === "blood_pressure"
      )?.kind
    ).toBe("declined");
    expect(
      collectUpcoming(profileId, now).some(
        (i) => i.key === "screening:blood_pressure"
      )
    ).toBe(false);

    // not_applicable upserts (flips the kind on the same row).
    setPreventiveOverride(profileId, "blood_pressure", "not_applicable");
    expect(getPreventiveOverrides(profileId)).toHaveLength(1);
    expect(getPreventiveOverrides(profileId)[0].kind).toBe("not_applicable");

    clearPreventiveOverride(profileId, "blood_pressure");
    expect(getPreventiveOverrides(profileId)).toHaveLength(0);
    expect(
      collectUpcoming(profileId, now).some(
        (i) => i.key === "screening:blood_pressure"
      )
    ).toBe(true);
  });

  it("preventive reads and writes are scoped to the profile", () => {
    const other = makeProfile("Other Preventive");
    setPreventiveOverride(other, "lipid_screening", "declined");
    recordPreventiveDone(other, "adult_physical", now);

    // The first profile still sees lipids as due (the other's override is invisible)
    // and its own satisfactions/overrides are unaffected.
    expect(getPreventiveOverrides(profileId).length).toBe(0);
    expect(
      collectUpcoming(profileId, now).some(
        (i) => i.key === "screening:lipid_screening"
      )
    ).toBe(true);
    expect(
      getPreventiveSatisfactions(other).some(
        (s) => s.ruleKey === "adult_physical"
      )
    ).toBe(true);
  });
});
