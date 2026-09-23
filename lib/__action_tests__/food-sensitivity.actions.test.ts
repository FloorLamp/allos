// SERVER-ACTION TIER — the declared-sensitivity gate (#5865). The store's own scoping
// is pinned in lib/__db_tests__/food-sensitivities.test.ts; what is pinned here is the
// action boundary above it: the profile comes from the session and never from the
// body, a read-only session is refused, another household's member cannot reach a row
// by its id, and a forged trigger kind is a typed refusal rather than a thrown INSERT.

import { describe, it, expect } from "vitest";
import {
  createFoodSensitivityAction,
  deleteFoodSensitivityAction,
  setFoodSensitivityStoppedAction,
  updateFoodSensitivityAction,
  type SensitivityFormInput,
} from "@/app/(app)/nutrition/sensitivity-actions";
import { getFoodSensitivities } from "@/lib/food-sensitivity-store";
import { actAs, createLogin, createProfile, seedActor } from "./harness";

const SPICY: SensitivityFormInput = {
  trigger_kind: "property",
  trigger_slug: "spicy",
  effect: "loose_stools",
  note: "",
};

async function declared(input = SPICY) {
  const created = await createFoodSensitivityAction(input);
  if (!created.ok) throw new Error(created.error);
  return created.sensitivity;
}

describe("sensitivity actions", () => {
  it("writes to the session's profile and ignores a posted profile id", async () => {
    const owner = seedActor();
    const other = createProfile("other", owner.login.id);
    await declared({
      ...SPICY,
      profile_id: other.id,
    } as SensitivityFormInput);
    expect(getFoodSensitivities(owner.profile.id)).toHaveLength(1);
    expect(getFoodSensitivities(other.id)).toEqual([]);
  });

  it("refuses a forged trigger kind in words, writing nothing", async () => {
    const { profile } = seedActor();
    const forged = {
      ...SPICY,
      trigger_kind: "vibe",
    } as unknown as SensitivityFormInput;
    expect(await createFoodSensitivityAction(forged)).toEqual({
      ok: false,
      error: "That isn’t a trigger this app knows.",
    });
    expect(getFoodSensitivities(profile.id)).toEqual([]);
  });

  it("refuses every write from a read-only session", async () => {
    const { login, profile } = seedActor();
    const row = await declared();
    actAs(login, profile, "read");
    await expect(createFoodSensitivityAction(SPICY)).rejects.toThrow(
      /read-only/
    );
    await expect(updateFoodSensitivityAction(row.id, SPICY)).rejects.toThrow(
      /read-only/
    );
    await expect(setFoodSensitivityStoppedAction(row.id, true)).rejects.toThrow(
      /read-only/
    );
    await expect(deleteFoodSensitivityAction(row.id)).rejects.toThrow(
      /read-only/
    );
    expect(getFoodSensitivities(profile.id)).toEqual([row]);
  });

  it("leaves another household's row intact on edit, stop and delete", async () => {
    const owner = seedActor();
    const row = await declared();
    const stranger = createLogin({ role: "member" });
    actAs(stranger, createProfile("stranger", stranger.id));

    for (const attempt of [
      updateFoodSensitivityAction(row.id, { ...SPICY, note: "changed" }),
      setFoodSensitivityStoppedAction(row.id, true),
      deleteFoodSensitivityAction(row.id),
    ])
      expect((await attempt).ok).toBe(false);
    expect(getFoodSensitivities(owner.profile.id)).toEqual([row]);
  });
});
