function doseSnapshotOf(
  med: ReturnType<typeof parsePrescription>
): string | null {
  const parts = [med.strength, med.sig].filter((p): p is string => !!p);
  return parts.length ? parts.join(" — ") : null;
}

// The stable within-document import key a projected medication carries (#1178): a
// reprocess deletes-and-reinserts the med under a new id but the SAME import_key, so
// its accepted tier-2 visit-link decision re-applies. NULL for a documentless (paste)
// med, whose stable id suffices. Mirrors migration 092's backfill expression.
function medImportKey(
  docId: number | null,
  cleanedName: string
): string | null {
  return docId != null
    ? `medimport:${docId}|${cleanedName.toLowerCase()}`
    : null;
}

// Project an import's prescriptions into the SINGLE medication entity (#1178):
// kind='medication' intake_items rows (+ dose rows + courses), never a paired
// medical_records prescription. Runs inside insertImportRows' caller transaction;
// for a document import, after this document's prior extracted meds were cleared.
// `docId` is null for a documentless (paste) import. Returns the count of NEW
// medication ITEMS created (a renewal course on an existing med is not a new item).
//
// Cross-document / repeat handling (#1204):
//   - A repeat of the SAME drug WITHIN this document collapses into ONE med carrying
//     the union of its derived courses (the first occurrence's parse wins).
//   - A drug whose cleaned/grouping name MATCHES an existing med (manual or another
//     document's) attaches as a new COURSE on that med (renewal semantics) — its
//     period + prescriber + dose snapshot — INSTEAD of the old skip-to-records-
//     fallback. The one exception is the #1027 concurrent-different-strength case
//     (the existing med has an OPEN course at a PROVABLY DIFFERENT strength), which
//     stays a SEPARATE item.
//
// Scheduling is conservative (see prescription-parse): a clear sig becomes scheduled
// doses; an unparseable one becomes an as-needed med (never scheduled-due) rather
// than a fabricated daily reminder.
export function persistExtractedMedications(
  profileId: number,
  docId: number | null,
  records: PersistRecord[],
  ctx: {
    existing: MedMatchState[];
    insMed: Stmt;
    insMedDose: Stmt;
    // Tier-1 (#1050): resolve the prescription's encounter reference to a local
    // encounter row id, stamped onto the projected med. Absent → no linking.
    resolveEnc?: (raw: string | null | undefined) => number | null;
    // Tier-1 indication (#1052): resolve the prescription's reason (condition)
    // reference to a local condition row id, stamped onto the projected med.
    resolveCondition?: (raw: string | null | undefined) => number | null;
  }
): number {
  const prescriptions = records.filter((r) => r.category === "prescription");
  if (prescriptions.length === 0) return 0;

  // Group prescriptions by cleaned drug name so repeated prescriptions — or several
  // MedicationStatements for one drug at different periods — collapse into ONE unit
  // carrying the UNION of their derived courses. The FIRST occurrence's parse (sig /
  // strength / schedule) wins; later ones only contribute courses + the earliest
  // prescribed date.
  const groups = new Map<
    string,
    {
      med: ReturnType<typeof parsePrescription>;
      courses: ImportedMedicationCourse[];
      encExt: string | null;
      indExt: string | null;
      // The earliest prescribed date across the grouped records — the fallback
      // course start when the source carried no explicit effective period.
      presDate: string | null;
    }
  >();
  const order: string[] = [];
  for (const r of prescriptions) {
    if (!r.name?.trim()) continue;
    const med = parsePrescription({
      name: r.name,
      value: r.value,
      unit: r.unit,
      notes: r.notes,
      // Structured attribution the CCD/FHIR mappers resolved — wins over the
      // free-text scrape so an imported med carries its real prescriber/pharmacy/
      // Rx number instead of NULL (#417).
      prescriber: r.prescriber ?? null,
      pharmacy: r.pharmacy ?? null,
      rxNumber: r.rxNumber ?? null,
    });
    const key = med.name.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = {
        med,
        courses: [],
        encExt: r.encounter_external_id ?? null,
        indExt: r.indication_condition_external_id ?? null,
        presDate: r.date ?? null,
      };
      groups.set(key, g);
      order.push(key);
    }
    if (!g.encExt && r.encounter_external_id)
      g.encExt = r.encounter_external_id;
    if (!g.indExt && r.indication_condition_external_id)
      g.indExt = r.indication_condition_external_id;
    if (r.date && (!g.presDate || r.date < g.presDate)) g.presDate = r.date;
    if (r.courses && r.courses.length) g.courses.push(...r.courses);
  }

  // Find an existing tracked med this parsed prescription matches — the SAME
  // cleaned/grouping-name identity the #1027 duplication family keys on (medNameKey),
  // RxCUI-first when both sides carry a code (#482/#1026).
  const matchExisting = (
    med: ReturnType<typeof parsePrescription>
  ): MedMatchState | null => {
    const key = medNameKey(med.name);
    for (const ex of ctx.existing) {
      const exKeys = new Set([medNameKey(ex.name)]);
      if (ex.brand) exKeys.add(medNameKey(ex.brand));
      if (key && exKeys.has(key)) return ex;
    }
    // The RxCUI-first path stays open for a future import that captures a code on the
    // prescription (records carry none today), so the cleaned name is the working
    // signal — the SAME grouping medNameKey the #1027 duplication family + the records
    // bridge use, so the identity can't diverge across surfaces (#482).
    return null;
  };

  let newItems = 0;
  for (const key of order) {
    const { med, courses, encExt, indExt, presDate } = groups.get(key)!;
    // Prescriber link (#1051 semantics (a)): resolve the parsed prescriber TEXT into
    // an EXISTING individual registry row (exact only — never an org / near-miss).
    const providerId = med.prescriber
      ? resolveExactPrescriberId(med.prescriber)
      : null;
    const attribution: CourseAttribution = {
      prescriber: med.prescriber,
      providerId,
      doseSnapshot: doseSnapshotOf(med),
    };

    // Cross-document / cross-provider re-prescription (#1204): does this drug match a
    // med the profile already tracks? If so, renew (course) unless the #1027
    // concurrent-different-strength case dictates a separate item.
    const existing = matchExisting(med);
    if (existing) {
      const newStrength = med.strength ?? strengthFromName(med.name);
      const relationship = classifyReprescription({
        existingHasOpenCourse: existing.hasOpenCourse,
        existingStrengths: new Set(
          existing.strengths
            .map((s) => normalizeStrength(s))
            .filter((s): s is string => !!s)
        ),
        newStrength,
      });
      if (relationship === "renewal") {
        // Attach the renewal's course(s) to the existing med. Explicit source
        // period(s) win; otherwise a single course dated the prescribed date. The
        // dose snapshot rides the attribution so a dose change is preserved in
        // history (the live schedule is not overwritten — Model X, #1204).
        if (courses.length > 0) {
          for (const c of courses) {
            addRenewalCourse(profileId, existing.id, {
              startedOn: c.started_on,
              stoppedOn: c.stopped_on,
              stopReason: c.stop_reason,
              notes: c.notes,
              attribution,
            });
          }
        } else {
          addRenewalCourse(profileId, existing.id, {
            startedOn: presDate,
            attribution,
          });
        }
        continue; // no new item — the existing med carries this prescription
      }
      // "separate" falls through: project a distinct item (#1027 concurrent).
    }

    const info = ctx.insMed.run(
      med.name,
      med.sig, // directions kept as the row's notes (may be null)
      med.prescriber,
      med.pharmacy,
      med.rxNumber,
      med.asNeeded ? 1 : 0,
      // document_id — traces the row back to its source document for the delete-set.
      docId,
      providerId,
      // import_key — the stable within-doc reprocess anchor for visit-link decisions.
      medImportKey(docId, med.name),
      profileId,
      // created_at — the clock seam, not SQL's real clock (#1534); see insMed.
      sqlNow()
    );
    const medId = Number(info.lastInsertRowid);
    newItems++;

    // Tier-1 visit link (#1050): stamp the resolved encounter id onto the med.
    if (ctx.resolveEnc && encExt) {
      const encId = ctx.resolveEnc(encExt);
      if (encId != null) {
        db.prepare(
          `UPDATE intake_items SET encounter_id = ? WHERE id = ? AND profile_id = ?`
        ).run(encId, medId, profileId);
      }
    }

    // Tier-1 indication link (#1052): stamp the resolved condition id onto the med.
    if (ctx.resolveCondition && indExt) {
      const condId = ctx.resolveCondition(indExt);
      if (condId != null) {
        db.prepare(
          `UPDATE intake_items SET indication_condition_id = ? WHERE id = ? AND profile_id = ?`
        ).run(condId, medId, profileId);
      }
    }

    // Courses: explicit source period(s) → one course per DERIVED course; otherwise
    // a single open initial course. Both carry the prescriber + dose snapshot + source
    // document. Idempotent — a reprocess first deletes the med, cascading its courses.
    if (courses.length > 0) {
      createImportedMedicationCourses(profileId, medId, courses, attribution);
    } else {
      ensureMedicationCourse(profileId, medId, null, false, attribution);
    }

    // Dose rows: a scheduled med gets one row per inferred time bucket; an
    // as-needed med gets a single row only when a strength is known (so its
    // strength still shows) — never a scheduled reminder.
    if (!med.asNeeded && med.timeBuckets.length > 0) {
      med.timeBuckets.forEach((bucket, i) => {
        ctx.insMedDose.run(medId, med.strength, bucket, i);
      });
    } else if (med.strength) {
      ctx.insMedDose.run(medId, med.strength, null, 0);
    }
  }
  return newItems;
}
import type Database from "better-sqlite3";
import { db } from "../db";
import { sqlNow } from "../clock";
import type { ImportedMedicationCourse } from "../health-import";
import { medNameKey } from "../medication-record-match";
import {
  classifyReprescription,
  normalizeStrength,
} from "../medication-renewal";
import { parsePrescription, strengthFromName } from "../prescription-parse";
import { resolveExactPrescriberId } from "../providers-db";
import {
  addRenewalCourse,
  createImportedMedicationCourses,
  ensureMedicationCourse,
  type CourseAttribution,
  type MedMatchState,
} from "../queries";
import type { PersistRecord } from "../import-shape";

type Stmt = Database.Statement;
