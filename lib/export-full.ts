import fs from "node:fs";
import path from "node:path";
import { db, readTx } from "./db";
import { PHOTO_ROOT } from "./profile-photo";
import { photoDomainRoot } from "./photo/store";
import { videoDomainRoot } from "./video/store";
import { LESION_PHOTO_DIR } from "./skin-photo-write";
import { SYMPTOM_PHOTO_DIR } from "./symptom-photo-write";
import { DATASETS, RESTRICTED_DATASETS } from "./export";
import { isTrainingRestricted } from "./age-gate";
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
  FhirExportAppointment,
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

// The profile's avatar photo as a bundle file, when one is stored on disk (#466).
// Confined to PHOTO_ROOT with the same path-traversal guard as the medical files and
// the serve route; a missing/tampered path yields null (nothing bundled).
export function getProfilePhotoFile(profileId: number): ExportFile | null {
  const row = db
    .prepare(`SELECT photo_path FROM profiles WHERE id = ?`)
    .get(profileId) as { photo_path: string | null } | undefined;
  const stored = row?.photo_path;
  if (!stored) return null;
  const abs = path.resolve(process.cwd(), stored);
  if (abs !== PHOTO_ROOT && !abs.startsWith(PHOTO_ROOT + path.sep)) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const ext = abs.split(".").pop()?.toLowerCase();
    return {
      zipName: `profile-photo${ext ? `.${sanitizeName(ext)}` : ""}`,
      absPath: abs,
      size: st.size,
    };
  } catch {
    return null;
  }
}

// ── Opt-in media bundle (#1846) ────────────────────────────────────────────────
//
// The photo + video cores are the STRICTEST privacy tier: structurally excluded
// from share links, the emergency card, and the DEFAULT full export. Their one
// other egress is the per-file authenticated serve route — which is why a year of
// mole tracking could never leave the app. "Include photo & video files" on the
// export flow opts the exporting profile's media into the ZIP under a per-domain
// layout (media/<domain>/<rowId>-<basename>) alongside media/index.json, which
// carries each file's row context (date, caption, which lesion, which activity).
// Exclusion stays the DEFAULT and the opt-in is per-download — never a stored
// setting, so it can't quietly become the new normal for later exports.

// The five media domains, in bundle order. Each key doubles as the directory name
// under media/ in the archive and as its section key in media/index.json.
export const MEDIA_DOMAINS = [
  "progress-photos",
  "lesion-photos",
  "symptom-photos",
  "symptom-videos",
  "activity-videos",
] as const;
export type MediaDomain = (typeof MEDIA_DOMAINS)[number];

export interface MediaExportFile extends ExportFile {
  domain: MediaDomain;
  // Row context for media/index.json — the date/caption/parent fields that make the
  // file readable to a clinician. The thin row itself is not a dataset, so this
  // index IS its export.
  meta: Record<string, unknown>;
}

interface MediaRow {
  id: number;
  stored_path: string;
  [key: string]: unknown;
}

// Per-domain row reads. Every SELECT filters the exporting profile's own
// profile_id — including the two with a JOIN, where the child row carries its own
// profile_id and the join adds only display context. Ordered stably so the bundle
// and the index come out deterministic.
//
// Exported so lib/__db_tests__/export-media.test.ts can assert that scoping per
// declared domain: the statement below is prepared from this Record indexed by the
// loop variable, so the #1208 source scan sees an expression instead of the strings
// and takes an ALLOW_NON_LITERAL entry pointing at that test.
export const MEDIA_ROW_SELECTS: Record<MediaDomain, string> = {
  "progress-photos": `SELECT id, stored_path, date, pose, caption
       FROM progress_photos WHERE profile_id = ? ORDER BY date, id`,
  "lesion-photos": `SELECT lp.id, lp.stored_path, lp.date, lp.caption,
              lp.lesion_id, sl.label AS lesion_label, sl.body_region
       FROM lesion_photos lp JOIN skin_lesions sl ON sl.id = lp.lesion_id
       WHERE lp.profile_id = ? ORDER BY lp.lesion_id, lp.date, lp.id`,
  "symptom-photos": `SELECT id, stored_path, date, symptom, caption
       FROM symptom_photos WHERE profile_id = ? ORDER BY date, id`,
  "symptom-videos": `SELECT id, stored_path, date, symptom, caption, kind, duration_sec
       FROM symptom_videos WHERE profile_id = ? ORDER BY date, id`,
  "activity-videos": `SELECT av.id, av.stored_path, av.exercise, av.caption, av.kind,
              av.duration_sec, a.date AS activity_date, a.title AS activity_title
       FROM activity_videos av JOIN activities a ON a.id = av.activity_id
       WHERE av.profile_id = ? ORDER BY a.date, av.id`,
};

// The one directory each domain's files may resolve into, taken from the STORES'
// own path helpers rather than string-built here — the same roots the serve routes,
// the per-row unlinks and deleteProfile contain against, so they cannot drift.
function mediaDomainRootFor(domain: MediaDomain): string {
  switch (domain) {
    case "progress-photos":
      return photoDomainRoot("progress");
    case "lesion-photos":
      return LESION_PHOTO_DIR;
    case "symptom-photos":
      return SYMPTOM_PHOTO_DIR;
    case "symptom-videos":
      return videoDomainRoot("symptom");
    case "activity-videos":
      return videoDomainRoot("activity");
  }
}

// The profile's media files for the opt-in bundle.
//
// Containment is one notch TIGHTER than listProfileMedicalFiles: every one of these
// five stores has written `<domainRoot>/<profileId>/<contentHash>.<ext>` since the
// domain existed (there is no legacy flat layout to accommodate), so a stored_path
// must resolve inside THIS profile's subdirectory — not merely inside the domain
// root. The SQL profile filter is the scoping guarantee; this is the second lock on
// it, so a corrupt or tampered stored_path can never make one profile's export read
// another profile's bytes. Missing-on-disk rows are skipped, exactly like the
// medical files.
//
// The zip name is `media/<domain>/<rowId>-<sanitized basename>`: the row id keeps
// two files distinct, and the basename is the content-hash-derived stored name.
// Posters and thumbnails are DERIVED artifacts and are deliberately not bundled —
// the original capture is the record, and a viewer re-derives the rest.
//
// `trainingRestricted` gates the activity-videos domain out for an age-restricted
// profile, because form-check clips hang off `activities` and that dataset is
// already gated out of the ZIP (#471) — the clips must not be the way around it.
export function listProfileMediaFiles(
  profileId: number,
  opts: { trainingRestricted?: boolean } = {}
): MediaExportFile[] {
  const out: MediaExportFile[] = [];
  const seenNames = new Set<string>();
  for (const domain of MEDIA_DOMAINS) {
    if (opts.trainingRestricted && domain === "activity-videos") continue;
    const profileRoot = path.resolve(
      mediaDomainRootFor(domain),
      String(profileId)
    );
    const rows = db
      .prepare(MEDIA_ROW_SELECTS[domain])
      .all(profileId) as MediaRow[];
    for (const r of rows) {
      const abs = path.resolve(process.cwd(), r.stored_path);
      if (!abs.startsWith(profileRoot + path.sep)) continue;
      let size = 0;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue; // vanished from disk
      }
      const base = sanitizeName(path.basename(r.stored_path)) || "file";
      let zipName = `media/${domain}/${r.id}-${base}`;
      let n = 1;
      while (seenNames.has(zipName))
        zipName = `media/${domain}/${r.id}-${n++}-${base}`;
      seenNames.add(zipName);
      // Row context = every selected column except the on-disk path, which is an
      // instance-local detail the archive's own layout replaces.
      const meta: Record<string, unknown> = { ...r };
      delete meta.stored_path;
      out.push({ zipName, absPath: abs, size, domain, meta });
    }
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
      `SELECT name, code, code_system, status, laterality, severity, stage,
              onset_date, resolved_date
         FROM conditions WHERE profile_id = ? ORDER BY name`
    )
    .all(profileId) as FhirExportCondition[];

  const allergies = db
    .prepare(
      `SELECT id, substance, substance_code, substance_code_system, reaction,
              severity, status, criticality, verification_status, onset_date
         FROM allergies WHERE profile_id = ? ORDER BY substance`
    )
    .all(profileId) as (FhirExportAllergy & { id: number })[];
  // Attach the graded manifestation list (#1405). A CHILD table with no profile_id
  // of its own — scoped through the JOIN to its parent, per the child-table
  // convention. Rows whose reactions only ever existed as the parent's cached scalar
  // get an empty list here and fall back to it in the resource builder.
  const allergyReactionRows = db
    .prepare(
      `SELECT r.allergy_id AS allergyId, r.manifestation, r.severity
         FROM allergy_reactions r
         JOIN allergies a ON a.id = r.allergy_id
        WHERE a.profile_id = ?
        ORDER BY r.allergy_id, r.position, r.id`
    )
    .all(profileId) as {
    allergyId: number;
    manifestation: string;
    severity: string | null;
  }[];
  for (const a of allergies) {
    a.reactions = allergyReactionRows
      .filter((r) => r.allergyId === a.id)
      .map((r) => ({ manifestation: r.manifestation, severity: r.severity }));
  }

  const procedures = db
    .prepare(
      `SELECT name, code, code_system, date
         FROM procedures WHERE profile_id = ? ORDER BY date DESC, id DESC`
    )
    .all(profileId) as FhirExportProcedure[];

  const immunizations = db
    .prepare(
      `SELECT vaccine, date, dose_label, lot_number, route, site, reaction
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
      `SELECT relation, condition, code, code_system, onset_age, deceased,
              age_at_death, cause_of_death, relation_type, lineage
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

  const appointments = db
    .prepare(
      `SELECT scheduled_at, status, title, location, notes, kind
         FROM appointments WHERE profile_id = ? ORDER BY scheduled_at DESC, id DESC`
    )
    .all(profileId) as FhirExportAppointment[];

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
    appointments,
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
  // The profile avatar to bundle, or null when none is stored (#466).
  profilePhoto: ExportFile | null;
  // The opt-in media bundle (#1846): the profile's photo/video files when the
  // caller opted in, or null when media was NOT requested (the default). null vs
  // [] keeps "opted out" distinguishable from "opted in, nothing to bundle".
  media: MediaExportFile[] | null;
}

// Collect the whole export payload inside a SINGLE SQLite read transaction (issue
// #135, item 1). The archive previously ran each dataset as its own lazy query as
// the stream was pulled, with no snapshot — so a write landing BETWEEN two pulls
// could tear the archive internally (a supplement present in supplements.json whose
// log row, read a moment later, is already gone). better-sqlite3 is synchronous and
// a `readTx` wraps the reads in one (deferred) BEGIN…COMMIT, so every dataset + the
// FHIR passport input + the medical-file list observe the same consistent snapshot.
// The bounded JSON (datasets + FHIR input) is materialized in memory here; the
// medical FILES are only LISTED here (their bytes are still streamed one at a time
// from disk by the route, preserving the entry-at-a-time memory discipline). Every
// read is scoped to `profileId` — the caller resolves it from the session.
export function collectExportSnapshot(
  profileId: number,
  profileName: string,
  opts: { includeMedia?: boolean } = {}
): ExportSnapshot {
  // A training-restricted profile's fitness datasets (activities/goals) are gated
  // out of the ZIP too, not just the export UI (issue #471) — same authoritative
  // enforcement as the per-dataset CSV route. Gate off by default (min age unset).
  const restricted = isTrainingRestricted(profileId);
  return readTx((): ExportSnapshot => ({
    datasets: DATASETS.filter(
      (ds) => !(restricted && RESTRICTED_DATASETS.has(ds.key))
    ).map((ds) => ({
      key: ds.key,
      columns: ds.columns,
      rows: ds.rows(profileId),
    })),
    fhirInput: collectFhirExportInput(profileId, profileName),
    files: listProfileMedicalFiles(profileId),
    profilePhoto: getProfilePhotoFile(profileId),
    // Media stays OUT unless this download explicitly opted in (#1846), and the
    // same age gate that drops the fitness datasets drops the form-check clips.
    media: opts.includeMedia
      ? listProfileMediaFiles(profileId, { trainingRestricted: restricted })
      : null,
  }));
}
