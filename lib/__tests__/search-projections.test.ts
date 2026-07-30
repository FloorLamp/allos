// PURE TIER — the row → hit text projections for the entity domains added in #1595.
//
// What earns a test here is the DECISION each projection makes, not the string
// concatenation: which attribute distinguishes two otherwise-identical rows (two
// studies of the same modality, two lesions in the same place, two same-named
// providers), and the end-bound semantics of a stored window — a protocol's end_date
// is its LAST day while an illness episode's ended_at is the first day it was OVER,
// an off-by-one no reader could catch. Synthetic values only (no PHI).

import { describe, expect, it } from "vitest";
import {
  dentalHitText,
  episodeHitText,
  equipmentHitText,
  genomicHitText,
  imagingHitText,
  isoDay,
  practiceHitText,
  protocolHitText,
  providerDisambiguator,
  providerHitText,
  providerKindLabel,
  rangeText,
  skinHitText,
  snippet,
} from "@/lib/search-projections";
import { EXCLUSIVE_END, INCLUSIVE_END } from "@/lib/date-range";
import type {
  DentalProcedure,
  GenomicVariant,
  ImagingStudy,
  SkinLesion,
} from "@/lib/types";

describe("isoDay", () => {
  it("trims a stored datetime to its ISO day and passes a date through", () => {
    expect(isoDay("2026-07-06 12:30:00")).toBe("2026-07-06");
    expect(isoDay("2026-07-06")).toBe("2026-07-06");
    expect(isoDay(null)).toBeNull();
    expect(isoDay("")).toBeNull();
  });
});

describe("snippet", () => {
  it("normalizes whitespace and keeps short text verbatim", () => {
    expect(snippet("  small   effusion\n noted ")).toBe("small effusion noted");
  });

  it("ellipsizes past the cap and returns null for blank text", () => {
    const out = snippet("a".repeat(50), 10);
    expect(out).toBe(`${"a".repeat(9)}…`);
    expect(out!.length).toBe(10);
    expect(snippet("   ")).toBeNull();
    expect(snippet(null)).toBeNull();
  });
});

describe("rangeText — the end-bound convention is explicit", () => {
  it("shows an INCLUSIVE end as itself (a protocol's last day)", () => {
    expect(
      rangeText({ start: "2026-03-01", end: "2026-04-15" }, INCLUSIVE_END)
    ).toBe("2026-03-01 → 2026-04-15");
  });

  it("shows an EXCLUSIVE end as the day BEFORE it (an episode's last active day)", () => {
    // ended_at = the first inactive day, so the window's last day is the 7th.
    expect(
      rangeText({ start: "2026-03-01", end: "2026-03-08" }, EXCLUSIVE_END)
    ).toBe("2026-03-01 → 2026-03-07");
  });

  it("reads an open window as 'since', a start-less one as 'until'", () => {
    expect(rangeText({ start: "2026-03-01", end: null }, INCLUSIVE_END)).toBe(
      "since 2026-03-01"
    );
    expect(rangeText({ start: null, end: "2026-03-09" }, EXCLUSIVE_END)).toBe(
      "until 2026-03-08"
    );
    expect(rangeText({ start: null, end: null }, INCLUSIVE_END)).toBeNull();
  });

  it("collapses a single-day window to one date", () => {
    expect(
      rangeText({ start: "2026-03-01", end: "2026-03-02" }, EXCLUSIVE_END)
    ).toBe("2026-03-01");
  });
});

describe("providerHitText", () => {
  const base = {
    name: "Northgate Family Clinic",
    type: "organization",
    specialty: null as string | null,
    npi: null as string | null,
    address: null as string | null,
    recordCount: 3,
  };

  it("states the specialty when known, else the provider's kind", () => {
    expect(
      providerHitText({ ...base, specialty: "Dermatology" }).subtitle
    ).toBe("Dermatology · 3 records");
    expect(providerHitText(base).subtitle).toBe("Organization · 3 records");
    expect(providerHitText({ ...base, type: "individual" }).subtitle).toBe(
      "Clinician · 3 records"
    );
  });

  it("counts the active profile's linked records, singular when one", () => {
    expect(providerHitText({ ...base, recordCount: 1 }).subtitle).toContain(
      "1 record"
    );
    // A provider with no linked rows says nothing rather than "0 records".
    expect(providerHitText({ ...base, recordCount: 0 }).subtitle).toBe(
      "Organization"
    );
  });

  it("adds the distinguishing attribute ONLY when the name is ambiguous", () => {
    const row = { ...base, type: "individual", npi: "1234567893" };
    expect(providerHitText(row).subtitle).not.toContain("NPI");
    expect(providerHitText(row, { ambiguousName: true }).subtitle).toContain(
      "NPI 1234567893"
    );
  });

  it("falls back to the address's first line when there is no NPI", () => {
    expect(
      providerDisambiguator({ npi: null, address: "12 Grove St, Springfield" })
    ).toBe("12 Grove St");
    expect(providerDisambiguator({ npi: null, address: null })).toBeNull();
    expect(providerKindLabel(null)).toBe("Clinician");
  });

  it("never renders an empty title", () => {
    expect(providerHitText({ ...base, name: "   " }).title).toBe("Provider");
  });
});

describe("imagingHitText", () => {
  const study: Pick<
    ImagingStudy,
    | "modality"
    | "body_region"
    | "laterality"
    | "study_date"
    | "impression"
    | "indication"
  > = {
    modality: "mri",
    body_region: "Knee",
    laterality: "left",
    study_date: "2026-02-11",
    impression: "No meniscal tear.",
    indication: null,
  };

  it("titles the study with modality, side, and region", () => {
    expect(imagingHitText(study).title).toBe("MRI Left Knee");
  });

  it("distinguishes two same-modality studies by their date", () => {
    const older = imagingHitText({ ...study, study_date: "2024-09-02" });
    const newer = imagingHitText(study);
    expect(older.title).toBe(newer.title);
    expect(older.subtitle).toContain("2024-09-02");
    expect(newer.subtitle).toContain("2026-02-11");
  });

  it("falls back to the indication when no impression was captured", () => {
    expect(
      imagingHitText({
        ...study,
        impression: null,
        indication: "Persistent knee pain",
      }).subtitle
    ).toBe("Persistent knee pain · 2026-02-11");
  });
});

describe("genomicHitText", () => {
  const variant: Pick<
    GenomicVariant,
    | "gene"
    | "variant"
    | "genotype"
    | "star_allele"
    | "zygosity"
    | "significance"
    | "result_type"
    | "source_lab"
    | "report_date"
  > = {
    gene: "CYP2C19",
    variant: null,
    genotype: null,
    star_allele: "*2/*17",
    zygosity: null,
    significance: null,
    result_type: "pharmacogenomic",
    source_lab: "Lakeside Genetics",
    report_date: "2025-11-04",
  };

  it("titles the row with the gene and its most specific call", () => {
    expect(genomicHitText(variant).title).toBe("CYP2C19 *2/*17");
  });

  it("states the report's own classification, preferring significance", () => {
    expect(genomicHitText(variant).subtitle).toBe(
      "Pharmacogenomic · Lakeside Genetics · 2025-11-04"
    );
    expect(
      genomicHitText({ ...variant, significance: "likely-benign" }).subtitle
    ).toContain("Likely benign");
  });
});

describe("dentalHitText", () => {
  const proc: Pick<
    DentalProcedure,
    "name" | "tooth" | "surface" | "status" | "procedure_date" | "finding"
  > = {
    name: "Composite filling",
    tooth: "14",
    surface: "MOD",
    status: "completed",
    procedure_date: "2026-01-20",
    finding: null,
  };

  it("puts the tooth in the title, which is what separates two fillings", () => {
    expect(dentalHitText(proc).title).toBe("Composite filling · #14 MOD");
    expect(dentalHitText({ ...proc, tooth: "30", surface: null }).title).toBe(
      "Composite filling · #30"
    );
  });

  it("states the status so a planned procedure is not read as history", () => {
    expect(dentalHitText({ ...proc, status: "planned" }).subtitle).toBe(
      "Planned · 2026-01-20"
    );
  });
});

describe("skinHitText", () => {
  const lesion: Pick<
    SkinLesion,
    | "label"
    | "body_region"
    | "body_side"
    | "status"
    | "size_mm"
    | "observed_date"
  > = {
    label: "Freckled mole",
    body_region: "forearm",
    body_side: "left",
    status: "watch",
    size_mm: 4,
    observed_date: "2026-05-06",
  };

  it("names the lesion and locates it, with its size and status", () => {
    const out = skinHitText(lesion);
    expect(out.title).toBe("Freckled mole");
    expect(out.subtitle).toBe("Left forearm · Watch · 4 mm · 2026-05-06");
  });

  it("says how many observations a serial-tracked lesion holds", () => {
    expect(skinHitText(lesion, 3).subtitle).toContain("3 observations");
    expect(skinHitText(lesion, 1).subtitle).not.toContain("observation");
  });

  it("distinguishes two lesions in the SAME place by side and size", () => {
    const left = skinHitText({ ...lesion, label: null });
    const right = skinHitText({
      ...lesion,
      label: null,
      body_side: "right",
      size_mm: 9,
    });
    expect(left.title).not.toBe(right.title);
    expect(left.subtitle).toContain("Left forearm");
    expect(right.subtitle).toContain("Right forearm");
    expect(right.subtitle).toContain("9 mm");
  });
});

describe("episodeHitText", () => {
  it("marks an open episode ongoing and dates it from its start", () => {
    expect(
      episodeHitText({
        situation: "Head cold",
        started_at: "2026-03-01",
        ended_at: null,
        outcome: null,
      }).subtitle
    ).toBe("Ongoing · since 2026-03-01");
  });

  it("renders a closed episode under the EXCLUSIVE end bound, with its outcome", () => {
    expect(
      episodeHitText({
        situation: "Flu",
        started_at: "2026-03-01",
        ended_at: "2026-03-08",
        outcome: "Resolved without antibiotics",
      }).subtitle
    ).toBe("2026-03-01 → 2026-03-07 · Resolved without antibiotics");
  });
});

describe("protocolHitText", () => {
  it("renders a finished protocol under the INCLUSIVE end bound", () => {
    expect(
      protocolHitText({
        name: "Sauna block",
        start_date: "2026-03-01",
        end_date: "2026-04-15",
        situation: null,
      }).subtitle
    ).toBe("2026-03-01 → 2026-04-15");
  });

  it("marks a running protocol ongoing and names its situation", () => {
    expect(
      protocolHitText({
        name: "Creatine trial",
        start_date: "2026-06-01",
        end_date: null,
        situation: "Travel week",
      }).subtitle
    ).toBe("Ongoing · since 2026-06-01 · Travel week");
  });
});

describe("practiceHitText", () => {
  it("shows the shared weekly cadence text plus the session tally", () => {
    expect(
      practiceHitText({
        name: "Cold plunge",
        perWeek: 3,
        perWeekMax: 5,
        sessionCount: 12,
        lastUsed: "2026-07-02",
      }).subtitle
    ).toBe("3–5×/week · 12 sessions · 2026-07-02");
  });

  it("is honest about an untracked or unlogged practice", () => {
    expect(
      practiceHitText({
        name: "Breathwork",
        perWeek: null,
        perWeekMax: null,
        sessionCount: 0,
        lastUsed: null,
      }).subtitle
    ).toBe("No sessions yet");
    expect(
      practiceHitText({
        name: "Sauna",
        perWeek: 4,
        perWeekMax: null,
        sessionCount: 1,
        lastUsed: "2026-07-02",
      }).subtitle
    ).toBe("4×/week · 1 session · 2026-07-02");
  });
});

describe("equipmentHitText", () => {
  it("states the category and flags retired gear", () => {
    expect(
      equipmentHitText({ name: "Trap bar", category: "Barbell", retired: 0 })
        .subtitle
    ).toBe("Barbell");
    expect(
      equipmentHitText({ name: "Old road bike", category: "Bike", retired: 1 })
        .subtitle
    ).toBe("Bike · Retired");
    expect(
      equipmentHitText({ name: "Mystery bar", category: null, retired: 0 })
        .subtitle
    ).toBeNull();
  });
});
