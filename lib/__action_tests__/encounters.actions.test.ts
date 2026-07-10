// SERVER-ACTION TIER — visit / encounter write path. Exercises
// add/update/delete against a real (temp) SQLite handle to prove every mutation is
// profile-scoped (no cross-profile bleed), that the provider + facility resolve
// through the shared registry, and that editing never disturbs an imported row's
// provenance columns (source/document_id/external_id/class_code). The static
// source scan (lib/__tests__/profile-scoping.test.ts) can't see across the action
// boundary; this is the dynamic guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addEncounter,
  updateEncounter,
  deleteEncounter,
} from "@/app/(app)/encounters/actions";
import { getEncounters } from "@/lib/queries";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// Insert an imported-style encounter directly (source/document_id/external_id set),
// bypassing the action, to model a CCD-imported row.
function importedEncounter(profileId: number, date: string): number {
  // The row cites medical document #7 as its import provenance. Now that
  // encounters.document_id carries an enforced FK (issue #95), that document must
  // exist — create it idempotently so repeated calls across tests don't collide.
  db.prepare(
    `INSERT OR IGNORE INTO medical_documents (id, profile_id, filename, stored_path)
       VALUES (7, ?, 'ccd.xml', 'data/uploads/medical/ccd.xml')`
  ).run(profileId);
  return Number(
    db
      .prepare(
        `INSERT INTO encounters
           (profile_id, date, type, class_code, reason, diagnoses,
            notes, source, document_id, external_id)
         VALUES (?, ?, 'Office Visit', 'AMB', 'Cough', 'Bronchitis',
                 NULL, 'document:7', 7, 'ext-abc')`
      )
      .run(profileId, date).lastInsertRowid
  );
}

beforeEach(() => revalidate.mockClear());

describe("addEncounter", () => {
  it("stores a profile-scoped visit and resolves provider + facility names", async () => {
    const { profile } = seedActor();
    await addEncounter(
      fd({
        date: "2025-03-01",
        end_date: "2025-03-03",
        type: "Hospitalization",
        reason: "Chest pain",
        diagnoses: "Angina; Hypertension",
        provider: "Dr. Smith",
        location: "Example Medical Center",
        notes: "Discharged stable",
      })
    );

    const rows = getEncounters(profile.id);
    expect(rows).toHaveLength(1);
    const e = rows[0];
    expect(e.date).toBe("2025-03-01");
    expect(e.end_date).toBe("2025-03-03");
    expect(e.type).toBe("Hospitalization");
    expect(e.reason).toBe("Chest pain");
    expect(e.diagnoses).toBe("Angina; Hypertension");
    // Names come back through the providers-registry JOIN.
    expect(e.provider_name).toBe("Dr. Smith");
    expect(e.location_name).toBe("Example Medical Center");
    // Manual rows carry NULL provenance so the import delete-set never touches them.
    expect(e.source).toBeNull();
    expect(e.document_id).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/encounters");
  });

  it("rejects a missing or impossible date", async () => {
    const { profile } = seedActor();
    await addEncounter(fd({ type: "Office Visit" }));
    await addEncounter(fd({ date: "not-a-date", type: "Office Visit" }));
    expect(getEncounters(profile.id)).toHaveLength(0);
  });
});

describe("updateEncounter", () => {
  it("edits the acting profile's row and preserves imported provenance", async () => {
    const { profile } = seedActor();
    const id = importedEncounter(profile.id, "2024-01-10");

    await updateEncounter(
      fd({
        id,
        date: "2024-01-11",
        type: "Follow-up",
        reason: "Recheck",
        diagnoses: "Resolved",
      })
    );

    const e = getEncounters(profile.id).find((r) => r.id === id)!;
    expect(e.date).toBe("2024-01-11");
    expect(e.type).toBe("Follow-up");
    expect(e.reason).toBe("Recheck");
    // The update statement never touches source/document_id/external_id/class_code,
    // so an imported row keeps its provenance after a manual edit.
    expect(e.source).toBe("document:7");
    expect(e.document_id).toBe(7);
    expect(e.external_id).toBe("ext-abc");
    expect(e.class_code).toBe("AMB");
  });

  it("cannot edit another profile's visit (scoped WHERE)", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("EncB", login.id);
    const bId = importedEncounter(profileB.id, "2024-05-05");

    actAs(login, profileA);
    await updateEncounter(fd({ id: bId, date: "2000-01-01", type: "Hacked" }));

    // Profile B's row is untouched.
    const b = getEncounters(profileB.id).find((r) => r.id === bId)!;
    expect(b.date).toBe("2024-05-05");
    expect(b.type).toBe("Office Visit");
  });
});

describe("deleteEncounter", () => {
  it("deletes only the acting profile's row", async () => {
    const { profile } = seedActor();
    await addEncounter(fd({ date: "2025-02-02", type: "Office Visit" }));
    const id = getEncounters(profile.id)[0].id;
    await deleteEncounter(fd({ id }));
    expect(getEncounters(profile.id)).toHaveLength(0);
  });

  it("cannot delete another profile's visit", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("EncDelB", login.id);
    const bId = importedEncounter(profileB.id, "2023-09-09");

    actAs(login, profileA);
    await deleteEncounter(fd({ id: bId }));

    // Still there — the DELETE's profile_id guard spared it.
    expect(getEncounters(profileB.id).some((r) => r.id === bId)).toBe(true);
  });
});
