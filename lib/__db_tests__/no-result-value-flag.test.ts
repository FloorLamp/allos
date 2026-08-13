// DB INTEGRATION TIER — a value that states no result keeps no guessed flag (#2687).
//
// A stored hepatitis A row carried `flag = 'abnormal'` on a value of literally
// "See Note". "See Note" is not a result — it is a pointer to the narrative — so
// there was nothing to be abnormal about, and a red flag on a hepatitis test is a
// poor place for a false alarm. The flag came from the extractor at import, and the
// reconciler could never revisit it: `classifyQualitativeResult` returns null for an
// unclassifiable value and null meant "leave whatever is there", so the guess was
// permanent per row.
//
// This proves the STORED consequence, not only the pure verdict:
//   • the boot-time reconcile (the deploy path) clears the guessed flag, and
//   • the request-time reconcile — the one an import runs over its own inserted
//     rows — reaches the same answer, so a NEW import never mints one either, and
//   • the two rows the issue pinned side by side (a qualitative reference range and
//     a numeric one) now agree, and
//   • a genuine result on the same analyte is untouched.
//
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { reconcileFlags } from "@/lib/queries";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";

let profileId: number;
let seeNoteQualitativeRefId: number; // "See Note" against ref "Negative", flagged abnormal
let seeNoteNumericRefId: number; // "SEE NOTE" against ref "6-22", flagged abnormal
let seeNoteUnflaggedId: number; // "See Note" with no flag — nothing to clear
let realResultId: number; // "Reactive" — a genuine result, must still resolve
let ambiguousId: number; // "Equivocal" — a FINDING, the flag stays

function flagOf(id: number): string | null {
  const r = db
    .prepare("SELECT flag FROM medical_records WHERE id = ?")
    .get(id) as { flag: string | null } | undefined;
  return r?.flag ?? null;
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('No Result Patient')").run()
      .lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, reference_range,
        canonical_name, flag)
     VALUES (?, ?, 'lab', ?, ?, NULL, ?, ?, ?)`
  );
  seeNoteQualitativeRefId = Number(
    insert.run(
      profileId,
      "2026-01-02",
      "HEPATITIS A Ab/TOTAL",
      "See Note",
      "Negative",
      "Hepatitis A Antibody, Total",
      "abnormal"
    ).lastInsertRowid
  );
  seeNoteNumericRefId = Number(
    insert.run(
      profileId,
      "2026-01-03",
      "BUN/CREATININE RATIO",
      "SEE NOTE",
      "6-22",
      null,
      "abnormal"
    ).lastInsertRowid
  );
  seeNoteUnflaggedId = Number(
    insert.run(
      profileId,
      "2026-01-04",
      "HEPATITIS A Ab/TOTAL",
      "See Note",
      "Negative",
      "Hepatitis A Antibody, Total",
      null
    ).lastInsertRowid
  );
  realResultId = Number(
    insert.run(
      profileId,
      "2026-01-05",
      "HEPATITIS A Ab/TOTAL",
      "Reactive",
      "Negative",
      "Hepatitis A Antibody, Total",
      null
    ).lastInsertRowid
  );
  ambiguousId = Number(
    insert.run(
      profileId,
      "2026-01-06",
      "Some Novel Assay",
      "Equivocal",
      null,
      null,
      "abnormal"
    ).lastInsertRowid
  );
});

describe("a stored value that states no result (#2687)", () => {
  it("the boot reconcile clears the extractor's guess on both reference-range shapes", () => {
    // Move the stored signature so the gate reconciles once, as a deploy would. The
    // FLAG_LOGIC_VERSION bump that ships with this change is what makes a real
    // install do the same on its next boot.
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'stale-signature') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();
    reconcileFlagsIfCanonicalChanged(db);

    // The two rows the issue pinned: same non-result value, and they now agree.
    expect(flagOf(seeNoteQualitativeRefId)).toBeNull();
    expect(flagOf(seeNoteNumericRefId)).toBeNull();
  });

  it("leaves an unflagged non-result alone and a genuine result correctly resolved", () => {
    // Nothing to clear — the pass invents no flag for a value that states nothing.
    expect(flagOf(seeNoteUnflaggedId)).toBeNull();
    // The same analyte with a real result still promotes to "immune" (#544): the new
    // class widens nothing.
    expect(flagOf(realResultId)).toBe("immune");
    // An AMBIGUOUS finding is a finding. The assay ran and reported one, so the
    // extractor's flag is preserved — the #549 conservatism this change keeps.
    expect(flagOf(ambiguousId)).toBe("abnormal");
  });

  it("the request-time reconcile an import runs reaches the same answer", () => {
    // applyImportFollowups → reconcileFlags(profileId, insertedIds) is what runs over
    // a freshly imported document, so this is the path that stops a NEW row from
    // acquiring a permanent guess in the first place.
    const id = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, reference_range,
              canonical_name, flag)
           VALUES (?, '2026-02-01', 'lab', 'HEPATITIS A Ab/TOTAL', 'See Note', NULL,
                   'Negative', 'Hepatitis A Antibody, Total', 'abnormal')`
        )
        .run(profileId).lastInsertRowid
    );
    expect(flagOf(id)).toBe("abnormal");
    reconcileFlags(profileId, [id]);
    expect(flagOf(id)).toBeNull();
  });
});
