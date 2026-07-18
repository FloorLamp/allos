import type Database from "better-sqlite3";
import crypto from "node:crypto";
import canonicalSeed from "../canonical-biomarkers.json";
import {
  computeFlagReconciliation,
  computeQualitativeFlagChanges,
} from "../flag-reconcile";
import { canonicalFlagsSignature } from "../canonical-flags-version";
import { hashPasswordSync } from "../password";
import { extractionLeaseMinutes } from "../extraction-lease";
import {
  initialOnboardingState,
  serializeOnboardingState,
} from "../onboarding";
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
//                                  flight; must run on every process start. AGE-GATED
//                                  on the extraction lease window (issue #461): boot
//                                  runs in EVERY process, including the hourly notify
//                                  tick (scripts/notify.ts imports lib/db => createDb
//                                  => bootTasks at the top of every hour), so an
//                                  unconditional reset would flip a FRESH in-flight
//                                  extraction started seconds ago by the web process
//                                  to 'failed'. The age gate makes the reset touch
//                                  only genuinely-stranded rows (past the lease) in
//                                  ANY process — the same lease reapStuckExtractions
//                                  uses — so a live extraction/import survives the tick.
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

  // Reset extraction/import rows a crash left mid-flight — but ONLY those stranded
  // past the lease window, so the hourly notify tick's boot can't fail a live
  // extraction the web process started seconds ago (issue #461).
  resetInterruptedWork(db);

  // One-time bootstrap: timezone moved from the `TZ` env into a DB setting. If no
  // timezone is stored yet but a TZ env is present and valid, seed the setting from
  // it so upgrading deploys keep their zone instead of snapping to UTC. This reads
  // the env once on first boot only — it is NOT an ongoing fallback.
  seedTimezoneFromEnv(db);

  // AI provider tiers (issue #875): seed the Heavy tier from the legacy AI env vars
  // on first boot (idempotent — the env is DEMOTED to a seed; the DB then owns it).
  // The runtime tier-config PROVIDER is registered in lib/db.ts (NOT here) so this
  // module stays off the lib/settings import — the db → boot-tasks → settings cycle
  // otherwise TDZ-faults some import orders (the header's "importing lib/settings
  // here would be circular" rule).
  seedAiTiersFromEnv(db);

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
  // Wrapped in the retrying IMMEDIATE-tx wrapper so a parallel cold boot waits out a
  // peer's write lock (issue #581) rather than surfacing a raw SQLITE_BUSY; the
  // INSERT OR IGNORE keeps a lost race a clean no-op.
  runBootTx(
    db.transaction(() => {
      db.prepare(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('install_first_boot_at', ?)"
      ).run(new Date().toISOString());
    })
  );
}

// Reap document-extraction and import-job rows a crash left mid-flight — AGE-GATED on
// the extraction lease window (issue #461).
//
// The old boot reset was unconditional ("a fresh process can't have any extraction in
// flight"). That holds per-PROCESS but not per-DATABASE: the hourly notify tick imports
// lib/db, so createDb() -> bootTasks() runs this at the top of every hour, and an
// unconditional reset would flip a FRESH in-flight extraction/import — one the web
// process kicked off seconds earlier — to 'failed' (a false failure toast, a
// double-charged AI quota on the user's retry, or the alarming "data may already have
// been imported" on a commit that is actually succeeding).
//
// The age gate fixes it in ANY process: only rows stranded PAST the lease are reaped —
// exactly the "genuinely abandoned by a dead process" set — so a live run always
// survives the tick, while a true crash orphan is still cleared (here on the next boot,
// or by reapStuckExtractions within the hour). `minutes` is a validated positive integer
// (extractionLeaseMinutes), so interpolating it into the datetime modifier is injection-
// safe. Exported so the DB-tier test can drive it with a controlled window.
export function resetInterruptedWork(
  db: Database.Database,
  minutes: number = extractionLeaseMinutes()
): void {
  const mins =
    Number.isInteger(minutes) && minutes >= 1
      ? minutes
      : extractionLeaseMinutes();
  const modifier = `-${mins} minutes`;

  // All three reaps run inside one retrying IMMEDIATE transaction so a parallel cold
  // boot waits out a peer's write lock (issue #581) instead of surfacing a raw
  // SQLITE_BUSY; each UPDATE is idempotent, so a re-run after a lost race is a no-op.
  const reap = db.transaction(() => {
    // Background document extraction runs in-process; a row stuck on 'processing' past
    // the lease was abandoned by a dead process. Gated by processing_started_at (stamped
    // when a row enters 'processing'): a NULL stamp or a fresh one is left alone.
    db.exec(
      `UPDATE medical_documents
         SET extraction_status = 'failed',
             extraction_error = 'Extraction was interrupted (server restarted). Delete and re-upload to retry.'
       WHERE extraction_status IN ('processing','pending')
         AND processing_started_at IS NOT NULL
         AND processing_started_at < datetime('now', '${modifier}')`
    );

    // Async paste/CSV import jobs left mid-extraction by a restart/crash. updated_at is
    // set at insert and bumped on every transition, so it ages a stalled job from when
    // it last made progress; a fresh 'processing' job (updated_at ~ now) is spared.
    db.exec(
      `UPDATE import_jobs
         SET status = 'failed',
             error = 'Extraction was interrupted (server restarted). Discard and try again.',
             updated_at = datetime('now')
       WHERE status = 'processing'
         AND updated_at < datetime('now', '${modifier}')`
    );

    // Jobs a crash stranded mid-commit (issue #323). commitImportJob claims a job by
    // flipping 'ready' -> 'committing' (bumping updated_at) before writing rows; a crash
    // between that claim and the row-delete would strand it in 'committing' forever — it
    // can't be re-claimed (the claim requires status='ready') and only a manual Discard
    // exits. Reap it to 'failed' with an explanatory error, mirroring the 'processing'
    // reset, but only once its lease is past so a commit that IS succeeding right now
    // isn't falsely reported as maybe-imported (issue #461). We do NOT revert to 'ready'
    // for auto-retry: the crash may have landed after the inner commit transaction (data
    // already imported), so the safe move is to fail it and let the user review — a
    // deliberate re-import is deduped by the importers.
    db.exec(
      `UPDATE import_jobs
         SET status = 'failed',
             error = 'Saving this import was interrupted (server restarted). Some or all of its data may already have been imported — check your data before retrying, then discard this job.',
             updated_at = datetime('now')
       WHERE status = 'committing'
         AND updated_at < datetime('now', '${modifier}')`
    );
  });
  runBootTx(reap);
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
    // Only profiles born after goal-based onboarding shipped carry this marker.
    // Existing profiles have no row and therefore are never forced through a
    // replay after upgrade.
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value)
       VALUES (?, 'onboarding_state', ?)`
    ).run(
      prof.lastInsertRowid,
      serializeOnboardingState(initialOnboardingState())
    );
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
  // Wrapped in the retrying IMMEDIATE-tx wrapper so a parallel cold boot waits out a
  // peer's write lock (issue #581); ON CONFLICT DO NOTHING keeps a lost race a no-op.
  runBootTx(
    db.transaction(() => {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('timezone', ?)
         ON CONFLICT(key) DO NOTHING`
      ).run(tz);
    })
  );
}

// Seed the Heavy AI tier from the legacy env vars on first boot (issue #875). The AI
// config moved from env-only (ANTHROPIC_API_KEY / AI_BASE_URL / HEALTH_AI_MODEL) into
// the settings table; on the first boot that has no Heavy tier stored yet, persist the
// env values so an upgrading deploy keeps its key/endpoint/model instead of snapping
// to offline. Idempotent — never overwrites a value the admin has since set (the
// seedTimezoneFromEnv pattern) — and a fresh instance with no AI env seeds nothing
// (both tiers stay unset → offline degradation, unchanged). Uses the passed db handle
// (the singleton isn't assigned yet inside createDb).
export function seedAiTiersFromEnv(db: Database.Database) {
  // Heavy tier setting keys, inlined here (NOT imported from lib/settings/ai-tiers) to
  // keep this module off the settings import — see the note in bootTasks. They mirror
  // the `ai_<tier>_<field>` scheme lib/settings/ai-tiers reads.
  const k = {
    shape: "ai_heavy_shape",
    baseUrl: "ai_heavy_base_url",
    apiKey: "ai_heavy_api_key",
    model: "ai_heavy_model",
  };
  const stored = db
    .prepare("SELECT key FROM settings WHERE key IN (?, ?, ?, ?) LIMIT 1")
    .get(k.shape, k.baseUrl, k.apiKey, k.model) as { key?: string } | undefined;
  if (stored) return; // Heavy tier already has stored config — never re-seed
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const baseUrl = (process.env.AI_BASE_URL || "").trim();
  const model = (process.env.HEALTH_AI_MODEL || "").trim();
  if (!apiKey && !baseUrl && !model) return; // nothing to seed
  runBootTx(
    db.transaction(() => {
      const put = db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING`
      );
      put.run(k.shape, "anthropic");
      put.run(k.baseUrl, baseUrl);
      put.run(k.apiKey, apiKey);
      put.run(k.model, model);
    })
  );
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
  // Record the new signature inside the retrying IMMEDIATE-tx wrapper so a parallel
  // cold boot waits out a peer's write lock (issue #581) rather than surfacing a raw
  // SQLITE_BUSY; the UPSERT keeps a re-run after a lost race a no-op.
  runBootTx(
    db.transaction(() => {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('canonical_flags_sig', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(sig);
    })
  );
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
    `SELECT id, value_num, unit, canonical_name, flag, date, reference_range FROM medical_records
       WHERE profile_id = ? AND canonical_name IS NOT NULL AND value_num IS NOT NULL
         AND (flag IS NULL OR flag IN ('normal','non-optimal','non-optimal-high','non-optimal-low','high','low'))`
  );
  const setFlag = db.prepare(
    "UPDATE medical_records SET flag = ? WHERE id = ?"
  );
  const clear = db.prepare(
    "UPDATE medical_records SET flag = NULL WHERE id = ?"
  );
  // Qualitative (value_num IS NULL) rows for the shared classifier pass (#549). It's
  // profile-independent (a blood type / immunity titer classifies the same for
  // everyone), so scan them once across all profiles rather than per-profile.
  // bootTasks is version-agnostic — it can run against a schema that predates the
  // migration 034 `loinc` column (e.g. a migration test that boots at an earlier
  // revision), so select it only when present and fall back to NULL (→ the
  // classifier's name-based path) otherwise (#684).
  const hasLoinc = (
    db.prepare(`PRAGMA table_info(medical_records)`).all() as { name: string }[]
  ).some((c) => c.name === "loinc");
  const qualRowsStmt = db.prepare(
    `SELECT id, canonical_name, name, value, notes, reference_range, flag,
            ${hasLoinc ? "loinc" : "NULL AS loinc"}
       FROM medical_records
      WHERE value_num IS NULL AND category IN ('lab','biomarker')`
  );

  const run = db.transaction(() => {
    for (const p of profiles) {
      const sex = readSex(p.id);
      const birthdate = readBirthdate(p.id);
      const age = readAge(p.id);
      const reproductiveStatus = readReproductiveStatus(p.id);
      const rows = (
        rowsStmt.all(p.id) as {
          id: number;
          value_num: number;
          unit: string | null;
          canonical_name: string;
          flag: string | null;
          date: string;
          reference_range: string | null;
        }[]
      ).map((r) => ({ ...r, reference: r.reference_range }));
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
    // Qualitative flag reconcile (#549): promote durable-immunity titers to "immune"
    // (#544) and clear blunt "abnormal" flags on context-neutral attributes (#548 §1),
    // through the SAME classifier the request-time reconcile uses.
    const qrows = (
      qualRowsStmt.all() as {
        id: number;
        canonical_name: string | null;
        name: string;
        value: string | null;
        notes: string | null;
        reference_range: string | null;
        flag: string | null;
        loinc: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.canonical_name?.trim() || r.name,
      value: r.value,
      notes: r.notes,
      reference: r.reference_range,
      flag: r.flag,
      loinc: r.loinc,
    }));
    for (const c of computeQualitativeFlagChanges(qrows)) {
      if (c.flag === null) clear.run(c.id);
      else setFlag.run(c.flag, c.id);
    }
  });
  runBootTx(run);
}
