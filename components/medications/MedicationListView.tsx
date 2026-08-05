import RxOtcBadge from "@/components/RxOtcBadge";
import {
  DEFAULT_FORMAT_PREFS,
  formatDateWithYear,
  formatTimestamp,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import type { MedicationListRow } from "@/lib/medication-list";

// The current-medication list, rendered identically for the printable page and the
// tokenized /share view (issue #852 item 4) — both format over the SAME buildMedicationList
// rows (one computation). A pure/server component (no "use client"), so it renders the
// same server-side and inside the share page. Print-legible from dark mode (#794 7c): the
// @media print block in globals.css forces black-on-white, and the layout uses plain
// bordered rows rather than frosted surfaces.
export default function MedicationListView({
  title,
  personName,
  generatedAt,
  rows,
  formatPrefs = DEFAULT_FORMAT_PREFS,
}: {
  title: string;
  personName: string;
  // ISO timestamp the list was generated — shown so a printed copy is dated.
  generatedAt: string;
  rows: MedicationListRow[];
  // Login-tier date/time shape (#964). The print page passes the viewer's prefs;
  // the tokenized /share view has no login in context and keeps the fixed default
  // (the documented login-less channel policy). Replaces the old implicit-locale
  // toLocaleString, which leaked the SERVER's locale/format (#1020).
  formatPrefs?: DisplayFormatPrefs;
}) {
  // One vocabulary for both dates on this card (issue #1448). It previously
  // hand-rolled the "Generated" stamp (short month + year + clock) while the
  // STARTED column called formatLongDate — so one printed card carried two shapes,
  // "Generated Jul 24, 2026, 22:14" beside "Friday, July 24", the latter undated
  // the moment the paper outlives the calendar year. Both now come from the
  // formatter's year-bearing entries, which is the rule for anything that leaves
  // the app on paper.
  const generatedLabel = Number.isNaN(new Date(generatedAt).getTime())
    ? null
    : formatTimestamp(generatedAt, formatPrefs);

  return (
    <div
      data-testid="medication-list-view"
      className="text-slate-800 dark:text-slate-100"
    >
      <header className="mb-4">
        <h1 className="text-xl font-semibold">{personName}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">{title}</p>
        {generatedLabel && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Generated {generatedLabel}
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <p
          data-testid="medication-list-empty"
          className="text-sm text-slate-500 dark:text-slate-400"
        >
          No current medications.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="section-label border-b border-black/15 text-left dark:border-white/15">
                <th className="th">Medication</th>
                <th className="th">Dose</th>
                <th className="th">Schedule</th>
                <th className="th">Prescriber</th>
                <th className="th">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  data-testid="medication-list-row"
                  className="border-b border-black/10 align-top dark:border-white/10"
                >
                  <td className="td">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium">{r.name}</span>
                      <RxOtcBadge rx={r.rx ? 1 : 0} />
                    </div>
                    {r.subtitle && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {r.subtitle}
                      </div>
                    )}
                  </td>
                  <td className="td">{r.dose ?? "—"}</td>
                  <td className="td">{r.schedule}</td>
                  <td className="td">{r.prescriber ?? "—"}</td>
                  <td className="td">
                    {r.startedOn
                      ? formatDateWithYear(r.startedOn, formatPrefs)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
