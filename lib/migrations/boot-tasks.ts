import type Database from "better-sqlite3";
import crypto from "node:crypto";
import canonicalSeed from "../canonical-biomarkers.json";
import { computeFlagReconciliation } from "../flag-reconcile";
import { canonicalFlagsSignature } from "../canonical-flags-version";
import { hashPasswordSync } from "../password";
import { runBootTx } from "./schema-utils";

// PER-BOOT TASKS (issue #119). These run on EVERY process start, AFTER the
// versioned migration runner (lib/migrations/runner.ts) has brought the schema to
// the current version. They are deliberately NOT schema migrations — each must
// re-apply its effect every boot — so they live here, outside the version-gated
// runner and outside the frozen baseline:
//
//   • bootstrapAuth              — env-dependent (ADMIN_USERNAME/ADMIN_PASSWORD);
//                                  creates the bootstrap admin/profile only when
//                                  missing. Env-dependent => never deterministic,
//                                  so it can't be a frozen migration.
//   • seedCanonicalBiomarkers    — re-UPSERTs canonical_biomarkers from the
//                                  committed JSON so a range edit shipped in a
//                                  release with NO schema change still propagates
//                                  to existing DBs on the next boot. Same
//                                  "ranges can change without a schema change"
//                                  reasoning the spec gives for the flag reconcile
//                                  below — the seed is that reconcile's data side,
//                                  so it stays per-boot too.
//   • reconcileFlagsIfCanonical… — gated on the canonical-flags-version content
//                                  signature, not the schema version.
//   • stuck-state cleanup        — resets extraction/import rows a crash left mid-
//                                  flight; must run on every process start.
//   • seedTimezoneFromEnv        — env-dependent first-boot seeding.
//
// (The old boot path also carried backfillProfileIds, adopting legacy
// NULL-profile_id rows onto profile 1. On the current schema every owned table is
// born profile_id NOT NULL and every write path supplies it, so NULL rows cannot
// exist and the task was dropped with the rest of the legacy upgrade machinery.)
//
// Order matters only in that bootstrapAuth (profile 1) and seedCanonicalBiomarkers
// (the canonical_biomarkers rows) must precede the flag reconcile, which reads
// both. This mirrors the relative order these calls had in the pre-runner
// migrate() tail.
export function bootTasks(db: Database.Database): void {
  // First-run auth bootstrap: create the initial admin login + its profile so a
  // fresh database is usable behind the login gate, and so profile 1 exists
  // before the flag reconcile references it.
  bootstrapAuth(db);

  // Re-sync the canonical_biomarkers table from the committed JSON so range edits
  // propagate to existing DBs on boot (see the module header).
  seedCanonicalBiomarkers(db);

  // Re-derive every record's flag against the canonical ranges, but only when
  // those ranges (or the flag-derivation logic) have actually changed since the
  // last run — so editing lib/canonical-biomarkers.json propagates to existing
  // records on the next boot, without a full re-scan on every startup.
  reconcileFlagsIfCanonicalChanged(db);

  // Background extraction runs in-process. A fresh process can't have any
  // extraction in flight, so any doc left mid-extraction was interrupted by a
  // restart/crash — mark it failed rather than leaving it stuck on 'processing'.
  db.exec(
    `UPDATE medical_documents
       SET extraction_status = 'failed',
           extraction_error = 'Extraction was interrupted (server restarted). Delete and re-upload to retry.'
     WHERE extraction_status IN ('processing','pending')`
  );

  // Same for async paste/CSV import jobs left mid-extraction by a restart/crash:
  // mark them failed rather than leaving them stuck spinning on 'processing'.
  db.exec(
    `UPDATE import_jobs
       SET status = 'failed',
           error = 'Extraction was interrupted (server restarted). Discard and try again.',
           updated_at = datetime('now')
     WHERE status = 'processing'`
  );

  // And for jobs a crash stranded mid-commit (issue #323). commitImportJob claims a
  // job by flipping 'ready' → 'committing' before writing rows; a crash between that
  // claim and the row-delete would strand it in 'committing' forever — it can't be
  // re-claimed (the claim requires status='ready') and only a manual Discard exits.
  // Reap it to 'failed' with an explanatory error, mirroring the 'processing' reset.
  // We do NOT revert to 'ready' for auto-retry: the crash may have landed after the
  // inner commit transaction (data already imported), so the safe move is to fail it
  // and let the user review — a deliberate re-import is deduped by the importers.
  db.exec(
    `UPDATE import_jobs
       SET status = 'failed',
           error = 'Saving this import was interrupted (server restarted). Some or all of its data may already have been imported — check your data before retrying, then discard this job.',
           updated_at = datetime('now')
     WHERE status = 'committing'`
  );

  // One-time bootstrap: timezone moved from the `TZ` env into a DB setting. If no
  // timezone is stored yet but a TZ env is present and valid, seed the setting from
  // it so upgrading deploys keep their zone instead of snapping to UTC. This reads
  // the env once on first boot only — it is NOT an ongoing fallback.
  seedTimezoneFromEnv(db);

  // Record an install/first-boot timestamp once, so the health endpoint can tell a
  // genuinely fresh install (exempt from the never-backed-up alarm) from a
  // long-running instance that has NEVER taken a backup (#464). Set only when
  // absent — never overwritten.
  seedInstallMarker(db);
}

// Stamp `install_first_boot_at` with the current time on the first boot that lacks
// it, and never again. Derives the instance age used by the health endpoint's
// "backups enabled but never ran" alarm (#464). On an instance upgrading INTO this
// change the marker is set now, so its age-grace window resets once (a bounded
// 72h) — an acceptable one-time cost documented at the health endpoint.
export function seedInstallMarker(db: Database.Database) {
  const existing = db
    .prepare("SELECT value FROM settings WHERE key = 'install_first_boot_at'")
    .get() as { value?: string } | undefined;
  if (existing?.value) return;
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('install_first_boot_at', ?)"
  ).run(new Date().toISOString());
}

// If no logins exist yet, create login 1 (admin) and profile 1, wired
// together with a grant row. The password comes from ADMIN_PASSWORD, or a random
// one printed to the log exactly once so the operator can capture it. Username
// from ADMIN_USERNAME (default "admin"). Runs on every boot, so it also upgrades
// an existing pre-auth database on its next boot.
export function bootstrapAuth(db: Database.Database) {
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM logins").get() as { c: number }
  ).c;
  if (count > 0) return;

  const username = (process.env.ADMIN_USERNAME ?? "admin").trim() || "admin";
  const envPassword = process.env.ADMIN_PASSWORD;
  // A URL-safe random password when none is supplied. Printed once below.
  const password =
    envPassword && envPassword.length > 0
      ? envPassword
      : crypto.randomBytes(18).toString("base64url");
  const passwordHash = hashPasswordSync(password);

  const create = db.transaction(() => {
    const acct = db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'admin')"
      )
      .run(username, passwordHash);
    const prof = db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(username);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(acct.lastInsertRowid, prof.lastInsertRowid);
  });
  try {
    runBootTx(create);
  } catch (err) {
    // `next build` collects page data with several workers, each running the boot
    // path against the same DB at once; two can both see logins empty and race to
    // bootstrap. Swallow the loser's UNIQUE violation — the admin now exists,
    // which is all we need. Re-throw anything else.
    if (
      err instanceof Error &&
      /UNIQUE constraint failed: logins\.username/i.test(err.message)
    ) {
      return;
    }
    throw err;
  }

  if (!envPassword) {
    // eslint-disable-next-line no-console
    console.log(
      `\n[allos] Created admin login "${username}" with a generated password:\n` +
        `    ${password}\n` +
        `Set ADMIN_PASSWORD to choose your own. This is shown once — save it now.\n`
    );
  }
}

// Seed the timezone setting from the TZ env on first boot.
export function seedTimezoneFromEnv(db: Database.Database) {
  const existing = db
    .prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .get() as { value?: string } | undefined;
  if (existing?.value) return;
  const tz = process.env.TZ;
  if (!tz) return;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    return; // invalid TZ env — leave unset so getTimezone() falls back to UTC
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('timezone', ?)
     ON CONFLICT(key) DO NOTHING`
  ).run(tz);
}

// Seed the canonical_biomarkers table from the committed JSON dataset. The JSON
// is the source of truth for any name it lists, so this UPSERTs: a missing row is
// inserted, and an existing row is refreshed to match the JSON (so edits to
// ranges — including the sex-specific bands — propagate to existing DBs on
// startup). A name present in the JSON also promotes the row to source='seed',
// so a biomarker first discovered by AI (source='ai') adopts curated ranges
// once the JSON gains an entry for it. Idempotent.
export function seedCanonicalBiomarkers(db: Database.Database) {
  const rows = (canonicalSeed as { biomarkers?: any[] }).biomarkers ?? [];
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO canonical_biomarkers
       (name, category, unit, ref_low, ref_high,
        ref_low_male, ref_high_male, ref_low_female, ref_high_female,
        optimal_low, optimal_high,
        optimal_low_male, optimal_high_male, optimal_low_female, optimal_high_female,
        direction, ranges_by_age, ranges_by_status, note, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'seed')
     ON CONFLICT(name) DO UPDATE SET
       category = excluded.category, unit = excluded.unit,
       ref_low = excluded.ref_low, ref_high = excluded.ref_high,
       ref_low_male = excluded.ref_low_male,
       ref_high_male = excluded.ref_high_male,
       ref_low_female = excluded.ref_low_female,
       ref_high_female = excluded.ref_high_female,
       optimal_low = excluded.optimal_low, optimal_high = excluded.optimal_high,
       optimal_low_male = excluded.optimal_low_male,
       optimal_high_male = excluded.optimal_high_male,
       optimal_low_female = excluded.optimal_low_female,
       optimal_high_female = excluded.optimal_high_female,
       direction = excluded.direction,
       ranges_by_age = excluded.ranges_by_age,
       ranges_by_status = excluded.ranges_by_status,
       note = excluded.note,
       source = 'seed'`
  );
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // Age bands are stored as a JSON array; null when absent so the adult fields win.
  const ageBands = (v: unknown) =>
    Array.isArray(v) && v.length > 0 ? JSON.stringify(v) : null;
  // Reproductive-status ranges are stored as a JSON object; null when absent.
  const statusRanges = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0
      ? JSON.stringify(v)
      : null;
  const seedAll = db.transaction(() => {
    for (const b of rows) {
      const name = str(b?.name);
      if (!name) continue;
      insert.run(
        name,
        str(b?.category),
        str(b?.unit),
        num(b?.ref_low),
        num(b?.ref_high),
        num(b?.ref_low_male),
        num(b?.ref_high_male),
        num(b?.ref_low_female),
        num(b?.ref_high_female),
        num(b?.optimal_low),
        num(b?.optimal_high),
        num(b?.optimal_low_male),
        num(b?.optimal_high_male),
        num(b?.optimal_low_female),
        num(b?.optimal_high_female),
        str(b?.direction),
        ageBands(b?.ranges_by_age),
        statusRanges(b?.ranges_by_status),
        str(b?.note)
      );
    }
  });
  runBootTx(seedAll);
}

// Flag-reconcile: re-derive every record's flag against the canonical ranges, but
// only when the ranges (or the flag-derivation logic) changed since the last run.
// The current signature is compared against the one stored in settings; equal
// means nothing relevant changed, so we skip the full scan. After reconciling, the
// new signature is recorded so it runs once per change. (An existing DB with no
// stored signature always reconciles once on first boot.)
export function reconcileFlagsIfCanonicalChanged(db: Database.Database) {
  const sig = canonicalFlagsSignature();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
    .get() as { value?: string } | undefined;
  if (row?.value === sig) return; // ranges + logic unchanged — nothing to do
  reconcileNonOptimalFlags(db);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(sig);
}

// Reconcile every record's flag against the canonical reference + optimal ranges
// (clinical high/low from the reference range, non-optimal from the optimal band,
// cleared when optimal). Mirrors queries.reconcileFlags but runs at boot time,
// where importing queries would be circular — it reads the canonical ranges
// straight from the table.
function reconcileNonOptimalFlags(db: Database.Database) {
  const cbs = db
    .prepare(
      `SELECT name, unit, ref_low, ref_high,
              ref_low_male, ref_high_male, ref_low_female, ref_high_female,
              optimal_low, optimal_high,
              optimal_low_male, optimal_high_male, optimal_low_female, optimal_high_female,
              direction, ranges_by_age, ranges_by_status
       FROM canonical_biomarkers`
    )
    .all() as Record<string, unknown>[];
  const byName = new Map(cbs.map((c) => [String(c.name).toLowerCase(), c]));

  // Flags depend on the profile's sex (sex-specific bands) and, for age-banded
  // biomarkers, the subject's age on each record's collection date. Both are
  // per-profile, so this loops profiles: each profile's sex/birthdate/age live in
  // profile_settings and records are scoped by profile_id.
  // Read them inline (importing lib/settings here would be circular), falling back
  // to legacy global settings for a DB migrated before the settings split ran.
  const profiles = db.prepare("SELECT id FROM profiles").all() as {
    id: number;
  }[];
  const profileSetting = db.prepare(
    "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
  );
  const globalSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const readProfileOrLegacy = (profileId: number, key: string) => {
    const row = profileSetting.get(profileId, key) as
      { value?: string } | undefined;
    if (row) return row.value;
    return (globalSetting.get(key) as { value?: string } | undefined)?.value;
  };
  const readSex = (profileId: number) => {
    const v = readProfileOrLegacy(profileId, "sex");
    return v === "male" ? "male" : v === "female" ? "female" : undefined;
  };
  const readBirthdate = (profileId: number) =>
    readProfileOrLegacy(profileId, "birthdate") ?? null;
  const readAge = (profileId: number) => {
    const v = readProfileOrLegacy(profileId, "age");
    const n = v != null ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 && n < 150 ? n : null;
  };
  // Reproductive (menopausal) status: female physiology only, overrides the age
  // proxy for the reproductive hormones. Per-profile; no legacy global fallback.
  const readReproductiveStatus = (profileId: number) => {
    const v = profileSetting.get(profileId, "reproductive_status") as
      { value?: string } | undefined;
    return v?.value === "premenopausal"
      ? "premenopausal"
      : v?.value === "postmenopausal"
        ? "postmenopausal"
        : null;
  };

  const rowsStmt = db.prepare(
    `SELECT id, value_num, unit, canonical_name, flag, date FROM medical_records
       WHERE profile_id = ? AND canonical_name IS NOT NULL AND value_num IS NOT NULL
         AND (flag IS NULL OR flag IN ('normal','non-optimal','non-optimal-high','non-optimal-low','high','low'))`
  );
  const setFlag = db.prepare(
    "UPDATE medical_records SET flag = ? WHERE id = ?"
  );
  const clear = db.prepare(
    "UPDATE medical_records SET flag = NULL WHERE id = ?"
  );
  const run = db.transaction(() => {
    for (const p of profiles) {
      const sex = readSex(p.id);
      const birthdate = readBirthdate(p.id);
      const age = readAge(p.id);
      const reproductiveStatus = readReproductiveStatus(p.id);
      const rows = rowsStmt.all(p.id) as {
        id: number;
        value_num: number;
        unit: string | null;
        canonical_name: string;
        flag: string | null;
        date: string;
      }[];
      // Same pure per-row derivation queries.reconcileFlags uses, so the boot-time
      // reconcile and the request-time one can't drift (lib/flag-reconcile). Age is
      // derived per row from birthdate + the record's own date (age on the
      // collection date, not today).
      for (const c of computeFlagReconciliation(rows, byName, {
        sex,
        birthdate,
        age,
        reproductiveStatus,
      })) {
        if (c.flag === null) clear.run(c.id);
        else setFlag.run(c.flag, c.id);
      }
    }
  });
  runBootTx(run);
}
