// CDA section extractors — medications. The medication mapper (plus its
// effective-period / status / narrative helpers) and the four medication section
// extractors (active, discharge, administered, ordered).
import { medicationExternalId } from "../../clinical-parse";
import type { ImportedRecord } from "../../health-import";
import {
  coursesFromImportedMedication,
  normalizeCcdaMedStatus,
} from "../../medication-course-import";
import type { ImportMedStatus } from "../../medication-course-import";
import { SECTIONS } from "../constants";
import type { SectionExtractor } from "../constants";
import {
  asArray,
  buildNarrativeIdMap,
  collectText,
  effTime,
  hl7Date,
  providerFromAssignedEntity,
  providerFromPerformer,
  resolveNarrativeText,
  sectionIs,
  textOf,
  truthyNegation,
} from "../normalize";

// A medication's effective/therapy period(s), for course derivation.
// A med's effectiveTime is typically an array of an IVL_TS therapy period
// (low/high) plus a PIVL_TS frequency (period/@value) — take the interval bound(s)
// and any point date, and ignore the frequency element (no low/high/@value). A
// substanceAdministration may carry MULTIPLE IVL_TS periods (distinct episodes).
function medEffectivePeriods(
  t: any
): { low: string | null; high: string | null }[] {
  const out: { low: string | null; high: string | null }[] = [];
  for (const e of asArray(t)) {
    const low = hl7Date(e?.low?.["@_value"]);
    const high = hl7Date(e?.high?.["@_value"]);
    if (low || high) {
      out.push({ low, high });
      continue;
    }
    const point = hl7Date(e?.["@_value"]);
    if (point) out.push({ low: point, high: null });
  }
  return out;
}

// The medication's lifecycle status: the substanceAdministration
// statusCode (active/completed/aborted/suspended/held), else a nested C-CDA
// "status of medication" observation's value code/displayName. The nested value
// is only trusted when it normalizes to a real status token, so an indication /
// reason observation ("Hypertension") is never mistaken for a status.
function ccdaMedStatus(sa: any): ImportMedStatus {
  const primary = normalizeCcdaMedStatus(sa?.statusCode?.["@_code"]);
  if (primary !== "unknown") return primary;
  for (const er of asArray(sa?.entryRelationship)) {
    const v = er?.observation?.value;
    const cand = normalizeCcdaMedStatus(v?.["@_code"] ?? v?.["@_displayName"]);
    if (cand !== "unknown") return cand;
  }
  return "unknown";
}

// Map a medication <substanceAdministration> to a `prescription` record. This is
// the interim home (medication support) calls for — the extraction
// pipeline's `prescription` category — until a dedicated medications table lands,
// at which point only this sink changes. The record ALSO carries the derived
// medication COURSES: the effective period(s) → course dates, the
// status → open/closed + stop_reason; the persist layer turns them into
// medication_courses rows. A nullified/entered-in-error med yields null courses,
// dropping the whole medication.
// A medication name resolved from the narrative table via the code's
// <originalText><reference>. The tested Epic shape points the
// reference at a <content ID> holding ONLY the drug name, but a different export
// could point it at a wider cell (a <td>/<tr> that also holds the sig/frequency),
// whose collectText returns a whitespace-collapsed blob. Guard that: take the
// first line and reject an implausibly long result (> 150 chars) so a
// mis-referenced blob never becomes the med name — the med then falls back to its
// other name sources (or is dropped) rather than being mis-named.
export function narrativeDrugName(
  node: any,
  narrativeIds: Record<string, string>
): string | null {
  const resolved = resolveNarrativeText(node, narrativeIds);
  if (!resolved) return null;
  const firstLine = resolved.split(/[\r\n]/)[0].trim();
  return firstLine.length > 0 && firstLine.length <= 150 ? firstLine : null;
}

// `opts` (#266) tunes the two inpatient medication-section flavors without
// touching the ambulatory med-list behavior:
//   - `snapshot`: the section documents what ALREADY HAPPENED (Administered
//     Medications — meds given during the stay), not an ongoing regimen. An
//     active/unstated lifecycle status is capped to `completed` so a one-off
//     administration never opens an open (current) course, and an undated entry's
//     course is anchored to the document date instead of staying open-undated.
//   - `courseNote`: a short provenance note put on the derived course(s) (e.g.
//     "At hospital discharge"), so the course's origin survives into the app.
export function mapMedication(
  sa: any,
  narrativeIds: Record<string, string> = {},
  documentDate: string | null = null,
  opts: { snapshot?: boolean; courseNote?: string | null } = {}
): ImportedRecord | null {
  if (!sa || truthyNegation(sa["@_negationInd"])) return null;
  const mat = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
  // The drug name: a structured <name>/<code displayName>, else the code's
  // <originalText><reference> into the section narrative table (Epic ships the
  // printed drug name there — e.g. "albuterol … nebulizer solution" — with the
  // structured code carrying only NDC/RxNorm and no displayName), else an inline
  // sa.text. The sa.text <reference> (the sig/directions) is intentionally NOT a
  // name fallback.
  const name =
    textOf(mat?.name) ||
    mat?.code?.["@_displayName"] ||
    narrativeDrugName(mat?.code?.originalText, narrativeIds) ||
    textOf(sa?.text);
  const date = effTime(sa.effectiveTime);
  // A med-list entry commonly carries a name but NO effectiveTime (#Fix 2). Rather
  // than drop the whole medication, fall back to the DOCUMENT date for the record
  // date — the course still opens UNDATED (started_on null) because we only build a
  // period from the med's OWN effectiveTime, never fabricating a start from the doc
  // date. Only a med with neither a name nor any date still drops.
  const recordDate = date ?? documentDate;
  if (!name || !recordDate) return null;
  const rxnorm =
    mat?.code?.["@_codeSystem"] === "2.16.840.1.113883.6.88"
      ? mat?.code?.["@_code"]
      : undefined;
  const dq = sa?.doseQuantity;
  const dose =
    dq?.["@_value"] != null
      ? `${dq["@_value"]}${dq["@_unit"] ? ` ${dq["@_unit"]}` : ""}`
      : null;
  // The sig / directions text (Epic ships the printed instructions in the
  // section narrative, referenced by <text><reference value="#…"/>). FHIR keeps
  // its dosageInstruction.text in the record's `value`; capture the CCD sig into
  // the SAME field so parsePrescription's schedule inference sees identical input
  // from both formats (#417). Fall back to the doseQuantity string when no sig
  // narrative is present, preserving the prior strength-only value.
  const sig = resolveNarrativeText(sa?.text, narrativeIds);
  // Attribution (#417): the ordering clinician (med <author>) and, when a
  // <supply> dispense act is present, the dispensing pharmacy + Rx number.
  const author = asArray(sa?.author)[0]?.assignedAuthor;
  const prescriber =
    providerFromAssignedEntity(author, "individual")?.name ?? null;
  const supply = asArray(sa?.entryRelationship)
    .map((er: any) => er?.supply)
    .find((s: any) => s != null);
  const pharmacy = supply
    ? (providerFromPerformer(supply, "organization")?.name ?? null)
    : null;
  const rxNumber = supply ? supplyRxNumber(supply) : null;
  const periods = medEffectivePeriods(sa.effectiveTime);
  let status = ccdaMedStatus(sa);
  // Snapshot sections (#266): an administration already happened — cap an
  // active/unstated status to `completed` so it can never open a current course.
  if (opts.snapshot && (status === "active" || status === "unknown"))
    status = "completed";
  const courses = coursesFromImportedMedication(
    // A snapshot entry with no date of its own is anchored to the document date
    // (the encounter is when it happened); a regular med-list entry keeps the
    // open-undated behavior (#Fix 2 — never fabricate a start from the doc date).
    periods.length
      ? periods
      : [{ low: date ?? (opts.snapshot ? documentDate : null), high: null }],
    status,
    {
      fallbackStopDate: opts.snapshot ? (date ?? documentDate) : date,
      note: opts.courseNote ?? null,
    }
  );
  // A nullified / entered-in-error med → drop it entirely.
  if (courses === null) return null;
  return {
    category: "prescription",
    name: String(name),
    canonical: String(name),
    value: sig ?? dose,
    value_num: null,
    unit: null,
    date: recordDate,
    external_id: medicationExternalId({
      name: String(name),
      code: rxnorm ? String(rxnorm) : null,
      date: recordDate,
    }),
    courses,
    prescriber,
    pharmacy,
    rxNumber,
  };
}

// The Rx number carried on a <supply> dispense act's <id extension="…"/>, else
// null. First non-empty extension wins.
function supplyRxNumber(supply: any): string | null {
  for (const id of asArray(supply?.id)) {
    const ext = id?.["@_extension"];
    if (typeof ext === "string" && ext.trim()) return ext.trim();
  }
  return null;
}

// ---- allergies + problem-list conditions ----

export const medicationsExtractor: SectionExtractor = {
  key: "medications",
  matches: (s) => sectionIs(s, SECTIONS.medications),
  extract: (s, documentDate) => {
    // The section's <text> id→text index, so a medication whose name lives in the
    // narrative table (referenced from the structured code's originalText) resolves
    // — same pattern as the lab/vital observation extractors.
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(e?.substanceAdministration, narrativeIds, documentDate)
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};

// Medications at Time of Discharge (#266): the take-home regimen on an inpatient
// discharge document — the closest analog of the ambulatory med list, so the
// entry's own coded status/effectiveTime are trusted (an "active" discharge med IS
// the intended ongoing medication); each derived course is tagged with an
// "At hospital discharge" provenance note.
export const dischargeMedicationsExtractor: SectionExtractor = {
  key: "dischargeMedications",
  matches: (s) => sectionIs(s, SECTIONS.dischargeMedications),
  extract: (s, documentDate) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(
            e?.substanceAdministration,
            narrativeIds,
            documentDate,
            {
              courseNote: "At hospital discharge",
            }
          )
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};

// Administered Medications (#266): meds GIVEN during the stay — a snapshot of
// past administrations, never an ongoing regimen, so mapMedication runs in
// snapshot mode (active/unstated status capped to `completed`; undated entries
// anchored to the document date) with an "Administered during encounter" note.
export const administeredMedicationsExtractor: SectionExtractor = {
  key: "administeredMedications",
  matches: (s) => sectionIs(s, SECTIONS.administeredMedications),
  extract: (s, documentDate) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(
            e?.substanceAdministration,
            narrativeIds,
            documentDate,
            {
              snapshot: true,
              courseNote: "Administered during encounter",
            }
          )
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};

// Ordered Prescriptions (#268): the prescriptions WRITTEN at the visit — Epic's
// order list, not the patient's current regimen (the Medications section remains
// the authority for that). The entries are the same Medication Activity (4.16)
// shape, so mapMedication parses them nearly unchanged — but in snapshot mode:
// the section documents an order EVENT, so an active/unstated status is capped to
// `completed` and an undated order anchors to the document date, meaning an order
// from a years-old visit can never fabricate a current (open-course) medication.
// A period with explicit bounds keeps them. Each derived course is tagged
// "Ordered at visit" so its provenance survives into the app.
export const orderedPrescriptionsExtractor: SectionExtractor = {
  key: "orderedPrescriptions",
  matches: (s) => sectionIs(s, SECTIONS.orderedPrescriptions),
  extract: (s, documentDate) => {
    const narrativeIds = buildNarrativeIdMap(s.raw?.text);
    return {
      records: s.entries
        .map((e) =>
          mapMedication(
            e?.substanceAdministration,
            narrativeIds,
            documentDate,
            {
              snapshot: true,
              courseNote: "Ordered at visit",
            }
          )
        )
        .filter((x): x is ImportedRecord => x != null),
    };
  },
};
