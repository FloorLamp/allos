// SERVER-ACTION TIER — the provider FK now settable on the specialty/imaging record
// forms (issue #1088). Each form's add/update resolves a create-on-type provider name
// into the GLOBAL registry and links it; the write is profile-scoped, so a record
// belonging to another profile is never touched (providers are global — there is no
// per-profile provider row, so "cross-profile" here means the profile-scoped record
// UPDATE refuses another profile's row). Imaging carries BOTH roles.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addOpticalPrescription,
  updateOpticalPrescription,
} from "@/app/(app)/vision/actions";
import { addDentalProcedure } from "@/app/(app)/dental/actions";
import { addSkinLesion } from "@/app/(app)/skin/actions";
import {
  addImagingStudy,
  updateImagingStudy,
} from "@/app/(app)/imaging/actions";
import {
  getOpticalPrescriptions,
  getDentalProcedures,
  getSkinLesions,
  getImagingStudies,
} from "@/lib/queries";
import { seedActor, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function providerType(id: number): string {
  return (
    db.prepare("SELECT type FROM providers WHERE id = ?").get(id) as {
      type: string;
    }
  ).type;
}

describe("#1088 — provider settable on the vision Rx form", () => {
  it("resolves a create-on-type prescriber into the registry and links it", async () => {
    const { profile } = seedActor();
    await addOpticalPrescription(
      fd({ kind: "glasses", provider: "Dr. Vision Test" })
    );
    const rx = getOpticalPrescriptions(profile.id)[0];
    expect(rx.provider_id).toBeTruthy();
    expect(rx.provider_name).toBe("Dr. Vision Test");
    // The prescriber is created as an individual clinician.
    expect(providerType(rx.provider_id!)).toBe("individual");
  });

  it("keeps the loaded link on an unrelated edit (round-trip), profile-scoped", async () => {
    const a = seedActor();
    await addOpticalPrescription(
      fd({ kind: "glasses", provider: "Dr. Keep Link" })
    );
    const rx = getOpticalPrescriptions(a.profile.id)[0];
    const linkedId = rx.provider_id!;

    // Another profile cannot update A's row (profile-scoped UPDATE).
    const b = seedActor();
    await updateOpticalPrescription(
      fd({ id: rx.id, kind: "contacts", provider: "" })
    );
    // Re-bind A and confirm the row is untouched (still glasses, still linked).
    actAs(a.login, a.profile);
    const after = getOpticalPrescriptions(a.profile.id)[0];
    expect(after.kind).toBe("glasses");
    expect(after.provider_id).toBe(linkedId);
    // B's own list is empty — the update never crossed profiles.
    expect(getOpticalPrescriptions(b.profile.id)).toHaveLength(0);

    // An untouched-name edit keeps the id; changing the name re-resolves.
    await updateOpticalPrescription(
      fd({
        id: rx.id,
        kind: "glasses",
        provider: "Dr. Keep Link",
        provider_id: String(linkedId),
        provider_loaded: "Dr. Keep Link",
      })
    );
    expect(getOpticalPrescriptions(a.profile.id)[0].provider_id).toBe(linkedId);
  });
});

describe("#1088 — provider settable on the dental form", () => {
  it("links a create-on-type dentist", async () => {
    const { profile } = seedActor();
    await addDentalProcedure(
      fd({ name: "Composite filling", provider: "Dr. Dental Test" })
    );
    const rec = getDentalProcedures(profile.id)[0];
    expect(rec.provider_name).toBe("Dr. Dental Test");
    expect(providerType(rec.provider_id!)).toBe("individual");
  });
});

describe("#1088 — provider settable on the skin form", () => {
  it("links a create-on-type dermatologist, NULL when omitted", async () => {
    const { profile } = seedActor();
    await addSkinLesion(fd({ label: "Left forearm mole", provider: "" }));
    await addSkinLesion(
      fd({ label: "Right cheek spot", provider: "Dr. Skin Test" })
    );
    const rows = getSkinLesions(profile.id);
    const selfEntered = rows.find((r) => r.label === "Left forearm mole")!;
    const withProvider = rows.find((r) => r.label === "Right cheek spot")!;
    expect(selfEntered.provider_id).toBeNull();
    expect(withProvider.provider_name).toBe("Dr. Skin Test");
  });
});

describe("#1088 — imaging carries BOTH ordering + reading providers", () => {
  it("links ordering + reading independently and re-points on edit", async () => {
    const { profile } = seedActor();
    await addImagingStudy(
      fd({
        modality: "ct",
        body_region: "Chest",
        ordering_provider: "Dr. Order Test",
        reading_provider: "Dr. Read Test",
      })
    );
    const study = getImagingStudies(profile.id)[0];
    expect(study.ordering_provider_name).toBe("Dr. Order Test");
    expect(study.reading_provider_name).toBe("Dr. Read Test");
    expect(study.ordering_provider_id).not.toBe(study.reading_provider_id);

    // Editing the reading name re-resolves only that role.
    await updateImagingStudy(
      fd({
        id: study.id,
        modality: "ct",
        body_region: "Chest",
        ordering_provider: "Dr. Order Test",
        ordering_provider_id: String(study.ordering_provider_id),
        ordering_provider_loaded: "Dr. Order Test",
        reading_provider: "Dr. New Reader",
        reading_provider_id: String(study.reading_provider_id),
        reading_provider_loaded: "Dr. Read Test",
      })
    );
    const after = getImagingStudies(profile.id)[0];
    expect(after.ordering_provider_id).toBe(study.ordering_provider_id);
    expect(after.reading_provider_name).toBe("Dr. New Reader");
    expect(after.reading_provider_id).not.toBe(study.reading_provider_id);
  });
});
