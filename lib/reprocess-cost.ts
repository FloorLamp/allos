// Pure cost model for "Re-extract all documents" (issue #208). Re-extraction splits
// by document kind: a portal HEALTH RECORD (CCD/XDM, SMART Health Card, FHIR) re-
// imports DETERMINISTICALLY — parsed, zero AI, no quota — while any other document
// (a scan/PDF/photo) re-runs AI extraction and consumes one unit of the profile's
// daily extraction quota (every attempt charged, no refund on a model decline —
// #135 item 3). Reprocess-all is worst-case "every AI doc ever uploaded" in one
// click, so the confirm dialog shows this split + the remaining daily quota BEFORE
// running. This module owns the classification + math + message so the dialog is a
// pure formatter over ONE computation (the "one question, one computation" rule).
// Free of any `@/lib/db` import → covered by the pure unit tier
// (lib/__tests__/reprocess-cost.test.ts).

// The `medical_documents.source` values the deterministic health-record importers
// stamp (lib/health-record-parse.ts → healthRecordToPersistInput): a CCD/XDM export,
// a SMART Health Card, or a FHIR bundle. A document carrying one of these re-imports
// with NO AI call; everything else re-runs AI extraction. This mirrors the three
// formats detectHealthRecord recognizes without needing to re-read the file — the
// source key was persisted when the record first imported.
export const DETERMINISTIC_REPROCESS_SOURCES = new Set([
  "ccda",
  "smart-health-card",
  "fhir",
]);

export interface ReprocessDoc {
  source: string | null;
  mime_type: string | null;
}

// Does this document reprocess deterministically (health record, no AI)? Keyed on
// the persisted source; mime_type is carried for forward-compatibility but the
// source key is authoritative (it's what the reprocess path itself keys on).
export function isDeterministicReprocess(doc: ReprocessDoc): boolean {
  return doc.source != null && DETERMINISTIC_REPROCESS_SOURCES.has(doc.source);
}

export interface ReprocessCost {
  total: number; // documents that would reprocess
  deterministic: number; // health records — re-imported instantly, no AI
  ai: number; // scans/PDFs — one AI extraction each
  quotaLimit: number; // the profile's daily extraction cap
  quotaRemaining: number; // quota left BEFORE this run
  // Of the `ai` docs, how many actually dispatch within the remaining quota vs are
  // shed to 'skipped' once the cap is hit (attempts beyond the cap don't queue —
  // reprocessOne marks them skipped, see medical/actions.ts).
  aiWithinQuota: number;
  aiOverQuota: number;
  quotaAfter: number; // quota left AFTER this run's AI extractions (floored at 0)
  // True when the run makes NO AI call at all (all deterministic, or nothing to do)
  // → the dialog can skip confirmation entirely.
  noAi: boolean;
}

// Classify a document set and compute the AI/no-AI split against the profile's
// remaining daily extraction quota. Pure → unit-tested.
export function computeReprocessCost(
  docs: ReprocessDoc[],
  quotaUsed: number,
  quotaLimit: number
): ReprocessCost {
  let deterministic = 0;
  let ai = 0;
  for (const d of docs) {
    if (isDeterministicReprocess(d)) deterministic++;
    else ai++;
  }
  const quotaRemaining = Math.max(0, quotaLimit - Math.max(0, quotaUsed));
  const aiWithinQuota = Math.min(ai, quotaRemaining);
  const aiOverQuota = ai - aiWithinQuota;
  return {
    total: deterministic + ai,
    deterministic,
    ai,
    quotaLimit,
    quotaRemaining,
    aiWithinQuota,
    aiOverQuota,
    quotaAfter: Math.max(0, quotaRemaining - aiWithinQuota),
    noAi: ai === 0,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The human cost-preview line the confirm dialog shows, e.g.
// "14 documents: 9 health records (re-imported instantly, no AI) · 5 scans/PDFs
//  (5 AI extractions — 43 of 50 daily remaining)".
// When the daily cap would be hit mid-run it says how many dispatch now vs are
// skipped. Pure → unit-tested.
export function formatReprocessCost(cost: ReprocessCost): string {
  if (cost.total === 0) return "No uploaded documents to re-extract.";

  const parts: string[] = [];
  if (cost.deterministic > 0) {
    parts.push(
      `${plural(cost.deterministic, "health record", "health records")} (re-imported instantly, no AI)`
    );
  }
  if (cost.ai > 0) {
    const scans = plural(cost.ai, "scan/PDF", "scans/PDFs");
    let detail: string;
    if (cost.aiOverQuota > 0) {
      detail =
        cost.aiWithinQuota > 0
          ? `${plural(cost.aiWithinQuota, "AI extraction", "AI extractions")} now — ${cost.aiOverQuota} skipped, daily limit of ${cost.quotaLimit} reached`
          : `daily AI limit of ${cost.quotaLimit} reached — all ${cost.ai} skipped`;
    } else {
      detail = `${plural(cost.ai, "AI extraction", "AI extractions")} — ${cost.quotaAfter} of ${cost.quotaLimit} daily remaining`;
    }
    parts.push(`${scans} (${detail})`);
  }

  return `${plural(cost.total, "document", "documents")}: ${parts.join(" · ")}`;
}
