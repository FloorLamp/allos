"use client";

import type {
  DryRunReport,
  DryRunVerdict,
} from "@/lib/medical-pipeline/dry-run";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatDateWithYear } from "@/lib/format-date";

const VERDICT_LABEL: Record<DryRunVerdict, string> = {
  rejected: "Won’t upload",
  duplicate: "Already uploaded",
  covered: "Visits already here",
  "would-import": "Has new records",
  "would-extract": "Will be read by AI",
};

// The "Check first" answer in the upload form: per file, what an upload would do.
export default function UploadCheckReport({
  reports,
}: {
  reports: DryRunReport[];
}) {
  const prefs = useFormatPrefs();
  if (reports.length === 0) return null;
  const target = reports[0].profile;
  return (
    <div
      data-testid="medical-upload-check"
      className="space-y-3 rounded-xl border border-black/10 p-3 text-sm dark:border-white/10"
    >
      <p className="text-slate-500 dark:text-slate-400">
        Goes to {target.name} ({target.decidedBy}). Nothing was saved.
      </p>
      <ul className="space-y-3">
        {reports.map((r, i) => (
          <li key={`${r.name}-${i}`} className="space-y-1">
            <p className="flex justify-between gap-3">
              <span className="truncate">{r.name}</span>
              <span className="shrink-0 font-medium">
                {VERDICT_LABEL[r.verdict]}
              </span>
            </p>
            {r.note && (
              <p className="text-slate-500 dark:text-slate-400">{r.note}</p>
            )}
            {r.duplicates
              .filter((d) => d.profile.id !== target.id)
              .map((d) => (
                <p key={d.id} className="text-slate-500 dark:text-slate-400">
                  Uploaded for {d.profile.name} as “{d.filename}”.
                </p>
              ))}
            {r.records.map((rec, j) => (
              <div key={`${rec.member}-${j}`} className="pl-3">
                <p className="text-slate-600 dark:text-slate-300">
                  {rec.member}
                  {rec.patient ? ` · ${rec.patient}` : ""}
                </p>
                <ul className="text-slate-500 dark:text-slate-400">
                  {rec.visits.map((v, k) => (
                    <li key={k}>
                      {formatDateWithYear(v.date, prefs)}
                      {v.type ? ` ${v.type}` : ""} —{" "}
                      {v.status === "covered" ? "already here" : "new"}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
