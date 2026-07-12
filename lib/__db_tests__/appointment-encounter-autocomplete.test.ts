// DB INTEGRATION TIER — import auto-complete of the appointment → encounter loop
// (issue #288). When a document import lands an encounter that matches a still-
// scheduled appointment (same profile + same calendar day + same provider_id),
// persistDocumentImport marks the appointment completed, links it
// (appointments.encounter_id), and — when the appointment's kind maps to a single
// preventive rule — records the satisfaction so the preventive loop closes end-to-
// end with zero manual steps. This exercises the real persist path + schema against
// the throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { persistDocumentImport } from "@/lib/import-persist";
import { resolveProviderId } from "@/lib/providers-db";
import { cleanProviderInput } from "@/lib/providers";
import { getAppointments, getEncounters } from "@/lib/queries";
import type { PersistInput, PersistEncounter } from "@/lib/import-shape";
import type { ImportedProvider } from "@/lib/health-import";

const DATE = "2026-03-10";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'visit.xml', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

function provider(name: string): ImportedProvider {
  return {
    name,
    type: "individual",
    npi: null,
    identifier: null,
    phone: null,
    address: null,
  };
}

const PROVIDER = provider("Dr. Ada Testwell");

// A scheduled appointment linked to `p` — resolved through the SAME registry path
// the import uses (resolveProviderId over the cleaned input), so the appointment's
// provider_id equals the id the imported encounter's provider resolves to.
function scheduleAppointment(
  profileId: number,
  p: ImportedProvider,
  kind: string | null
): number {
  const providerId = resolveProviderId(cleanProviderInput(p)!);
  return Number(
    db
      .prepare(
        `INSERT INTO appointments
           (profile_id, scheduled_at, provider_id, title, kind, status)
         VALUES (?, ?, ?, 'Annual physical', ?, 'scheduled')`
      )
      .run(profileId, DATE, providerId, kind).lastInsertRowid
  );
}

// A minimal CCD-style import carrying ONE office-visit encounter attended by
// PROVIDER on DATE. `providerOverride` lets a test point the encounter at a
// different clinician (the conservative "different provider ≠ match" case).
function visitInput(
  encounterProvider: ImportedProvider | null = PROVIDER
): PersistInput {
  const encounter: PersistEncounter = {
    date: DATE,
    end_date: null,
    type: "Office Visit",
    class_code: "AMB",
    reason: "Annual physical",
    diagnoses: [],
    provider: encounterProvider,
    location: null,
    notes: null,
    external_id: "encounter:1",
  };
  return {
    records: [],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [encounter],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: DATE,
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

describe("import auto-complete (#288)", () => {
  let profileId: number;
  beforeEach(() => {
    profileId = newProfile(`AC-${Math.random().toString(36).slice(2)}`);
  });

  it("completes + links a matching appointment and satisfies its preventive rule", () => {
    const apptId = scheduleAppointment(profileId, PROVIDER, "physical");
    const doc = newDocument(profileId);

    persistDocumentImport(profileId, doc, visitInput());

    const enc = getEncounters(profileId);
    expect(enc).toHaveLength(1);
    const encId = enc[0].id;

    const appt = getAppointments(profileId).find((a) => a.id === apptId)!;
    expect(appt.status).toBe("completed");
    expect(appt.encounter_id).toBe(encId);

    // The preventive loop closed with zero manual steps: kind 'physical' →
    // adult_physical, recorded on the visit day via the appointment source.
    const ev = db
      .prepare(
        `SELECT date, source FROM preventive_events
           WHERE profile_id = ? AND rule_key = 'adult_physical'`
      )
      .get(profileId) as { date: string; source: string } | undefined;
    expect(ev).toEqual({ date: DATE, source: "appointment" });
  });

  it("does NOT match a same-day appointment with a different provider", () => {
    const apptId = scheduleAppointment(
      profileId,
      provider("Dr. Someone Else"),
      "physical"
    );
    const doc = newDocument(profileId);

    persistDocumentImport(profileId, doc, visitInput());

    const appt = getAppointments(profileId).find((a) => a.id === apptId)!;
    expect(appt.status).toBe("scheduled");
    expect(appt.encounter_id).toBeNull();
  });

  it("does NOT match when the encounter carries no provider (conservative)", () => {
    const apptId = scheduleAppointment(profileId, PROVIDER, "physical");
    const doc = newDocument(profileId);

    persistDocumentImport(profileId, doc, visitInput(null));

    const appt = getAppointments(profileId).find((a) => a.id === apptId)!;
    expect(appt.status).toBe("scheduled");
    expect(appt.encounter_id).toBeNull();
  });

  it("completes + links but records NO preventive event for an ambiguous kind", () => {
    // 'screening' maps to no single rule, so no satisfaction is auto-recorded —
    // the link + completion still happen.
    const apptId = scheduleAppointment(profileId, PROVIDER, "screening");
    const doc = newDocument(profileId);

    persistDocumentImport(profileId, doc, visitInput());

    const appt = getAppointments(profileId).find((a) => a.id === apptId)!;
    expect(appt.status).toBe("completed");
    expect(appt.encounter_id).not.toBeNull();
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM preventive_events WHERE profile_id = ?"
      )
      .get(profileId) as { n: number };
    expect(count.n).toBe(0);
  });

  it("deleting the linked encounter's document nulls the appointment link (row-ops)", () => {
    const apptId = scheduleAppointment(profileId, PROVIDER, "physical");
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, visitInput());
    expect(
      getAppointments(profileId).find((a) => a.id === apptId)!.encounter_id
    ).not.toBeNull();

    // Reprocess with an EMPTY encounter set clears the imported encounter (the
    // clearImportedDocumentRows path). The manual appointment survives, unlinked,
    // rather than tripping the encounter_id FK.
    const empty = visitInput();
    empty.encounters = [];
    persistDocumentImport(profileId, doc, empty);

    expect(getEncounters(profileId)).toHaveLength(0);
    const appt = getAppointments(profileId).find((a) => a.id === apptId)!;
    expect(appt.encounter_id).toBeNull();
    // The completion recorded on the first import stands (a fact about the visit).
    expect(appt.status).toBe("completed");
  });
});
