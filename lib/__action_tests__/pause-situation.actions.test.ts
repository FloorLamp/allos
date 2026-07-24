// SERVER-ACTION TIER — the pause-during-situation write path (#1296) and the
// surgery-bridge accept/dismiss actions (#1299).
//
// Covers: linking/unlinking a pause situation through addSupplement/updateSupplement
// (the pause_situation_id resolves to the id-keyed row and re-keys on edit); the
// surgery-bridge accept (idempotent ACTIVATE, not toggle) and clear; and the
// per-procedure dismiss writing the suppression row that the gather then filters.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
  activateSurgerySituation,
  clearSurgerySituation,
  dismissSurgeryBridge,
} from "@/app/(app)/nutrition/supplement-actions";
import { getSupplements, getSurgeryBridgeSuggestions } from "@/lib/queries";
import { getActiveSituations } from "@/lib/settings";
import { surgeryBridgeDismissKey } from "@/lib/surgery-bridge";
import { shiftDateStr } from "@/lib/date";
import { seedActor, fd } from "./harness";

function pauseLinkOf(profileId: number, name: string) {
  const s = getSupplements(profileId).find((x) => x.name === name)!;
  return {
    pause_situation: s.pause_situation,
    pause_situation_id: s.pause_situation_id,
  };
}

describe("pause-situation link write path (#1296)", () => {
  let profileId: number;
  beforeEach(() => {
    profileId = seedActor().profile.id;
  });

  it("addSupplement resolves the pause link to an id-keyed situation row", async () => {
    const res = await addSupplement(
      fd({
        name: "Fish Oil",
        condition: "daily",
        priority: "high",
        pause_situation: "Pre-surgery",
      })
    );
    expect(res.ok).toBe(true);
    const link = pauseLinkOf(profileId, "Fish Oil");
    expect(link.pause_situation).toBe("Pre-surgery");
    expect(link.pause_situation_id).not.toBeNull();
  });

  it("updateSupplement re-keys and clears the pause link", async () => {
    await addSupplement(
      fd({ name: "Vitamin E", condition: "daily", priority: "high" })
    );
    const id = getSupplements(profileId).find(
      (s) => s.name === "Vitamin E"
    )!.id;

    // Link it.
    await updateSupplement(
      fd({
        id,
        name: "Vitamin E",
        condition: "daily",
        priority: "high",
        pause_situation: "Pre-surgery",
      })
    );
    expect(pauseLinkOf(profileId, "Vitamin E").pause_situation).toBe(
      "Pre-surgery"
    );

    // Clear it (blank field).
    await updateSupplement(
      fd({ id, name: "Vitamin E", condition: "daily", priority: "high" })
    );
    const cleared = pauseLinkOf(profileId, "Vitamin E");
    expect(cleared.pause_situation).toBeNull();
    expect(cleared.pause_situation_id).toBeNull();
  });
});

describe("surgery-bridge accept/dismiss actions (#1299)", () => {
  let profileId: number;
  function seedVisit(title: string, offset: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, scheduled_at, title, status)
           VALUES (?, ?, ?, 'scheduled')`
        )
        .run(
          profileId,
          `${shiftDateStr(today(profileId), offset)} 09:00`,
          title
        ).lastInsertRowid
    );
  }
  beforeEach(() => {
    profileId = seedActor().profile.id;
  });

  it("accept ACTIVATES the situation idempotently (never toggles off)", async () => {
    await activateSurgerySituation(fd({ situation: "Pre-surgery" }));
    expect(getActiveSituations(profileId)).toContain("Pre-surgery");
    // Accepting again is a no-op, not a deactivation.
    await activateSurgerySituation(fd({ situation: "Pre-surgery" }));
    expect(getActiveSituations(profileId)).toContain("Pre-surgery");
  });

  it("clear DEACTIVATES the situation (held items resume)", async () => {
    await activateSurgerySituation(fd({ situation: "Pre-surgery" }));
    await clearSurgerySituation(fd({ situation: "Pre-surgery" }));
    expect(getActiveSituations(profileId)).not.toContain("Pre-surgery");
  });

  it("dismiss silences that procedure's suggestion via the bus", async () => {
    seedVisit("Arthroscopy", 3);
    expect(getSurgeryBridgeSuggestions(profileId).length).toBe(1);
    const key = surgeryBridgeDismissKey(
      "pre",
      getSurgeryBridgeSuggestions(profileId)[0].suggestion.visitId
    );
    const res = await dismissSurgeryBridge(fd({ key }));
    expect(res.ok).toBe(true);
    expect(getSurgeryBridgeSuggestions(profileId)).toEqual([]);
  });

  it("dismiss refuses a foreign key namespace", async () => {
    const res = await dismissSurgeryBridge(fd({ key: "biomarker:ldl" }));
    expect(res.ok).toBe(false);
  });
});
