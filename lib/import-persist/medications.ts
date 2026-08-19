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
//     period + prescriber + dose snapshot — INSTEAD of the old fallback that skipped
//     the med and kept only the imported observation. The one exception is the #1027
//     concurrent-different-strength case
//     (the existing med has an OPEN course at a PROVABLY DIFFERENT strength), which
//     stays a SEPARATE item.
//
// Scheduling is conservative (see prescription-parse): a clear sig becomes scheduled
// doses; an unparseable one becomes an as-needed med (never scheduled-due) rather
// than a fabricated daily reminder.
export function persistExtractedMedications(
  profileId: number,
  docId: number | null,
  observations: PersistClinicalObservation[],
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
  const prescriptions = observations.filter(
    (r) => r.category === "prescription"
  );
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
      // The source-supplied RxCUI (#3070), first one across the grouped
      // observations — already RxNorm-system-gated by the CCD/FHIR mappers.
      rxcui: string | null;
      // The earliest prescribed date across the grouped observations — the fallback
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
        rxcui: r.rxcui ?? null,
        presDate: r.date ?? null,
      };
      groups.set(key, g);
      order.push(key);
    }
    if (!g.encExt && r.encounter_external_id)
      g.encExt = r.encounter_external_id;
    if (!g.indExt && r.indication_condition_external_id)
      g.indExt = r.indication_condition_external_id;
    if (!g.rxcui && r.rxcui) g.rxcui = r.rxcui;
    if (r.date && (!g.presDate || r.date < g.presDate)) g.presDate = r.date;
    if (r.courses && r.courses.length) g.courses.push(...r.courses);
  }

  // Every existing tracked med this parsed prescription matches — the SAME
  // cleaned/grouping-name identity the #1027 duplication family keys on (medNameKey),
  // RxCUI-first when both sides carry a code (#482/#1026).
  //
  // ALL of them, not the first (#2919): this used to return the first same-key row and
  // classify only against that one, so a legitimate different-strength med with an
  // open course permanently SHADOWED an identical twin further down the id order that
  // would have renewed. An imported prescription now CARRIES its source-supplied
  // RxCUI (#3070) — persisted onto the projected row below — but the MATCH still
  // keys on the cleaned name: the SAME grouping medNameKey the #1027 duplication
  // family + the observations bridge use, so the identity can't diverge across
  // surfaces (#482).
  const matchCandidates = (
    med: ReturnType<typeof parsePrescription>
  ): MedMatchState[] => medFoldCandidates(ctx.existing, med.name);

  let newItems = 0;
  for (const key of order) {
    const { med, courses, encExt, indExt, rxcui, presDate } =
      groups.get(key)!;
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
    // The new side's strength passes through the SAME extraction the existing side's
    // strengths did (#2919) — a raw sig sentence is not comparable evidence.
    const newStrength = comparableNewStrength(med.strength ?? med.name);
    // Renew onto the first candidate that classifies as a renewal; only when EVERY
    // candidate is a genuinely separate concurrent product do we project a new item.
    const existing = pickRenewalTarget(matchCandidates(med), newStrength);
    if (existing) {
      // Source-supplied RxCUI on a renewal (#3070): fill the existing med's code
      // only when it has NONE — a user-confirmed or hand-edited code always wins
      // over a re-import (the SQL guard is the authority, so a concurrent confirm
      // can't be clobbered either).
      if (rxcui) {
        db.prepare(
          `UPDATE intake_items SET rxcui = ?
            WHERE id = ? AND profile_id = ?
              AND (rxcui IS NULL OR TRIM(rxcui) = '')`
        ).run(rxcui, existing.id, profileId);
      }
      // Attach the renewal's course(s) to the existing med. Explicit source period(s)
      // win; otherwise a single course dated the prescribed date. The dose snapshot
      // rides the attribution so a dose change is preserved in history (the live
      // schedule is not overwritten — Model X, #1204).
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
    // No renewable candidate: project a distinct item (#1027 concurrent).

    const info = ctx.insMed.run(
      med.name,
      med.sig, // directions kept as the row's notes (may be null)
      // Obligation (#1505): the sig's as-needed reading IS the `may` shape; anything
      // scheduled lands on the medication default, `must`.
      med.asNeeded ? "may" : "must",
      med.prescriber,
      med.pharmacy,
      med.rxNumber,
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

    // The source-supplied RxCUI (#3070): written as source-confirmed on insert.
    // PRODUCT level only — `rxcui_ingredients` stays null (the #279 decomposition
    // remains its own network step) and the name-keyed safety matchers keep
    // working meanwhile; a resolved product code plus null ingredients is an
    // honest state, not a complete one.
    if (rxcui) {
      db.prepare(
        `UPDATE intake_items SET rxcui = ? WHERE id = ? AND profile_id = ?`
      ).run(rxcui, medId, profileId);
    }

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
import {
  comparableNewStrength,
  medFoldCandidates,
  pickRenewalTarget,
} from "../medication-renewal";
import { parsePrescription } from "../prescription-parse";
import { resolveExactPrescriberId } from "../providers-db";
import {
  addRenewalCourse,
  createImportedMedicationCourses,
  ensureMedicationCourse,
  type CourseAttribution,
  type MedMatchState,
} from "../queries";
import type { PersistClinicalObservation } from "../import-shape";

type Stmt = Database.Statement;
