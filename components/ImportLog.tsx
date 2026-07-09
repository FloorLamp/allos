import Link from "next/link";
import { IconAlertTriangle, IconLoader2 } from "@tabler/icons-react";
import { getImportLog } from "@/lib/queries";
import {
  documentLogStatus,
  jobLogStatus,
  statusBadge,
  documentFormatLabel,
  jobTitle,
  jobFormatLabel,
  isProvenanceMismatch,
  type BadgeTone,
  type ImportLogStatus,
} from "@/lib/import-log";
import RelativeTime from "@/components/RelativeTime";
import ScrollFade from "@/components/ScrollFade";
import ReprocessDocButton from "@/components/ReprocessDocButton";
import DeleteDocumentButton from "@/components/DeleteDocumentButton";
import ReprocessButton from "@/components/ReprocessButton";
import ImportLogFilters from "@/components/ImportLogFilters";
import { deleteMedicalDocument } from "@/app/(app)/medical/actions";

const TONE_CLASS: Record<BadgeTone, string> = {
  green:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
};

function StatusBadge({ status }: { status: ImportLogStatus }) {
  const b = statusBadge(status);
  return <span className={`badge ${TONE_CLASS[b.tone]}`}>{b.label}</span>;
}

// The unified import log: a profile's uploaded documents + paste/CSV jobs,
// interleaved newest-first, filterable by status and kind. Document rows link to
// the import-detail page (/import/[id]); paste-job rows point back at the importer
// above (where the existing review/commit/discard lives). Profile-scoped: rows
// come from getImportLog(profileId) and the profile's own names drive the
// provenance mismatch flag.
export default function ImportLog({
  profileId,
  knownNames,
  status,
  kind,
}: {
  profileId: number;
  knownNames: (string | null | undefined)[];
  status?: string;
  kind?: string;
}) {
  const rows = getImportLog(profileId);

  const filtered = rows.filter((r) => {
    const s =
      r.kind === "document"
        ? documentLogStatus(r.extraction_status)
        : jobLogStatus(r.status);
    if (status && s !== status) return false;
    if (kind && r.kind !== kind) return false;
    return true;
  });

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Import log
        </h2>
        <div className="flex flex-wrap items-center gap-4">
          <ImportLogFilters status={status} kind={kind} />
          <ReprocessButton />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          Nothing imported yet. Upload a document or paste a log above to get
          started.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No imports match these filters.
        </p>
      ) : (
        <ScrollFade>
          <table className="w-full">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/10">
                <th className="th">Source</th>
                <th className="th">Format</th>
                <th className="th">When</th>
                <th className="th">Status</th>
                <th className="th">Produced</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) =>
                r.kind === "document" ? (
                  <tr
                    key={`d${r.id}`}
                    className="border-b border-black/5 dark:border-white/10"
                  >
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/import/${r.id}`}
                          className="font-medium text-brand-700 hover:underline dark:text-brand-400"
                        >
                          {r.filename}
                        </Link>
                        {isProvenanceMismatch(r.patient_name, knownNames) && (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                            title={`Document names “${r.patient_name}”, which doesn’t match this profile.`}
                          >
                            <IconAlertTriangle className="h-4 w-4" />
                            {r.patient_name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="td capitalize text-slate-600 dark:text-slate-300">
                      {documentFormatLabel(r)}
                    </td>
                    <td className="td whitespace-nowrap text-slate-500 dark:text-slate-400">
                      <RelativeTime value={r.uploaded_at} />
                    </td>
                    <td className="td">
                      <StatusBadge
                        status={documentLogStatus(r.extraction_status)}
                      />
                    </td>
                    <td className="td text-slate-600 dark:text-slate-300">
                      {r.extraction_status === "processing"
                        ? "—"
                        : r.extracted_count > 0
                          ? r.extracted_count
                          : "—"}
                    </td>
                    <td className="td text-right">
                      <div className="flex items-center justify-end gap-3">
                        {r.extraction_status === "processing" ? (
                          <IconLoader2
                            className="h-4 w-4 animate-spin text-slate-400 dark:text-slate-500"
                            aria-label="Processing"
                          />
                        ) : (
                          <ReprocessDocButton id={r.id} filename={r.filename} />
                        )}
                        <DeleteDocumentButton
                          id={r.id}
                          filename={r.filename}
                          action={deleteMedicalDocument}
                        />
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={`j${r.id}`}
                    className="border-b border-black/5 dark:border-white/10"
                  >
                    <td className="td font-medium text-slate-800 dark:text-slate-100">
                      {jobTitle(r.type)}
                    </td>
                    <td className="td text-slate-600 dark:text-slate-300">
                      {jobFormatLabel(r.type)}
                    </td>
                    <td className="td whitespace-nowrap text-slate-500 dark:text-slate-400">
                      <RelativeTime value={r.created_at} />
                    </td>
                    <td className="td">
                      <StatusBadge status={jobLogStatus(r.status)} />
                    </td>
                    <td className="td text-slate-600 dark:text-slate-300">
                      {r.summary ?? "—"}
                    </td>
                    <td className="td text-right">
                      {r.status === "ready" ||
                      r.status === "failed" ||
                      r.status === "skipped" ? (
                        <Link
                          href="/import#paste-import"
                          className="text-sm text-brand-700 hover:underline dark:text-brand-400"
                        >
                          Review
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </ScrollFade>
      )}
      <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
        Deleting a document also removes the results it imported. Click a
        document to verify what it produced or view the raw extraction.
      </p>
    </div>
  );
}
