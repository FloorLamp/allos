// SERVER-ACTION TIER — a converted action still refuses a read-only session (#5936).
//
// lib/__tests__/actions-write-access.test.ts stops looking for a gate literal in an
// action once it calls a branded write core: from then on `tsc` refuses an unbranded
// id at the call site (TS2345, "Argument of type 'number' is not assignable to
// parameter of type 'WriteAuthorizedProfileId'"), and that refusal is what the
// step-aside rests on. It refuses the argument, not the missing gate. A plain `any`
// assigned into a `WriteAuthorizedProfileId` annotation — `JSON.parse(...)`, no `as`
// — makes the same call type-valid with `npm run typecheck` and `npm run lint` both
// green (#5939's probe shape), and with the gate swapped for `requireSession()` the
// scanner and the equipment tier stay green too. This file is what goes red under
// that ablation, which is why it is one spec for one action rather than one per
// domain: it pins the residual, not the domains.
//
// The write-session control shows the refusal is the gate and not a missing row.

import { describe, expect, it } from "vitest";
import { setStoredAge } from "@/lib/settings";
import {
  createEquipmentAction,
  setEquipmentRetiredAction,
} from "@/app/(app)/equipment/actions";
import { getEquipment } from "@/lib/equipment";
import { actAs, createLogin, createProfile } from "./harness";

describe("setEquipmentRetiredAction, whose gate the scanner no longer looks for", () => {
  it("refuses a read-only session and leaves the row active", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("ro-equipment", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 30);
    const created = await createEquipmentAction({
      name: "Old Bike",
      weight_kg: null,
      category: "Bike",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.equipment.id;
    const retired = () =>
      getEquipment(profile.id, { includeRetired: true }).find(
        (e) => e.id === id
      )?.retired;

    actAs(login, profile, "read");
    await expect(setEquipmentRetiredAction(id, true)).rejects.toThrow(
      /read-only/
    );
    expect(retired()).toBe(0);

    actAs(login, profile, "write");
    expect(await setEquipmentRetiredAction(id, true)).toEqual({ ok: true });
    expect(retired()).toBe(1);
  });
});
