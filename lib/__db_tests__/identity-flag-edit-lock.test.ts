// DB INTEGRATION TIER — a hand-set flag on an identity-class result survives (#2715).
//
// `isEditLocked(medical_records.edited)` means a person has been in the row through
// the record editor and set a value by hand. #2712 taught the #2687 no-result clear to
// respect it. The IDENTITY branch — blood type, ABO/Rh, genotype — never consulted it,
// so the #548 §1 clear deleted a hand-set "abnormal" on such a row with no indication
// to the user. That clear exists to remove an EXTRACTOR GUESS on a value that cannot be
// abnormal; on an edit-locked row the flag is not a guess.
//
// The pure verdict is pinned in lib/__tests__/reference-range.test.ts. What is pinned
// HERE is the stored consequence, over both passes that write flags:
//
//   • the BOOT reconcile (reconcileFlagsIfCanonicalChanged — the deploy path the issue
//     names), and
//   • the REQUEST-TIME reconcile (reconcileFlags), which is the sharper repro: the
//     record editor's updateResult writes the user's chosen flag AND edited = 1, then
//     calls reconcileFlags on the very next line, so before this change the save
//     returned {ok:true} with the flag already deleted.
//
// Every case is asserted BOTH ways round. A test that only proves the new behaviour
// cannot tell you whether the old one broke, and the old one — clearing the extractor's
// guess on an UNTOUCHED identity row — is #548 §1 and must be untouched. So each locked
// row has an otherwise-identical unlocked twin, and the mutable-neutral and immunity
// classes are carried alongside to prove the reach did not widen past identity.
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
  // ── The reach did NOT widen past identity ────────────────────────────────────
  // A MUTABLE context-neutral attribute is #548 §1's other half (`immutable: false`).
  // Its guessed flag still clears even when the row is edit-locked.
  {
    label: "urinalysis colour, hand-edited",
    name: "Urine Color",
    value: "Yellow",
    loinc: null,
    flag: "abnormal",
    edited: 1,
    want: null,
  },
  {
    label: "morphology pattern, hand-edited",
    name: "RBC Morphology Pattern",
    value: "Pattern A",
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
      .prepare("INSERT INTO profiles (name) VALUES ('Identity Flag Patient')")
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

describe("a hand-set flag on an identity-class result (#2715)", () => {
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

  it("clears a flag a person sets on an identity row and then UNLOCKS", () => {
    // Nothing here is a permanent exemption for the ROW — the lock is what protects
    // the flag, so a row whose lock is dropped is an extractor-guess row again.
    const id = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, flag, edited)
           VALUES (?, '2026-04-02', 'lab', 'ABO Blood Group', 'AB POSITIVE', NULL,
                   'abnormal', 1)`
        )
        .run(profileId).lastInsertRowid
    );
    reconcileFlags(profileId, [id]);
    const flagOf = () =>
      (
        db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as
          { flag: string | null } | undefined
      )?.flag ?? null;
    expect(flagOf()).toBe("abnormal");

    db.prepare("UPDATE medical_records SET edited = 0 WHERE id = ?").run(id);
    reconcileFlags(profileId, [id]);
    expect(flagOf()).toBeNull();
  });
});
