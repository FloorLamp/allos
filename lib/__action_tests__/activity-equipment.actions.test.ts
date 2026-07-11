// SERVER-ACTION TIER — saveActivity persists the ACTIVITY-level equipment link
// (issue #342), resolving an untrusted id to one the acting profile actually owns.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

const cardioComponents = JSON.stringify([
  { name: "Cycling", type: "cardio", distance: null, duration_min: 40 },
]);

function equipmentOf(activityId: number): number | null {
  return (
    db
      .prepare("SELECT equipment_id FROM activities WHERE id = ?")
      .get(activityId) as { equipment_id: number | null }
  ).equipment_id;
}

function makeEquipment(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, category) VALUES (?, ?, 'Bike')`
      )
      .run(profileId, name).lastInsertRowid
  );
}

describe("saveActivity activity-level equipment (issue #342)", () => {
  it("stores an owned equipment_id on a manual create", async () => {
    const login = createLogin();
    const profile = createProfile("cyclist", login.id);
    actAs(login, profile);
    const bikeId = makeEquipment(profile.id, "Road Bike");

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Ride",
        date: "2026-07-03",
        components: cardioComponents,
        sets: "[]",
        equipment_id: String(bikeId),
      })
    );
    if (!res.ok) throw new Error(`expected save ok, got ${res.reason}`);
    expect(equipmentOf(res.id)).toBe(bikeId);
  });

  it("drops a foreign (cross-profile) equipment id to null", async () => {
    // A bike owned by a DIFFERENT profile.
    const strangerLogin = createLogin();
    const stranger = createProfile("stranger", strangerLogin.id);
    const foreignBike = makeEquipment(stranger.id, "Stranger Bike");

    const login = createLogin();
    const profile = createProfile("cyclist2", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Ride",
        date: "2026-07-04",
        components: cardioComponents,
        sets: "[]",
        equipment_id: String(foreignBike),
      })
    );
    if (!res.ok) throw new Error(`expected save ok, got ${res.reason}`);
    expect(equipmentOf(res.id)).toBeNull();
  });

  it("clears the link on an edit that omits equipment_id", async () => {
    const login = createLogin();
    const profile = createProfile("cyclist3", login.id);
    actAs(login, profile);
    const bikeId = makeEquipment(profile.id, "Commuter");

    const created = await saveActivity(
      fd({
        type: "cardio",
        title: "Ride",
        date: "2026-07-05",
        components: cardioComponents,
        sets: "[]",
        equipment_id: String(bikeId),
      })
    );
    if (!created.ok) throw new Error("create failed");
    expect(equipmentOf(created.id)).toBe(bikeId);

    // Re-save the same row without equipment_id — the link is cleared.
    const edited = await saveActivity(
      fd({
        id: String(created.id),
        type: "cardio",
        title: "Ride",
        date: "2026-07-05",
        components: cardioComponents,
        sets: "[]",
      })
    );
    if (!edited.ok) throw new Error("edit failed");
    expect(equipmentOf(created.id)).toBeNull();
  });
});
