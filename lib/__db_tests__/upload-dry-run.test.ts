// DB INTEGRATION TIER — the upload dry run answers what an upload would do and writes
// nothing. SYNTHETIC ONLY: fictional names, deep-past dates.

import { describe, expect, it, vi } from "vitest";

// Stub only the extractor, so a model call would be visible.
vi.mock("@/lib/medical-extract", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/medical-extract")>();
  return { ...actual, extractMedicalDocument: vi.fn() };
});

import { rawDb as db } from "@/lib/db";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { dryRunMedicalUpload } from "@/lib/medical-pipeline/dry-run";
import { extractMedicalDocument } from "@/lib/medical-extract";
import { seedActor } from "@/lib/__action_tests__/harness";

function encounter(ext: string, day: string): string {
  return `<entry><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="1.2.3.4" extension="${ext}"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <effectiveTime><low value="${day}"/></effectiveTime>
    </encounter></entry>`;
}

// A CCD with the given visits. `stamp` changes the bytes without changing the visits.
function ccd(stamp: string, visits: [string, string][]): File {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="${stamp}"/>
  <effectiveTime value="${stamp}"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Encounters</title>
      ${visits.map(([ext, day]) => encounter(ext, day)).join("\n")}
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
  return new File([Buffer.from(xml)], `ccd-${stamp}.xml`, {
    type: "application/xml",
  });
}

const VISITS: [string, string][] = [
  ["900001", "20190402"],
  ["900002", "20190815"],
  ["900003", "20191001"],
];

function counts(profileId: number) {
  const n = (sql: string) =>
    (db.prepare(sql).get(profileId) as { n: number }).n;
  return {
    docs: n("SELECT COUNT(*) AS n FROM medical_documents WHERE profile_id = ?"),
    jobs: n("SELECT COUNT(*) AS n FROM import_jobs WHERE profile_id = ?"),
    encounters: n("SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ?"),
  };
}

function seed() {
  const { login, profile } = seedActor({ profileName: "Robin" });
  const target = { id: profile.id, name: "Robin", decidedBy: "test" };
  const readable = [{ id: profile.id, name: "Robin" }];
  return { login, profile, target, readable };
}

describe("upload dry run", () => {
  it("reports a duplicate and writes nothing", async () => {
    const { login, profile, target, readable } = seed();
    const first = await ingestMedicalUpload(
      login.id,
      profile.id,
      ccd("20260101", VISITS)
    );
    const before = counts(profile.id);

    const report = await dryRunMedicalUpload(
      target,
      ccd("20260101", VISITS),
      readable
    );

    expect(report.verdict).toBe("duplicate");
    expect(report.duplicates).toEqual([
      {
        id: first.docId,
        filename: "ccd-20260101.xml",
        profile: { id: profile.id, name: "Robin" },
      },
    ]);
    expect(counts(profile.id)).toEqual(before);
  });

  it("calls a CCD whose visits are all present covered", async () => {
    const { login, profile, target, readable } = seed();
    await ingestMedicalUpload(login.id, profile.id, ccd("20260101", VISITS));

    // Different bytes, two of the same visits: not a byte or records duplicate.
    const report = await dryRunMedicalUpload(
      target,
      ccd("20260714", VISITS.slice(0, 2)),
      readable
    );

    expect(report.verdict).toBe("covered");
    expect(report.records).toEqual([
      {
        member: "ccd-20260714.xml",
        patient: "Robin Sample",
        birthdate: null,
        visits: [
          { date: "2019-04-02", type: null, status: "covered" },
          { date: "2019-08-15", type: null, status: "covered" },
        ],
      },
    ]);
  });

  it("lists a visit allos does not have as new", async () => {
    const { login, profile, target, readable } = seed();
    await ingestMedicalUpload(login.id, profile.id, ccd("20260101", VISITS));
    const before = counts(profile.id);

    const report = await dryRunMedicalUpload(
      target,
      ccd("20260714", [...VISITS, ["900004", "20191220"]]),
      readable
    );

    expect(report.verdict).toBe("would-import");
    expect(report.records[0].visits.map((v) => [v.date, v.status])).toEqual([
      ["2019-04-02", "covered"],
      ["2019-08-15", "covered"],
      ["2019-10-01", "covered"],
      ["2019-12-20", "new"],
    ]);
    expect(counts(profile.id)).toEqual(before);
  });

  it("says a PDF would be extracted, without calling the model", async () => {
    const { profile, target, readable } = seed();
    const pdf = new File(
      [Buffer.from("%PDF-1.4\n% allos dry run\n%%EOF\n")],
      "labs.pdf",
      { type: "application/pdf" }
    );

    const report = await dryRunMedicalUpload(target, pdf, readable);

    expect(report.verdict).toBe("would-extract");
    expect(vi.mocked(extractMedicalDocument)).not.toHaveBeenCalled();
    expect(counts(profile.id)).toEqual({ docs: 0, jobs: 0, encounters: 0 });
  });
});
