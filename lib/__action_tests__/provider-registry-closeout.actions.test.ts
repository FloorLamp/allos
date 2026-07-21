// SERVER-ACTION TIER — the provider-domain closeout registry actions
// (#1056/#1057/#1058/#1055). All are GLOBAL (admin-gated) registry mutations driven
// through the mocked requireAdmin() boundary: the identity edit now carries specialty
// + sets the contact edit-lock (#1058), archive/unarchive (#1057), and the affiliation
// link/accept/decline/unlink (#1055).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  updateProviderAction,
  setProviderArchivedAction,
  linkAffiliationAction,
  acceptAffiliationAction,
  declineAffiliationAction,
  unlinkAffiliationAction,
} from "@/app/(app)/providers/actions";
import { getProvider, getAffiliatesFor } from "@/lib/queries";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function newProvider(
  name: string,
  type: "individual" | "organization",
  dedup: string
): number {
  return Number(
    db
      .prepare(`INSERT INTO providers (name, type, dedup_key) VALUES (?, ?, ?)`)
      .run(name, type, dedup).lastInsertRowid
  );
}

function row(id: number) {
  return db
    .prepare(
      `SELECT specialty, specialty_code, archived, contact_edited, phone
         FROM providers WHERE id = ?`
    )
    .get(id) as {
    specialty: string | null;
    specialty_code: string | null;
    archived: number;
    contact_edited: number;
    phone: string | null;
  };
}

describe("updateProviderAction — specialty + contact edit-lock (#1056/#1058)", () => {
  it("saves specialty and sets contact_edited when a contact is supplied", async () => {
    seedActor(); // admin
    const id = newProvider(
      "Dr. Edit Test",
      "individual",
      `edit-${Math.random()}`
    );
    const res = await updateProviderAction(
      fd({
        id,
        name: "Dr. Edit Test",
        type: "individual",
        specialty: "Cardiology",
        specialty_code: "207RC0000X",
        phone: "(555) 010-2222",
      })
    );
    expect(res.error).toBeUndefined();
    const r = row(id);
    expect(r.specialty).toBe("Cardiology");
    expect(r.specialty_code).toBe("207RC0000X");
    expect(r.contact_edited).toBe(1); // the lock is set
    expect(r.phone).toBe("(555) 010-2222");
  });

  it("does not lock contact when no phone/address is supplied", async () => {
    seedActor();
    const id = newProvider(
      "Dr. No Contact",
      "individual",
      `nc-${Math.random()}`
    );
    await updateProviderAction(
      fd({
        id,
        name: "Dr. No Contact",
        type: "individual",
        specialty: "Neurology",
      })
    );
    expect(row(id).contact_edited).toBe(0);
  });
});

describe("setProviderArchivedAction (#1057)", () => {
  it("archives then un-archives a provider", async () => {
    seedActor();
    const id = newProvider(
      "Old Clinic",
      "organization",
      `arc-${Math.random()}`
    );
    await setProviderArchivedAction(fd({ id, archived: "1" }));
    expect(getProvider(id)!.archived).toBe(1);
    await setProviderArchivedAction(fd({ id, archived: "0" }));
    expect(getProvider(id)!.archived).toBe(0);
  });
});

describe("affiliation actions (#1055)", () => {
  it("links, accepts, declines, and unlinks an individual↔org edge", async () => {
    seedActor();
    const chen = newProvider("Dr. Chen", "individual", `chen-${Math.random()}`);
    const east = newProvider(
      "Sample Care East",
      "organization",
      `east-${Math.random()}`
    );

    // Manual link from Dr. Chen's card, picking the org by name.
    const res = await linkAffiliationAction(
      fd({
        id: chen,
        name: "Sample Care East",
        counterpart_type: "organization",
      })
    );
    expect(res.error).toBeUndefined();
    expect(getAffiliatesFor(chen, "individual").map((a) => a.id)).toContain(
      east
    );
    // And the reverse view ("People:" on the org).
    expect(getAffiliatesFor(east, "organization").map((a) => a.id)).toContain(
      chen
    );

    // Unlink removes the edge.
    await unlinkAffiliationAction(fd({ id: chen, other_id: east }));
    expect(getAffiliatesFor(chen, "individual")).toHaveLength(0);

    // Decline a suggestion (remembered), then accept re-links.
    await declineAffiliationAction(
      fd({ individual_id: chen, organization_id: east })
    );
    const declined = db
      .prepare(
        `SELECT status FROM provider_affiliations WHERE individual_id = ? AND organization_id = ?`
      )
      .get(chen, east) as { status: string };
    expect(declined.status).toBe("declined");

    await acceptAffiliationAction(
      fd({ individual_id: chen, organization_id: east })
    );
    expect(getAffiliatesFor(chen, "individual").map((a) => a.id)).toContain(
      east
    );
  });

  it("refuses a same-type pair (individual↔individual)", async () => {
    seedActor();
    const a = newProvider("Dr. A", "individual", `a-${Math.random()}`);
    const b = newProvider("Dr. B", "individual", `b-${Math.random()}`);
    const res = await linkAffiliationAction(
      fd({ id: a, name: "Dr. B", counterpart_type: "individual" })
    );
    expect(res.error).toBeTruthy();
    expect(getAffiliatesFor(a, "individual")).toHaveLength(0);
    expect(b).toBeTruthy();
  });
});
