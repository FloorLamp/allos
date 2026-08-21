// DB INTEGRATION TIER (not the pure suite). Runs via `npm run test:db`.
//
// WHAT THIS TIER ADDS THAT A UNIT TEST CANNOT (#3444). The comma-decimal defect was a
// pure-function bug — `strengthFromName("Bisoprolol 2,5 mg")` returned "5 mg" — and it
// would have been perfectly possible to fix that function, pin it in
// lib/__tests__/prescription-parse.test.ts, and still ship a corrupted dose, because
// nothing in the pure tier says WHICH COLUMN the fixed string lands in or whether it
// lands at all. The fabricated "5 mg" was not a display bug: it was written to
// `intake_item_doses.amount` by `persistDocumentImport`, from where it fed the
// medication detail, the medication card, the dose column of the shared summary link,
// the offline snapshot, and the UL/RDA totals — all reading a number the source
// document never stated, beside the honest name that contradicted it.
//
// So the assertions here are on STORED ROWS after a real import, and they are made
// against what each document SAID rather than against what the parser returns.
import { describe, it, expect, beforeAll } from "vitest";
import { persistDocumentImport } from "@/lib/import-persist";
import type {
  PersistInput,
  PersistClinicalObservation,
} from "@/lib/import-shape";
import { getUnreadableDoseAmounts } from "@/lib/queries/data-quality";
import { classifyDoseAmount } from "@/lib/dose-amount-census";
import { readDoseQuantity } from "@/lib/dri";
import { db } from "@/lib/db";

const DATE = "2024-03-04";

// The ordinary sig every one of these prescriptions carries, so the schedule half is
// constant and the only thing varying between rows is how the strength is written.
const SIG = "Take 1 tablet by mouth daily";

function rx(name: string): PersistClinicalObservation {
  return {
    category: "prescription",
    name,
    canonical: name,
    value: SIG,
    value_num: null,
    unit: null,
    date: DATE,
    reference_range: null,
    flag: null,
    panel: null,
    notes: null,
    source: null,
    external_id: `med:${name}`,
    loinc: null,
    provider: null,
    courses: null,
  };
}

function inputWith(observations: PersistClinicalObservation[]): PersistInput {
  return {
    observations,
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
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
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

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
         VALUES (?, 'meds.ccd', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

// The stored item and its dose rows, looked up the way a person meets them: by the
// drug, not by an id the test happens to know.
function storedMed(
  profileId: number,
  groupingName: string
): { id: number; name: string; amounts: (string | null)[] } {
  const item = db
    .prepare(
      `SELECT id, name FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' AND name = ?`
    )
    .get(profileId, groupingName) as { id: number; name: string } | undefined;
  if (!item) {
    const all = db
      .prepare(
        `SELECT name FROM intake_items WHERE profile_id = ? AND kind = 'medication' ORDER BY id`
      )
      .all(profileId) as { name: string }[];
    throw new Error(
      `no medication named ${JSON.stringify(groupingName)} — stored: ${JSON.stringify(all.map((r) => r.name))}`
    );
  }
  const amounts = (
    db
      .prepare(
        "SELECT amount FROM intake_item_doses WHERE item_id = ? ORDER BY sort, id"
      )
      .all(item.id) as { amount: string | null }[]
  ).map((r) => r.amount);
  return { ...item, amounts };
}

// Each row: the observation name exactly as a European discharge summary writes it,
// the grouping name the item must be filed under, the dose text that must be stored,
// and the quantity the totals are allowed to read from it — the TRUE value, or
// `unreadable` when the separator rule declines to guess a locale.
//
// `was` records what the pre-fix import actually persisted. It is not asserted; it is
// what makes each row's stake legible to whoever reads this next.
const CASES: {
  name: string;
  grouping: string;
  amount: string;
  reads: number | "unreadable";
  unit?: string;
  was: string;
}[] = [
  {
    name: "Bisoprolol 2,5 mg",
    grouping: "Bisoprolol",
    amount: "2,5 mg",
    reads: "unreadable",
    was: "5 mg — twice the prescribed dose of a beta blocker",
  },
  {
    name: "Warfarin 1,25 mg",
    grouping: "Warfarin",
    amount: "1,25 mg",
    reads: "unreadable",
    was: "25 mg — twenty times, on an anticoagulant",
  },
  {
    name: "Digoxin 0,125 mg",
    grouping: "Digoxin",
    amount: "0,125 mg",
    reads: "unreadable",
    was: "125 mg — a thousandfold overdose",
  },
  {
    name: "Levothyroxine 0,05 mg",
    grouping: "Levothyroxine",
    amount: "0,05 mg",
    reads: "unreadable",
    was: "05 mg, read as 5 — a hundredfold",
  },
  // A comma that really IS a thousands group must still READ, and read correctly —
  // otherwise "refuse everything with a comma in it" would pass this file while making
  // the app worse. Before the fix this stored "000 mg", a confident zero.
  {
    name: "Metformin 1,000 mg",
    grouping: "Metformin",
    amount: "1,000 mg",
    reads: 1000,
    unit: "mg",
    was: "000 mg, read as 0 — contributing nothing to any total",
  },
  // The US spelling of the first row's tablet. Unchanged by the fix, and here so a
  // regression in the ordinary case cannot hide behind the interesting ones.
  {
    name: "Amlodipine 2.5 mg",
    grouping: "Amlodipine",
    amount: "2.5 mg",
    reads: 2.5,
    unit: "mg",
    was: "2.5 mg — always correct",
  },
  // THE NAKED DECIMAL (#3444, second round). Not a comma at all — a dropped leading
  // zero, which ISMP names as its own error class because prescribers write it that
  // way. It reaches the dose column through the identical mechanism: the scan was free
  // to start after the separator, so it read the "125".
  {
    name: "Digitoxin .125 mg",
    grouping: "Digitoxin",
    amount: ".125 mg",
    reads: "unreadable",
    was: "125 mg — a thousandfold overdose, from a missing character",
  },
  {
    name: "Liothyronine .05 mg",
    grouping: "Liothyronine",
    amount: ".05 mg",
    reads: "unreadable",
    was: "05 mg, read as 5 — a hundredfold",
  },
];

let profile: number;

beforeAll(() => {
  profile = newProfile("RX-COMMA");
  const doc = newDocument(profile);
  persistDocumentImport(profile, doc, inputWith(CASES.map((c) => rx(c.name))));
});

describe("comma-decimal prescription strengths through persistDocumentImport (#3444)", () => {
  for (const c of CASES) {
    it(`${c.name} stores ${c.amount} (was ${c.was})`, () => {
      const med = storedMed(profile, c.grouping);
      // The sig schedules one daily dose, so exactly one row — and its amount is the
      // document's own text.
      expect(med.amounts).toEqual([c.amount]);

      const reading = readDoseQuantity(med.amounts[0]);
      if (typeof c.reads === "number") {
        expect(reading).toEqual({
          kind: "quantity",
          value: c.reads,
          unit: c.unit,
        });
      } else {
        expect(reading.kind).toBe("unreadable");
      }
    });
  }

  // THE ASSERTION THE WHOLE FILE EXISTS FOR, and the only one a wrong fix cannot pass.
  // It compares the stored dose against the DOCUMENT rather than against the expected
  // strings above, so rewriting those rows to match a regression would not rescue it.
  it("no stored dose states a quantity the source document did not", () => {
    const offenders: string[] = [];
    for (const c of CASES) {
      const med = storedMed(profile, c.grouping);
      for (const amount of med.amounts) {
        const reading = readDoseQuantity(amount);
        if (reading.kind !== "quantity") continue;
        if (typeof c.reads !== "number" || reading.value !== c.reads) {
          offenders.push(
            `"${c.name}" → stored ${JSON.stringify(amount)}, read as ${reading.value} ${reading.unit}`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The grouping half (#1204): the item is filed under the bare drug, so a later plain
  // "Bisoprolol" — a manual entry, or a renewal written without the strength — folds
  // onto the same medication instead of starting a second one. Before the fix the
  // comma-decimal strength stayed welded to the name.
  it("the item is filed under the drug, not the drug-plus-strength", () => {
    const names = (
      db
        .prepare(
          `SELECT name FROM intake_items WHERE profile_id = ? AND kind = 'medication' ORDER BY id`
        )
        .all(profile) as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(CASES.map((c) => c.grouping));
  });

  // AND THE REFUSAL IS VISIBLE, not silent. A dose the engines decline to read is worth
  // storing only if something tells the person it needs their eyes: the
  // `dose-amount-unreadable` data-quality gap is that something, and the census bucket
  // is how the population is counted. Both were BLIND to these rows before — a
  // fabricated "5 mg" is readable, so it was classified `always-correct` and no gap
  // ever mentioned it. This is what "the census measures the string that was stored"
  // costs when the wrong string is stored, and what it buys once the right one is.
  it("the unreadable strengths surface as a data-quality gap, one per drug", () => {
    const flagged = getUnreadableDoseAmounts(profile);
    const flaggedNames = new Set(
      flagged.map(
        (f) =>
          (
            db
              .prepare("SELECT name FROM intake_items WHERE id = ?")
              .get(f.itemId) as {
              name: string;
            }
          ).name
      )
    );
    expect([...flaggedNames].sort()).toEqual(
      CASES.filter((c) => c.reads === "unreadable")
        .map((c) => c.grouping)
        .sort()
    );
    // …and nothing that reads is dragged in with them.
    expect(flaggedNames.has("Metformin")).toBe(false);
    expect(flaggedNames.has("Amlodipine")).toBe(false);
  });

  it("the census buckets the stored rows honestly", () => {
    expect(classifyDoseAmount("2,5 mg")).toBe("unreadable-unrecoverable");
    // The stored string is what the census sees, so this is the bucket these rows now
    // land in — where before the fix "5 mg" landed in `always-correct`.
    for (const c of CASES.filter((x) => x.reads === "unreadable")) {
      expect(
        classifyDoseAmount(storedMed(profile, c.grouping).amounts[0])
      ).toBe("unreadable-unrecoverable");
    }
    expect(classifyDoseAmount(storedMed(profile, "Metformin").amounts[0])).toBe(
      "recovered-from-zero"
    );
  });
});
