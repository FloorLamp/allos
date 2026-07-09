"use client";

import { reprocessDocument } from "@/app/(app)/medical/actions";
import { useConfirmedAction } from "@/components/useConfirmedAction";

// Shared behavior for the two "reprocess this document" triggers — the row
// button in the documents list (ReprocessDocButton) and the button on the
// document subpage (ExtractedRecords). Confirms first (reprocessing discards
// manual edits to the document's records), then kicks off background
// re-extraction via the reprocessDocument action. Returns `pending` so callers
// can disable their trigger and/or show a loading state while it's in flight.
export function useReprocessDocument(id: number, filename: string) {
  const { pending, run } = useConfirmedAction(
    {
      title: "Reprocess document",
      message: `Re-run extraction on “${filename}”? This replaces its records and discards any manual edits to them.`,
      confirmLabel: "Reprocess",
    },
    () => {
      const fd = new FormData();
      fd.set("id", String(id));
      return reprocessDocument(fd);
    }
  );

  return { pending, reprocess: run };
}
