import Link from "next/link";
import { today } from "@/lib/db";
import {
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
  getPickerProviders,
} from "@/lib/queries";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
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
import { EmptyState } from "@/components/ui";
import { dataSectionHref } from "@/lib/hrefs";
import { Notice } from "@/components/Notice";
import { parseSortColumn, parseSortDir, sortRows } from "@/lib/table-sort";
import SortableHeader from "@/components/SortableHeader";
import { STATUS_TEXT, statusBadge } from "@/app/(app)/immunizations/status-ui";
import ScheduleGrid from "@/app/(app)/immunizations/ScheduleGrid";
import ImmunizationForm from "@/app/(app)/immunizations/ImmunizationForm";
import ImmunizationHistory from "@/app/(app)/immunizations/ImmunizationHistory";
import ImmunizationStatusFilter from "@/app/(app)/immunizations/ImmunizationStatusFilter";
import MyChartImport from "@/app/(app)/immunizations/MyChartImport";
import { addImmunization } from "@/app/(app)/immunizations/actions";

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

// The former /immunizations index body (#1042 phase 6), now the #immunizations
// section of /records. The master table's sort/filter ride the ?sort/?dir/?status
// query params on the ONE /records URL; the per-vaccine detail page
// (/immunizations/[vaccine]) survives at its own route.
export default function ImmunizationsSection({
  scope,
  searchParams,
}: {
  scope: ProfileScope;
  searchParams: { sort?: string; dir?: string; status?: string };
}) {
  // Multi-view (#1359): the SCHEDULE assessment (master vaccine table, grid, status
  // counts, titers, next-up subtitle) is AGE-DERIVED and stays ACTING-ONLY — the
  // #1096 per-profile-context trap restated for immunizations: another member's
  // schedule position must be computed in THEIR age context, never the acting
  // member's, so it is never cross-composed here. Only the flat "All recorded doses"
  // list below reads the whole view-set (each member's doses numbered in their OWN
  // sequence — see ImmunizationHistory). Single view is byte-identical.
  const profileId = scope.actingProfileId;
  const multi = scope.viewIds.length > 1;
  const now = today(profileId);
  const birthdate = getUserBirthdate(profileId);
  const sex = getUserSex(profileId);
  // Age drives the schedule: prefer the birthdate, but fall back to the stored
  // whole-year age (a profile can set an age without a DOB) so adult
  // recommendations still work — only per-band dose placement on the grid
  // genuinely needs a birthdate. Shares the canonical month-resolution policy
  // (issue #310) so every surface agrees which vaccines are due.
  const ageMonths = ageMonthsFrom(birthdate, getStoredAge(profileId), now);
  const hasAge = ageMonths != null;

  const records = getImmunizations(profileId);
  // The flat "All recorded doses" list reads the whole view-set (loop-composed — the
  // per-profile dedup CTE must stay scoped) + stamped subject identity, so non-acting
  // rows carry a chip and per-item write gate. In single view this is exactly
  // `records` (stamped), so the list renders byte-identical.
  const recordedDoses = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) => getImmunizations(pid))
  );
  const titers = getImmunityTiters(profileId);
  const overrides = getImmunizationOverrides(profileId);
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
  const riskFactors = getRiskFactors(profileId);
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
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <div>
        {/* Section status line + at-a-glance counts (the old PageHeader subtitle +
          action, inlined so the merged /records SectionHeader stays generic). */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
          <div className="hidden gap-2 sm:flex">
            <Summary count={summary.overdueCount} label="Overdue" tone="rose" />
            <Summary count={summary.dueCount} label="Due" tone="amber" />
            <Summary
              count={summary.unknownCount}
              label="No record"
              tone="slate"
            />
          </div>
        </div>

        {!hasAge && (
          <Notice tone="amber" className="mb-5">
            No date of birth or age is set for this profile, so age-based
            recommendations (due / overdue / next dose) cannot be computed. You
            can still record and review doses below.{" "}
            <Link href="/settings/profile" className="font-medium underline">
              Set date of birth
            </Link>
            .
          </Notice>
        )}
        {hasAge && !birthdate && (
          <Notice tone="slate" className="mb-5">
            Recommendations use the stored age for this profile. Add a date of
            birth to place recorded doses on the schedule grid by age-at-dose.{" "}
            <Link href="/settings/profile" className="font-medium underline">
              Set date of birth
            </Link>
            .
          </Notice>
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
                          {a.dosesRequired != null
                            ? ` / ${a.dosesRequired}`
                            : ""}
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
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
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
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Immunity titers
              </h3>
              {titers.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  No antibody/titer results yet. They appear here automatically
                  when a lab report with immunity markers (e.g. Hepatitis B
                  Surface Antibody, Measles IgG) is added under{" "}
                  <Link href="/results/biomarkers" className="underline">
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
                      <span
                        className={`badge shrink-0 ${TITER_BADGE[t.status]}`}
                      >
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
                  ({recordedDoses.length})
                </span>
              </summary>
              <div className="mt-3">
                {recordedDoses.length === 0 ? (
                  <EmptyState
                    message="No immunizations recorded yet. Add one with the form, or import a MyChart export."
                    action={{
                      href: dataSectionHref("import"),
                      label: "Go to Import",
                    }}
                  />
                ) : (
                  <ImmunizationHistory
                    items={recordedDoses}
                    defaultDate={now}
                    multiView={
                      multi
                        ? { actingProfileId: scope.actingProfileId }
                        : undefined
                    }
                  />
                )}
              </div>
            </details>
          </div>

          <div className="min-w-0 space-y-4">
            <ImmunizationForm action={addImmunization} defaultDate={now} />
            <MyChartImport />
            <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
              Simplified schedule. The tracked schedule is a practical subset of
              the CDC/ACIP recommendations and does not model risk conditions,
              pregnancy, or shared-decision cases.
            </p>
          </div>
        </div>
      </div>
    </ProviderOptionsProvider>
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
