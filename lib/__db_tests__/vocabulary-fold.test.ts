// DB INTEGRATION TIER (issue #3325).
//
// The case-fold is only real at the WRITE BOUNDARY: the pure tier can show that a fold
// picks an existing spelling out of a list, but only this tier can show that logging the
// same word in three casings produces ONE ledger row-set under ONE label, in BOTH
// vocabularies, against the real migrated schema.
//
// Both domains are exercised here on purpose. #3323 re-instantiated lib/symptoms.ts's
// vocabulary for substances rather than inventing a second one; a fold tested in one
// domain alone is exactly the re-fork this issue exists to prevent.
//
// Deterministic: :memory:-backed temp DB via setup.ts; no network.

import { describe, it, expect, vi } from "vitest";
import { db } from "@/lib/db";
import {
  profileVocabulary,
  resolveProfileVocabularyKey,
} from "@/lib/vocabulary-store";
import {
  logSymptomCore,
  renameCustomSymptomCore,
  removeSymptomCore,
} from "@/lib/symptom-log-write";
import {
  getSymptomsOnDate,
  getSymptomSeveritiesOnDate,
  getCustomSymptomNames,
} from "@/lib/queries";
import { symptomLabel } from "@/lib/symptoms";
import { addSubstanceDailyTotalCore } from "@/lib/substance-daily-totals-write";
import { getSubstanceDailyTotals } from "@/lib/queries/substance";
import { substanceLabel, validateSubstanceName } from "@/lib/substance-use";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The one substance write core that mints a key from typed text lives behind a Server
// Action (trackSubstanceUseAction), which needs auth. This is the same two-step that
// action performs — vocabulary, then validate-and-resolve — so the DB tier can pin the
// resolution without the auth gate.
function trackTypedSubstance(profileId: number, typed: string): string {
  const name = validateSubstanceName(
    typed,
    profileVocabulary("substance", profileId)
  );
  if (!name.ok) throw new Error(`refused: ${name.reason}`);
  return name.key;
}

describe("profileVocabulary — the profile's own spellings, first-seen first", () => {
  it("does not scan stored spellings for a curated symptom tap", () => {
    const p = newProfile("curated-symptom-fast-path");
    const scans: string[] = [];
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (/FROM symptom_logs[\s\S]*GROUP BY symptom/.test(sql)) scans.push(sql);
      return realPrepare(sql);
    }) as typeof db.prepare);
    try {
      expect(logSymptomCore(p, "Fever", 2, "2026-07-01", "page").kind).toBe(
        "logged"
      );
    } finally {
      spy.mockRestore();
    }
    expect(scans).toEqual([]);
  });

  it("orders symptom spellings by the OLDEST row that carries them, not by date", () => {
    const p = newProfile("first-seen-symptom");
    // Logged first, but describing a LATER day…
    logSymptomCore(p, "Kratom head", 2, "2026-07-20", "page");
    // …and this row describes an EARLIER day while being typed second.
    logSymptomCore(p, "Kava jitters", 2, "2026-07-01", "page");
    expect(profileVocabulary("symptom", p)).toEqual([
      "Kratom head",
      "Kava jitters",
    ]);
  });

  it("orders substance spellings the same way, from the substance ledger", () => {
    const p = newProfile("first-seen-substance");
    addSubstanceDailyTotalCore(
      p,
      "Kratom",
      { date: "2026-07-20", amount: 1 },
      "page"
    );
    addSubstanceDailyTotalCore(
      p,
      "Kava",
      { date: "2026-07-01", amount: 1 },
      "page"
    );
    expect(profileVocabulary("substance", p)).toEqual(["Kratom", "Kava"]);
  });

  it("is scoped to the profile — another profile's spelling never leaks in", () => {
    const mine = newProfile("mine");
    const theirs = newProfile("theirs");
    logSymptomCore(theirs, "Kratom", 2, "2026-07-01", "page");
    addSubstanceDailyTotalCore(
      theirs,
      "Kratom",
      {
        date: "2026-07-01",
        amount: 1,
      },
      "page"
    );
    expect(profileVocabulary("symptom", mine)).toEqual([]);
    expect(profileVocabulary("substance", mine)).toEqual([]);
    // …so a same-cased name typed here mints MY OWN key, not a share of theirs.
    expect(resolveProfileVocabularyKey("symptom", mine, "kratom")).toBe(
      "kratom"
    );
    expect(resolveProfileVocabularyKey("substance", mine, "kratom")).toBe(
      "kratom"
    );
  });
});

describe("symptom vocabulary — three casings, one key, one label (#3325)", () => {
  it("logs one symptom-day under the first-seen spelling", () => {
    const p = newProfile("symptom-fold");
    // The AC's shape: the same word typed three ways across three days.
    expect(logSymptomCore(p, "Kratom head", 2, "2026-07-01", "page").kind).toBe(
      "logged"
    );
    expect(logSymptomCore(p, "kratom head", 3, "2026-07-02", "page").kind).toBe(
      "logged"
    );
    expect(logSymptomCore(p, "KRATOM HEAD", 1, "2026-07-03", "page").kind).toBe(
      "logged"
    );

    // ONE vocabulary entry, spelled as first seen…
    expect(getCustomSymptomNames(p)).toEqual(["Kratom head"]);
    // …one label…
    expect(symptomLabel("Kratom head")).toBe("Kratom head");
    // …and every day's row keyed to it.
    for (const date of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
      expect(getSymptomsOnDate(p, date).map((r) => r.symptom)).toEqual([
        "Kratom head",
      ]);
    }
  });

  it("keeps the WORST severity when a re-cased re-tap lands on the same day", () => {
    // Before the fold this minted a second row at severity 2 beside the first at 4;
    // now it is the same symptom-day, so #799's worst-severity rule owns the answer.
    const p = newProfile("symptom-fold-day");
    logSymptomCore(p, "Kratom head", 4, "2026-07-01", "page");
    logSymptomCore(p, "kratom head", 2, "2026-07-01", "page");
    expect(getSymptomsOnDate(p, "2026-07-01")).toHaveLength(1);
    expect(getSymptomSeveritiesOnDate(p, "2026-07-01")["Kratom head"]).toBe(4);
  });

  it("answers with the key it actually wrote, so a caller names what landed", () => {
    const p = newProfile("symptom-fold-outcome");
    logSymptomCore(p, "MDMA", 2, "2026-07-01", "page");
    const out = logSymptomCore(p, "mdma", 2, "2026-07-02", "page");
    expect(out).toMatchObject({ kind: "logged", symptom: "MDMA" });
  });

  it("keeps an all-caps custom symptom in capitals", () => {
    const p = newProfile("symptom-mdma");
    logSymptomCore(p, "MDMA", 2, "2026-07-01", "page");
    logSymptomCore(p, "mdma", 2, "2026-07-02", "page");
    logSymptomCore(p, "Mdma", 2, "2026-07-03", "page");
    expect(getCustomSymptomNames(p)).toEqual(["MDMA"]);
    expect(symptomLabel("MDMA")).toBe("MDMA");
  });

  it("still keeps genuinely different symptoms apart", () => {
    const p = newProfile("symptom-exclusion");
    logSymptomCore(p, "Kratom head", 2, "2026-07-01", "page");
    logSymptomCore(p, "Kava jitters", 2, "2026-07-01", "page");
    expect(getSymptomsOnDate(p, "2026-07-01")).toHaveLength(2);
  });
});

describe("substance vocabulary — three casings, one key, one label (#3325)", () => {
  it("resolves a typed name onto the first-seen spelling", () => {
    const p = newProfile("substance-fold");
    expect(trackTypedSubstance(p, "Kratom")).toBe("Kratom");
    addSubstanceDailyTotalCore(
      p,
      "Kratom",
      { date: "2026-07-01", amount: 2 },
      "page"
    );

    const keys = ["Kratom", "kratom", "KRATOM"].map((typed) =>
      trackTypedSubstance(p, typed)
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("Kratom");
    expect(new Set(keys.map((k) => substanceLabel(k))).size).toBe(1);
    expect(substanceLabel(keys[0])).toBe("Kratom");
  });

  it("puts every casing's day on ONE ledger, not two half-ledgers", () => {
    const p = newProfile("substance-ledger");
    addSubstanceDailyTotalCore(
      p,
      trackTypedSubstance(p, "Kratom"),
      {
        date: "2026-07-01",
        amount: 2,
      },
      "page"
    );
    addSubstanceDailyTotalCore(
      p,
      trackTypedSubstance(p, "kratom"),
      {
        date: "2026-07-02",
        amount: 1,
      },
      "page"
    );
    addSubstanceDailyTotalCore(
      p,
      trackTypedSubstance(p, "KRATOM"),
      {
        date: "2026-07-03",
        amount: 3,
      },
      "page"
    );

    expect(profileVocabulary("substance", p)).toEqual(["Kratom"]);
    const rows = getSubstanceDailyTotals(p, "Kratom");
    expect(rows.map((r) => r.date).sort()).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    // The other casings name no ledger of their own.
    expect(getSubstanceDailyTotals(p, "kratom")).toEqual([]);
    expect(getSubstanceDailyTotals(p, "KRATOM")).toEqual([]);
  });

  it("keeps an all-caps custom substance in capitals", () => {
    const p = newProfile("substance-mdma");
    addSubstanceDailyTotalCore(
      p,
      trackTypedSubstance(p, "MDMA"),
      {
        date: "2026-07-01",
        amount: 1,
      },
      "page"
    );
    for (const typed of ["mdma", "Mdma", "MDMA"]) {
      expect(trackTypedSubstance(p, typed)).toBe("MDMA");
      expect(substanceLabel(trackTypedSubstance(p, typed))).toBe("MDMA");
    }
    expect(profileVocabulary("substance", p)).toEqual(["MDMA"]);
  });

  it("still collapses a typed curated label onto its curated key", () => {
    const p = newProfile("substance-curated");
    addSubstanceDailyTotalCore(
      p,
      trackTypedSubstance(p, "Kratom"),
      {
        date: "2026-07-01",
        amount: 1,
      },
      "page"
    );
    expect(trackTypedSubstance(p, "Alcohol")).toBe("alcohol");
    expect(trackTypedSubstance(p, "NICOTINE")).toBe("nicotine");
  });
});

// ---- Rows that already differ only by case ----------------------------------
//
// Left as they are, deliberately (the reasoning is in lib/vocabulary-store.ts). These
// pin what that decision MEANS, so the next reader is not left guessing whether the
// behaviour is intended: the older card keeps taking the writes, the newer one keeps its
// own history and stays fully addressable, and the symptom rename that MERGES the pair
// is not broken by the fold.

describe("rows that predate the fold", () => {
  it("routes new logs to the first-seen spelling and leaves the other one readable", () => {
    const p = newProfile("legacy-pair");
    // A pair minted before this fix (written straight to the ledger, since the write
    // boundary can no longer produce one).
    const insert = db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity) VALUES (?,?,?,?)`
    );
    insert.run(p, "2026-07-01", "Kratom", 2);
    insert.run(p, "2026-07-02", "kratom", 3);

    // New logs join the FIRST-SEEN one…
    logSymptomCore(p, "KRATOM", 1, "2026-07-03", "page");
    expect(getSymptomsOnDate(p, "2026-07-03").map((r) => r.symptom)).toEqual([
      "Kratom",
    ]);
    // …and the second spelling is still there, with its own day, not orphaned.
    expect(getSymptomsOnDate(p, "2026-07-02").map((r) => r.symptom)).toEqual([
      "kratom",
    ]);
    expect(getCustomSymptomNames(p).sort()).toEqual(["Kratom", "kratom"]);
  });

  it("still lets an edit and a delete address the exact stored spelling", () => {
    // Why the non-minting cores resolve BARE: folding them would aim an edit or a
    // delete at the other card.
    const p = newProfile("legacy-address");
    const insert = db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity) VALUES (?,?,?,?)`
    );
    insert.run(p, "2026-07-01", "Kratom", 2);
    insert.run(p, "2026-07-01", "kratom", 3);

    removeSymptomCore(p, "kratom", "2026-07-01");
    expect(getSymptomsOnDate(p, "2026-07-01").map((r) => r.symptom)).toEqual([
      "Kratom",
    ]);
  });

  it("keeps rename as the user-facing MERGE for a pair, worst severity surviving", () => {
    const p = newProfile("legacy-merge");
    const insert = db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity) VALUES (?,?,?,?)`
    );
    insert.run(p, "2026-07-01", "Kratom", 2);
    insert.run(p, "2026-07-01", "kratom", 4); // same day, both spellings
    insert.run(p, "2026-07-02", "kratom", 1); // only the lowercase one

    // The rename resolves both ends BARE, so re-casing is not a silent no-op.
    expect(renameCustomSymptomCore(p, "kratom", "Kratom").kind).toBe("ok");

    expect(getCustomSymptomNames(p)).toEqual(["Kratom"]);
    expect(getSymptomSeveritiesOnDate(p, "2026-07-01")["Kratom"]).toBe(4);
    expect(getSymptomSeveritiesOnDate(p, "2026-07-02")["Kratom"]).toBe(1);
  });
});
