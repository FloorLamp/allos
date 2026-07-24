import { getReportRecords } from "@/lib/queries";
import { EmptyState } from "@/components/ui";
import NotesText from "@/components/NotesText";
import { formatLongDate, type DisplayFormatPrefs } from "@/lib/format-date";
import { importHref } from "@/lib/hrefs";
import Link from "next/link";

// Results › Reports (#708): the narrative diagnostic reports — the free-text body of a
// microbiology culture, gram stain, or cytopathology report, recovered from an imported
// CCD/XDM Results-section ED-valued observation. These are documents, not analytes:
// they carry no value and never trend or flag, so they live here rather than in the
// Biomarkers catalog. The structured organism datum (e.g. "Culture Organism" = MSSA)
// still imports as its own reading; this is its narrative companion. Reports are
// import-only — there is no manual add form (the AI-extract path handles uploaded PDFs).
export default function ReportsSection({
  profileId,
  fmt,
}: {
  profileId: number;
  fmt: DisplayFormatPrefs;
}) {
  const reports = getReportRecords(profileId);

  if (reports.length === 0) {
    return (
      <EmptyState message="No narrative reports yet. Microbiology, pathology, and cytology report text is captured when you import a CCD/XDM health record." />
    );
  }

  return (
    <div className="space-y-4" data-testid="reports-list">
      {reports.map((r) => (
        <article
          key={r.id}
          className="card space-y-2"
          data-testid="report-card"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="min-w-0 font-medium text-slate-900 dark:text-slate-100">
              {r.name}
            </h3>
            <span className="shrink-0 text-sm text-slate-500 dark:text-slate-400">
              {formatLongDate(r.date, fmt)}
            </span>
          </header>
          {r.provider_name && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {r.provider_name}
            </p>
          )}
          <NotesText
            notes={r.notes}
            as="div"
            className="text-sm text-slate-700 dark:text-slate-300"
            data-testid="report-body"
          />
          {r.document_id != null && (
            <p className="text-xs">
              <Link
                href={importHref(r.document_id)}
                className="text-brand-600 hover:underline dark:text-brand-400"
              >
                View source document →
              </Link>
            </p>
          )}
        </article>
      ))}
    </div>
  );
}
