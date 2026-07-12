// The document-import contract, as PURE DATA — no db/network imports — so both the
// persist core (lib/import-persist.ts, which opens the DB) and the pure test tier
// (lib/__tests__/*) can consume it. Mirrors lib/owned-tables.ts: a shared constant is
// the single source of truth, and tests bind to it without pulling in a DB handle.

// THE single source of truth for a document import's per-row footprint: every
// table an import writes, and how each row traces back to its source document.
// EVERY consumer that must touch a document's whole footprint derives its
// statements from this ONE list, so a table can never be handled in one place but
// leak in another (#201):
//   - clearImportedDocumentRows — the reprocess/delete delete-set;
//   - moveImportedDocumentRows — reassignDocument's cross-profile move;
//   - countImportedDocumentRows — the extracted_count tally.
// (The tables had drifted before this list existed: head-circ samples/allergies/
// conditions/encounters were added to the reprocess clear but not the delete path,
// then procedures/family_history/care_plan_items/care_goals were cleared+deleted
// but NOT moved on reassign — stranding them cross-profile with an FK-500 on the
// new owner's later delete. Binding both callers to this list makes that drift
// impossible.)
//
// `key` is how a row is tied to its document — and MUST match what
// persistDocumentImport writes:
//   - "document_id": the row carries the document_id (medical_records, allergies,
//     conditions, encounters, procedures, family_history, care_plan_items,
//     care_goals, and the auto-structured extracted medications, which ALSO carry
//     `extra: source = 'extracted'`).
//   - "source": the row carries the document's source STRING
//     (documentSource(docId)) rather than a document_id (body_metrics,
//     immunizations, and the height/head-circumference metric_samples, the latter
//     two isolated by their `extra` metric filter).
// `extra` is an additional bound-param-free AND predicate.
export interface ImportFootprintTable {
  table: string;
  key: "document_id" | "source";
  extra?: string;
}

export const IMPORT_FOOTPRINT_TABLES: readonly ImportFootprintTable[] = [
  { table: "medical_records", key: "document_id" },
  { table: "allergies", key: "document_id" },
  { table: "conditions", key: "document_id" },
  { table: "encounters", key: "document_id" },
  { table: "procedures", key: "document_id" },
  { table: "family_history", key: "document_id" },
  { table: "care_plan_items", key: "document_id" },
  { table: "care_goals", key: "document_id" },
  // Medications auto-structured from this document. Keyed on source='extracted' so
  // a manual med — even one pointing at no document — is never touched; child
  // dose/log rows cascade via their FKs.
  { table: "intake_items", key: "document_id", extra: "source = 'extracted'" },
  { table: "body_metrics", key: "source" },
  { table: "immunizations", key: "source" },
  { table: "metric_samples", key: "source", extra: "metric = 'height_cm'" },
  {
    table: "metric_samples",
    key: "source",
    extra: "metric = 'head_circumference_cm'",
  },
];

// THE side-STATE an import writes ALONGSIDE its footprint rows — the non-row
// effects that IMPORT_FOOTPRINT_TABLES does NOT cover, inventoried in ONE place so
// the next side effect added has an obvious slot and an obvious question to answer
// (#453 item 2). A footprint TABLE is mechanically cleared/moved/counted off the
// list above; a side EFFECT is a decision, so each entry DECLARES how it behaves
// when the document is deleted/reprocessed, when it's reassigned to another
// profile, and whether it feeds the extracted_count tally. This list is
// documentation-with-teeth: it is pinned by lib/__tests__/import-side-effects.test.ts
// so a new followup can't be added silently — it must take a slot and answer the
// three questions. `where` names the code that performs the effect.
//
// The four verdicts:
//   - "one-way": the effect is a FACT LEARNED about the profile that stays true
//     regardless of the document's fate, so it is deliberately NOT reverted on
//     delete NOR moved on reassign — reverting could clobber a later manual edit
//     (the #452 item-2 adoption decision, declared here IN the contract).
//   - "recompute": derived state that is re-derived from whatever rows remain, so
//     it needs no explicit revert (delete leaves nothing to reconcile; reassign
//     re-reconciles the moved rows against the destination's demographics).
//   - "sweep": name-keyed side-state (stars, retest/flag dismissals) that is swept
//     of now-orphaned keys after the rows move/leave (#203/#327).
//   - "global": a shared cross-profile registry (providers, canonical names) that
//     no single document owns, so a delete/reassign touches nothing.
export interface ImportSideEffect {
  key: string;
  what: string;
  where: string;
  // In the persist transaction, or a post-commit best-effort followup?
  inTransaction: boolean;
  onDelete: "one-way" | "recompute" | "sweep" | "global";
  onReassign: "one-way" | "recompute" | "sweep" | "global";
  // Does this effect contribute a row to the extracted_count footprint tally?
  // Always false — side EFFECTS are not footprint ROWS (that's the distinction).
  countsTowardFootprint: false;
}

export const IMPORT_SIDE_EFFECTS: readonly ImportSideEffect[] = [
  {
    key: "smoking-status-adoption",
    what: "seed the STRUCTURED smoking record (profile_settings) from an imported social-history smoking condition; the condition ROW itself is a footprint row, this is the derived structured status",
    where:
      "adoptSmokingStatusFromImport (insertImportRows, in the persist transaction)",
    inTransaction: true,
    onDelete: "one-way",
    onReassign: "one-way",
    countsTowardFootprint: false,
  },
  {
    key: "demographics-adoption",
    what: "backfill the profile's sex/birthdate/name from the document's stated patient demographics (never overwriting a chosen value)",
    where: "adoptProfileFromExtraction (applyImportFollowups, post-commit)",
    inTransaction: false,
    onDelete: "one-way",
    onReassign: "one-way",
    countsTowardFootprint: false,
  },
  {
    key: "canonical-name-registration",
    what: "register the document's biomarker canonical names into the global canonical registry",
    where: "addCanonicalNames (applyImportFollowups, post-commit)",
    inTransaction: false,
    onDelete: "global",
    onReassign: "global",
    countsTowardFootprint: false,
  },
  {
    key: "flag-reconciliation",
    what: "re-derive out-of-range flags on medical_records (reconciledFlag depends on the profile's sex/age/reproductive status)",
    where:
      "reconcileFlags (applyImportFollowups post-commit; reassignDocument re-reconciles the destination)",
    inTransaction: false,
    onDelete: "recompute",
    onReassign: "recompute",
    countsTowardFootprint: false,
  },
  {
    key: "orphan-biomarker-keyed-state-sweep",
    what: "drop stars AND retest/flag dismissals whose biomarker no longer has any backing records, so a later document re-pins/re-nudges instead of inheriting stale name-keyed state (#203/#327)",
    where:
      "cleanupOrphanBiomarkerKeyedState (deleteMedicalDocument + reassignDocument transactions)",
    inTransaction: true,
    onDelete: "sweep",
    onReassign: "sweep",
    countsTowardFootprint: false,
  },
];
