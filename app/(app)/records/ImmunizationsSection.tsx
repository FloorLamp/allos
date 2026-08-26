import Link from "next/link";
import { today } from "@/lib/db";
import {
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
  getPickerProviders,
} from "@/lib/queries";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import AddEntryPanel from "@/components/AddEntryPanel";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import {
  getProfileBirthdate,
  getProfileSex,
  getStoredAge,
} from "@/lib/settings";
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
import { dataSectionHref, clinicalResultDetailHref } from "@/lib/hrefs";
import { Notice } from "@/components/Notice";
import {
  parseSortColumn,
  parseSortDir,
  sortRows,
  type SortChoice,
} from "@/lib/table-sort";
import SortableHeader from "@/components/SortableHeader";
import TableSortSelect from "@/components/TableSortSelect";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import ScrollFade from "@/components/ScrollFade";
import { STATUS_TEXT, statusBadge } from "@/app/(app)/immunizations/status-ui";
import ScheduleGrid from "@/app/(app)/immunizations/ScheduleGrid";
import ImmunizationForm from "@/app/(app)/immunizations/ImmunizationForm";
import ImmunizationHistory from "@/app/(app)/immunizations/ImmunizationHistory";
import ImmunizationStatusFilter from "@/app/(app)/immunizations/ImmunizationStatusFilter";
import ImmunizationRecordActions from "@/app/(app)/immunizations/ImmunizationRecordActions";
import { addImmunization } from "@/app/(app)/immunizations/actions";
import SourceDocumentLink from "@/components/SourceDocumentLink";
import { displayUnit } from "@/lib/display-unit";

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

// The same five columns the SortableHeaders carry, for the card-mode control.
// Below `sm` the header row is hidden (the row is a card there), so this is the
// ONLY way to re-sort on a phone — and it writes the identical `?sort=`/`?dir=`
// params, so the server-side ordering above is untouched.
const VACCINE_SORT_CHOICES: readonly SortChoice[] = [
  { column: "status", label: "Status" },
  { column: "vaccine", label: "Vaccine" },
  { column: "last", label: "Last dose", defaultDir: "desc" },
  { column: "doses", label: "Doses" },
  { column: "next", label: "Next due" },
];

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
  const birthdate = getProfileBirthdate(profileId);
  const sex = getProfileSex(profileId);
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
        {/* ONE PRIMARY, ONE ⋯ (#3408, item C / item G). Four button species used
            to stand here on every visit — a full `btn` primary, a bordered
            secondary, and two icon-only squares — above a list whose records are
            rare-cadence by definition (#1497). The add stays the pane's single
            primary; import, print and share fold into the ⋯ that
            ImmunizationRecordActions now hosts (it owns the share modal, so the
            fold belongs with it), and below `md` that ⋯ is an action sheet.
            Print and share keep their #1849 acting-profile scoping untouched. */}
        <div className="section-seam mb-6 flex flex-wrap items-center gap-2">
          <AddEntryPanel
            testId="add-immunization-panel"
            panelId="add-immunization-panel-body"
            label="Add immunization"
            presentation="modal"
            dense
          >
            <ImmunizationForm action={addImmunization} defaultDate={now} />
          </AddEntryPanel>
          <ImmunizationRecordActions includeImport />
        </div>

        {/* Section status line + at-a-glance counts (the old PageHeader subtitle +
          action, inlined so the merged /records SectionHeader stays generic). */}
        {/* THE COUNTS STOP FLOATING AGAINST THE SENTENCE (#3408, item 6). At
            430px `justify-between` on a wrapping row put three `text-2xl` numerals
            hard against the right edge with the status sentence orphaned above
            them, reading as two unrelated things. Below `md` the counts are a row
            of their OWN under the sentence and shrink to a running-text scale;
            from `md` up, where there is room for both on one line, nothing
            changes. */}
        <div className="mb-4 flex flex-col gap-1 md:mb-6 md:flex-row md:flex-wrap md:items-start md:justify-between md:gap-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
          <div
            className="flex gap-3 md:gap-2"
            data-testid="immunization-summary-counts"
          >
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
            recommendations (due / overdue / next dose) cannot be computed.
            Doses can still be recorded and reviewed below.{" "}
            <Link href="/settings/health" className="font-medium underline">
              Set date of birth
            </Link>
            .
          </Notice>
        )}
        {hasAge && !birthdate && (
          <Notice tone="slate" className="mb-5">
            Recommendations use the stored age for this profile. Add a date of
            birth to place recorded doses on the schedule grid by age-at-dose.{" "}
            <Link href="/settings/health" className="font-medium underline">
              Set date of birth
            </Link>
            .
          </Notice>
        )}

        {/* ── THE VACCINE LIST ─────────────────────────────────────────────────
            THE FILTER SITS ON THE LIST IT FILTERS (#3408, item E). "Vaccines" was
            a heading line of its own with the status strip under it and the list
            under that — three stacked rows before the first record. The label is
            now IN the filter row, which is what makes the strip read as this
            list's control rather than as a third navigation layer. #1449's point
            still holds and is why the strip gets the full width below `sm`: seven
            pills cannot scroll in one line beside a heading on a phone, so the
            label and the strip share a row only from `sm` up.

            A SORT CONTROL, BECAUSE THE HEADERS ARE GONE (#3408, item D). Card mode
            hides `thead`, so the SortableHeader links that carry sorting become
            unreachable — `TableSortSelect` is the house answer, one control
            encoding both axes over the SAME `?sort=`/`?dir=` params. One sort
            model, two affordances; not a second implementation. */}
        <div className="mb-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="shrink-0 font-semibold text-slate-800 dark:text-slate-100">
              Vaccines
            </h2>
            <TableSortSelect
              choices={VACCINE_SORT_CHOICES}
              defaultSort="status"
              label="Sort vaccines"
            />
          </div>
          {/* THE LABEL AND THE FILTER ARE ONE BLOCK, NOT ONE ROW. #1449 already
              ruled that seven status pills need the full width to scroll in one
              line on a phone, and putting "Vaccines" beside them takes ~90px of
              the 430 they have — that ruling is not silently reversed here. What
              the issue is actually asking for is that the strip stop reading as a
              third NAVIGATION layer, and what did that was the standalone heading
              line between them: `space-y-2` inside one wrapper directly above the
              list makes the label and the strip read as this list's own header,
              which is the same thing at a tenth of the cost. */}
          <ImmunizationStatusFilter value={statusFilter} />
        </div>
        {rows.length === 0 ? (
          <EmptyState compact message="No vaccines match this filter." />
        ) : (
          // THE CARD CHROME AND THE 70vh SCROLLER ARE DESKTOP FURNITURE. Below
          // `sm` the rows ARE cards — a bordered box around them is a second
          // border, and a 70vh inner scroller on a phone is a nested scroll
          // region inside the page's own, which is the shape #3360 spent a whole
          // issue undoing one layer up. Both start at `sm`, where the table is a
          // table again.
          <div className="section-seam mb-6 sm:card sm:overflow-hidden sm:p-0">
            <ScrollFade className="sm:max-h-[70vh] sm:overflow-y-auto">
              <ResponsiveTable
                className="w-full"
                data-testid="immunization-vaccines-table"
              >
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
                    {/* Last dose / Doses / Next due still hide below their
                  breakpoints in the TABLE — three more columns is what makes a
                  table need a sideways swipe. On a CARD they come back as meta
                  lines, which is the whole point of the responsive-table
                  machinery: a responsively-hidden column is not lost on a phone,
                  it is re-placed. That is what retires the hand-rolled
                  `sm:hidden` detail line this cell used to carry beside them. */}
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
                        <Td slot="title">
                          <Link
                            href={`/immunizations/${a.code}`}
                            className="font-medium text-brand-700 hover:underline dark:text-brand-400"
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
                        </Td>
                        {/* The status pill is the row's HEADLINE — what you came
                            to the list to read — so it is the card's `value`, not
                            one meta line among four. */}
                        <Td slot="value">
                          <span className={`badge ${badge.cls}`}>
                            {badge.text}
                          </span>
                        </Td>
                        <Td
                          slot="meta"
                          label="Last dose"
                          empty={a.lastDate == null}
                          className="hidden whitespace-nowrap text-slate-600 sm:table-cell dark:text-slate-300"
                        >
                          {a.lastDate ?? "—"}
                        </Td>
                        {/* "Doses 0" is not a fact about this vaccine, it is the
                            absence of one — and on the phone card it is a whole
                            line saying nothing, on the rows (unknown / due) that
                            dominate the list. It keeps its CELL so the desktop
                            grid stays aligned; it just claims no card slot
                            (#531–#534, "label by what DIFFERS"). A required-dose
                            count is real information even at zero, so a vaccine
                            with a known series still shows "0 / 2". */}
                        <Td
                          slot="meta"
                          label="Doses"
                          empty={
                            a.dosesReceived === 0 && a.dosesRequired == null
                          }
                          className="hidden text-slate-600 md:table-cell dark:text-slate-300"
                        >
                          {a.dosesReceived}
                          {a.dosesRequired != null
                            ? ` / ${a.dosesRequired}`
                            : ""}
                        </Td>
                        <Td
                          slot="meta"
                          label="Next due"
                          empty={a.nextLabel == null}
                          className="hidden text-slate-500 md:table-cell dark:text-slate-400"
                        >
                          {a.nextLabel ?? "—"}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </ResponsiveTable>
            </ScrollFade>
          </div>
        )}

        <div className="space-y-6">
          <div className="space-y-6">
            <div className="card">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Immunity titers
              </h3>
              {titers.length === 0 ? (
                // AN ABSENCE PAYS A LINE, NOT A PARAGRAPH (#3408, item B). Four
                // lines of prose explaining a feature that has produced nothing
                // yet, above the fold, every visit. The compact empty state says
                // the same thing in the house shape and keeps the one link that
                // is actually actionable.
                <EmptyState
                  compact
                  message={
                    <>
                      No antibody/titer results yet — they appear here when a
                      lab report with immunity markers is added under{" "}
                      <Link
                        href="/results/clinical-results"
                        className="underline"
                      >
                        Clinical results
                      </Link>
                      .
                    </>
                  }
                />
              ) : (
                <div className="divide-y divide-black/5 dark:divide-white/5">
                  {titers.map((t) => (
                    <div
                      key={t.marker}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <Link
                          href={clinicalResultDetailHref(t.marker)}
                          className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
                        >
                          {t.marker}
                        </Link>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {t.value ?? "—"} {displayUnit(t.unit) ?? ""}
                          {t.date ? ` · ${t.date}` : ""}
                          {t.document_id != null ? (
                            <>
                              {" · "}
                              <SourceDocumentLink
                                documentId={t.document_id}
                                className="text-brand-700 hover:underline dark:text-brand-300"
                              >
                                Source document
                              </SourceDocumentLink>
                            </>
                          ) : null}
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

            <details className="border-t border-black/5 pt-4 dark:border-white/5">
              <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">
                All recorded doses{" "}
                <span className="text-sm font-normal text-slate-400">
                  ({recordedDoses.length})
                </span>
              </summary>
              <div className="mt-3">
                {recordedDoses.length === 0 ? (
                  <EmptyState
                    compact
                    message="No immunizations recorded yet. Use Add immunization, or import a MyChart export."
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

            <details className="border-t border-black/5 pt-4 dark:border-white/5">
              <summary
                data-testid="immunization-schedule-disclosure"
                className="cursor-pointer text-slate-800 dark:text-slate-100"
              >
                <h3 className="inline font-semibold">
                  CDC recommended schedule
                </h3>
              </summary>
              <div className="mt-3">
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
            </details>
          </div>

          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Simplified schedule. The tracked schedule is a practical subset of
            the CDC/ACIP recommendations and does not model risk conditions,
            pregnancy, or shared-decision cases.
          </p>
        </div>
      </div>
    </ProviderOptionsProvider>
  );
}

// THE COUNTS ARE A LINE ON A PHONE AND A TILE ROW ON A DESKTOP (#3408, item 6).
//
// Three stacked `text-2xl` numerals with a caption under each is ~100px of
// vertical space to say "1 overdue, 0 due, 3 no record" — on the one viewport
// where vertical space is the scarce resource, directly above the list those
// three numbers are ABOUT. Below `md` the same three facts read as one running
// line at `text-sm`, which is ~20px; from `md` up, where the row sits beside the
// status sentence with room to spare, the tiles are unchanged.
//
// ONE AUTHORED NODE, NOT TWO (#2305). The number and its label are the same two
// elements at both widths — `inline`/`md:block` and a scale swap — so there is no
// hidden twin holding a stale count.
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
    <div className="flex items-baseline gap-1 md:block md:text-center">
      <span
        className={`text-sm font-semibold md:block md:text-2xl md:font-bold ${tones[tone]}`}
      >
        {count}
      </span>
      <span className="text-xs text-slate-500 md:block md:text-slate-400 dark:text-slate-400">
        {label}
      </span>
    </div>
  );
}
