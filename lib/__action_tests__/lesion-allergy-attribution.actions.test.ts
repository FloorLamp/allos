// SERVER-ACTION TIER — the attribution write paths #1526 added: an allergy's
// documenting provider + visit, and a skin lesion's visit. The DB tier proves the
// columns and the reads; only this tier can see the FormData plumbing and the auth
// boundary, so this is where "the picker's posted id actually lands, and a forged one
// does not" is pinned.
//
// The cross-profile forge is the assertion that matters most: the picker is a <select>
// of the row's own profile's visits, but a POST is not a UI — so each action re-resolves
// the id against the target profile (encounterIdForProfile) and stores "no link" rather
// than a dangling or leaked reference.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addAllergy,
  updateAllergy,
} from "@/app/(app)/records/problems/allergies/actions";
import {
  addSkinLesion,
  updateSkinLesion,
} from "@/app/(app)/records/specialty/skin/actions";
import { getAllergies, getSkinLesions } from "@/lib/queries";
import { seedActor, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function newEncounter(
  profileId: number,
  date = "2026-03-03",
  type = "Dermatology"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type) VALUES (?, ?, ?)`
      )
      .run(profileId, date, type).lastInsertRowid
  );
}

function allergyLinks(id: number): {
  encounter_id: number | null;
  provider_id: number | null;
} {
  return db
    .prepare(`SELECT encounter_id, provider_id FROM allergies WHERE id = ?`)
    .get(id) as { encounter_id: number | null; provider_id: number | null };
}

describe("addAllergy attribution (#1526)", () => {
  it("stores the picked visit and resolves the documenting provider into the registry", async () => {
    const { profile } = seedActor();
    const encId = newEncounter(profile.id, "2026-03-03", "Allergy clinic");
    const res = await addAllergy(
      fd({
        substance: "Penicillin",
        reaction_manifestation: "Hives",
        reaction_severity: "Moderate",
        status: "active",
        verification_status: "confirmed",
        onset_date: "2026-03-03",
        provider: "Dr. Okafor",
        encounter_id: String(encId),
      })
    );
    expect(res.ok).toBe(true);

    const rows = getAllergies(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].encounter_id).toBe(encId);
    expect(rows[0].provider_id).not.toBeNull();
    // The read layer joins the name back for display + for the edit form's loaded value.
    expect(rows[0].provider_name).toBe("Dr. Okafor");
    expect(
      db
        .prepare(`SELECT name FROM providers WHERE id = ?`)
        .get(rows[0].provider_id) as { name: string }
    ).toEqual({ name: "Dr. Okafor" });
  });

  it("leaves both links NULL when the form posts neither (attribution is optional)", async () => {
    const { profile } = seedActor();
    const res = await addAllergy(fd({ substance: "Latex", status: "active" }));
    expect(res.ok).toBe(true);
    const row = getAllergies(profile.id)[0];
    expect(row.encounter_id).toBeNull();
    expect(row.provider_id).toBeNull();
  });

  it("refuses another profile's visit id — stored as no link, never dangling", async () => {
    const { profile } = seedActor();
    const stranger = createProfile("Stranger");
    const foreignEnc = newEncounter(stranger.id);
    const res = await addAllergy(
      fd({
        substance: "Shellfish",
        status: "active",
        encounter_id: String(foreignEnc),
      })
    );
    expect(res.ok).toBe(true);
    expect(getAllergies(profile.id)[0].encounter_id).toBeNull();
  });
});

describe("updateAllergy attribution (#1526)", () => {
  it("sets, keeps, and clears the visit link across edits", async () => {
    const { profile } = seedActor();
    const encId = newEncounter(profile.id, "2026-04-04", "Allergy clinic");
    await addAllergy(fd({ substance: "Peanut", status: "active" }));
    const id = getAllergies(profile.id)[0].id;
    expect(allergyLinks(id).encounter_id).toBeNull();

    // Set it.
    let res = await updateAllergy(
      fd({
        id: String(id),
        substance: "Peanut",
        status: "active",
        provider: "Dr. Okafor",
        encounter_id: String(encId),
      })
    );
    expect(res.ok).toBe(true);
    const linked = allergyLinks(id);
    expect(linked.encounter_id).toBe(encId);
    const providerId = linked.provider_id;
    expect(providerId).not.toBeNull();

    // An edit that re-posts the LOADED provider name must not coin a second registry
    // row — resolveProviderOnEdit returns the loaded id untouched.
    res = await updateAllergy(
      fd({
        id: String(id),
        substance: "Peanut",
        status: "active",
        provider: "Dr. Okafor",
        provider_id: String(providerId),
        provider_loaded: "Dr. Okafor",
        encounter_id: String(encId),
      })
    );
    expect(res.ok).toBe(true);
    expect(allergyLinks(id).provider_id).toBe(providerId);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM providers WHERE name = 'Dr. Okafor'`
          )
          .get() as { n: number }
      ).n
    ).toBe(1);

    // Clearing the picker clears the link — "not linked to a visit" is a real answer.
    res = await updateAllergy(
      fd({
        id: String(id),
        substance: "Peanut",
        status: "active",
        encounter_id: "",
      })
    );
    expect(res.ok).toBe(true);
    expect(allergyLinks(id).encounter_id).toBeNull();
  });

  it("refuses to link another profile's visit on edit", async () => {
    const { profile } = seedActor();
    const stranger = createProfile("Stranger");
    const foreignEnc = newEncounter(stranger.id);
    await addAllergy(fd({ substance: "Iodine", status: "active" }));
    const id = getAllergies(profile.id)[0].id;
    const res = await updateAllergy(
      fd({
        id: String(id),
        substance: "Iodine",
        status: "active",
        encounter_id: String(foreignEnc),
      })
    );
    expect(res.ok).toBe(true);
    expect(allergyLinks(id).encounter_id).toBeNull();
  });
});

describe("skin-lesion visit link (#1526)", () => {
  it("stores the picked visit on add and clears it on edit", async () => {
    const { profile } = seedActor();
    const encId = newEncounter(profile.id, "2026-05-05", "Dermatology");
    let res = await addSkinLesion(
      fd({
        label: "Upper left forearm mole",
        body_region: "forearm",
        status: "watch",
        observed_date: "2026-05-05",
        finding: "unchanged since last check",
        encounter_id: String(encId),
      })
    );
    expect(res.ok).toBe(true);
    const lesion = getSkinLesions(profile.id)[0];
    expect(lesion.encounter_id).toBe(encId);

    res = await updateSkinLesion(
      fd({
        id: String(lesion.id),
        label: "Upper left forearm mole",
        body_region: "forearm",
        status: "watch",
        encounter_id: "",
      })
    );
    expect(res.ok).toBe(true);
    expect(getSkinLesions(profile.id)[0].encounter_id).toBeNull();
  });

  it("refuses another profile's visit id on a lesion too", async () => {
    const { profile } = seedActor();
    const stranger = createProfile("Stranger");
    const foreignEnc = newEncounter(stranger.id);
    const res = await addSkinLesion(
      fd({
        label: "Scalp spot",
        body_region: "scalp",
        status: "active",
        encounter_id: String(foreignEnc),
      })
    );
    expect(res.ok).toBe(true);
    expect(getSkinLesions(profile.id)[0].encounter_id).toBeNull();
  });
});
