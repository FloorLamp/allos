// DB INTEGRATION TIER — the biomarker row states the band its own flag came from
// (#2315).
//
// THE DEFECT. The Reference cell printed `reference_range`, the free-text string the
// lab document stated, beside a flag `reconciledFlag` derived from the CANONICAL
// reference range and the CANONICAL optimal band. The printed string reaches that
// function exactly once — as an input to the #761 unit-mislabel detector — so the row
// showed the one range that never judges it and hid both that do. Measured on a real
// profile: 35 of 333 readings (10.5%) visibly contradicting their own row, including
// a red "High" on a value sitting comfortably inside the printed range.
//
// WHY THIS TIER. The cell's content is decided by a pure function
// (lib/reading-reference-cell, unit-tested), but the thing that was WRONG is the
// join: which bands the gather resolves for which row, against which subject. So
// these fixtures store readings, let `reconcileFlags` derive the flag exactly as
// ingest does, and then assert that the cell the browser gather produces names the
// very bands that derivation used. The three cases below are the issue's own table
// and are the regression surface.
//
// PHI: synthetic profiles and reserved-looking names only; every value and printed
// range here is invented for the fixture.

import { describe, expect, it, beforeAll, vi } from "vitest";

// This suite is about the query layer under a hand-built ProfileScope, not about
// auth; restore the real module the shared action setup mocks.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

import { db } from "@/lib/db";
import { reconcileFlags } from "@/lib/queries";
import type { ProfileScope } from "@/lib/scope";
import {
  readingIndexRows,
  parseReadingFilters,
  type ReadingTableObservation,
} from "@/app/(app)/results/reading-index";
import { medicalValueFlagText } from "@/lib/medical-value";

const DRAW_DATE = "2026-03-04";

// A single-profile scope, hand-built: readingIndexRows takes an ALREADY-resolved
// scope and reads only the acting profile + the view set, so no login/grant fixture
// is needed to exercise the gather.
function singleScope(profileId: number): ProfileScope {
  return {
    loginId: 0,
    role: "admin",
    actingProfileId: profileId,
    ownProfileId: profileId,
    profiles: [
      {
        id: profileId,
        name: `p_${profileId}`,
        photo_path: null,
        photo_version: 0,
      },
    ],
    ids: [profileId],
    viewIds: [profileId],
    access: new Map([[profileId, "write" as const]]),
  };
}

function newProfile(name: string, settings: Record<string, string>): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  const ins = db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)"
  );
  for (const [k, v] of Object.entries(settings)) ins.run(id, k, v);
  return id;
}

// A stored reading with the range its DOCUMENT printed, and no flag: the flag is
// derived by reconcileFlags below, so the fixture can never assert a flag the app
// would not actually store.
function newReading(
  profileId: number,
  r: {
    canonical: string;
    value: number;
    unit: string;
    printed: string | null;
    date?: string;
  }
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit,
        reference_range, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    profileId,
    r.date ?? DRAW_DATE,
    r.canonical,
    r.canonical,
    String(r.value),
    r.value,
    r.unit,
    r.printed
  );
}

function rowsFor(profileId: number): Map<string, ReadingTableObservation> {
  const rows = readingIndexRows(singleScope(profileId), {
    ...parseReadingFilters({}),
  });
  return new Map(rows.map((r) => [r.canonical_name ?? r.name, r]));
}

// The severity word the surface renders beside the value, from the row's stored
// flag — the same decision `MedicalValue showFlagLabel` makes.
function flagWord(row: ReadingTableObservation): string | null {
  return medicalValueFlagText(row.flag, true)?.label ?? null;
}

describe("the three readings from the issue's table", () => {
  let profileId: number;
  let rows: Map<string, ReadingTableObservation>;

  beforeAll(() => {
    profileId = newProfile("Reference Cell Adult", {
      sex: "male",
      birthdate: "1985-06-06",
    });
    newReading(profileId, {
      canonical: "Uric Acid",
      value: 8.0,
      unit: "mg/dL",
      printed: "3.4-8.5",
    });
    newReading(profileId, {
      canonical: "Apolipoprotein B (ApoB)",
      value: 77,
      unit: "mg/dL",
      printed: "<90",
    });
    newReading(profileId, {
      canonical: "Hemoglobin A1c",
      value: 4.9,
      unit: "%",
      printed: "5.0-5.6",
    });
    // Derive each flag the way ingest does, from the canonical bands.
    reconcileFlags(profileId);
    rows = rowsFor(profileId);
  });

  it("Uric Acid 8.0 printed 3.4-8.5 — the ceiling that flagged it was 7.2, not 8.5", () => {
    const row = rows.get("Uric Acid");
    expect(row?.reference_range).toBe("3.4-8.5");
    // Red "High" on a value sitting comfortably inside the printed range: the worst
    // of the 35, and the row could not say why.
    expect(row?.flag).toBe("high");
    expect(flagWord(row!)).toBe("High");
    // Both bands, resolved for THIS subject: the optimal band is sex-specific
    // (male 4–5.5), which is a second thing the printed string could never say.
    expect(row?.referenceCell?.text).toBe("ref 3.5–7.2 · optimal 4–5.5");
    expect(row?.referenceCell?.label).toBe("Reference");
    // The lab's own string does not disappear — it becomes provenance.
    expect(row?.referenceCell?.title).toBe("Lab reference: 3.4-8.5");
  });

  it("ApoB 77 printed <90 — both bands, because the amber/red split is which one you crossed", () => {
    const row = rows.get("Apolipoprotein B (ApoB)");
    expect(row?.flag).toBe("non-optimal-high");
    expect(flagWord(row!)).toBe("Above optimal");
    expect(row?.referenceCell?.text).toBe("ref ≤ 90 · optimal ≤ 60");
  });

  it("A1c 4.9 printed 5.0-5.6 — below its own stated floor, and correctly unflagged", () => {
    const row = rows.get("Hemoglobin A1c");
    // A low A1c is not a finding and the canonical model declines to invent one
    // (≤5.7, no floor). The row used to show a number under its printed floor with
    // nothing beside it, which reads as a missed flag.
    expect(row?.flag).toBeNull();
    expect(flagWord(row!)).toBeNull();
    expect(row?.referenceCell?.text).toBe("ref ≤ 5.7 · optimal ≤ 5.3");
  });
});

describe("a pediatric row names the band that actually applied (the #150 half)", () => {
  it("shows the child's band and its label, not the adult range the lab printed", () => {
    // Six years old on the draw date. A lab prints its adult 40–129 U/L; the app
    // flags against the curated 1–10 band (140–420), so 300 U/L is NORMAL for this
    // child and would have read as an unexplained calm row above an out-of-range
    // printed range.
    const profileId = newProfile("Reference Cell Child", {
      sex: "female",
      birthdate: "2019-11-02",
    });
    newReading(profileId, {
      canonical: "Alkaline Phosphatase",
      value: 300,
      unit: "U/L",
      printed: "40-129",
    });
    reconcileFlags(profileId);

    const row = rowsFor(profileId).get("Alkaline Phosphatase");
    expect(row?.flag).toBeNull();
    expect(row?.referenceCell?.text).toBe("ref 140–420 · age 1–10");
    expect(row?.referenceCell?.title).toBe("Lab reference: 40-129");
  });

  it("is judged by the age ON the draw date, not the age today", () => {
    // The same profile, an older draw taken before the band boundary. Age on the
    // collection date is what the flag reconcile uses (#150), so the cell must not
    // silently show today's band for a childhood reading.
    const profileId = newProfile("Reference Cell Child Earlier", {
      sex: "female",
      birthdate: "2019-11-02",
    });
    newReading(profileId, {
      canonical: "Alkaline Phosphatase",
      value: 300,
      unit: "U/L",
      printed: "40-129",
      date: "2020-05-05",
    });
    const row = rowsFor(profileId).get("Alkaline Phosphatase");
    expect(row?.referenceCell?.text).toBe("ref 80–450 · age <1");
  });
});

describe("no canonical entry — the printed string IS the deciding range", () => {
  it("shows it as before, relabelled Lab reference", () => {
    const profileId = newProfile("Reference Cell Unknown Analyte", {
      sex: "male",
      birthdate: "1990-01-01",
    });
    newReading(profileId, {
      canonical: "Fictional Marker Nine",
      value: 4,
      unit: "units/L",
      printed: "2-6",
    });

    const row = rowsFor(profileId).get("Fictional Marker Nine");
    expect(row?.referenceCell?.judged).toBe(false);
    expect(row?.referenceCell?.label).toBe("Lab reference");
    // Prefixed, so the cell says which case it is in without leaning on a column
    // header the desktop table shares with every other row (#2344).
    expect(row?.referenceCell?.text).toBe("lab 2-6");
    // Nothing to hover: the content already IS the lab's string.
    expect(row?.referenceCell?.title).toBeNull();
  });
});
