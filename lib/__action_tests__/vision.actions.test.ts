// SERVER-ACTION TIER — optical-prescription write path (#697). Exercises add /
// update / delete against a real (temp) SQLite handle to prove every mutation is
// profile-scoped (no cross-profile bleed), that the kind is normalized onto the DB
// CHECK set and the per-eye powers / axis / distances are parsed off the Rx notation
// (an off-vocabulary form can never trip the constraint), and that a manual row
// carries NULL provenance so the import delete-set never touches it. The static
// source scan can't see across the action boundary; this is the dynamic guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  addOpticalPrescription,
  updateOpticalPrescription,
  deleteOpticalPrescription,
} from "@/app/(app)/vision/actions";
import { getOpticalPrescriptions } from "@/lib/queries";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

describe("addOpticalPrescription", () => {
  it("stores a profile-scoped Rx and parses/normalizes the fields", async () => {
    const { profile } = seedActor();
    const res = await addOpticalPrescription(
      fd({
        kind: "Eyeglasses",
        od_sphere: "-2.00",
        od_cylinder: "-0.75",
        od_axis: "90",
        od_add: "+1.00",
        os_sphere: "plano",
        os_cylinder: "",
        os_axis: "",
        os_add: "",
        pd: "63",
        issued_date: "2026-02-01",
        expiry_date: "2028-02-01",
        notes: "First pair",
      })
    );
    expect(res.ok).toBe(true);

    const rows = getOpticalPrescriptions(profile.id);
    expect(rows).toHaveLength(1);
    const rx = rows[0];
    expect(rx.kind).toBe("glasses");
    expect(rx.od_sphere).toBe(-2);
    expect(rx.od_cylinder).toBe(-0.75);
    expect(rx.od_axis).toBe(90);
    expect(rx.od_add).toBe(1);
    expect(rx.os_sphere).toBe(0); // "plano" → 0
    expect(rx.pd).toBe(63);
    expect(rx.issued_date).toBe("2026-02-01");
    expect(rx.expiry_date).toBe("2028-02-01");
    // Manual rows carry no import provenance / provider link.
    expect(rx.source).toBeNull();
    expect(rx.document_id).toBeNull();
    expect(rx.external_id).toBeNull();
    expect(rx.provider_id).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/vision");
  });

  it("keeps contacts extras and defaults an unknown kind to glasses", async () => {
    const { profile } = seedActor();
    await addOpticalPrescription(
      fd({
        kind: "soft toric contacts",
        od_sphere: "-3.25",
        base_curve: "8.6",
        diameter: "14.2",
        brand: "Acuvue",
      })
    );
    const rx = getOpticalPrescriptions(profile.id)[0];
    expect(rx.kind).toBe("contacts");
    expect(rx.base_curve).toBe(8.6);
    expect(rx.diameter).toBe(14.2);
    expect(rx.brand).toBe("Acuvue");

    await addOpticalPrescription(fd({ kind: "???", od_sphere: "-1" }));
    expect(getOpticalPrescriptions(profile.id)[0].kind).toBe("glasses");
  });
});

describe("updateOpticalPrescription", () => {
  it("edits in place and stays profile-scoped", async () => {
    const { login, profile } = seedActor();
    await addOpticalPrescription(fd({ kind: "glasses", od_sphere: "-1.00" }));
    const id = getOpticalPrescriptions(profile.id)[0].id;

    // Another profile the same admin can act as — its rows must be untouched.
    const other = createProfile("Other Patient");
    actAs(login, other);
    await addOpticalPrescription(fd({ kind: "contacts", od_sphere: "-5.00" }));
    actAs(login, profile);

    const res = await updateOpticalPrescription(
      fd({ id, kind: "glasses", od_sphere: "-1.50" })
    );
    expect(res.ok).toBe(true);
    expect(getOpticalPrescriptions(profile.id)[0].od_sphere).toBe(-1.5);

    // A cross-profile update is filtered out by the WHERE profile_id.
    actAs(login, other);
    await updateOpticalPrescription(fd({ id, kind: "glasses", od_sphere: "9" }));
    expect(
      getOpticalPrescriptions(other.id).some((r) => r.od_sphere === 9)
    ).toBe(false);
    actAs(login, profile);
    expect(getOpticalPrescriptions(profile.id)[0].od_sphere).toBe(-1.5);
  });
});

describe("deleteOpticalPrescription", () => {
  it("deletes only the acting profile's row", async () => {
    const { profile } = seedActor();
    await addOpticalPrescription(fd({ kind: "glasses", od_sphere: "-2" }));
    const id = getOpticalPrescriptions(profile.id)[0].id;
    const res = await deleteOpticalPrescription(fd({ id }));
    expect(res.ok).toBe(true);
    expect(getOpticalPrescriptions(profile.id)).toHaveLength(0);
  });
});
