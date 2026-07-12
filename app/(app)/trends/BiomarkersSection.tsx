import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getMedicalRecords, getRecentNarratives } from "@/lib/queries";
import {
  isBiomarkerStale,
  daysBetween,
  humanizeAge,
} from "@/lib/reference-range";
import { groupContiguous } from "@/lib/table-sort";
import { filterSeriesByRange } from "@/lib/trends";
import { formatLongDate } from "@/lib/format-date";
import type { DateRange } from "@/lib/timeline-format";
import { getUserSex, getUserAgeOn } from "@/lib/settings";
import { hasFitnessNorms } from "@/lib/fitness-norms";
import {
  fitnessContextFor,
  FitnessPercentileInline,
} from "@/components/FitnessPercentile";
import { EmptyState, MedicalValue } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import TrajectoryFindings from "./TrajectoryFindings";
import { generateLabTrend } from "./actions";

export type BiomarkerFlagFilter = "oor" | "nonoptimal";

// Cross-biomarker trends view for the Trends hub. Reuses getMedicalRecords (with
// its flag-range + panel filters and the reference/optimal machinery baked into
// MedicalValue) and windows the readings to the shared range. Each biomarker
// links into the SHARED per-biomarker detail page (/biomarkers/view) — that page
// is not split. Filter chips (flag + panel) round-trip through `hrefFor`, which
// the hub builds to preserve the active tab and window.
export default async function BiomarkersSection({
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
  const { profile } = await requireSession();
  const now = today(profile.id);
  // Sex for the age/sex fitness-percentile inline (#158); age is resolved per row
  // from the reading's date. Null sex hides every percentile (adult-context gate).
  const sex = getUserSex(profile.id);
  const records = filterSeriesByRange(
    getMedicalRecords(profile.id, { range: flag, panel, sort: "name" }),
    range
  );
  // The latest stored AI lab-trend interpretation (issue #20), if any. Not date-
  // windowed — it's a standing read of the analytes' full history.
  const labTrend = getRecentNarratives(profile.id, ["labs"], 1)[0];

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

      {/* AI lab-trend interpretation (issue #20): an optional AI read of the
          biomarker deltas in context — medication timeline + conditions —
          grounded in the same structured history the trajectory rules use.
          Degrades to a deterministic offline summary without an API key. */}
      <div
        data-testid="lab-trend-interpretation"
        className="card space-y-3 border-brand-100 dark:border-brand-950"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">
              ✦ Lab-trend interpretation
            </h3>
            <p className="max-w-lg text-xs text-slate-400 dark:text-slate-500">
              An AI read of your recent lab movements in the context of your
              medications and conditions. Observations, not diagnoses — raise
              anything concerning with a clinician.
            </p>
          </div>
          <form action={generateLabTrend}>
            <SubmitButton pendingLabel="Interpreting…">
              {labTrend ? "Refresh" : "Interpret trends"}
            </SubmitButton>
          </form>
        </div>
        {labTrend && (
          <div className="border-t border-black/5 pt-3 dark:border-white/10">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-400 dark:text-slate-500">
                As of {formatLongDate(labTrend.period_end)}
              </span>
              <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                {labTrend.model ?? "n/a"}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-200">
              {labTrend.summary}
            </p>
          </div>
        )}
      </div>

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
                    !!r.is_latest &&
                    isBiomarkerStale(r.date, r.category, now, undefined, {
                      name: r.canonical_name?.trim() || r.name,
                      flag: r.flag,
                      value: r.value,
                      notes: r.notes,
                      reference: r.reference_range,
                    });
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
                        {r.is_latest &&
                          r.canonical_name &&
                          hasFitnessNorms(r.canonical_name) && (
                            <FitnessPercentileInline
                              ctx={fitnessContextFor(
                                r.canonical_name,
                                r.value_num,
                                sex,
                                getUserAgeOn(profile.id, r.date)
                              )}
                            />
                          )}
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
