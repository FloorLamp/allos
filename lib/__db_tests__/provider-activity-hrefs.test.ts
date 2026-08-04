import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  getProviderAppointments,
  getProviderCarePlan,
  getProviderDental,
  getProviderImaging,
  getProviderImmunizations,
  getProviderLabs,
  getProviderMedications,
  getProviderProcedures,
  getProviderSkin,
  getProviderVision,
  getProviderVisits,
} from "@/lib/queries";
import {
  readingDetailHref,
  encounterHref,
  immunizationHref,
  medicationHref,
} from "@/lib/hrefs";

// Provider activity is navigation to the clinical item, never to the file that
// happened to create it. Every fixture deliberately looks document-backed via
// `source`; this catches any future attempt to make provenance override routing.
describe("provider activity domain destinations", () => {
  it("routes every document-backed activity to its item or owning surface", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Provider Hrefs")
        .lastInsertRowid
    );
    const providerId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key)
           VALUES ('Provider Hrefs Clinic', 'organization', 'provider-hrefs-clinic')`
        )
        .run().lastInsertRowid
    );
    const source = "document:424242";

    const visitId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, provider_id, source)
           VALUES (?, '2026-01-01', 'Dental visit', ?, ?)`
        )
        .run(profileId, providerId, source).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, provider_id, source)
       VALUES (?, '2026-01-02', 'lab', 'GLUCOSE', 'Glucose', '90', ?, ?)`
    ).run(profileId, providerId, source);
    const medicationId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, active, obligation, provider_id, source)
           VALUES (?, 'Provider Hrefs Medication', 'medication', 1, 'must', ?, ?)`
        )
        .run(profileId, providerId, source).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO immunizations
         (profile_id, date, vaccine, provider_id, source)
       VALUES (?, '2026-01-03', 'Tdap', ?, ?)`
    ).run(profileId, providerId, source);
    db.prepare(
      `INSERT INTO procedures (profile_id, name, date, provider_id, source)
       VALUES (?, 'Provider Hrefs Procedure', '2026-01-04', ?, ?)`
    ).run(profileId, providerId, source);
    db.prepare(
      `INSERT INTO care_plan_items
         (profile_id, description, planned_date, provider_id, source)
       VALUES (?, 'Provider Hrefs Care Plan', '2026-01-05', ?, ?)`
    ).run(profileId, providerId, source);
    db.prepare(
      `INSERT INTO appointments
         (profile_id, scheduled_at, title, provider_id, source)
       VALUES (?, '2026-01-06 09:00', 'Provider Hrefs Appointment', ?, ?)`
    ).run(profileId, providerId, source);
    db.prepare(
      `INSERT INTO imaging_studies
         (profile_id, modality, body_region, study_date, ordering_provider_id, source)
       VALUES (?, 'mri', 'knee', '2026-01-07', ?, ?)`
    ).run(profileId, providerId, source);
    db.prepare(
      `INSERT INTO optical_prescriptions
         (profile_id, kind, issued_date, provider_id, source)
       VALUES (?, 'glasses', '2026-01-08', ?, ?)`
    ).run(profileId, providerId, source);
    db.prepare(
      `INSERT INTO dental_procedures
         (profile_id, name, procedure_date, provider_id, source)
       VALUES (?, 'Provider Hrefs Filling', '2026-01-09', ?, ?)`
    ).run(profileId, providerId, source);
    db.prepare(
      `INSERT INTO skin_lesions
         (profile_id, label, observed_date, provider_id, source)
       VALUES (?, 'Provider Hrefs Lesion', '2026-01-10', ?, ?)`
    ).run(profileId, providerId, source);

    const destinations = {
      visits: getProviderVisits(profileId, providerId)[0].href,
      labs: getProviderLabs(profileId, providerId)[0].href,
      medications: getProviderMedications(profileId, providerId)[0].href,
      immunizations: getProviderImmunizations(profileId, providerId)[0].href,
      procedures: getProviderProcedures(profileId, providerId)[0].href,
      carePlan: getProviderCarePlan(profileId, providerId)[0].href,
      appointments: getProviderAppointments(profileId, providerId)[0].href,
      imaging: getProviderImaging(profileId, providerId)[0].href,
      vision: getProviderVision(profileId, providerId)[0].href,
      dental: getProviderDental(profileId, providerId)[0].href,
      skin: getProviderSkin(profileId, providerId)[0].href,
    };

    expect(destinations).toEqual({
      visits: encounterHref(visitId),
      labs: readingDetailHref("Glucose", "GLUCOSE"),
      medications: medicationHref(medicationId),
      immunizations: immunizationHref("Tdap"),
      procedures: "/records/history/procedures",
      carePlan: "/records/care/overview#care-plan",
      appointments: "/records/history/visits",
      imaging: "/results/imaging",
      vision: "/records/specialty/vision",
      dental: "/records/specialty/dental",
      skin: "/records/specialty/skin",
    });
    expect(
      Object.values(destinations).some((href) => href.startsWith("/import/"))
    ).toBe(false);
  });
});
