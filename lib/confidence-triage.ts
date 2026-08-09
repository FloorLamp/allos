// Triage links for the import-detail "Check these first" card (#2339).
//
// The card (#1601) names the rows the extractor hedged on; every one of them is
// already rendered a few hundred pixels below in the tabbed records browser. This
// module answers the ONE question that turns a name into an action: WHICH row on
// WHICH tab does this flag's label name?
//
// Two rules from the issue, and both outrank the happy path:
//
//   1. NEVER GUESS A ROW. A label that resolves to several rows resolves to a
//      FILTER, not to one of them — sending a reviewer to the wrong row is worse
//      than sending them to a filtered list, because they may edit it. A label
//      that resolves to nothing SAYS SO, in the card, instead of offering a link
//      that goes nowhere.
//   2. RESOLVE BY LABEL, NOT BY A PERSISTED ID. The flag carries no row id and
//      gets none: an id is stale the moment a row is edited or the document is
//      reprocessed, while the label is already the identity the Dropped list and
//      the confidence list both key on. The same rule governs the link's own
//      `?focus=` param — it carries the LABEL, and the destination re-resolves it
//      against the rows that exist right then, so a row deleted between render and
//      click says so rather than highlighting nothing.
//
// Pure: no DB, no network. `getDocumentTriageRows` (lib/queries/imports.ts) builds
// the candidate rows; the import detail page asks the questions below.

import type { ConfidenceKind } from "./extraction-confidence";
import { medNameKey } from "./medication-record-match";

// One row of the records browser a flag's label could name.
export interface TriageRow {
  // Which extracted domain the row belongs to — the SAME vocabulary the flag
  // carries, so a "condition" flag can never resolve to a lab row that happens to
  // share its name.
  kind: ConfidenceKind;
  // The tab that renders it (an ImportTab key).
  tabKey: string;
  // Its DOM id inside that tab's panel (triageRowId below).
  rowId: string;
  // Every name the row goes by: its own name, its canonical name, the
  // relation-qualified spelling the extractor used… Any ONE of them matching the
  // flag's label is a match, because the flag records the name the MODEL used and
  // the panel renders the name the row was STORED under, and those legitimately
  // differ (a canonicalized analyte, "Mother: Diabetes" vs "Diabetes").
  labels: (string | null | undefined)[];
}

// What a flag's label resolves to.
export type TriageTarget =
  // Exactly one row: link straight at it (the destination highlights it).
  | { status: "row"; tabKey: string; rowId: string }
  // More than one: link at the owning tab FILTERED to the label, never at a row.
  | { status: "filter"; tabKey: string }
  // Nothing carries that label any more: no link at all, and the card says so.
  | { status: "missing" };

// What the DESTINATION tab should do with a `?focus=` label, re-resolved against
// the rows that exist right now.
export interface TriageFocus {
  // The label as it arrived, for the notice copy.
  label: string;
  // The matching rows on the ACTIVE tab (0, 1, or several).
  rowIds: string[];
  // "highlight" — exactly one match: scroll to it and tint it.
  // "filter"    — several: show only those rows, select none of them.
  // "missing"   — none: leave the panel alone and say so.
  mode: "highlight" | "filter" | "missing";
}

// The DOM id of a row inside its tab's panel. Tab key + row id, because a
// medical_records id and a conditions id collide freely.
export function triageRowId(tabKey: string, id: number): string {
  return `triage-row-${tabKey}-${id}`;
}

// Comparison form of a label: trimmed, inner whitespace collapsed, case-folded.
// Deliberately NOT fuzzy — a near-match is a guess, and guessing is the failure
// mode this whole module exists to avoid.
export function normalizeTriageLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

// The comparison key for a label IN ITS DOMAIN. Everything compares on the plain
// normalized form except a MEDICATION, which compares on the identity its own
// domain already owns (`medNameKey`): the flag records the printed prescription
// line ("Lisinopril 10 mg") while the med the import created is named by the drug
// alone, with the strength on its dose. That is not a fuzzy match — it is the same
// collapse the import/renewal/family paths key on, so the triage link and the
// writer cannot disagree about which med a prescription became.
function labelKey(kind: ConfidenceKind, label: string): string {
  const normalized = normalizeTriageLabel(label);
  if (kind !== "medication" || !normalized) return normalized;
  return medNameKey(label) || normalized;
}

function rowMatches(row: TriageRow, label: string): boolean {
  const wanted = labelKey(row.kind, label);
  if (!wanted) return false;
  return row.labels.some(
    (l) => l != null && l.trim() !== "" && labelKey(row.kind, l) === wanted
  );
}

// Which medical_records category maps to which confidence kind. The mirror image
// of the kind an extracted row was FLAGGED under (lib/import-shape's
// extractionConfidenceItems), so a persisted row and the flag that describes it
// agree: a prescription is a medication, a vitals row is a vital, and every other
// category — lab, biomarker, genomics, scan, report — is flagged as "lab".
export function recordConfidenceKind(
  category: string | null | undefined
): ConfidenceKind {
  if (category === "prescription") return "medication";
  if (category === "vitals") return "vitals";
  return "lab";
}

// The flag's label → the rows it names. Kind-scoped, exact after normalization.
export function resolveTriageTarget(
  flag: { kind: ConfidenceKind; label: string },
  rows: TriageRow[]
): TriageTarget {
  if (!normalizeTriageLabel(flag.label)) return { status: "missing" };
  const matches = rows.filter(
    (r) => r.kind === flag.kind && rowMatches(r, flag.label)
  );
  if (matches.length === 0) return { status: "missing" };
  if (matches.length === 1) {
    return {
      status: "row",
      tabKey: matches[0].tabKey,
      rowId: matches[0].rowId,
    };
  }
  // Several. The tab is the first match's — rows arrive in tab-strip order, so
  // that is the leftmost tab carrying the name. The link filters it; it never
  // selects a row, and the destination's notice says why.
  return { status: "filter", tabKey: matches[0].tabKey };
}

// The `?focus=` label → what the ACTIVE tab's panel does about it. Re-resolved
// here rather than trusted from the link, so an edited or deleted row degrades to
// an honest "not here" instead of a silent no-op highlight.
export function triageFocus(label: string, rows: TriageRow[]): TriageFocus {
  // Matched per ROW, because the comparison key is the row's own domain's.
  const rowIds = normalizeTriageLabel(label)
    ? rows.filter((r) => rowMatches(r, label)).map((r) => r.rowId)
    : [];
  return {
    label: label.trim(),
    rowIds,
    mode:
      rowIds.length === 1
        ? "highlight"
        : rowIds.length > 1
          ? "filter"
          : "missing",
  };
}
