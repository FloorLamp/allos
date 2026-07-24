// The per-control explainer copy for the import-detail Actions section (#1340,
// finishing the #1071/#1332 verb consolidation). The bottom Actions paragraph used
// to statically narrate all three verbs — but "Re-apply saved extraction" renders
// only when the document carries a SAVED AI extraction (#903), so the common case
// showed copy describing a button that wasn't there, and the AI-cost warning
// vanished exactly when it mattered. Each rendered control now carries its own
// subtext, selected here so the deterministic-vs-AI × has-raw matrix lives in ONE
// pure, tested place and can't drift from what actually renders.
//
// Product decision (#1340): DETERMINISTIC imports (CCD/XDM/SHC/FHIR) get ZERO
// re-apply narration anywhere — they store no AI extraction, so the control never
// renders and its copy must never appear — and their "Preview changes" says the
// re-run is FREE and EXACT (no AI call, no quota; the diff footnote already states
// deterministic imports diff exactly), while an AI document's "Preview changes"
// carries the daily-extraction cost note whether or not re-apply is present.
//
// Pure (no db/network) → lives in the unit tier. The `deterministic` flag is the
// same classification as isDeterministicReprocess (lib/reprocess-cost.ts); callers
// pass it in so this module needn't import the DB-facing helper.

export interface ImportActionExplainers {
  // Subtext under "Preview changes" (ReprocessDiffPanel). Deterministic health
  // records re-import exactly with no AI call or quota; AI documents spend one daily
  // extraction on the re-read.
  preview: string;
  // Subtext under "Re-apply saved extraction". Null when that control isn't
  // rendered — a deterministic import (no saved extraction, product-decided zero
  // narration) or any document with no stored raw to replay — so nothing describes a
  // missing button.
  reapply: string | null;
  // Subtext under "Delete document & its records".
  delete: string;
}

export function importActionExplainers(input: {
  deterministic: boolean;
  hasRaw: boolean;
}): ImportActionExplainers {
  const { deterministic, hasRaw } = input;
  return {
    preview: deterministic
      ? "Re-imports this health record and shows the diff before saving — no AI call, no quota, and the re-import is exact."
      : "Re-runs the AI to re-read this document and shows the diff before saving — costs one daily extraction.",
    // Belt-and-braces: gate on BOTH the product rule (never for deterministic) and
    // the structural fact (nothing to replay without a saved raw). Deterministic
    // imports carry no raw, so either alone would hide it — but stating both keeps
    // the intent legible.
    reapply:
      !deterministic && hasRaw
        ? "Replays the extraction already saved with this document — no AI call, no quota used. Use it when the extraction was right but only the import was off."
        : null,
    delete:
      "Removes this document and every record it imported. This can’t be undone.",
  };
}
