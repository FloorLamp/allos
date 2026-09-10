// The SQL IDENTITY layer shared by the three submodules behind lib/queries/medical.ts
// (issue #5171): the name / family / panel key expressions every biomarker surface
// partitions on, and the cross-source DEDUP + LATEST representative CTEs built over
// the family key. Private to the directory apart from the three key helpers, which
// the barrel re-exports. Nothing here opens a statement; it is SQL text only.

import { BIOMARKER_FAMILY_FN, BIOMARKER_PANEL_FN } from "../../sql-functions";
import {
  inRepresentativeCte,
  medicalDedupSpec,
  medicalLatestSpec,
  representativeCte,
} from "../../representative-ids";

// Display/grouping identity for a biomarker: the canonical name when present,
// otherwise the raw name. Name sorting and the "current value" filter both key
// off this so the table orders and dedupes by the same identity it shows.
// Pass a table alias (e.g. "mr2") when disambiguating a self-join.
export function biomarkerNameKey(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(NULLIF(TRIM(${p}canonical_name), ''), ${p}name)`;
}

// The biomarker FAMILY identity as a SQL expression (#482) — the ONE grouping key
// every biomarker surface partitions/matches on so none of them can disagree about
// what "Vitamin D" is: the dedup partition, the is_latest/current marker, the
// chart/detail series, and the starred tile all key on THIS instead of the bare
// per-name key.
//
// It calls the SAME pure biomarkerFamily() the JS surfaces do, through the
// `biomarker_family()` SQLite user function lib/db.ts registers (see
// lib/sql-functions.ts) — literally one computation, not two realizations of it.
// This USED to be a finite-preimage (#394) `CASE WHEN lower(name) IN (<members>)`
// built from BIOMARKER_FAMILIES, which could only enumerate each family's finite
// member list and structurally dropped the family's freeform `match` matcher. A
// stored name caught only by that regex (an un-snapped AI-coined A1c spelling) was
// then one family to the JS star/retest/dismissal surfaces and its OWN singleton
// to the partitions below — the same measurement double-counted on one date and
// markable "current" twice (#1401). Behavior is otherwise unchanged: an enumerated
// member resolves to the identical `family:<key>` string, and every non-family name
// still resolves to its own display name (now trimmed on both sides rather than
// only the JS side), byte-for-byte the pre-#482 grouping for non-family analytes.
//
// Reused both for the records grouping key (over the canonical-or-raw display name)
// and the star store (over its bare `key` column), so both key on the identical
// family identity. The function name is a hardcoded constant, so this is
// injection-safe. Pass a table alias for a self-join.
export function familyKeyOfExpr(nameExpr: string): string {
  return `${BIOMARKER_FAMILY_FN}(${nameExpr})`;
}
export function biomarkerFamilyKey(alias = ""): string {
  return familyKeyOfExpr(biomarkerNameKey(alias));
}
// The normalized PANEL slug as a SQL expression (#1502), over the same canonical-or-
// raw display-name key the family grouping uses. A name the taxonomy doesn't know
// resolves to 'other'. Pass a table alias for a self-join.
//
// Like the family key above, it calls the SAME pure panelForCanonicalName() the JS
// surfaces do, through the `biomarker_panel()` SQLite user function lib/db.ts
// registers (see lib/sql-functions.ts). This USED to be a generated finite-preimage
// (#394) `CASE WHEN lower(name) IN (<member spellings>)` over each panel's enumerated
// members — which inherited the #1401 blind spot one level up (#1629): a stored name
// caught only by a family's freeform `match` matcher was a family member to the
// family key but panel 'other' to THIS expression, so the Biomarkers panel facet and
// the Timeline panel titles could file one reading of a family under its clinical
// panel and a sibling reading of the same family under "Other". Behavior is otherwise
// unchanged: every enumerated spelling resolves to the identical slug, and an unknown
// name still resolves to 'other' (including a NULL name — the resolver maps blank to
// the fallback exactly as the CASE's ELSE did).
export function biomarkerPanelKey(alias = ""): string {
  return `${BIOMARKER_PANEL_FN}(${biomarkerNameKey(alias)})`;
}
export const BIOMARKER_FAMILY_KEY = biomarkerFamilyKey();

// ---- Cross-source de-duplication (read layer, import assessment P1-1) ----
//
// Storage keeps ONE physical row per source document — lib/import-persist scopes
// every parsed external_id with the document source, so the SAME reading appearing
// in two separately-uploaded documents lands as two rows (and a manual reading
// plus its imported twin as two rows). That is deliberate: deleting one document
// must never orphan a reading a DIFFERENT document independently contributed, and
// the per-document delete-set relies on each document owning its own rows. The
// cost is user-visible double-counting in lists, series, and counts.
//
// This collapses those duplicates at READ time only — no schema change, no storage
// change — so per-document delete semantics are untouched: every physical row still
// exists and is cleared with exactly its own document; deleting one of two documents
// that both contributed a reading simply leaves the other document's row, which this
// CTE then surfaces as the single representative, and deleting the ONLY contributor
// removes the reading entirely.
//
// Content-identity = (profile_id, biomarker FAMILY NOCASE, date, value,
// value_num, unit). The name dimension is the #482 FAMILY key, not the bare name,
// so two names that are the same measurement (a "Vitamin D, 25-Hydroxy" and a
// generic "Vitamin D" reading of the same value/date/unit from two documents)
// collapse to one representative instead of double-counting — the same identity
// the series/starred/is_latest surfaces now use. Rows sharing ALL of these are the
// SAME reading and collapse to one; any difference — most importantly a DIFFERENT
// value for the same date+family (a genuine conflict, not a dup) — puts rows in
// different groups so BOTH stay visible and are never silently merged (so a
// same-date total/D2/D3 breakdown with distinct values stays fully visible; only an
// exact value+date+unit coincidence across two family members would coalesce).
// value/value_num/unit NULLs group together (window PARTITION BY treats NULLs as
// equal), so a numeric-only reading (value NULL, value_num set) dedups correctly too.
//
// Representative rule: prefer a MANUAL row (document_id IS NULL — manual entries
// carry no document; both import paths stamp one) over an imported twin, so the
// user's own entry and its reference_range/flag win; then the most-recent physical
// row (id DESC — a proxy for the newest upload, since a reprocess re-inserts). That
// is the shared `document` preference axis, and the window is emitted by the shared
// builder (lib/representative-ids.ts, #2035) rather than hand-written here. The
// single `?` binds profile_id.
export const DEDUP_IDS_CTE = representativeCte(
  "deduped",
  medicalDedupSpec(BIOMARKER_FAMILY_KEY)
);
// Membership test: this row is the surviving representative of its content-identity.
export const IN_DEDUPED = inRepresentativeCte("deduped");

// CTE that ranks every reading within its biomarker group (keyed on the #482
// FAMILY identity, case-insensitively — so the vitamin-D 25-OH variants share one
// current reading) newest-first — date, then id as tie-break — and keeps
// only rn = 1, the current reading. That ordering is the shared `recency` axis (the
// SQL half of lib/latest-per-group.isLaterReading, #944). Ranked over the DE-DUPED id
// set (not all rows) so the "current value" filter and is_latest marker agree with
// the de-duplicated list: whichever representative dedup kept is the one ranked here,
// so a manual reading preferred by dedup is also the one flagged current. Filtered by
// profile_id, independent of the table's other filters (category/panel/range/q).
// The `?` binds profile_id (a second time, after the deduped CTE's).
export const LATEST_IDS_CTE = representativeCte(
  "latest",
  medicalLatestSpec(BIOMARKER_FAMILY_KEY),
  { where: IN_DEDUPED }
);
// True for the current reading in a biomarker group — a membership test against
// the ranked CTE above. Same identity the "current value" filter uses.
export const LATEST_IN_GROUP = inRepresentativeCte("latest");
