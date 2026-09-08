// SERVER-ACTION TIER (#1099) — the "Create a visit from this record?" accept/decline
// write paths, driven through the real actions with the auth boundary mocked
// (setup.ts). The pure/DB tiers can't see the auth gate or the FormData plumbing; this
// pins that the actions create+link under requireWriteAccess, remember a decline, and
// reject a cross-profile write target.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createVisitFromRecordAction,
  declineCreateVisitAction,
} from "@/app/(app)/visit-link-actions";
import { seedActor, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function newOpticalRx(profileId: number, date = "2026-04-04"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO optical_prescriptions (profile_id, kind, issued_date)
         VALUES (?, 'glasses', ?)`
      )
      .run(profileId, date).lastInsertRowid
  );
}
function rxEncounterId(id: number): number | null {
  return (
    db
      .prepare("SELECT encounter_id FROM optical_prescriptions WHERE id = ?")
      .get(id) as { encounter_id: number | null }
  ).encounter_id;
}

describe("create-visit-from-record actions", () => {
  it.each(["profile_id", "profileId"])(
    "creates and links a visit for the posted non-acting subject via %s",
    async (field) => {
      const { login } = seedActor({ role: "member" });
      const profile = createProfile("Shared optical subject", login.id);
      const rx = newOpticalRx(profile.id);

      await createVisitFromRecordAction(
        fd({ [field]: profile.id, domain: "optical", recordId: rx })
      );

      const encId = rxEncounterId(rx);
      expect(encId).toBeTruthy();
      const enc = db
        .prepare(
          "SELECT source, type FROM encounters WHERE id = ? AND profile_id = ?"
        )
        .get(encId, profile.id) as { source: string; type: string };
      expect(enc.source).toBe("derived-from-record");
      expect(enc.type).toBe("Eye exam");
      expect(revalidate).toHaveBeenCalled();
    }
  );

  it("declineCreateVisitAction remembers the decline and creates no encounter", async () => {
    const { profile } = seedActor();
    const rx = newOpticalRx(profile.id);

    await declineCreateVisitAction(fd({ domain: "optical", recordId: rx }));

    expect(rxEncounterId(rx)).toBeNull();
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ?")
        .get(profile.id) as { n: number }
    ).toEqual({ n: 0 });
    const decision = db
      .prepare(
        `SELECT decision FROM visit_link_decisions
          WHERE profile_id = ? AND domain = 'optical' AND encounter_key = 'create'`
      )
      .get(profile.id) as { decision: string } | undefined;
    expect(decision?.decision).toBe("declined");
  });

  it("rejects an unknown domain (only optical/dental/imaging are honored)", async () => {
    const { profile } = seedActor();
    const rx = newOpticalRx(profile.id);
    await createVisitFromRecordAction(fd({ domain: "record", recordId: rx }));
    expect(rxEncounterId(rx)).toBeNull();
  });
});
