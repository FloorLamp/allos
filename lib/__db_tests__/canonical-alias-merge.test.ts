// DB INTEGRATION TIER — the #2306 acceptance criterion, end to end through a REAL
// boot (bootTasks), not through the merge function in isolation:
//
//   "Adding a CANONICAL_ALIASES route for a spelling already present as an ai-coined
//    vocabulary row resolves that spelling — in the vocabulary, in newly imported
//    rows, AND in already-stored rows — after ONE boot, with no manual DB edit and
//    no re-import."
//
// The fixture is a database in the state the issue describes: it imported the
// drifted spelling BEFORE the curated route shipped, so the spelling sits in
// canonical_biomarkers as an `ai` row and buildCanonicalIndex drops the route that
// exists to retire it. The "before" assertions PIN that defect; the "after" ones pin
// the repair. Both use the routes that actually ship:
//
//   • BLOCKED  — "Occult Blood, Urine" → "Blood, Urine" (a curated CANONICAL_ALIASES
//     route, dead on arrival while the ai row owns its key).
//   • SHADOWED — "Hyaline Casts, Urine" beside the curated "Casts, Hyaline, Urine".
//     One key, two spellings; snapCanonicalName already resolved it for fresh imports,
//     but the rows stored before the curated entry existed kept the losing spelling.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { bootTasks } from "@/lib/migrations/boot-tasks";
import { mergeSupersededCanonicalNames } from "@/lib/canonical-alias-merge-db";
import { getCanonicalVocabulary } from "@/lib/queries";
import { snapCanonicalName } from "@/lib/canonical-name";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "@/lib/dismissal-keys";
import { biomarkerCoverageKey } from "@/lib/coverage-gaps";

const BLOCKED = "Occult Blood, Urine";
const BLOCKED_TARGET = "Blood, Urine";
const SHADOWED = "Hyaline Casts, Urine";
const SHADOWED_TARGET = "Casts, Hyaline, Urine";
const DATE = "2019-03-04";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The state an import leaves behind: the extractor's spelling registered as an
// ai-coined vocabulary row (addCanonicalNames' INSERT OR IGNORE, verbatim).
function coinVocabulary(name: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO canonical_biomarkers (name, source) VALUES (?, 'ai')"
  ).run(name);
}

function addReading(profileId: number, canonical: string, value: string): void {
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, canonical_name, value)
     VALUES (?, ?, 'lab', ?, ?, ?)`
  ).run(profileId, DATE, canonical, canonical, value);
}

function storedNames(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT canonical_name AS n FROM medical_records
          WHERE profile_id = ? ORDER BY canonical_name, id`
      )
      .all(profileId) as { n: string }[]
  ).map((r) => r.n);
}

function vocabularyHas(name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM canonical_biomarkers WHERE name = ?")
      .get(name) as unknown
  );
}

function stars(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT key FROM saved_items WHERE profile_id = ? AND kind = 'biomarker' ORDER BY key"
      )
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);
}

function dismissals(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? ORDER BY signal_key"
      )
      .all(profileId) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

describe("one boot resolves an alias its own database had blocked (#2306)", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile("ALIAS-MERGE");
    coinVocabulary(BLOCKED);
    coinVocabulary(SHADOWED);
  });

  it("BEFORE: the ai-coined row shadows the curated route, so the route is inert", () => {
    const vocab = getCanonicalVocabulary();
    expect(vocab).toContain(BLOCKED);
    // The defect, stated: the route exists and its target is right there, and the
    // snap still returns the drifted spelling unchanged.
    expect(vocab).toContain(BLOCKED_TARGET);
    expect(snapCanonicalName(BLOCKED, vocab)).toBe(BLOCKED);
  });

  it("AFTER one boot: vocabulary, fresh snaps, and STORED rows all resolve", () => {
    // Two readings stranded on the blocked spelling, one already on the real series.
    addReading(profileId, BLOCKED, "negative");
    addReading(profileId, BLOCKED, "trace");
    addReading(profileId, BLOCKED_TARGET, "negative");
    // The shadowed fork: two stored under the losing spelling, one under a spelling
    // that never had a vocabulary row of its own at all, one on the curated entry.
    addReading(profileId, SHADOWED, "0-2");
    addReading(profileId, SHADOWED, "1-3");
    addReading(profileId, "Urine Hyaline Casts", "0-1");
    addReading(profileId, SHADOWED_TARGET, "0-4");

    bootTasks(db);

    // 1. the vocabulary no longer offers the superseded spellings to the extractor
    const vocab = getCanonicalVocabulary();
    expect(vocab).not.toContain(BLOCKED);
    expect(vocab).not.toContain(SHADOWED);
    expect(vocabularyHas(BLOCKED)).toBe(false);
    // 2. a NEWLY imported row snaps onto the target (this is exactly what the import
    //    path does: buildCanonicalIndex(getCanonicalVocabulary()))
    expect(snapCanonicalName(BLOCKED, vocab)).toBe(BLOCKED_TARGET);
    expect(snapCanonicalName(SHADOWED, vocab)).toBe(SHADOWED_TARGET);
    // 3. the ALREADY-STORED rows joined their series — the retroactive half
    expect(storedNames(profileId)).toEqual([
      BLOCKED_TARGET,
      BLOCKED_TARGET,
      BLOCKED_TARGET,
      SHADOWED_TARGET,
      SHADOWED_TARGET,
      SHADOWED_TARGET,
      SHADOWED_TARGET,
    ]);
    // 4. the curated targets themselves are untouched
    expect(vocabularyHas(BLOCKED_TARGET)).toBe(true);
    expect(vocabularyHas(SHADOWED_TARGET)).toBe(true);
  });

  it("is idempotent — a second boot finds nothing left to move", () => {
    addReading(profileId, BLOCKED, "negative");
    bootTasks(db);
    const after = storedNames(profileId);
    bootTasks(db);
    expect(storedNames(profileId)).toEqual(after);
    expect(after).toEqual([BLOCKED_TARGET]);
  });

  it("never deletes a curated row, even one shadowed by another curated spelling", () => {
    const curatedBefore = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM canonical_biomarkers WHERE source = 'seed'"
        )
        .get() as { c: number }
    ).c;
    bootTasks(db);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM canonical_biomarkers WHERE source = 'seed'"
          )
          .get() as { c: number }
      ).c
    ).toBe(curatedBefore);
  });
});

describe("the rename carries every piece of name-keyed side-state", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile("ALIAS-SIDE-STATE");
    coinVocabulary(BLOCKED);
    addReading(profileId, BLOCKED, "trace");
  });

  it("moves the ★ save onto the target and drops a redundant old pin", () => {
    db.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
    ).run(profileId, BLOCKED);
    mergeSupersededCanonicalNames(db);
    expect(stars(profileId)).toEqual([BLOCKED_TARGET]);
  });

  it("collapses onto an existing pin rather than leaving the profile two", () => {
    for (const key of [BLOCKED, BLOCKED_TARGET])
      db.prepare(
        "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
      ).run(profileId, key);
    mergeSupersededCanonicalNames(db);
    expect(stars(profileId)).toEqual([BLOCKED_TARGET]);
  });

  it("re-keys the retest snooze and the flagged-result acknowledgment", () => {
    for (const key of [
      biomarkerDismissalKey(BLOCKED),
      biomarkerFlagDismissalKey(BLOCKED),
    ])
      db.prepare(
        `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until)
         VALUES (?, ?, '2999-01-01')`
      ).run(profileId, key);
    mergeSupersededCanonicalNames(db);
    expect(dismissals(profileId)).toEqual(
      [
        biomarkerDismissalKey(BLOCKED_TARGET),
        biomarkerFlagDismissalKey(BLOCKED_TARGET),
      ].sort()
    );
  });

  it("re-points a biomarker-linked goal at the surviving spelling", () => {
    db.prepare(
      `INSERT INTO goals (profile_id, title, biomarker_name, target_direction, target_value)
       VALUES (?, 'Fictional goal', ?, 'below', 1)`
    ).run(profileId, BLOCKED);
    mergeSupersededCanonicalNames(db);
    expect(
      (
        db
          .prepare("SELECT biomarker_name AS n FROM goals WHERE profile_id = ?")
          .get(profileId) as { n: string }
      ).n
    ).toBe(BLOCKED_TARGET);
  });

  it("re-keys a tracked coverage gap so it stops naming an analyte nobody has", () => {
    db.prepare(
      `INSERT INTO coverage_gaps (profile_id, kind, item_key, label)
       VALUES (?, 'biomarker', ?, ?)`
    ).run(profileId, biomarkerCoverageKey(BLOCKED), BLOCKED);
    mergeSupersededCanonicalNames(db);
    expect(
      db
        .prepare(
          "SELECT item_key, label FROM coverage_gaps WHERE profile_id = ? AND kind = 'biomarker'"
        )
        .get(profileId)
    ).toEqual({
      item_key: biomarkerCoverageKey(BLOCKED_TARGET),
      label: BLOCKED_TARGET,
    });
  });

  it("rewrites a protocol's biomarker outcome key so the link survives the rename", () => {
    db.prepare(
      `INSERT INTO protocols (profile_id, name, start_date, outcome_keys)
       VALUES (?, 'Fictional protocol', ?, ?)`
    ).run(profileId, DATE, JSON.stringify([`biomarker:${BLOCKED}`]));
    mergeSupersededCanonicalNames(db);
    expect(
      (
        db
          .prepare(
            "SELECT outcome_keys AS k FROM protocols WHERE profile_id = ?"
          )
          .get(profileId) as { k: string }
      ).k
    ).toBe(JSON.stringify([`biomarker:${BLOCKED_TARGET}`]));
  });

  it("never crosses the profile boundary", () => {
    const other = newProfile("ALIAS-OTHER");
    addReading(other, BLOCKED, "negative");
    db.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
    ).run(profileId, BLOCKED);
    db.prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
    ).run(other, BLOCKED_TARGET);
    mergeSupersededCanonicalNames(db);
    // Each profile's rows moved under its OWN id; neither inherited the other's pin.
    expect(stars(profileId)).toEqual([BLOCKED_TARGET]);
    expect(stars(other)).toEqual([BLOCKED_TARGET]);
    expect(storedNames(other)).toEqual([BLOCKED_TARGET]);
  });
});

describe("the flag reconcile is re-armed only when something actually moved", () => {
  it("clears the stored canonical-flags signature after a merge", () => {
    const profileId = newProfile("ALIAS-FLAGS");
    coinVocabulary(BLOCKED);
    addReading(profileId, BLOCKED, "trace");
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'stale-sentinel')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();

    const report = mergeSupersededCanonicalNames(db);
    expect(report.vocabulary).toEqual([{ from: BLOCKED, to: BLOCKED_TARGET }]);
    // Cleared, so reconcileFlagsIfCanonicalChanged (next in bootTasks) re-derives the
    // flags of readings that just landed on a curated band for the first time.
    expect(
      db
        .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
        .get()
    ).toBeUndefined();
  });

  it("leaves the signature alone on a boot with no drift to repair", () => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', 'keep-me')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    const report = mergeSupersededCanonicalNames(db);
    expect(report.vocabulary).toEqual([]);
    expect(report.renames).toEqual([]);
    expect(
      (
        db
          .prepare(
            "SELECT value AS v FROM settings WHERE key = 'canonical_flags_sig'"
          )
          .get() as { v: string }
      ).v
    ).toBe("keep-me");
  });
});
