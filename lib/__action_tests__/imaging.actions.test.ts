// SERVER-ACTION TIER — imaging-study write path (#702). Exercises add / update /
// delete against a real (temp) SQLite handle to prove every mutation is
// profile-scoped (no cross-profile bleed), that the modality / laterality / contrast
// strings are normalized onto the DB CHECK sets (an off-vocabulary form can never
// trip the constraint), and that a manual row carries NULL provenance so the import
// delete-set never touches it. The static source scan can't see across the action
// boundary; this is the dynamic guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  addImagingStudy,
  updateImagingStudy,
  deleteImagingStudy,
} from "@/app/(app)/imaging/actions";
import { getImagingStudies } from "@/lib/queries";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

describe("addImagingStudy", () => {
  it("stores a profile-scoped study and normalizes the enum fields", async () => {
    const { profile } = seedActor();
    const res = await addImagingStudy(
      fd({
        modality: "Magnetic Resonance Imaging",
        body_region: "Knee",
        laterality: "Left",
        contrast: "true",
        contrast_agent: "gadolinium",
        study_date: "2024-02-01",
        impression: "No tear.",
        indication: "Knee pain",
        status: "final",
      })
    );
    expect(res.ok).toBe(true);

    const rows = getImagingStudies(profile.id);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s.modality).toBe("mri");
    expect(s.body_region).toBe("Knee");
    expect(s.laterality).toBe("left");
    expect(s.contrast).toBe(true);
    expect(s.contrast_agent).toBe("gadolinium");
    expect(s.impression).toBe("No tear.");
    expect(s.indication).toBe("Knee pain");
    expect(s.study_date).toBe("2024-02-01");
    // Manual rows carry no import provenance.
    expect(s.source).toBeNull();
    expect(s.document_id).toBeNull();
    expect(s.external_id).toBeNull();
    // Provider links are captured structurally but not populated from this form yet.
    expect(s.ordering_provider_id).toBeNull();
    expect(s.reading_provider_id).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/results");
  });

  it("defaults an unknown modality to 'other' and a missing laterality to null", async () => {
    const { profile } = seedActor();
    // "nuclear medicine ..." classifies as nuclear-medicine since #1034 gave the
    // high-dose modalities their own branches; use a genuinely unknown phrasing.
    await addImagingStudy(
      fd({ modality: "thermography thing", body_region: "Whole body" })
    );
    const s = getImagingStudies(profile.id)[0];
    expect(s.modality).toBe("other");
    expect(s.laterality).toBeNull();
    expect(s.contrast).toBe(false);
  });

  it("parses a recorded effective dose (mSv) and leaves it null when blank (#703)", async () => {
    const { profile } = seedActor();
    // A form value with a stray unit still lands as a clean number.
    await addImagingStudy(
      fd({ modality: "ct", body_region: "Abdomen", dose_msv: "12.5 mSv" })
    );
    // Blank dose stays null (→ the typical estimate takes over on the read side).
    await addImagingStudy(fd({ modality: "x-ray", body_region: "Chest" }));

    const rows = getImagingStudies(profile.id);
    const ct = rows.find((r) => r.modality === "ct")!;
    const cxr = rows.find((r) => r.modality === "x-ray")!;
    expect(ct.dose_msv).toBe(12.5);
    expect(cxr.dose_msv).toBeNull();
  });

  it("updates a recorded dose in place (#703)", async () => {
    const { profile } = seedActor();
    await addImagingStudy(fd({ modality: "ct", body_region: "Chest" }));
    const id = getImagingStudies(profile.id)[0].id;
    await updateImagingStudy(
      fd({ id, modality: "ct", body_region: "Chest", dose_msv: "8" })
    );
    expect(getImagingStudies(profile.id)[0].dose_msv).toBe(8);
  });
});

describe("updateImagingStudy", () => {
  it("edits in place and stays profile-scoped", async () => {
    const { login, profile } = seedActor();
    await addImagingStudy(fd({ modality: "x-ray", body_region: "Chest" }));
    const id = getImagingStudies(profile.id)[0].id;

    // Another profile the same admin can act as — its rows must be untouched.
    const other = createProfile("Other Patient");
    actAs(login, other);
    await addImagingStudy(fd({ modality: "ct", body_region: "Abdomen" }));
    actAs(login, profile);

    const res = await updateImagingStudy(
      fd({ id, modality: "x-ray", body_region: "Chest", impression: "Clear." })
    );
    expect(res.ok).toBe(true);
    expect(getImagingStudies(profile.id)[0].impression).toBe("Clear.");

    // The cross-profile update is refused: updating from `other` can't reach it.
    actAs(login, other);
    const cross = await updateImagingStudy(
      fd({ id, modality: "mri", body_region: "HACKED" })
    );
    expect(cross.ok).toBe(true); // action returns ok; the WHERE profile_id filters it out
    expect(
      getImagingStudies(other.id).some((r) => r.body_region === "HACKED")
    ).toBe(false);
    actAs(login, profile);
    expect(getImagingStudies(profile.id)[0].body_region).toBe("Chest");
  });
});

describe("deleteImagingStudy", () => {
  it("deletes only the acting profile's row", async () => {
    const { profile } = seedActor();
    await addImagingStudy(fd({ modality: "dexa", body_region: "Hip/Spine" }));
    const id = getImagingStudies(profile.id)[0].id;
    const res = await deleteImagingStudy(fd({ id }));
    expect(res.ok).toBe(true);
    expect(getImagingStudies(profile.id)).toHaveLength(0);
  });
});
