// SERVER-ACTION TIER — the typed FormResult contract (issue #474).
//
// Representative coverage across the migrated passport surface that a validation
// guard now answers with `{ ok:false, error }` (never a bare `undefined` resolve
// the form reads as "Saved ✓") and a persisted write answers with `{ ok:true }`.
// The per-module tests cover behaviour; this pins the CONTRACT shape end-to-end
// through the real action so a regression to `return;` fails here as well as in the
// source-scan guard (lib/__tests__/action-return-contract.test.ts).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { addAllergy, updateAllergy } from "@/app/(app)/allergies/actions";
import { addCondition } from "@/app/(app)/conditions/actions";
import { createGoal } from "@/app/(app)/goals/actions";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function count(table: string, profileId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_id = ?`)
      .get(profileId) as { n: number }
  ).n;
}

describe("FormResult contract (issue #474)", () => {
  it("addAllergy: blank substance → { ok:false, error }, nothing persisted", async () => {
    const { profile } = seedActor();
    const res = await addAllergy(fd({ substance: "   " }));
    expect(res).toEqual({ ok: false, error: expect.any(String) });
    expect(count("allergies", profile.id)).toBe(0);
  });

  it("addAllergy: valid → { ok:true } and a row is written", async () => {
    const { profile } = seedActor();
    const res = await addAllergy(fd({ substance: "Penicillin" }));
    expect(res).toEqual({ ok: true });
    expect(count("allergies", profile.id)).toBe(1);
  });

  it("updateAllergy: missing id → typed error", async () => {
    seedActor();
    const res = await updateAllergy(fd({ substance: "Latex" }));
    expect(res.ok).toBe(false);
  });

  it("addCondition: blank name → typed error, nothing persisted", async () => {
    const { profile } = seedActor();
    const res = await addCondition(fd({ name: "" }));
    expect(res.ok).toBe(false);
    expect(count("conditions", profile.id)).toBe(0);
  });

  it("createGoal: invalid payload → typed error (target ≤ 0 no longer silently no-ops)", async () => {
    seedActor();
    // A goal with no title / non-positive target fails goalColsFromForm — which
    // used to `return;` (silent) and now returns a typed error.
    const res = await createGoal(
      fd({ title: "", metric: "weight", target: "0" })
    );
    expect(res.ok).toBe(false);
  });
});
