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
    const { med, courses, encExt, indExt, rxcui, presDate } = groups.get(key)!;
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

    // Tier-1 visit link (#1050) and indication link (#1052): resolve the
    // prescription's encounter / reason references to local row ids. Resolved BEFORE
    // the create so they are BOUND by the insert rather than stamped by follow-up
    // UPDATEs — the row is never briefly a medication with no visit and no reason.
    const encounterId =
      ctx.resolveEnc && encExt ? ctx.resolveEnc(encExt) : null;
    const indicationConditionId =
      ctx.resolveCondition && indExt ? ctx.resolveCondition(indExt) : null;

    // Dose rows: a scheduled med gets one row per inferred time bucket; an
    // as-needed med gets a single row only when a strength is known (so its
    // strength still shows) — never a scheduled reminder.
    const doses: IntakeItemDoseSeed[] =
      !med.asNeeded && med.timeBuckets.length > 0
        ? med.timeBuckets.map((bucket) => ({
            amount: med.strength,
            time_of_day: bucket,
            food_timing: "any" as const,
          }))
        : med.strength
          ? [
              {
                amount: med.strength,
                time_of_day: null,
                food_timing: "any" as const,
              },
            ]
          : [];

    // The SAME create core the item form and the suggestion accept go through
    // (#4669). What this caller does not pass, it does not know: an extracted
    // prescription has no brand, no stack, no situation and no shared bottle. What it
    // used to omit and SHOULD have known — the Rx/OTC flag its own prescriber and Rx
    // number imply — the core now derives, so an imported prescription stops arriving
    // labelled OTC.
    const created = createIntakeItemCore(profileId, {
      name: med.name,
      kind: "medication",
      // The source-supplied RxCUI (#3070) is source-confirmed at creation. PRODUCT
      // level only — `rxcui_ingredients` stays null (the #279 decomposition remains
      // its own network step) and the name-keyed safety matchers keep working
      // meanwhile; a resolved product code plus null ingredients is an honest state,
      // not a complete one.
      rxcui,
      provenance: {
        source: "extracted",
        // document_id traces the row back to its source document for the delete-set;
        // import_key is the stable within-doc reprocess anchor for visit-link
        // decisions.
        documentId: docId,
        importKey: medImportKey(docId, med.name),
      },
      notes: med.sig, // directions kept as the row's notes (may be null)
      condition: "daily",
      // Obligation (#1505): the sig's as-needed reading IS the `may` shape; anything
      // scheduled lands on the medication default, `must`.
      obligation: med.asNeeded ? "may" : "must",
      prescriber: med.prescriber,
      pharmacy: med.pharmacy,
      rxNumber: med.rxNumber,
      providerId,
      encounterId,
      indicationConditionId,
      doses,
      // Courses: explicit source period(s) → one course per DERIVED course, written
      // by this caller below; otherwise the core opens a single initial course. Both
      // carry the prescriber + dose snapshot. Idempotent — a reprocess first deletes
      // the med, cascading its courses.
      course:
        courses.length > 0
          ? { kind: "caller" }
          : { kind: "open", startedOn: null, attribution },
    });
    if (!created.ok) {
      // Unreachable by construction — parsePrescription's cleaned name is documented
      // never-empty and the loop above already skipped blank source names — but an
      // import must never half-create a medication, so a refusal aborts the
      // transaction instead of silently dropping the drug.
      throw new Error(
        `Refused to create imported medication: ${created.error}`
      );
    }
    const medId = created.id;
    newItems++;

    if (courses.length > 0) {
      createImportedMedicationCourses(profileId, medId, courses, attribution);
    }
  }
  return newItems;
}
import { db } from "../db";
import {
  createIntakeItemCore,
  type IntakeItemDoseSeed,
} from "../intake-item-create";
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
  type CourseAttribution,
  type MedMatchState,
} from "../queries";
import type { PersistClinicalObservation } from "../import-shape";
