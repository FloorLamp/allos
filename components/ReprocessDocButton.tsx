"use client";

import { IconRefresh } from "@tabler/icons-react";
import { useReprocessDocument } from "@/components/useReprocessDocument";

// Reprocess a single uploaded document: re-runs AI extraction and replaces its
// records. Destructive (discards manual edits to this document), so it confirms.
export default function ReprocessDocButton({
  id,
  filename,
}: {
  id: number;
  filename: string;
}) {
  const { pending, reprocess } = useReprocessDocument(id, filename);

  return (
    <button
      type="button"
      onClick={reprocess}
      disabled={pending}
      className="text-slate-500 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:text-brand-400"
      title="Reprocess document"
      aria-label="Reprocess document"
    >
      <IconRefresh className="h-4 w-4" />
    </button>
  );
}
