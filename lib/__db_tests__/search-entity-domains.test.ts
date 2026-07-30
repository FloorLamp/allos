// DB INTEGRATION TIER — the second-generation entity domains in global search (#1595).
//
// Search stopped at the domain set #19 shipped, so nine entity domains the app grew
// afterwards were invisible to both the palette and grounded record Q&A (which
// retrieves SOLELY through this fan-out). These tests exercise each new reader against
// a realistic fixture and pin the four things only a live schema can prove:
//
//   1. the row is REACHABLE by the words a person would type (a modality, a gene, a
//      tooth number, a body region, an outcome note, a gear category);
//   2. it never leaks ACROSS PROFILES (each reader filters profile_id — and providers,
//      whose registry is global, are scoped through this profile's record links);
//   3. the domain's own IDENTITY collapse is honored: one hit per skin lesion (#482),
//      one per practice identity (#1591), not one per stored row;
//   4. the fan-out and the Q&A retrieval share the readers, so a question can cite
//      an imaging study / dental record / protocol.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic,
// clearly fictional fixtures only (no PHI).

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { retrieveRecordCitations, searchAll } from "@/lib/queries";
import {
  getProviderActivityTotal,
  getProviderRecordCounts,
} from "@/lib/queries/providers";
import type { SearchDomain, SearchHit } from "@/lib/search-rank";

let mine = 0;
let other = 0;
let clinicId = 0;
let dupSmithA = 0;
let dupSmithB = 0;
let episodeId = 0;
let protocolId = 0;
let equipmentId = 0;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newProvider(input: {
  name: string;
  type?: string;
  specialty?: string | null;
  npi?: string | null;
  address?: string | null;
  dedupKey: string;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, specialty, npi, address, dedup_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.type ?? "individual",
        input.specialty ?? null,
        input.npi ?? null,
        input.address ?? null,
        input.dedupKey
      ).lastInsertRowid
  );
}

// All hits of one domain for a query, as the palette would render them.
function hits(
  profileId: number,
  query: string,
  domain: SearchDomain
): SearchHit[] {
  return (
    searchAll(profileId, query).find((g) => g.domain === domain)?.hits ?? []
  );
}

function titles(
  profileId: number,
  query: string,
  domain: SearchDomain
): string[] {
  return hits(profileId, query, domain).map((h) => h.title);
}

beforeAll(() => {
  mine = newProfile("SEARCHDOM-MINE");
  other = newProfile("SEARCHDOM-OTHER");

  // ── Providers: a clinic this profile has seen, a clinician only the OTHER
  // profile has seen, and two same-named clinicians (the disambiguation case).
  clinicId = newProvider({
    name: "Northgate Imaging Center",
    type: "organization",
    specialty: "Radiology",
    npi: "4041110001",
    dedupKey: "searchdom-northgate",
  });
  const unseenId = newProvider({
    name: "Northgate Sleep Lab",
    type: "organization",
    dedupKey: "searchdom-unseen",
  });
  dupSmithA = newProvider({
    name: "Robin Quailfeather",
    specialty: "Dermatology",
    npi: "4042220002",
    dedupKey: "searchdom-quail-a",
  });
  dupSmithB = newProvider({
    name: "Robin Quailfeather",
    specialty: "Dentistry",
    npi: "4043330003",
    dedupKey: "searchdom-quail-b",
  });

  // ── Imaging: two studies of the SAME modality + region on different dates, so
  // only their dates tell them apart; one belongs to the other profile.
  db.prepare(
    `INSERT INTO imaging_studies
       (profile_id, modality, body_region, laterality, study_date, impression,
        ordering_provider_id)
     VALUES (?, 'mri', 'Knee', 'left', '2026-02-11', 'No meniscal tear.', ?)`
  ).run(mine, clinicId);
  db.prepare(
    `INSERT INTO imaging_studies
       (profile_id, modality, body_region, laterality, study_date, impression)
     VALUES (?, 'mri', 'Knee', 'left', '2024-09-02', 'Mild joint effusion.')`
  ).run(mine);
  db.prepare(
    `INSERT INTO imaging_studies
       (profile_id, modality, body_region, study_date, impression)
     VALUES (?, 'mri', 'Shoulder', '2026-01-05', 'Other profile study.')`
  ).run(other);

  // ── Genomics.
  db.prepare(
    `INSERT INTO genomic_variants
       (profile_id, gene, star_allele, result_type, source_lab, report_date)
     VALUES (?, 'CYP2C19', '*2/*17', 'pharmacogenomic', 'Lakeside Genetics', '2025-11-04')`
  ).run(mine);
  db.prepare(
    `INSERT INTO genomic_variants (profile_id, gene, result_type)
     VALUES (?, 'CYP2C19', 'pharmacogenomic')`
  ).run(other);

  // ── Dental: a completed filling on tooth 14 and a planned crown, both with the
  // dentist attached.
  db.prepare(
    `INSERT INTO dental_procedures
       (profile_id, name, status, tooth, surface, procedure_date, provider_id)
     VALUES (?, 'Composite filling', 'completed', '14', 'MOD', '2026-01-20', ?)`
  ).run(mine, dupSmithB);
  db.prepare(
    `INSERT INTO dental_procedures
       (profile_id, name, status, tooth, procedure_date, provider_id)
     VALUES (?, 'Crown', 'completed', '30', '2026-03-02', ?)`
  ).run(mine, dupSmithB);

  // ── Skin: THREE serial observations of ONE lesion (same identity), plus a second
  // lesion on the same region but the other side.
  for (const [date, size] of [
    ["2025-08-01", 3],
    ["2026-01-15", 4],
    ["2026-05-06", 4],
  ] as const) {
    db.prepare(
      `INSERT INTO skin_lesions
         (profile_id, label, body_region, body_side, size_mm, status, observed_date,
          provider_id)
       VALUES (?, 'Freckled mole', 'forearm', 'left', ?, 'watch', ?, ?)`
    ).run(mine, size, date, dupSmithA);
  }
  db.prepare(
    `INSERT INTO skin_lesions
       (profile_id, body_region, body_side, size_mm, status, observed_date)
     VALUES (?, 'forearm', 'right', 9, 'active', '2026-04-04')`
  ).run(mine);
  db.prepare(
    `INSERT INTO skin_lesions
       (profile_id, label, body_region, body_side, status, observed_date)
     VALUES (?, 'Freckled mole', 'forearm', 'left', 'active', '2026-02-02')`
  ).run(other);

  // ── Illness episodes: one closed with an outcome note, one still open.
  episodeId = Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at, outcome)
         VALUES (?, 'Winter flu', '2026-03-01', '2026-03-08', 'Resolved without antibiotics')`
      )
      .run(mine).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at)
     VALUES (?, 'Winter flu', '2026-06-20')`
  ).run(other);

  // ── Protocols.
  protocolId = Number(
    db
      .prepare(
        `INSERT INTO protocols (profile_id, name, start_date, end_date, notes)
         VALUES (?, 'Sauna block', '2026-03-01', '2026-04-15', 'Four sessions a week')`
      )
      .run(mine).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO protocols (profile_id, name, start_date)
     VALUES (?, 'Sauna block', '2026-05-01')`
  ).run(other);

  // ── Wellness practices: a target plus logs under TWO spellings of one identity,
  // and a logs-only practice with no target at all.
  // scope_identity is required for a practice target (a DB trigger enforces it);
  // it carries the same folded identity the read layer groups on.
  db.prepare(
    `INSERT INTO frequency_targets
       (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
     VALUES (?, 'practice', 'Cold plunge', 'cold plunge', 3, 5)`
  ).run(mine);
  for (const [practice, date] of [
    ["Cold plunge", "2026-07-01"],
    ["cold  plunge", "2026-07-02"],
  ] as const) {
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, ?, ?)`
    ).run(mine, practice, date);
  }
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date)
     VALUES (?, 'Breathwork', '2026-07-03')`
  ).run(mine);
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date)
     VALUES (?, 'Cold plunge', '2026-07-04')`
  ).run(other);

  // ── Equipment: an active bar and a retired bike.
  equipmentId = Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Trap bar', 'Barbell')`
      )
      .run(mine).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO equipment (profile_id, name, category, retired)
     VALUES (?, 'Old road bike', 'Bike', 1)`
  ).run(mine);
  db.prepare(
    `INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Trap bar', 'Barbell')`
  ).run(other);

  // Link the unseen provider to the OTHER profile only, so "seen by somebody" and
  // "seen by ME" are genuinely different sets.
  db.prepare(
    `INSERT INTO encounters (profile_id, date, type, provider_id)
     VALUES (?, '2026-02-02', 'Sleep study', ?)`
  ).run(other, unseenId);
  db.prepare(
    `INSERT INTO encounters (profile_id, date, type, provider_id)
     VALUES (?, '2026-02-11', 'Imaging visit', ?)`
  ).run(mine, clinicId);
});

describe("providers are searchable as entities (#1055/#1595)", () => {
  it("finds a provider this profile's records name, by name and by specialty", () => {
    expect(titles(mine, "Northgate Imaging", "provider")).toContain(
      "Northgate Imaging Center"
    );
    expect(titles(mine, "Radiology", "provider")).toContain(
      "Northgate Imaging Center"
    );
  });

  it("deep-links the provider's registry page and counts THIS profile's records", () => {
    const hit = hits(mine, "Northgate Imaging", "provider")[0];
    expect(hit.href).toBe(`/providers/${clinicId}`);
    expect(hit.subtitle).toContain("Radiology");
    expect(hit.subtitle).toMatch(/\d+ records?/);
  });

  it("never surfaces a provider only ANOTHER profile has seen", () => {
    // The registry row exists and matches the query — it is excluded because THIS
    // profile's records never name it.
    expect(titles(mine, "Northgate", "provider")).not.toContain(
      "Northgate Sleep Lab"
    );
    expect(titles(other, "Northgate", "provider")).toContain(
      "Northgate Sleep Lab"
    );
    expect(titles(other, "Northgate", "provider")).not.toContain(
      "Northgate Imaging Center"
    );
  });

  it("disambiguates two same-named providers in the label", () => {
    const found = hits(mine, "Quailfeather", "provider");
    expect(found).toHaveLength(2);
    const subtitles = found.map((h) => h.subtitle ?? "");
    expect(subtitles.some((s) => s.includes("NPI 4042220002"))).toBe(true);
    expect(subtitles.some((s) => s.includes("NPI 4043330003"))).toBe(true);
    expect(found.map((h) => h.href)).toEqual(
      expect.arrayContaining([
        `/providers/${dupSmithA}`,
        `/providers/${dupSmithB}`,
      ])
    );
  });

  it("agrees with the directory's own per-provider activity total", () => {
    const counts = new Map(
      getProviderRecordCounts(mine).map((c) => [c.providerId, c.records])
    );
    for (const id of [clinicId, dupSmithA, dupSmithB]) {
      expect(counts.get(id) ?? 0).toBe(getProviderActivityTotal(mine, id));
    }
  });
});

describe("imaging studies are searchable (#702/#1595)", () => {
  it("finds a study by modality, region, and impression text", () => {
    expect(titles(mine, "MRI", "imaging").length).toBeGreaterThan(0);
    expect(titles(mine, "knee", "imaging")).toContain("MRI Left Knee");
    expect(titles(mine, "meniscal", "imaging")).toContain("MRI Left Knee");
  });

  it("tells two studies of the same modality and region apart by date", () => {
    const found = hits(mine, "knee", "imaging");
    expect(found).toHaveLength(2);
    expect(found.map((h) => h.date)).toEqual(["2026-02-11", "2024-09-02"]);
    expect(found[0].href).toBe("/results/imaging");
  });

  it("stays inside the profile", () => {
    expect(titles(mine, "Other profile study", "imaging")).toEqual([]);
    expect(titles(other, "Shoulder", "imaging")).toHaveLength(1);
  });
});

describe("genomic variants are searchable (#709/#1595)", () => {
  it("finds a variant by gene, call, and lab", () => {
    expect(titles(mine, "CYP2C19", "genomic")).toContain("CYP2C19 *2/*17");
    expect(titles(mine, "*2/*17", "genomic")).toContain("CYP2C19 *2/*17");
    expect(titles(mine, "Lakeside", "genomic")).toContain("CYP2C19 *2/*17");
  });

  it("lands on Results › Genomics and is profile-scoped", () => {
    expect(hits(mine, "Lakeside", "genomic")[0].href).toBe("/results/genomics");
    expect(titles(other, "Lakeside", "genomic")).toEqual([]);
  });
});

describe("dental records are searchable (#705/#1595)", () => {
  it("finds a procedure by name and by the tooth as typed", () => {
    expect(titles(mine, "Composite", "dental")).toContain(
      "Composite filling · #14 MOD"
    );
    expect(titles(mine, "14", "dental")).toContain(
      "Composite filling · #14 MOD"
    );
  });

  it("lands on the Dental pane and is profile-scoped", () => {
    expect(hits(mine, "Composite", "dental")[0].href).toBe(
      "/records/specialty/dental"
    );
    expect(titles(other, "Composite", "dental")).toEqual([]);
  });
});

describe("skin lesions are searchable, ONE hit per lesion (#715/#482)", () => {
  it("collapses serial observations of the same mole into one hit", () => {
    const found = hits(mine, "Freckled mole", "skin");
    expect(found).toHaveLength(1);
    expect(found[0].subtitle).toContain("3 observations");
    // The NEWEST observation heads the group, exactly as the Skin list shows it.
    expect(found[0].date).toBe("2026-05-06");
    expect(found[0].href).toBe("/records/specialty/skin");
  });

  it("keeps two lesions on the same region apart and labels the difference", () => {
    const found = hits(mine, "forearm", "skin");
    expect(found).toHaveLength(2);
    const subtitles = found.map((h) => h.subtitle ?? "").join(" | ");
    expect(subtitles).toContain("Left forearm");
    expect(subtitles).toContain("Right forearm");
    expect(new Set(found.map((h) => h.key)).size).toBe(2);
  });

  it("never reaches another profile's lesion", () => {
    expect(hits(other, "Freckled mole", "skin")).toHaveLength(1);
    expect(hits(other, "forearm", "skin")).toHaveLength(1);
  });
});

describe("illness episodes are searchable (#856/#1595)", () => {
  it("finds an episode by situation and by its outcome note, deep-linking the detail page", () => {
    const found = hits(mine, "Winter flu", "episode");
    expect(found).toHaveLength(1);
    expect(found[0].href).toBe(`/medical/episodes/${episodeId}`);
    // ended_at is the EXCLUSIVE first inactive day, so the label ends on the 7th.
    expect(found[0].subtitle).toContain("2026-03-01 → 2026-03-07");
    expect(titles(mine, "antibiotics", "episode")).toContain("Winter flu");
  });

  it("stays inside the profile", () => {
    const theirs = hits(other, "Winter flu", "episode");
    expect(theirs).toHaveLength(1);
    expect(theirs[0].href).not.toBe(`/medical/episodes/${episodeId}`);
    expect(theirs[0].subtitle).toContain("Ongoing");
  });
});

describe("protocols are searchable (#344/#1595)", () => {
  it("finds a protocol by name and notes and deep-links its detail page", () => {
    const found = hits(mine, "Sauna block", "protocol");
    expect(found).toHaveLength(1);
    expect(found[0].href).toBe(`/protocols/${protocolId}`);
    // end_date is INCLUSIVE for a protocol — the label ends on the stored day.
    expect(found[0].subtitle).toContain("2026-03-01 → 2026-04-15");
    expect(titles(mine, "sessions a week", "protocol")).toContain(
      "Sauna block"
    );
  });

  it("stays inside the profile", () => {
    expect(hits(other, "Sauna block", "protocol")[0].href).not.toBe(
      `/protocols/${protocolId}`
    );
  });
});

describe("wellness practices are searchable, ONE hit per identity (#1591/#1595)", () => {
  it("folds spellings of one practice into a single hit with its cadence", () => {
    const found = hits(mine, "Cold plunge", "practice");
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("Cold plunge");
    expect(found[0].subtitle).toContain("3–5×/week");
    expect(found[0].subtitle).toContain("2 sessions");
    expect(found[0].date).toBe("2026-07-02");
    expect(found[0].href).toBe("/wellness");
  });

  it("finds a logs-only practice that has no weekly target", () => {
    const found = hits(mine, "Breathwork", "practice");
    expect(found).toHaveLength(1);
    expect(found[0].subtitle).toContain("1 session");
  });

  it("counts only the asking profile's sessions", () => {
    expect(hits(other, "Cold plunge", "practice")[0].subtitle).toContain(
      "1 session"
    );
  });
});

describe("equipment is searchable (#343/#1595)", () => {
  it("finds gear by name and category, deep-linking its detail page", () => {
    const found = hits(mine, "Trap bar", "equipment");
    expect(found).toHaveLength(1);
    expect(found[0].href).toBe(`/equipment/${equipmentId}`);
    expect(titles(mine, "Barbell", "equipment")).toContain("Trap bar");
  });

  it("keeps RETIRED gear findable and says so", () => {
    const found = hits(mine, "Old road bike", "equipment");
    expect(found).toHaveLength(1);
    expect(found[0].subtitle).toContain("Retired");
  });

  it("stays inside the profile", () => {
    expect(hits(other, "Trap bar", "equipment")[0].href).not.toBe(
      `/equipment/${equipmentId}`
    );
  });
});

// The point of the issue: grounded Q&A retrieves through the SAME fan-out, so each
// newly searchable domain becomes citable the moment it joins. These are the
// questions the issue names as guaranteed "nothing found" before the change.
describe("grounded record Q&A can now cite the new domains (#878 × #1595)", () => {
  it("cites an imaging study for 'when was her last MRI'", () => {
    const cites = retrieveRecordCitations(mine, "when was her last MRI?");
    expect(cites.map((c) => c.domain)).toContain("imaging");
    expect(cites.find((c) => c.domain === "imaging")?.title).toBe(
      "MRI Left Knee"
    );
  });

  it("cites the protocol a question NAMES", () => {
    // Retrieval is keyword-based over the row's own words (the deterministic seam,
    // #878): the protocol is now reachable, so a question that names it cites it.
    // A question that only names the DOMAIN ("what protocol was I running in
    // March") still depends on the retrieval VOCABULARY — domain nouns and date
    // phrases are not retrieval keys, the same boundary #1597 drew for plurals —
    // and that is deliberately not what this change claims to fix.
    const cites = retrieveRecordCitations(mine, "how did the sauna block go?");
    expect(cites.map((c) => c.domain)).toContain("protocol");
    expect(cites.find((c) => c.domain === "protocol")?.href).toBe(
      `/protocols/${protocolId}`
    );
  });

  it("cites the dental record and its dentist for 'which dentist did the crown'", () => {
    const cites = retrieveRecordCitations(mine, "which dentist did the crown?");
    const domains = cites.map((c) => c.domain);
    expect(domains).toContain("dental");
    expect(domains).toContain("provider");
  });

  it("still never cites another profile's row", () => {
    const cites = retrieveRecordCitations(mine, "MRI shoulder Lakeside");
    expect(cites.map((c) => c.title)).not.toContain("MRI Shoulder");
  });
});
