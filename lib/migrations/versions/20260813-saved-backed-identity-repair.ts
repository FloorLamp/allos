import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { createLogger } from "../../log";
import { biomarkerFamily } from "../../canonical-name";
import { NON_IDENTITY_CATEGORIES } from "../../medical-categories";

// Issue #2673 — undo the watch-stars `20260812-saved-biomarker-backed` wrongly
// marked as backed.
//
// WHAT WENT WRONG. `backed` (#2623) records whether a reading has EVER stood behind
// a biomarker star, and it is the ONE thing standing between a watch — "star it now,
// measure it later" — and `cleanupOrphanSavedBiomarkers`' DELETE. Its one-shot
// backfill decided that from every `medical_records` row carrying a non-blank
// `canonical_name`, and omitted the filter every runtime consumer of the column
// applies: `category NOT IN (NON_IDENTITY_CATEGORIES)` (`IDENTITY_CATEGORY_SQL`,
// lib/queries/medical.ts). Its own header says it is matching the sweep's PROMOTE
// query, and on that one clause it did not.
//
// An `assessment` row legitimately carries a `canonical_name` on a post-177
// database — lib/assessment-reclass-db.ts keeps it as provenance on a re-homed row
// — and an `assessment` carries NO result identity (#2318). So a star whose only
// family member in `medical_records` was an assessment came out of the backfill
// with `backed = 1`: the watch amnesty gone, the star now eligible for the sweep's
// DELETE at the next unrelated record delete anywhere in the profile. That is the
// exact failure #2623 shipped the column to prevent, reintroduced in the backfill
// — and #2318 is the same class of bug one surface over.
//
// WHY A FORWARD REPAIR RATHER THAN A FIX IN PLACE. The backfill is shipped and
// hash-locked by lib/migrations/manifest.json. Correcting its query would also
// help nobody: it is one-shot, so every database that already applied it carries
// the wrong marks regardless. (A FRESH database is unharmed either way — it reaches
// the backfill with no `saved_items` rows at all and takes its early return, which
// is also why no test caught this.) The repair is the migration 184 / cascade-orphan
// shape: fix the damage forward, leave the frozen file alone.
//
// WHAT THIS TOUCHES, exactly. A biomarker star with `backed = 1` whose family has
// NO identity-carrying `medical_records` row in its profile, but DOES have a
// non-identity one carrying a canonical name — the backfill's signature and nothing
// else. Two neighbours are deliberately left alone:
//
//   • A star with no family row of ANY kind. The buggy query never matched it, so
//     it is still `backed = 0` and is not this defect's blast radius.
//   • A star whose identity-carrying readings were deleted since. That is a GENUINE
//     orphan the sweep should still take, and un-backing it would grant an amnesty
//     the user never earned.
//
// The move is only ever 1 → 0. `backed` is a claim about the past, so making it
// smaller can lose nothing a reading actually justified — and the direction matters:
// a star wrongly left at 1 is silently deleted, a star wrongly reset to 0 is only
// preserved, and it is promoted back to 1 by the sweep the moment a real reading
// arrives. Preserving a user's tap is the side to err on, which is the side #2623
// picked for the same reason.
//
// The family collapse runs in TS for the reason the backfill states: the
// `biomarker_family()` SQL function is registered on the RUNTIME connection, and
// the migration runner's tests apply migrations to a bare handle that has never
// seen it. The category filter runs in SQL, bound from the live registry so that a
// category joining NON_IDENTITY_CATEGORIES reaches this the same way it reaches
// every runtime consumer.
//
// NO SCHEMA CHANGE and NO DELETE — this only ever writes `backed = 0`, so it
// declares no CHILD_LINKS: a probe guarding a delete that cannot happen is the
// #2444 defect, not a guard against it.
//
// Idempotent: a second run finds nothing left to reset.
//
// AND IT SAYS WHAT IT DID. This rewrites USER CURATION — the state behind someone's
// star — at boot, once, with no undo. The only run that matters is the one that
// actually changed a row on a real install, so every run emits a line, including
// the empty one, because "this ran and found nothing" is the other half of the
// trail (the #2696 precedent: a boot-time write that records nothing cannot be
// audited afterwards). Star KEYS are the user's own analyte names and are not
// logged; the count and the profiles are.

const log = createLogger("migrate");

interface StarRow {
  id: number;
  profile_id: number;
  key: string;
}

interface NameRow {
  profile_id: number;
  n: string;
}

function familySet(rows: readonly NameRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) out.add(`${r.profile_id} ${biomarkerFamily(r.n)}`);
  return out;
}

export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(saved_items)").all() as {
    name: string;
  }[];
  // Defensive only against an out-of-order dev database: on any database that has
  // applied 20260812-saved-biomarker-backed the column is there, and with no column
  // there is no wrong mark to undo.
  if (!cols.some((c) => c.name === "backed")) return;

  const stars = db
    .prepare(
      `SELECT id, profile_id, key FROM saved_items
        WHERE kind = 'biomarker' AND backed = 1`
    )
    .all() as StarRow[];
  if (stars.length === 0) {
    log.info(
      "20260813-saved-backed-identity-repair: no backed biomarker stars, nothing to check"
    );
    return;
  }

  const named = `canonical_name IS NOT NULL AND TRIM(canonical_name) != ''`;
  const nameExpr = `COALESCE(NULLIF(TRIM(canonical_name), ''), name) AS n`;
  const placeholders = NON_IDENTITY_CATEGORIES.map(() => "?").join(",");

  // What a reading of this family would have to be to justify `backed = 1` — the
  // sweep's own test.
  const identity = familySet(
    db
      .prepare(
        `SELECT profile_id, ${nameExpr} FROM medical_records
          WHERE ${named} AND category NOT IN (${placeholders})`
      )
      .all(...NON_IDENTITY_CATEGORIES) as NameRow[]
  );
  // What the buggy backfill accepted instead.
  const nonIdentity = familySet(
    db
      .prepare(
        `SELECT profile_id, ${nameExpr} FROM medical_records
          WHERE ${named} AND category IN (${placeholders})`
      )
      .all(...NON_IDENTITY_CATEGORIES) as NameRow[]
  );

  const reset = db.prepare("UPDATE saved_items SET backed = 0 WHERE id = ?");
  const profiles = new Set<number>();
  let rows = 0;
  const run = db.transaction(() => {
    for (const s of stars) {
      const family = `${s.profile_id} ${biomarkerFamily(s.key)}`;
      if (identity.has(family)) continue;
      if (!nonIdentity.has(family)) continue;
      reset.run(s.id);
      profiles.add(s.profile_id);
      rows += 1;
    }
  });
  run.immediate();

  if (rows === 0) {
    log.info(
      "20260813-saved-backed-identity-repair: every backed biomarker star has a real reading behind it, nothing reset"
    );
    return;
  }
  // WARN, not info: user-owned curation was rewritten and the operator has no other
  // record of it.
  log.warn(
    `20260813-saved-backed-identity-repair: reset ${rows} biomarker star(s) to ` +
      `backed = 0 whose only backing record carries no result identity (#2673)`,
    { rows, profiles: [...profiles].sort((a, b) => a - b) }
  );
}

export const migration: Migration = {
  name: "20260813-saved-backed-identity-repair",
  up,
};
