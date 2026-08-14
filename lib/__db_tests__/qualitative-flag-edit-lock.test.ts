// DB INTEGRATION TIER — the qualitative reconcile's edit-lock gate, whole (#2715, #2777).
//
// `isEditLocked(medical_records.edited)` means a person has been in the row through the
// record editor. #2712 taught the #2687 no-result clear to respect it; #2715 extended
// that to the #548 §1 clear on an IDENTITY-class row; #2777 moved the gate off
// `immutable` (which answers the RETEST question) onto `valueIndependent`, which is the
// question the gate is actually asking — is this verdict a statement about the ANALYTE
// rather than about this reading's value? So the gate now covers a MUTABLE neutral
// attribute (urinalysis colour, morphology pattern) and a QC metric too, and still
// covers no transition whose verdict is read off the value.
//
// Those clears exist to remove an EXTRACTOR GUESS on a value that cannot be abnormal;
// on an edit-locked row the flag is not a guess. And withholding one strands nothing:
// where the app's position is "no flag is derivable for this analyte", no later
// correction produces a flag the pass was holding back.
//
// The pure verdicts are pinned in lib/__tests__/reference-range.test.ts. What is pinned
// HERE is the stored consequence, over both passes that write flags:
//
//   • the BOOT reconcile (reconcileFlagsIfCanonicalChanged — the deploy path), and
//   • the REQUEST-TIME reconcile (reconcileFlags), which is the sharper repro: the
//     record editor's updateResult writes the user's chosen flag AND edited = 1, then
//     calls reconcileFlags on the very next line, so before these changes the save
//     returned {ok:true} with the flag already deleted.
//
// Every case is asserted BOTH ways round. A test that only proves the new behaviour
// cannot tell you whether the old one broke, and the old one — clearing the extractor's
// guess on an UNTOUCHED row — is #548 §1 and must be untouched. So each locked row has
// an otherwise-identical unlocked twin, and the VALUE-DEPENDENT classes are carried
// alongside locked to prove the reach stops where the argument does.
//
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { reconcileFlags } from "@/lib/queries";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";

// The ABO+Rh interpretation code (#910): the identity class resolved from the LOINC
// rather than the name, because "ABORh Interpretation" matches no name regex.
const ABO_RH_LOINC = "19057-9";

let profileId: number;

interface Row {
  label: string;
  name: string;
  value: string;
  loinc: string | null;
  flag: string | null;
  edited: number;
  // The flag the row must carry after BOTH reconcile passes have run over it.
  want: string | null;
}

// Each identity case appears twice — edit-locked and not — differing in nothing else.
const rows: Row[] = [
  {
    label: "blood type, hand-edited",
    name: "ABO Blood Group",
    value: "O POSITIVE",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: "abnormal",
  },
  {
    label: "blood type, untouched",
    name: "ABO Blood Group",
    value: "O POSITIVE",
    loinc: null,
    flag: "abnormal",
    edited: 0,
    want: null,
  },
  {
    label: "ABO/Rh by LOINC, hand-edited",
    name: "ABORh Interpretation",
    value: "A POS",
    loinc: ABO_RH_LOINC,
    flag: "abnormal",
    edited: 1,
    want: "abnormal",
  },
  {
    label: "ABO/Rh by LOINC, untouched",
    name: "ABORh Interpretation",
    value: "A POS",
    loinc: ABO_RH_LOINC,
    flag: "abnormal",
    edited: 0,
    want: null,
  },
  {
    label: "genotype, hand-edited",
    name: "APOE Genotype",
    value: "e3/e4",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: "abnormal",
  },
  {
    label: "genotype, untouched",
    name: "APOE Genotype",
    value: "e3/e4",
    loinc: null,
    flag: "abnormal",
    edited: 0,
    want: null,
  },
  // A "high" on an identity row is as meaningless as an "abnormal" and equally the
  // user's to keep — isOutOfRange covers both, so the gate must too.
  {
    label: "blood type flagged high, hand-edited",
    name: "ABO Blood Group",
    value: "B NEGATIVE",
    loinc: null,
    flag: "high",
    edited: 1,
    want: "high",
  },
  // ── The gate reaches every VALUE-INDEPENDENT verdict (#2777) ────────────────
  // A MUTABLE context-neutral attribute is #548 §1's other half. "A urine colour is
  // never abnormal" is a fact about the analyte, not about this reading, so a hand-set
  // flag on one is as much the person's as a hand-set flag on a blood type. #2715
  // pinned these as still clearing; #2777 is the decision that reversed it.
  {
    label: "urinalysis colour, hand-edited",
    name: "Urine Color",
    value: "Yellow",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: "abnormal",
  },
  {
    label: "urinalysis colour, untouched",
    name: "Urine Color",
    value: "Yellow",
    loinc: null,
    flag: "abnormal",
    edited: 0,
    want: null,
  },
  {
    label: "morphology pattern, hand-edited",
    name: "RBC Morphology Pattern",
    value: "Pattern A",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: "abnormal",
  },
  {
    label: "morphology pattern, untouched",
    name: "RBC Morphology Pattern",
    value: "Pattern A",
    loinc: null,
    flag: "abnormal",
    edited: 0,
    want: null,
  },
  // A QC metric (#687) is value-independent for the same reason: fetal fraction is a
  // run-quality number, not a health signal, whatever it reads.
  {
    label: "fetal fraction, hand-edited",
    name: "Fetal Fraction",
    value: "8.2",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: "abnormal",
  },
  {
    label: "fetal fraction, untouched",
    name: "Fetal Fraction",
    value: "8.2",
    loinc: null,
    flag: "abnormal",
    edited: 0,
    want: null,
  },
  // ── …and no VALUE-DEPENDENT one ─────────────────────────────────────────────
  // #544's clear on an infection marker read as NEGATIVE. The app derives that verdict
  // from the value, so gating it would leave someone who corrected "Reactive" to
  // "Non-Reactive" looking at `abnormal` forever — #221's argument for re-deriving a
  // corrected numeric row's flag, one column over. Locked, and still clears.
  {
    label: "infection-negative, hand-edited",
    name: "Hepatitis B Surface Antigen",
    value: "Non-Reactive",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: null,
  },
  // An INDETERMINATE screen is polarity "neutral" too, and is deliberately out: its
  // risk call is read off the value (#687). A gate keyed on polarity would have taken
  // it; one keyed on valueIndependent does not.
  {
    label: "indeterminate screen, hand-edited",
    name: "Trisomy 18 Screen",
    value: "No Call",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: null,
  },
  // #544: an immune-positive titer still PROMOTES on an edit-locked row. The gate
  // protects what a person wrote; it never withholds a verdict from an unflagged row.
  {
    label: "immunity titer unflagged, hand-edited",
    name: "Rubella IgG",
    value: "Reactive",
    loinc: null,
    flag: null,
    edited: 1,
    want: "immune",
  },
  // #629: and a bad-polarity positive still promotes off `normal` while locked. A lock
  // is not a licence to leave an infection-positive displaying as Normal.
  {
    label: "infection-positive shown normal, hand-edited",
    name: "Hepatitis C Antibody",
    value: "Reactive",
    loinc: null,
    flag: "normal",
    edited: 1,
    want: "abnormal",
  },
];

let ids: number[];

function flagsNow(): string[] {
  const read = db.prepare("SELECT flag FROM medical_records WHERE id = ?");
  return rows.map((r, i) => {
    const got = (read.get(ids[i]) as { flag: string | null } | undefined)?.flag;
    return `${r.label}: ${got ?? "none"}`;
  });
}

const want = (): string[] => rows.map((r) => `${r.label}: ${r.want ?? "none"}`);

beforeAll(() => {
  profileId = Number(
    db
      .prepare(
        "INSERT INTO profiles (name) VALUES ('Qualitative Flag Patient')"
      )
      .run().lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, loinc, flag, edited)
     VALUES (?, '2026-04-01', 'lab', ?, ?, NULL, ?, ?, ?)`
  );
  ids = rows.map((r) =>
    Number(
      insert.run(profileId, r.name, r.value, r.loinc, r.flag, r.edited)
        .lastInsertRowid
    )
  );
});

describe("a hand-set flag on a value-independent result (#2715, #2777)", () => {
  it("survives the boot reconcile, and an untouched twin still clears", () => {
    // Move the stored signature so the gate reconciles once, as a deploy would.
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'stale-signature') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();
    reconcileFlagsIfCanonicalChanged(db);
    expect(flagsNow()).toEqual(want());
  });

  it("survives the request-time reconcile the record editor runs on save", () => {
    // updateResult writes flag + edited = 1 and calls this on the next line. Before
    // this change that save deleted the flag it had just stored, and returned ok.
    reconcileFlags(profileId, ids);
    expect(flagsNow()).toEqual(want());
  });

  it("is stable — a second pass of each writes nothing further", () => {
    // The gate must be idempotent in the direction that matters: repeated boots must
    // not erode a protected flag, and must not resurrect a cleared one.
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'stale-again') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();
    reconcileFlagsIfCanonicalChanged(db);
    reconcileFlags(profileId, ids);
    expect(flagsNow()).toEqual(want());
  });

  it.each([
    ["identity", "ABO Blood Group", "AB POSITIVE"],
    ["mutable neutral", "Urine Color", "Straw"],
  ])(
    "clears a %s row's flag once the lock is DROPPED",
    (_label, name, value) => {
      // Nothing here is a permanent exemption for the ROW — the lock is what protects
      // the flag, so a row whose lock is dropped is an extractor-guess row again.
      const id = Number(
        db
          .prepare(
            `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, flag, edited)
           VALUES (?, '2026-04-02', 'lab', ?, ?, NULL, 'abnormal', 1)`
          )
          .run(profileId, name, value).lastInsertRowid
      );
      reconcileFlags(profileId, [id]);
      const flagOf = () =>
        (
          db
            .prepare("SELECT flag FROM medical_records WHERE id = ?")
            .get(id) as { flag: string | null } | undefined
        )?.flag ?? null;
      expect(flagOf()).toBe("abnormal");

      db.prepare("UPDATE medical_records SET edited = 0 WHERE id = ?").run(id);
      reconcileFlags(profileId, [id]);
      expect(flagOf()).toBeNull();
    }
  );

  it("still clears an IMPORTED colour row's guess — the #548 §1 population is untouched", () => {
    // The clear this gate narrows exists for the extractor's coin-flip, and an
    // imported row is never edit-locked: applyImportFollowups reconciles inserted
    // records at import, before any human can have opened one. So the gate's
    // population and #548 §1's are disjoint at the door, which is why widening it
    // does not re-open #548. Simulated here as the import path does it — insert with
    // the extractor's flag and edited = 0, then reconcile the inserted ids.
    const id = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, flag, edited, source)
           VALUES (?, '2026-04-03', 'lab', 'Urine Color', 'Amber', NULL,
                   'abnormal', 0, 'extracted')`
        )
        .run(profileId).lastInsertRowid
    );
    reconcileFlags(profileId, [id]);
    expect(
      (
        db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as
          { flag: string | null } | undefined
      )?.flag
    ).toBeNull();
  });
});
