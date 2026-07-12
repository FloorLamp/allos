import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { DATASETS } from "./export";
import {
  getUserSex,
  getUserBirthdate,
  getUserFullName,
  getBloodType,
  getEmergencyContact,
  getSmokingHistory,
} from "./settings";
import type {
  FhirExportInput,
  FhirExportCondition,
  FhirExportAllergy,
  FhirExportProcedure,
  FhirExportImmunization,
  FhirExportObservation,
  FhirExportMedication,
  FhirExportEncounter,
  FhirExportFamilyHistory,
  FhirExportCarePlanItem,
  FhirExportCareGoal,
} from "./fhir-export";

// Server-side collection layer for the full-account export (issue #18). Reads the
// active profile's clinical passport + medical files from SQLite (synchronous
// better-sqlite3) and hands provider-neutral rows to the PURE builders
// (lib/fhir-export, lib/export-manifest). Every read here is strictly scoped to the
// passed profileId — the caller resolves it from requireSession()/getCurrentSession.

// The only directory uploaded medical files live under; a bundled file must resolve
// to inside it (the same path-traversal guard the file-serve route uses).
const UPLOAD_ROOT = path.resolve(process.cwd(), "data", "uploads", "medical");

// One medical upload file to bundle: its on-disk absolute path (already confined to
// UPLOAD_ROOT) and the name it gets inside the archive.
export interface ExportFile {
  zipName: string;
  absPath: string;
  size: number;
}

// The profile's uploaded medical files, resolved from medical_documents rows (which
// cover both the per-profile `<profileId>/` layout and legacy flat files — the path
// is per-row). Confined to UPLOAD_ROOT: a tampered/absolute stored_path is skipped,
// never read from outside the upload tree. Missing-on-disk rows are skipped too.
export function listProfileMedicalFiles(profileId: number): ExportFile[] {
  const rows = db
    .prepare(
      `SELECT id, filename, stored_path
         FROM medical_documents
        WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''
        ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    filename: string;
    stored_path: string;
  }[];

  const out: ExportFile[] = [];
  const seenNames = new Set<string>();
  for (const r of rows) {
    const abs = path.resolve(process.cwd(), r.stored_path);
    // Confine to the upload root, then require the file to still exist.
    if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep))
      continue;
    let size = 0;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // missing on disk
    }
    // Prefix with the row id so two documents that share a filename stay distinct.
    const base = r.filename && r.filename.trim() ? r.filename.trim() : "file";
    let zipName = `medical-files/${r.id}-${sanitizeName(base)}`;
    // Belt-and-suspenders uniqueness (a duplicated id can't happen, but keep names
    // collision-free regardless).
    let n = 1;
    while (seenNames.has(zipName))
      zipName = `medical-files/${r.id}-${n++}-${sanitizeName(base)}`;
    seenNames.add(zipName);
    out.push({ zipName, absPath: abs, size });
  }
  return out;
}

// Strip path separators / control chars from a stored filename so it can't create
// nested dirs or escape the medical-files/ prefix inside the archive.
function sanitizeName(name: string): string {
  return name
    .replace(/[/\\]+/g, "_")
    .replace(/[\x00-\x1f]+/g, "")
    .slice(0, 200);
}

// A readable dose-schedule summary for a medication, folded from its
// intake_item_doses children (mirrors the CSV export's `schedule` column). Scoped
// through the parent intake_items JOIN (ii.profile_id = ?).
function medicationSchedules(profileId: number): Map<number, string> {
  const doses = db
    .prepare(
      `SELECT d.item_id, d.amount, d.time_of_day, d.food_timing
         FROM intake_item_doses d JOIN intake_items ii ON ii.id = d.item_id
        WHERE ii.profile_id = ? ORDER BY ii.id, d.sort, d.id`
    )
    .all(profileId) as {
    item_id: number;
    amount: string | null;
    time_of_day: string | null;
    food_timing: string | null;
  }[];
  const byItem = new Map<number, string[]>();
  for (const d of doses) {
    const time = (d.time_of_day ?? "").trim();
    const amount = (d.amount ?? "").trim();
    const food =
      d.food_timing && d.food_timing !== "any" ? d.food_timing.trim() : "";
    let piece = time && amount ? `${time} × ${amount}` : time || amount;
    if (food) piece = piece ? `${piece} (${food})` : food;
    if (!piece) continue;
    const list = byItem.get(d.item_id);
    if (list) list.push(piece);
    else byItem.set(d.item_id, [piece]);
  }
  const out = new Map<number, string>();
  for (const [id, parts] of byItem) out.set(id, parts.join("; "));
  return out;
}

// Collect the profile's clinical passport into the provider-neutral shape the pure
// FHIR builder consumes. `displayName` is the profile's switcher label, used only
// when no fuller full_name is stored.
export function collectFhirExportInput(
  profileId: number,
  displayName: string
): FhirExportInput {
  const conditions = db
    .prepare(
      `SELECT name, code, code_system, status, onset_date, resolved_date
         FROM conditions WHERE profile_id = ? ORDER BY name`
    )
    .all(profileId) as FhirExportCondition[];

  const allergies = db
    .prepare(
      `SELECT substance, substance_code, substance_code_system, reaction,
              severity, status, onset_date
         FROM allergies WHERE profile_id = ? ORDER BY substance`
    )
    .all(profileId) as FhirExportAllergy[];

  const procedures = db
    .prepare(
      `SELECT name, code, code_system, date
         FROM procedures WHERE profile_id = ? ORDER BY date DESC, id DESC`
    )
    .all(profileId) as FhirExportProcedure[];

  const immunizations = db
    .prepare(
      `SELECT vaccine, date, dose_label
         FROM immunizations WHERE profile_id = ? ORDER BY date DESC, id DESC`
    )
    .all(profileId) as FhirExportImmunization[];

  // Labs/vitals/biomarkers as Observations — NOT prescriptions (medications come
  // from the structured intake_items rows below, the passport's primary med source).
  const observations = db
    .prepare(
      `SELECT name, value, value_num, unit, date
         FROM medical_records
        WHERE profile_id = ? AND category != 'prescription'
        ORDER BY date DESC, id DESC`
    )
    .all(profileId) as FhirExportObservation[];

  const schedules = medicationSchedules(profileId);
  const medRows = db
    .prepare(
      `SELECT id, name, notes, active, created_at
         FROM intake_items WHERE profile_id = ? AND kind = 'medication'
        ORDER BY name`
    )
    .all(profileId) as {
    id: number;
    name: string;
    notes: string | null;
    active: number;
    created_at: string;
  }[];
  const medications: FhirExportMedication[] = medRows.map((m) => ({
    name: m.name,
    dosage: schedules.get(m.id) ?? m.notes ?? null,
    date:
      (m.created_at || "").slice(0, 10) ||
      new Date().toISOString().slice(0, 10),
    active: m.active !== 0,
  }));

  // Encounters, family history, care plan items and care goals — the domains the
  // importer already parses (Encounter / FamilyMemberHistory / CarePlan / Goal) but
  // the exporter used to drop (#465). encounters.diagnoses is stored as a "; "-joined
  // summary column, so split it back into the string[] the builder expects.
  const encounters = (
    db
      .prepare(
        `SELECT date, end_date, type, class_code, reason, diagnoses
           FROM encounters WHERE profile_id = ? ORDER BY date DESC, id DESC`
      )
      .all(profileId) as {
      date: string;
      end_date: string | null;
      type: string | null;
      class_code: string | null;
      reason: string | null;
      diagnoses: string | null;
    }[]
  ).map<FhirExportEncounter>((e) => ({
    date: e.date,
    end_date: e.end_date,
    type: e.type,
    class_code: e.class_code,
    reason: e.reason,
    diagnoses: (e.diagnoses ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  }));

  const familyHistory = db
    .prepare(
      `SELECT relation, condition, code, code_system, onset_age, deceased
         FROM family_history WHERE profile_id = ? ORDER BY condition, id`
    )
    .all(profileId) as FhirExportFamilyHistory[];

  const carePlanItems = db
    .prepare(
      `SELECT description, code, code_system, category, planned_date, status
         FROM care_plan_items WHERE profile_id = ?
        ORDER BY planned_date DESC, id DESC`
    )
    .all(profileId) as FhirExportCarePlanItem[];

  const careGoals = db
    .prepare(
      `SELECT description, code, code_system, target_date, status
         FROM care_goals WHERE profile_id = ? ORDER BY target_date DESC, id DESC`
    )
    .all(profileId) as FhirExportCareGoal[];

  const smoking = getSmokingHistory(profileId);
  const profile = {
    name: getUserFullName(profileId) ?? displayName,
    sex: getUserSex(profileId),
    birthdate: getUserBirthdate(profileId),
    bloodType: getBloodType(profileId),
    emergencyContact: getEmergencyContact(profileId),
    smoking: {
      status: smoking.status,
      packYears: smoking.packYears,
      quitYear: smoking.quitYear,
    },
  };

  return {
    profile,
    conditions,
    allergies,
    procedures,
    immunizations,
    observations,
    medications,
    encounters,
    familyHistory,
    carePlanItems,
    careGoals,
  };
}

// One dataset's rows captured at snapshot time (key + column order + rows), the
// shape the streamer serializes to `datasets/<key>.json` / `.csv`.
export interface ExportDatasetSnapshot {
  key: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

// Everything the full-account export streams, captured as ONE point-in-time read.
export interface ExportSnapshot {
  datasets: ExportDatasetSnapshot[];
  fhirInput: FhirExportInput;
  files: ExportFile[];
}

// Collect the whole export payload inside a SINGLE SQLite read transaction (issue
// #135, item 1). The archive previously ran each dataset as its own lazy query as
// the stream was pulled, with no snapshot — so a write landing BETWEEN two pulls
// could tear the archive internally (a supplement present in supplements.json whose
// log row, read a moment later, is already gone). better-sqlite3 is synchronous and
// a `db.transaction` wraps the reads in one BEGIN…COMMIT, so every dataset + the
// FHIR passport input + the medical-file list observe the same consistent snapshot.
// The bounded JSON (datasets + FHIR input) is materialized in memory here; the
// medical FILES are only LISTED here (their bytes are still streamed one at a time
// from disk by the route, preserving the entry-at-a-time memory discipline). Every
// read is scoped to `profileId` — the caller resolves it from the session.
export function collectExportSnapshot(
  profileId: number,
  profileName: string
): ExportSnapshot {
  return db.transaction((): ExportSnapshot => ({
    datasets: DATASETS.map((ds) => ({
      key: ds.key,
      columns: ds.columns,
      rows: ds.rows(profileId),
    })),
    fhirInput: collectFhirExportInput(profileId, profileName),
    files: listProfileMedicalFiles(profileId),
  }))();
}
