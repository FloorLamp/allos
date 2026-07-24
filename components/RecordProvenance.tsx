import Link from "next/link";
import { sourceLabel } from "@/lib/record-format";
import { importHref } from "@/lib/hrefs";

// The shared provenance label for a clinical/medical row's Source column:
// "Manual" for a hand-entered row, "Document" for one imported from a health
// record, or the raw source id (e.g. an integration) otherwise. Rendered as
// muted text so every clinical list treats provenance identically — callers
// supply only the row's `source` (and, when it exists, its `documentId`).
//
// When the row carries a `document_id` (#1353), the label becomes a deep-link to
// the source import detail (`/import/<id>`, the same target the encounter page
// uses) so provenance is traceable everywhere at once — every records table that
// renders this component inherits the link with no per-page work. A row with no
// document (manual, or an integration source) stays a plain muted label.
export default function RecordProvenance({
  source,
  documentId,
}: {
  source: string | null;
  documentId?: number | null;
}) {
  const label = sourceLabel(source);
  if (documentId != null) {
    return (
      <Link
        href={importHref(documentId)}
        className="text-brand-700 transition hover:underline dark:text-brand-300"
        data-testid="record-provenance-link"
      >
        {label}
      </Link>
    );
  }
  return <span className="text-slate-500 dark:text-slate-400">{label}</span>;
}
