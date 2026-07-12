import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
  getProviderNames,
} from "@/lib/queries";
import ProviderDatalist from "@/components/ProviderDatalist";
import { getUserBirthdate, getUserSex, getStoredAge } from "@/lib/settings";
import { getRiskFactors } from "@/lib/queries/upcoming/risk";
import { immunizationPriorityFor } from "@/lib/risk-stratification";
import { ageMonthsFrom } from "@/lib/date";
import {
  assessSchedule,
  filterCategoryFor,
  type VaccineAssessment,
  type VaccineStatus,
  type ImmunizationFilter,
} from "@/lib/immunization-status";
import { PageHeader, EmptyState } from "@/components/ui";
import { parseSortColumn, parseSortDir, sortRows } from "@/lib/table-sort";
import SortableHeader from "@/components/SortableHeader";
import { STATUS_TEXT, statusBadge } from "./status-ui";
import ScheduleGrid from "./ScheduleGrid";
import ImmunizationForm from "./ImmunizationForm";
import ImmunizationHistory from "./ImmunizationHistory";
import ImmunizationStatusFilter from "./ImmunizationStatusFilter";
import MyChartImport from "./MyChartImport";
import { addImmunization } from "./actions";

export const dynamic = "force-dynamic";

const TITER_BADGE = {
  immune:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  non_immune: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  indeterminate:
    "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
} as const;
const TITER_TEXT = {
  immune: "Immune",
  non_immune: "Non-immune",
  indeterminate: "Indeterminate",
} as const;

// Severity order for the status sort — worst/most-actionable first, so the
// default (status, ascending) surfaces overdue/due at the top.
const STATUS_RANK: Record<VaccineStatus, number> = {
  overdue: 0,
  due: 1,
  unknown: 2,
  up_to_date: 3,
  complete: 4,
  declined: 5,
  not_recommended: 6,
};

type SortKey = "vaccine" | "status" | "last" | "doses" | "next";

// Within a status band, a risk-elevated (issue #553) vaccine leads. STATUS_RANK
// spans 0..6; multiplying by 10 leaves room to subtract the priority (max 2)
// WITHOUT crossing a band boundary — so a risk-elevated `due` vaccine sorts above
// a routine `due` one but never above an `overdue` one.
function sortValue(
  a: VaccineAssessment,
  key: SortKey,
  priority: number
): string | number {
  switch (key) {
    case "vaccine":
      return a.name.toLowerCase();
    case "status":
      return STATUS_RANK[a.status] * 10 - priority;
    case "last":
      // No dose → "" sorts to the top ascending; a real date otherwise. Desc
      // then puts the most recent dose first.
      return a.lastDate ?? "";
    case "doses":
      return a.dosesReceived;
    default:
      return a.nextLabel ? a.nextLabel.toLowerCase() : "";
  }
}

export default async function ImmunizationsPage(props: {
  searchParams: Promise<{ sort?: string; dir?: string; status?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const now = today(profile.id);
  const birthdate = getUserBirthdate(profile.id);
  const sex = getUserSex(profile.id);
  // Age drives the schedule: prefer the birthdate, but fall back to the stored
  // whole-year age (a profile can set an age without a DOB) so adult
  // recommendations still work — only per-band dose placement on the grid
  // genuinely needs a birthdate. Shares the canonical month-resolution policy
  // (issue #310) so every surface agrees which vaccines are due.
  const ageMonths = ageMonthsFrom(birthdate, getStoredAge(profile.id), now);
  const hasAge = ageMonths != null;

  const records = getImmunizations(profile.id);
  const providerNames = getProviderNames();
  const titers = getImmunityTiters(profile.id);
  const overrides = getImmunizationOverrides(profile.id);
  const summary = assessSchedule(
    records.map((r) => ({ vaccine: r.vaccine, date: r.date })),
    ageMonths,
    sex,
    now,
    titers.map((t) => ({ marker: t.marker, status: t.status })),
    overrides.map((o) => ({ vaccine: o.vaccine, kind: o.kind }))
  );

  // Risk-stratified priority (issue #553): the SAME risk-factor gather + pure
  // machinery the Upcoming immunization signal uses, so the page and the feed
  // never disagree on which vaccines a risk factor ranks up. A calm reason line
  // explains why; the status sort below leads a risk-elevated vaccine within its
  // band.
  const riskFactors = getRiskFactors(profile.id);
  const riskByCode = new Map(
    summary.assessments.map((a) => [
      a.code,
      immunizationPriorityFor(a.code, riskFactors),
    ])
  );

  // Master-table sort + filter, driven by query params (SortableHeader writes
  // sort/dir; ImmunizationStatusFilter writes status). Sort/dir parsing and the
  // comparator are the shared lib/table-sort helpers.
  const sortKey = parseSortColumn(
    searchParams.sort,
    ["vaccine", "status", "last", "doses", "next"] as const,
    "status"
  );
  const dir = parseSortDir(searchParams.dir);
  const statusFilter = searchParams.status as ImmunizationFilter | undefined;

  // Base rows: every tracked vaccine except the not-recommended ones (outside the
  // age/sex window, or a record-only travel vaccine with no dose) — matching the
  // old sectioned view, which never listed N/A rows.
  let rows = summary.assessments.filter((a) => a.status !== "not_recommended");
  if (statusFilter)
    rows = rows.filter((a) => filterCategoryFor(a) === statusFilter);
  // Tie-break on vaccine name (ascending) so equal keys keep a predictable order.
  rows = sortRows(
    rows,
    (a) => sortValue(a, sortKey, riskByCode.get(a.code)?.priority ?? 0),
    dir,
    (a) => a.name
  );

  const next = summary.nextRecommended;
  const subtitle = hasAge
    ? next
      ? `Next up: ${next.name} — ${STATUS_TEXT[next.status].toLowerCase()}`
      : "You're up to date on the tracked schedule."
    : "Add your date of birth in Settings to see age-based recommendations.";

  return (
    <div>
      {/* Shared provider picker options for the add + edit forms. */}
      <ProviderDatalist names={providerNames} />
      <PageHeader
        title="Immunizations"
        subtitle={subtitle}
        action={
          <div className="hidden gap-2 sm:flex">
            <Summary count={summary.overdueCount} label="Overdue" tone="rose" />
            <Summary count={summary.dueCount} label="Due" tone="amber" />
            <Summary
              count={summary.unknownCount}
              label="No record"
              tone="slate"
            />
          </div>
        }
      />

      {!hasAge && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          No date of birth or age is set for this profile, so age-based
          recommendations (due / overdue / next dose) cannot be computed. You
          can still record and review doses below.{" "}
          <Link href="/settings/profile" className="font-medium underline">
            Set date of birth
          </Link>
          .
        </div>
      )}
      {hasAge && !birthdate && (
        <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-ink-700 dark:bg-ink-850 dark:text-slate-300">
          Recommendations use the stored age for this profile. Add a date of
          birth to place recorded doses on the schedule grid by age-at-dose.{" "}
          <Link href="/settings/profile" className="font-medium underline">
            Set date of birth
          </Link>
          .
        </div>
      )}

      {/* Master table: one row per tracked vaccine, sortable + status-filterable,
      each row drilling into the per-vaccine detail view. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Vaccines
        </h2>
        <ImmunizationStatusFilter value={statusFilter} />
      </div>
      {rows.length === 0 ? (
        <EmptyState message="No vaccines match this filter." />
      ) : (
        <div className="card mb-6 overflow-hidden p-0">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <SortableHeader
                    column="vaccine"
                    label="Vaccine"
                    defaultSort="status"
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    defaultSort="status"
                  />
                  {/* Last dose / Doses / Next due hide below their breakpoints so
                  the table fits a phone; they stay on the detail view, and the
                  key facts fold under the name cell on small screens. */}
                  <SortableHeader
                    column="last"
                    label="Last dose"
                    defaultSort="status"
                    defaultDir="desc"
                    className="hidden sm:table-cell"
                  />
                  <SortableHeader
                    column="doses"
                    label="Doses"
                    defaultSort="status"
                    className="hidden md:table-cell"
                  />
                  <SortableHeader
                    column="next"
                    label="Next due"
                    defaultSort="status"
                    className="hidden md:table-cell"
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const badge = statusBadge(a);
                  const risk = riskByCode.get(a.code);
                  const prioritized = (risk?.priority ?? 0) > 0;
                  const riskReason = risk?.reasons.join(", ") ?? "";
                  return (
                    <tr
                      key={a.code}
                      className="border-b border-black/5 last:border-0 dark:border-white/10"
                    >
                      <td className="td">
                        <Link
                          href={`/immunizations/${a.code}`}
                          className="font-medium text-brand-700 hover:underline dark:text-brand-400"
                          title={`View ${a.name}`}
                        >
                          {a.name}
                        </Link>
                        {prioritized && (
                          <div
                            data-testid={`immunization-prioritized-${a.code}`}
                            className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                          >
                            Prioritized — {riskReason}
                          </div>
                        )}
                        <div className="text-xs text-slate-500 sm:hidden dark:text-slate-400">
                          {a.detail}
                          {a.nextLabel ? ` · ${a.nextLabel}` : ""}
                        </div>
                      </td>
                      <td className="td">
                        <span className={`badge ${badge.cls}`}>
                          {badge.text}
                        </span>
                      </td>
                      <td className="td hidden whitespace-nowrap text-slate-600 sm:table-cell dark:text-slate-300">
                        {a.lastDate ?? "—"}
                      </td>
                      <td className="td hidden text-slate-600 md:table-cell dark:text-slate-300">
                        {a.dosesReceived}
                        {a.dosesRequired != null ? ` / ${a.dosesRequired}` : ""}
                      </td>
                      <td className="td hidden text-slate-500 md:table-cell dark:text-slate-400">
                        {a.nextLabel ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mb-6">
        <h2 className="mb-2 font-semibold text-slate-800 dark:text-slate-100">
          CDC recommended schedule
        </h2>
        <ScheduleGrid
          records={records.map((r) => ({
            vaccine: r.vaccine,
            date: r.date,
            dose_label: r.dose_label,
            notes: r.notes,
            source: r.source,
          }))}
          birthdate={birthdate}
          ageMonths={ageMonths}
          assessments={summary.assessments}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <div className="card">
            <h3 className="mb-2 font-semibold text-slate-800 dark:text-slate-100">
              Immunity titers
            </h3>
            {titers.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No antibody/titer results yet. They appear here automatically
                when a lab report with immunity markers (e.g. Hepatitis B
                Surface Antibody, Measles IgG) is added under{" "}
                <Link href="/biomarkers" className="underline">
                  Biomarkers
                </Link>
                .
              </p>
            ) : (
              <div className="divide-y divide-black/5 dark:divide-white/5">
                {titers.map((t) => (
                  <div
                    key={t.marker}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/biomarkers/view?name=${encodeURIComponent(t.marker)}`}
                        className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
                      >
                        {t.marker}
                      </Link>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {t.value ?? "—"} {t.unit ?? ""}
                        {t.date ? ` · ${t.date}` : ""}
                      </div>
                    </div>
                    <span className={`badge shrink-0 ${TITER_BADGE[t.status]}`}>
                      {TITER_TEXT[t.status]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <details className="card">
            <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">
              All recorded doses{" "}
              <span className="text-sm font-normal text-slate-400">
                ({records.length})
              </span>
            </summary>
            <div className="mt-3">
              {records.length === 0 ? (
                <EmptyState message="No immunizations recorded yet. Add one, or import a MyChart export." />
              ) : (
                <ImmunizationHistory items={records} defaultDate={now} />
              )}
            </div>
          </details>
        </div>

        <div className="min-w-0 space-y-4">
          <ImmunizationForm action={addImmunization} defaultDate={now} />
          <MyChartImport />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Simplified schedule — informational only, not medical advice. The
            tracked schedule is a practical subset of the CDC/ACIP
            recommendations and does not model risk conditions, pregnancy, or
            shared-decision cases.
          </p>
        </div>
      </div>
    </div>
  );
}

function Summary({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "rose" | "amber" | "slate";
}) {
  const tones = {
    rose: "text-rose-600 dark:text-rose-400",
    amber: "text-amber-600 dark:text-amber-400",
    slate: "text-slate-500 dark:text-slate-400",
  };
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${tones[tone]}`}>{count}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  );
}
