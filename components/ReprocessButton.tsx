"use client";

import { useState, useTransition } from "react";
import { IconRefresh } from "@tabler/icons-react";
import {
  reprocessAllDocuments,
  previewReprocessAllCost,
} from "@/app/(app)/medical/document-actions";
import type { ReprocessResult } from "@/lib/medical-pipeline";
import { useConfirm } from "@/components/ConfirmDialog";
import { formatReprocessCost } from "@/lib/reprocess-cost";

// "Re-run extraction on all documents" — re-extracts every uploaded document and replaces its
// imported records with fresh results: deterministic re-import for health records
// (MyChart CCD/XDM, SMART Health Cards, FHIR), AI extraction for scans/PDFs. It is
// scoped to DOCUMENTS only (never the recurring syncs), which is why it lives in the
// Imports section header (issue #208). Before confirming it previews the AI cost —
// how many documents re-import instantly vs burn a daily extraction unit, and the
// quota that remains — computed by the pure lib/reprocess-cost (one computation, the
// dialog formats over it). Destructive for manual edits to imported records, so the
// AI case confirms first; an all-deterministic run has no cost and skips the confirm.
export default function ReprocessButton() {
  const confirm = useConfirm();
  const [transitionPending, startTransition] = useTransition();
  const [preparing, setPreparing] = useState(false);
  const [result, setResult] = useState<ReprocessResult | null>(null);
  const pending = preparing || transitionPending;

  async function run() {
    setResult(null);
    setPreparing(true);
    let cost;
    try {
      cost = await previewReprocessAllCost();
    } catch {
      // The preview is fired from an un-awaited onClick, so a throw here was
      // completely silent (issue #477) — surface it inline instead.
      setResult({
        status: "skipped",
        message: "Couldn't check documents. Try again.",
      });
      return;
    } finally {
      setPreparing(false);
    }

    if (cost.total === 0) {
      setResult({
        status: "done",
        message: "No uploaded documents to re-extract.",
      });
      return;
    }

    const costLine = formatReprocessCost(cost);
    // Skip-confirm fast path: an all-deterministic run makes no AI call, replaces
    // nothing you edited by hand in an irreversible way beyond a re-import, and has
    // no quota cost — just run it.
    if (!cost.noAi) {
      const ok = await confirm({
        title: "Re-run extraction on all documents",
        message: (
          <div className="space-y-2">
            <p className="font-medium text-slate-700 dark:text-slate-200">
              {costLine}
            </p>
            <p>
              Each document&apos;s imported records are replaced and any manual
              edits to them are discarded — records you added by hand are
              untouched.
            </p>
          </div>
        ),
        confirmLabel: "Re-run extraction on all",
      });
      if (!ok) return;
    }

    setResult(null);
    startTransition(async () => {
      try {
        setResult(await reprocessAllDocuments());
      } catch {
        // A throw inside the transition would escalate to the route error
        // boundary; keep it on this row instead (issue #477).
        setResult({
          status: "skipped",
          message: "Couldn't re-extract. Try again.",
        });
      }
    });
  }

  const tone =
    result?.status === "skipped"
      ? "text-amber-600 dark:text-amber-400"
      : "text-slate-500 dark:text-slate-400";

  return (
    <div className="flex items-center gap-3">
      {result && <span className={`text-sm ${tone}`}>{result.message}</span>}
      <button
        type="button"
        onClick={run}
        disabled={pending}
        data-testid="reprocess-all"
        title="Re-run extraction on all documents"
        aria-label="Re-run extraction on all documents"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:text-brand-400"
      >
        {pending ? (
          <span>{transitionPending ? "Re-extracting…" : "Checking…"}</span>
        ) : (
          <>
            <IconRefresh className="h-4 w-4" />
            <span>Re-run extraction on all documents</span>
          </>
        )}
      </button>
    </div>
  );
}
