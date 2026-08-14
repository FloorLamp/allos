// Reconcile each record's flag against our canonical ranges: clinical high/low
// from the reference range (overriding an over-strict or missing lab flag),
// non-optimal from the optimal band, cleared when optimal — so the stored flag
// never contradicts the live-computed status. Never touches 'abnormal'
// (qualitative). Pass `ids` to limit the scan to specific rows (e.g. a
// just-imported batch); omit to evaluate all eligible rows. Returns the number
// of rows whose flag changed.
// The profile-level context both flag passes judge against: sex + birthdate /
// stored age (age-banded ranges), reproductive status and the cycle log (#718),
// and the canonical table preloaded as a NOCASE map. Shared by reconcileFlags and
// its preview twin below so the two can never read different context.
//
// Exported since #2315: a row that STATES the bands its flag came from has to
// resolve them from the identical context, or the statement is the very
// disagreement the issue is about. lib/queries/metric-judgment.ts reads it.
export function flagReconcileProfileContext(profileId: number) {
  const cbRows = db
    .prepare("SELECT * FROM canonical_biomarkers")
    .all() as CanonicalResultDefinition[];
  const cbByName = new Map(cbRows.map((c) => [c.name.toLowerCase(), c]));
  // Alias-aware resolution: the pure core looks a row's canonical_name up by exact
  // (lowercased) name, so a stored row whose canonical_name is a legacy spelling or
  // an un-migrated bare abbreviation (e.g. "RDW" before migration 103 runs) would
  // silently MISS its entry and lose its band. Snap it onto the dataset spelling
  // first via the shared (cached) resolver — recognized aliases/variants resolve; an
  // unrecognized name returns unchanged (→ still no match → no flag, exactly as
  // before). The SAME resolver the derived-index gathering uses, so both read paths
  // are uniformly alias-aware, and the ~300-entry index is cached per vocabulary
  // rather than rebuilt per call. Makes a future rename not require a data migration.
  const resolve = canonicalResolver();
  return {
    cbByName,
    resolve,
    ctx: {
      sex: getProfileSex(profileId),
      birthdate: getProfileBirthdate(profileId),
      age: getStoredAge(profileId),
      reproductiveStatus: getProfileReproductiveStatus(profileId),
      periods: listCyclePeriods(profileId),
      // The profile-LOCAL day the cycle log is read against (#2613). The phase
      // derivation refuses a date after it, so a record dated ahead of today —
      // a typo, or a document whose collection date parsed wrong — derives no
      // phase and falls back to the coarse status proxy, instead of being
      // judged against a phase range nobody could have been in yet. Resolved
      // from the profile's own timezone, never the host's UTC day.
      today: today(profileId),
    },
  };
}

// The flag values reconcileFlags is allowed to revisit — a derived/range flag. A
// qualitative 'abnormal'/'immune' etc. from the numeric pass's view is left alone.
//
// #2777 asked whether the NUMERIC pass should acquire the qualitative pass's edit-lock
// gate, given it has none and `abnormal` is missing from this set. It should not, and
// the two facts are the same fact seen twice. This set is the numeric pass's OWN
// vocabulary: high / low / normal / non-optimal* are what it derives from a value and a
// band, so it may revisit them — and MUST, because #221 requires a corrected value to
// re-derive its flag (the correction stamps `edited = 1` on the same write, so a lock
// here would freeze the old "high" on a blood pressure someone just fixed). `abnormal`
// and `immune` are not in its vocabulary at all: it cannot produce them, so it cannot
// restate them, so it declines to touch a row carrying one. That is already the edit
// lock's protection arrived at from the other side — a hand-set `abnormal` on a NUMERIC
// row has never been at risk from this pass, with or without a lock.
//
// Which leaves the QUALITATIVE pass as the only place a hand-set `abnormal` can be
// deleted, because it is the pass that owns that word. It is the odd one out for a
// reason, and the gate it carries (lib/reference-range/qualitative.ts, #2712/#2715/
// #2777) draws the same line this set draws: revisit what you can restate, leave alone
// what you cannot. Nothing to change here.
const RECONCILABLE_FLAGS = new Set([
  "normal",
  "non-optimal",
  "non-optimal-high",
  "non-optimal-low",
  "high",
  "low",
]);

// Preview twin of reconcileFlags: derive the flags the post-commit reconcile WILL
// write for a NOT-yet-persisted batch of records (the reprocess preview's fresh
// extraction), mutating each record's `flag` in place. Without this, the preview
// diff compares post-follow-up persisted rows against pre-follow-up extraction, so
// every app-derived flag (age-banded vitals, optimal bands, titer "immune") reads
// as a phantom "flag → none" change on a byte-identical reprocess. Same
// eligibility gates and the same pure cores (computeFlagReconciliation /
// computeQualitativeFlagChanges) as reconcileFlags, so preview and commit can't
// drift.
export function previewReconcileFlags(
  profileId: number,
  records: PersistInput["records"]
): void {
  if (records.length === 0) return;
  const { cbByName, ctx, resolve } = flagReconcileProfileContext(profileId);
  const numericRows = records.flatMap((r, i) =>
    r.canonical?.trim() &&
    r.value_num != null &&
    (r.flag == null || RECONCILABLE_FLAGS.has(r.flag))
      ? [
          {
            id: i,
            value_num: r.value_num,
            unit: r.unit,
            canonical_name: resolve(r.canonical),
            flag: r.flag,
            date: r.date,
            reference: r.reference_range,
          },
        ]
      : []
  );
  const qualRows = records.flatMap((r, i) =>
    r.value_num == null && (r.category === "lab" || r.category === "biomarker")
      ? [
          {
            id: i,
            name: resolve(r.canonical?.trim() || r.name),
            value: r.value,
            notes: r.notes,
            reference: r.reference_range,
            flag: r.flag,
            loinc: r.loinc,
          },
        ]
      : []
  );
  for (const c of [
    ...computeFlagReconciliation(numericRows, cbByName, ctx),
    ...computeQualitativeFlagChanges(qualRows),
  ]) {
    records[c.id].flag = c.flag as PersistInput["records"][number]["flag"];
  }
}

export function reconcileFlags(profileId: number, ids?: number[]): number {
  // profile_id scopes every row, so an id from another profile in `ids` simply
  // can't match — the caller's list is never trusted on its own.
  // The revisitable-flag set is the SAME constant the preview twin gates on
  // (RECONCILABLE_FLAGS — fixed app-controlled tokens, safe to inline in SQL), so
  // the two eligibility checks cannot drift.
  const reconcilable = [...RECONCILABLE_FLAGS].map((f) => `'${f}'`).join(",");
  let sql = `SELECT id, value_num, unit, canonical_name, flag, date, reference_range FROM medical_records
     WHERE profile_id = ? AND canonical_name IS NOT NULL AND value_num IS NOT NULL
       AND (flag IS NULL OR flag IN (${reconcilable}))`;
  const args: number[] = [profileId];
  if (ids) {
    if (ids.length === 0) return 0;
    sql += ` AND id IN (${ids.map(() => "?").join(",")})`;
    args.push(...ids);
  }
  // Sex/age/cycle context + the preloaded canonical map + alias-aware resolve —
  // shared with the preview twin (flagReconcileProfileContext) so both judge against
  // identical context AND resolve names the same way.
  const { cbByName, ctx, resolve } = flagReconcileProfileContext(profileId);

  const rows = (
    db.prepare(sql).all(...args) as {
      id: number;
      value_num: number;
      unit: string | null;
      canonical_name: string;
      flag: string | null;
      date: string;
      reference_range: string | null;
    }[]
  ).map((r) => ({
    ...r,
    canonical_name: resolve(r.canonical_name),
    reference: r.reference_range,
  }));

  // The per-row flag-derivation is the pure shared decision (lib/flag-reconcile).
  const changes = computeFlagReconciliation(rows, cbByName, ctx);
  // Qualitative pass (#549): the numeric reconcile above bails on value_num IS NULL,
  // so a qualitative value's extractor-guessed flag is never revisited. Route those
  // rows through the shared classifier — promote a durable-immunity titer to "immune"
  // (#544), clear a blunt "abnormal" on a context-neutral attribute like a blood type
  // (#548 §1) — leaving infection markers + unrecognized values alone. Same profile
  // scoping and optional id filter as the numeric pass.
  // `edited` rides along for the hand-edit gate on the two flag-DELETING transitions —
  // the #2687 no-result clear (#2712 R3) and the #548 §1 clear on an identity-class row
  // (#2715): updateResult writes the user's chosen flag AND edited = 1, then calls this
  // on the very next line, so without it the save silently deletes the flag it just
  // stored. The column is already in this SELECT, so the identity gate costs no query.
  let qsql = `SELECT id, canonical_name, name, value, notes, reference_range, flag, loinc, edited
     FROM medical_records
     WHERE profile_id = ? AND value_num IS NULL AND category IN ('lab','biomarker')`;
  const qargs: number[] = [profileId];
  if (ids) {
    qsql += ` AND id IN (${ids.map(() => "?").join(",")})`;
    qargs.push(...ids);
  }
  const qrows = (
    db.prepare(qsql).all(...qargs) as {
      id: number;
      canonical_name: string | null;
      name: string;
      value: string | null;
      notes: string | null;
      reference_range: string | null;
      flag: string | null;
      loinc: string | null;
      edited: number | null;
    }[]
  ).map((r) => ({
    id: r.id,
    name: resolve(r.canonical_name?.trim() || r.name),
    value: r.value,
    notes: r.notes,
    reference: r.reference_range,
    flag: r.flag,
    loinc: r.loinc,
    edited: r.edited,
  }));
  const qChanges = computeQualitativeFlagChanges(qrows);

  const setFlag = db.prepare(
    "UPDATE medical_records SET flag = ? WHERE id = ?"
  );
  const clear = db.prepare(
    "UPDATE medical_records SET flag = NULL WHERE id = ?"
  );
  writeTx(() => {
    for (const c of [...changes, ...qChanges]) {
      if (c.flag === null) clear.run(c.id);
      else setFlag.run(c.flag, c.id);
    }
  });
  return changes.length + qChanges.length;
}
import { canonicalResolver } from "../../canonical-resolve";
import { listCyclePeriods } from "../../cycle-store";
import { db, today, writeTx } from "../../db";
import {
  computeFlagReconciliation,
  computeQualitativeFlagChanges,
} from "../../flag-reconcile";
import type { PersistInput } from "../../import-shape";
import {
  getStoredAge,
  getProfileBirthdate,
  getProfileReproductiveStatus,
  getProfileSex,
} from "../../settings";
import type { CanonicalResultDefinition } from "../../types";
