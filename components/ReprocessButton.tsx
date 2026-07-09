"use client";

import { IconRefresh } from "@tabler/icons-react";
import { reprocessAllDocuments } from "@/app/(app)/medical/actions";
import { useConfirmedAction } from "@/components/useConfirmedAction";

// Re-runs AI extraction on every uploaded document and replaces its imported
// records with fresh results. Destructive — overwrites manual edits — so it
// confirms first. Rendered as an icon action in the documents header. Unlike the
// single-document reprocess, this awaits the full sequential run and shows a
// summary of the outcome.
export default function ReprocessButton() {
  const { pending, result, run } = useConfirmedAction(
    {
      title: "Reprocess all documents",
      message:
        "Re-run AI extraction on every uploaded document — useful after improving extraction or to regroup biomarkers consistently. This replaces each document’s imported records and discards manual edits.",
      confirmLabel: "Reprocess all",
    },
    reprocessAllDocuments
  );

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
        title="Reprocess all documents"
        aria-label="Reprocess all documents"
        className="text-slate-400 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-500 dark:hover:text-brand-400"
      >
        {pending ? (
          <span className="text-sm">Reprocessing…</span>
        ) : (
          <IconRefresh className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
