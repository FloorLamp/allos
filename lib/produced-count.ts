// Reconciles a document's stored extracted_count SNAPSHOT (#212 — the row tally
// captured at import time) against the LIVE footprint count now. Rows legitimately
// leave a document after import — a user delete, a merge-fold into another row, a
// cross-profile reassign — so the snapshot can exceed what remains. Presenting the
// stale snapshot as a bare current "N items" on the Review feed, one click from a
// detail page that lists the live rows, was a visible contradiction ("7 items" vs
// "This import produced no records", #1339). ONE pure model both surfaces format,
// so the feed and detail can never phrase the same two numbers differently (#221).
//
// The extracted_count tally itself is unchanged — it stays the #212-tested import
// footprint (countImportedDocumentRows); the live count is the SAME footprint sum
// re-read now (producedTotal(getDocumentProduced)). This module is presentation
// only, and pure (no db/network) so it lives in the unit tier.

export interface ProducedReconciliation {
  // The extracted_count snapshot stamped at import time.
  extracted: number;
  // The rows that still trace back to this document right now.
  live: number;
  // Rows have left the document since import (live < extracted). Manual rows carry
  // no document link, so live never legitimately exceeds extracted; a defensive
  // clamp keeps `gone` non-negative if it somehow does.
  drifted: boolean;
  // How many rows left (extracted − live, floored at 0).
  gone: number;
}

export function reconcileProduced(
  extracted: number,
  live: number
): ProducedReconciliation {
  return {
    extracted,
    live,
    drifted: live < extracted,
    gone: Math.max(0, extracted - live),
  };
}

function items(n: number): string {
  return n === 1 ? "item" : "items";
}

// The compact Review-feed detail for a DONE document. The live count is the truth;
// when rows have drifted away the snapshot rides along as context ("3 of 7 items")
// so a current-looking bare count is never wrong, and a fully-drained import reads
// muted rather than announcing a phantom haul.
export function feedProducedDetail(r: ProducedReconciliation): {
  detail: string;
  muted: boolean;
} {
  if (!r.drifted) {
    return r.live === 0
      ? { detail: "no items", muted: true }
      : { detail: `${r.live} ${items(r.live)}`, muted: false };
  }
  return {
    detail: `${r.live} of ${r.extracted} ${items(r.extracted)}`,
    muted: r.live === 0,
  };
}

// The import-detail reconciliation line, shown only when the snapshot and the live
// count disagree. Names WHY the rows are gone so "0 remain" doesn't read as a
// failed import. Null when nothing drifted (the normal tab strip / empty-state copy
// stands).
export function detailReconciliationLine(
  r: ProducedReconciliation
): string | null {
  if (!r.drifted) return null;
  return `${r.extracted} extracted · ${r.live} remain (${r.gone} deleted, merged, or reassigned)`;
}
