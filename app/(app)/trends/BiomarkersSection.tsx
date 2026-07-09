import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getMedicalRecords } from "@/lib/queries";
import {
  isBiomarkerStale,
  daysBetween,
  humanizeAge,
} from "@/lib/reference-range";
import { groupContiguous } from "@/lib/table-sort";
import { filterSeriesByRange } from "@/lib/trends";
import type { DateRange } from "@/lib/timeline-format";
import { EmptyState, MedicalValue } from "@/components/ui";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import TrajectoryFindings from "./TrajectoryFindings";

export type BiomarkerFlagFilter = "oor" | "nonoptimal";

// Cross-biomarker trends view for the Trends hub. Reuses getMedicalRecords (with
// its flag-range + panel filters and the reference/optimal machinery baked into
// MedicalValue) and windows the readings to the shared range. Each biomarker
// links into the SHARED per-biomarker detail page (/biomarkers/view) — that page
// is not split. Filter chips (flag + panel) round-trip through `hrefFor`, which
// the hub builds to preserve the active tab and window.
export default function BiomarkersSection({
  range,
  flag,
  panel,
  hrefFor,
}: {
  range: DateRange;
  flag?: BiomarkerFlagFilter;
  panel?: string;
  hrefFor: (opts: { flag?: BiomarkerFlagFilter; panel?: string }) => string;
}) {
  const { profile } = requireSession();
  const now = today(profile.id);
  const records = filterSeriesByRange(
    getMedicalRecords(profile.id, { range: flag, panel, sort: "name" }),
    range
  );

  const flagChips: { label: string; value?: BiomarkerFlagFilter }[] = [
    { label: "All" },
    { label: "Out of range", value: "oor" },
    { label: "Non-optimal", value: "nonoptimal" },
  ];

  const chipClass = (active: boolean) =>
    `shrink-0 rounded-full px-3 py-1 text-sm font-medium transition ${
      active
        ? "bg-brand-500 text-white"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
    }`;

  return (
    <div className="space-y-6">
      {/* Forward-looking trajectory rules (#41): warn BEFORE a range crossing.
          Independent of the flag/panel filters and the date window — a trajectory
          is a property of the analyte's full history. */}
      <TrajectoryFindings />

      <StarredBiomarkers />

      <div className="flex flex-wrap items-center gap-2">
        {flagChips.map((c) => (
          <Link
            key={c.label}
            href={hrefFor({ flag: c.value, panel })}
            className={chipClass(flag === c.value)}
          >
            {c.label}
          </Link>
        ))}
        {panel && (
          <Link
            href={hrefFor({ flag })}
            className="shrink-0 rounded-full bg-brand-100 px-3 py-1 text-sm font-medium text-brand-700 transition hover:bg-brand-200 dark:bg-brand-950 dark:text-brand-300"
          >
            Panel: {panel} ✕
          </Link>
        )}
      </div>

      {records.length === 0 ? (
        <EmptyState
          message={
            flag || panel
              ? "No biomarkers match these filters in this range."
              : "No biomarker readings in this range. Widen the date range or import labs."
          }
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Name
                  </th>
                  <th className="th sticky top-0 z-10 hidden bg-white sm:table-cell dark:bg-ink-900">
                    Panel
                  </th>
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Value
                  </th>
                  <th className="th sticky top-0 z-10 hidden bg-white sm:table-cell dark:bg-ink-900">
                    Reference
                  </th>
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {groupContiguous(records, (r) =>
                  r.canonical_name?.trim() ? r.canonical_name : r.name
                ).map(({ row: r, isGroupStart, isGroupEnd }) => {
                  const stale =
                    !!r.is_latest && isBiomarkerStale(r.date, r.category, now);
                  const ageDays = daysBetween(r.date, now);
                  const relative =
                    ageDays <= 0 ? "today" : `${humanizeAge(ageDays)} ago`;
                  return (
                    <tr
                      key={r.id}
                      className={
                        isGroupEnd
                          ? "border-b border-black/5 dark:border-white/10"
                          : ""
                      }
                    >
                      <td className="td">
                        {isGroupStart ? (
                          r.canonical_name ? (
                            <Link
                              href={`/biomarkers/view?name=${encodeURIComponent(
                                r.canonical_name
                              )}`}
                              className="font-medium text-brand-700 hover:underline dark:text-brand-400"
                            >
                              {r.canonical_name}
                            </Link>
                          ) : (
                            <span className="font-medium">{r.name}</span>
                          )
                        ) : null}
                        {isGroupStart && stale && (
                          <span
                            className="ml-1.5 text-xs text-amber-600 dark:text-amber-400"
                            title="Latest reading over a year old — consider retesting"
                          >
                            ⏳
                          </span>
                        )}
                      </td>
                      <td className="td hidden sm:table-cell">
                        {r.panel ? (
                          <Link
                            href={hrefFor({ flag, panel: r.panel })}
                            className="text-xs text-slate-500 hover:text-brand-700 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                          >
                            {r.panel}
                          </Link>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">
                            —
                          </span>
                        )}
                      </td>
                      <td className="td">
                        <MedicalValue
                          value={r.value}
                          unit={r.unit}
                          flag={r.flag}
                        />
                      </td>
                      <td className="td hidden text-slate-500 sm:table-cell dark:text-slate-400">
                        {r.reference_range ?? "—"}
                      </td>
                      <td className="td whitespace-nowrap">
                        {r.date}
                        {r.is_latest ? (
                          <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
                            · {relative}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
