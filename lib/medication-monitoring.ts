// Pure medication → required-monitoring-lab bridge (issue #995) — the med-driven sibling
// of the biomarker retest clock. No DB, no network: given a profile's ACTIVE medications
// (with their start / recent-change dates) and the newest date each monitoring lab was
// last drawn, it returns retest-shaped hits — one per (med, dataset entry) whose
// monitoring labs are DUE — that the query layer turns into Upcoming retest items.
//
// It is the med-driven sibling of condition/family-history screening cadence: a NEW input
// to the retest layer that can CREATE a retest that wouldn't otherwise exist (a healthy
// person has no lithium-level retest; taking lithium creates one). Unlike the one-shot
// safety cross-checks (contrast #701, dental #704, PGx #710, ototoxic #717), this is a
// RECURRING due-item on a med-driven cadence, satisfied when a matching lab result comes
// in (the newest matching reading moves the clock forward).
//
// DRUG IDENTITY (#482): monitored drugs are matched by RxNorm ingredient CUI + synonym
// through the SHARED matchConceptKeysIn machinery (the same matcher the drug-interaction /
// PGx / ototoxic cross-checks use), NOT raw-name matching.
//
// LAB SATISFACTION (#482): each required lab is keyed on a CANONICAL biomarker name, and a
// matching reading satisfies it FAMILY-AWARE through biomarkerFamily — so an eAG reading
// satisfies an "Hemoglobin A1c" requirement, sharing the same identity function the
// biomarker retest/series/starred surfaces key on. Never a forked satisfaction path.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE (#995 decision 3). A hit flags a
// monitoring conversation to have with the prescriber; it never says "get this test",
// never "change a drug", and the absence of an entry is NOT clearance (a curated subset).

import {
  MED_MONITORING_ENTRIES,
  type MedMonitoringEntry,
  type MonitoringTier,
} from "./datasets/medication-monitoring";
import { matchConceptKeysIn } from "./drug-interactions";
import { biomarkerFamily } from "./canonical-name";
import { shiftDateStr, daysBetweenDateStr } from "./date";

// ---- Documented cadence constants (boundary-tested) ------------------------

// The window (days) after a med's start OR most recent dose change during which the
// tighter `initDays` cadence applies before settling to `maintenanceDays`. Monitoring is
// intensified right after starting/adjusting a drug (titration/toxicity watch), then
// spaced out once the level and organ function are stable. 90 days ≈ a quarter — long
// enough to cover the typical titration + first steady-state check across the curated
// drugs, deliberately conservative (a slightly-longer tight phase errs toward MORE
// monitoring, which is the safe direction for a monitoring nudge).
export const MONITORING_INIT_WINDOW_DAYS = 90;

// ---- Inputs / outputs ------------------------------------------------------

// The medication fields the builder reads: the active-med shape from
// getIntakeSafetyContext (id, name, rxcui, rxcuiIngredients) plus the derived
// `startDate` (medicationStartDate — the open course's start, else created_at) and
// `recentChangeDate` (the most recent of start / dose re-time / course restart). Both
// dates are YYYY-MM-DD; a null start falls back to no-init (maintenance cadence).
export interface MonitoredMedInput {
  id: number;
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
  startDate: string | null;
  recentChangeDate: string | null;
}

// One monitoring lab that is currently due (or missing) for a med.
export interface DueMonitoringLab {
  canonical: string;
  label: string;
  // The newest date this lab (family-aware) was last drawn, or null when never on file.
  lastTested: string | null;
}

// One retest-shaped hit: an active med resolves to a monitoring entry whose labs are due.
export interface MedMonitoringHit {
  medId: number;
  medName: string;
  // The matched entry's stable key + human label (never user input).
  entryKey: string;
  entryLabel: string;
  tier: MonitoringTier;
  // Whether the med is in its tighter post-start/-change window or steady state.
  phase: "init" | "maintenance";
  // The cadence (days) the current phase applies — for the copy ("every ~6 months").
  cadenceDays: number;
  // "baseline" when the med is newly monitored with NONE of its baseline labs on file
  // (the calm "baseline recommended" framing); "retest" otherwise.
  kind: "baseline" | "retest";
  // The labs currently due/missing (non-empty — a hit is only emitted when ≥1 is due).
  dueLabs: DueMonitoringLab[];
  // Earliest due date among the due labs (YYYY-MM-DD); `today` for a baseline hit.
  dueDate: string;
  note: string;
  citation: string;
  // The stable suppression/identity key — `med-monitor:<medId>:<entryKey>`. Keyed on the
  // med's item id (ids never recycle, names do — AGENTS.md #203) + the stable entry key,
  // so a dismiss follows the specific med-and-monitoring finding and a med rename never
  // re-attaches it elsewhere.
  dedupeKey: string;
}

export function medMonitoringSignalKey(
  medId: number,
  entryKey: string
): string {
  return `med-monitor:${medId}:${entryKey}`;
}

// The family key a monitoring lab's canonical name resolves to (#482) — the key
// `labDatesByFamily` is keyed on, so an eAG reading (same family as HbA1c) satisfies an
// HbA1c requirement.
export function monitoringLabFamilyKey(canonical: string): string {
  return biomarkerFamily(canonical).toLowerCase();
}

// The monitoring entries an active medication resolves to — matched by RxCUI ingredient +
// synonym through the shared machinery (#482). A med can match more than one (clozapine →
// its ANC entry AND the antipsychotic metabolic entry).
export function monitoringEntriesForMed(med: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): MedMonitoringEntry[] {
  const keys = new Set(
    matchConceptKeysIn(
      {
        name: med.name,
        rxcui: med.rxcui,
        rxcuiIngredients: med.rxcuiIngredients ?? undefined,
      },
      MED_MONITORING_ENTRIES
    )
  );
  return MED_MONITORING_ENTRIES.filter((e) => keys.has(e.key));
}

// The cadence phase for a med on `today`: `init` while within
// MONITORING_INIT_WINDOW_DAYS of its most recent start/change, else `maintenance`. A med
// with no known change date (neither start nor recentChange) is treated as maintenance
// (nothing signals an active titration window).
function phaseFor(
  med: MonitoredMedInput,
  today: string
): "init" | "maintenance" {
  const anchor = med.recentChangeDate ?? med.startDate;
  if (!anchor) return "maintenance";
  const age = daysBetweenDateStr(anchor, today);
  if (age == null) return "maintenance";
  return age <= MONITORING_INIT_WINDOW_DAYS ? "init" : "maintenance";
}

// Detect every med-monitoring hit between the profile's active meds and the curated
// table. `labDatesByFamily` maps a lab's family key (monitoringLabFamilyKey) to the
// NEWEST date a matching reading was drawn; a missing key means the lab is not on file.
// Deterministically ordered (med name, then entry key). An unrecognized medication, or a
// monitored med whose labs are all fresh, produces nothing.
export function buildMedMonitoring(
  meds: readonly MonitoredMedInput[],
  labDatesByFamily: ReadonlyMap<string, string>,
  today: string
): MedMonitoringHit[] {
  const hits: MedMonitoringHit[] = [];
  for (const med of meds) {
    const phase = phaseFor(med, today);
    for (const entry of monitoringEntriesForMed(med)) {
      const cadenceDays =
        phase === "init" ? entry.initDays : entry.maintenanceDays;
      const dueLabs: DueMonitoringLab[] = [];
      let earliestDue: string | null = null;
      for (const lab of entry.labs) {
        const lastTested =
          labDatesByFamily.get(monitoringLabFamilyKey(lab.canonical)) ?? null;
        let due: string | null = null;
        if (lastTested) {
          // Satisfaction: the clock runs from the newest matching reading. Due when
          // last + cadence is in the past (mirrors the biomarker retest staleness gate).
          const next = shiftDateStr(lastTested, cadenceDays);
          if (next <= today) due = next;
        } else if (entry.baseline) {
          // Newly monitored, no baseline reading on file → recommended now.
          due = today;
        } else if (med.startDate) {
          // Non-baseline lab never drawn: due once the first cadence has elapsed since
          // the med started (so a just-started med isn't nagged on day one).
          const next = shiftDateStr(med.startDate, cadenceDays);
          if (next <= today) due = next;
        }
        if (due == null) continue;
        dueLabs.push({
          canonical: lab.canonical,
          label: lab.label,
          lastTested,
        });
        if (earliestDue == null || due < earliestDue) earliestDue = due;
      }
      if (dueLabs.length === 0 || earliestDue == null) continue;
      const kind =
        entry.baseline && dueLabs.every((l) => l.lastTested == null)
          ? "baseline"
          : "retest";
      hits.push({
        medId: med.id,
        medName: med.name,
        entryKey: entry.key,
        entryLabel: entry.label,
        tier: entry.tier,
        phase,
        cadenceDays,
        kind,
        dueLabs,
        dueDate: earliestDue,
        note: entry.note,
        citation: entry.source,
        dedupeKey: medMonitoringSignalKey(med.id, entry.key),
      });
    }
  }
  return hits.sort(
    (a, b) =>
      a.medName.localeCompare(b.medName) || a.entryKey.localeCompare(b.entryKey)
  );
}

// ---- The medications-row "requires monitoring" note (issue #995 item 6) ----

// One monitoring descriptor for a med's row note — the required labs a clinician
// typically watches while on this drug (independent of dueness). Rendered as
// "Requires monitoring: lithium level, TSH, creatinine".
export interface MonitoringRowNote {
  entryKey: string;
  entryLabel: string;
  tier: MonitoringTier;
  labels: string[];
  note: string;
  citation: string;
}

// The monitoring descriptors for an active med (its matched entries' required labs). One
// per matched entry, so a drug in two classes (clozapine → ANC + metabolic) lists both.
// Empty when the med isn't in the curated table.
export function monitoringNotesForMed(med: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): MonitoringRowNote[] {
  return monitoringEntriesForMed(med).map((entry) => ({
    entryKey: entry.key,
    entryLabel: entry.label,
    tier: entry.tier,
    labels: entry.labs.map((l) => l.label),
    note: entry.note,
    citation: entry.source,
  }));
}

// The single-line row note text for a med, or null when it isn't monitored. Joins every
// matched entry's labs into one "Requires monitoring: …" phrase (deduped, order-stable).
export function monitoringRowNoteText(med: {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): string | null {
  const notes = monitoringNotesForMed(med);
  if (notes.length === 0) return null;
  const labels: string[] = [];
  for (const n of notes) {
    for (const l of n.labels) if (!labels.includes(l)) labels.push(l);
  }
  return `Requires monitoring: ${labels.join(", ")}`;
}

// ---- Formatting (shared by every surface) ----------------------------------

// The retest-item title. Baseline hits read "Baseline labs for Lithium"; recurring hits
// read "Monitoring labs for Lithium" — the verb-carrying action framing the biomarker
// retest copy uses, never a bare drug name.
export function medMonitoringTitle(hit: MedMonitoringHit): string {
  return hit.kind === "baseline"
    ? `Baseline labs for ${hit.entryLabel}`
    : `Monitoring labs for ${hit.entryLabel}`;
}

// A rough month approximation of the cadence, for the copy ("every ~6 months").
function cadenceMonths(days: number): number {
  return Math.max(1, Math.round(days / 30.44));
}

// The informational, never-prescriptive detail line. Lists the due labs, states the
// cadence, and appends the class note + citation. Baseline hits use the "baseline
// recommended around starting" framing.
export function medMonitoringDetail(hit: MedMonitoringHit): string {
  const labs = hit.dueLabs.map((l) => l.label).join(", ");
  const cadence = `recommended about every ${cadenceMonths(
    hit.cadenceDays
  )} months while taking ${hit.entryLabel}`;
  const lead =
    hit.kind === "baseline"
      ? `Baseline ${labs} recommended around starting ${hit.entryLabel}`
      : `Due: ${labs} · ${cadence}`;
  return `${lead}. ${hit.note} Informational — discuss timing with your prescriber; the absence of a note is not clearance. Source: ${hit.citation}.`;
}
