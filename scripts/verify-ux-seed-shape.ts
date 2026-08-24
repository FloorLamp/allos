import "./load-env";

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { LONG_NAMES } from "./seed-long-names";

const dbPath = process.env.ALLOS_DB_PATH;
const ownedDir = process.env.UX_OWNED_DB_DIR;
if (!dbPath || !ownedDir || dbPath === ":memory:") {
  throw new Error(
    "UX seed verification requires an owned file-backed database"
  );
}
if (path.resolve(dbPath) !== path.join(path.resolve(ownedDir), "allos.db")) {
  throw new Error("UX seed verification database escaped its owned directory");
}
const stat = fs.lstatSync(dbPath);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error("UX seed verification target is not an owned regular file");
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma("quick_check", { simple: true });
  if (integrity !== "ok")
    throw new Error(`UX database quick_check: ${integrity}`);
  const migrations = db
    .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
    .get() as { count: number };
  if (migrations.count === 0) throw new Error("UX database has no migrations");

  if (process.env.UX_SEED === "dirty") {
    const count = (sql: string, value: string) =>
      (db.prepare(sql).get(value) as { count: number }).count;
    const witnesses = {
      qualifiedEncounter: count(
        "SELECT COUNT(*) AS count FROM encounters WHERE profile_id = 1 AND diagnoses = ?",
        "Encounter for screening for malignant neoplasm of colon; Encounter for screening for malignant neoplasm of colon - Primary"
      ),
      longIntake: count(
        "SELECT COUNT(*) AS count FROM intake_items WHERE profile_id = 1 AND name = ?",
        LONG_NAMES.intakeItem
      ),
      longLab: count(
        "SELECT COUNT(*) AS count FROM medical_records WHERE profile_id = 1 AND category = 'lab' AND name = ?",
        LONG_NAMES.clinicalResult
      ),
      longCondition: count(
        "SELECT COUNT(*) AS count FROM conditions WHERE profile_id = 1 AND name = ?",
        LONG_NAMES.condition
      ),
    };
    const missing = Object.entries(witnesses)
      .filter(([, value]) => value !== 1)
      .map(([name, value]) => `${name}=${value}`);
    if (missing.length) {
      throw new Error(
        `Dirty seed witnesses do not match: ${missing.join(", ")}`
      );
    }
  }
} finally {
  db.close();
}

console.log(
  `verified ${process.env.UX_SEED || "fresh"} UX database: ${dbPath}`
);
