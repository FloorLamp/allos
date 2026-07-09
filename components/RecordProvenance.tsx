import { sourceLabel } from "@/lib/record-format";

// The shared provenance label for a clinical/medical row's Source column:
// "Manual" for a hand-entered row, "Document" for one imported from a health
// record, or the raw source id (e.g. an integration) otherwise. Rendered as
// muted text so every clinical list treats provenance identically — callers
// supply only the row's `source`.
export default function RecordProvenance({
  source,
}: {
  source: string | null;
}) {
  return (
    <span className="text-slate-500 dark:text-slate-400">
      {sourceLabel(source)}
    </span>
  );
}
