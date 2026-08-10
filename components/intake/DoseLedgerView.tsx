import Link from "next/link";
import { PageHeader } from "@/components/ui";
import DateRangeControl from "@/components/DateRangeControl";
import FilterPills, { type FilterPillOption } from "@/components/FilterPills";
import DoseLedgerItemFilter from "@/components/intake/DoseLedgerItemFilter";
import DoseLedgerTable, {
  type DoseLedgerEntry,
  type DoseLedgerItem,
} from "@/components/intake/DoseLedgerTable";
import { today } from "@/lib/db";
import {
  getIntakeDoseHistoryAll,
  getSupplements,
  getSupplementDoses,
} from "@/lib/queries";
import { getDisplayFormatPrefs, getTimezone } from "@/lib/settings";
import { zonedDateParts } from "@/lib/date";
import { bestKnownInstant } from "@/lib/row-instants";
import { formatGivenAtClock } from "@/lib/administration-format";
import { isPrn } from "@/lib/supplement-schedule";
import {
  DOSE_LEDGER_KIND_FILTERS,
  DOSE_LEDGER_KIND_LABELS,
  doseLedgerQueryKind,
  doseLedgerWindowNote,
  resolveDoseLedgerKind,
  resolveDoseLedgerRange,
  type DoseLedgerKindFilter,
} from "@/lib/dose-ledger";
import {
  ALL_TIME_RANGE_PARAM,
  ALL_TIME_RANGE_VALUE,
  isAllTimeRange,
  normalizeTimelineRange,
  timelineDateFromParam,
  type DateRange,
} from "@/lib/timeline-format";
import { doseLedgerHref, intakeHref } from "@/lib/hrefs";
import type { SupplementKind } from "@/lib/types";

// The ISO floor an all-time window reads from — the ledger's reader takes a `since`
// day, and "all time" is a window with no lower bound rather than a second query.
const ISO_FLOOR = "0001-01-01";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The cross-item dose ledger (#2417), rendered by BOTH intake surfaces
// (/nutrition/dose-history and /medications/dose-history) over one component.
//
// The rest of intake_items already refuses to split its machinery by kind — dose,
// adherence, refill, interaction and warning behavior are shared, and historical dose
// correction is adherence machinery — so a supplements-only ledger and a
// medications-only ledger would be that split all over again. What differs between the
// two routes is exactly one thing: which kind the page opens PRE-FILTERED to, which is
// the same kind→surface seam `intakeHref` encodes one level up.
//
// Auth is the PAGE's: each route resolves its own scope and hands this component an
// already-authorized profileId, the login whose display preferences format the clocks,
// and whether that caller may write. This component reads and renders; it imports no
// auth module.
export default function DoseLedgerView({
  profileId,
  loginId,
  canWrite,
  surface,
  params,
}: {
  profileId: number;
  loginId: number;
  canWrite: boolean;
  // Which surface is rendering — the kind this ledger opens pre-filtered to.
  surface: SupplementKind;
  params: {
    from?: string | string[];
    to?: string | string[];
    range?: string | string[];
    kind?: string | string[];
    item?: string | string[];
  };
}) {
  const todayStr = today(profileId);
  const tz = getTimezone(profileId);
  const { timeFormat } = getDisplayFormatPrefs(loginId);

  const range: DateRange = resolveDoseLedgerRange(
    normalizeTimelineRange(
      timelineDateFromParam(params.from),
      timelineDateFromParam(params.to)
    ),
    todayStr,
    firstParam(params.range)
  );
  const kindFilter: DoseLedgerKindFilter = resolveDoseLedgerKind(
    firstParam(params.kind),
    surface
  );
  const queryKind = doseLedgerQueryKind(kindFilter);

  // Every item this profile owns, active or not: an item paused or retired since the
  // dose was taken still took that dose, and both the filter's options and the row's
  // item name have to keep saying so.
  const allItems = getSupplements(profileId);
  const filterItems = allItems.filter(
    (item) => !queryKind || item.kind === queryKind
  );
  const rawItem = Number(firstParam(params.item) ?? 0);
  const itemId = filterItems.some((item) => item.id === rawItem)
    ? rawItem
    : undefined;

  const rows = getIntakeDoseHistoryAll(profileId, range.from ?? ISO_FLOOR, {
    kind: queryKind,
    itemId,
    untilDate: range.to,
  });

  const entries: DoseLedgerEntry[] = rows.map((row) => {
    // The row-level time question, asked once (#2205 phase 3): the stated event
    // instant (`occurred_at`) when somebody named one, else the record chain
    // (recorded_at → taken_at), with the answer saying WHICH it was. A ledger IS the
    // clinical record (#2228 decision 4), so a record-chain clock renders as
    // "recorded 7:02am" rather than presenting a filing timestamp as an
    // administration time.
    const when = bestKnownInstant("intake_item_logs", row);
    const clock = formatGivenAtClock(
      tz,
      when.known ? when.at : null,
      timeFormat
    );
    return {
      id: row.id,
      itemId: row.item_id,
      itemName: row.item_name,
      kind: row.item_kind,
      doseId: row.dose_id,
      date: row.date,
      time:
        clock && when.known && when.semantic === "record"
          ? `recorded ${clock}`
          : clock,
      // The edit form's time seed: the row's STATED instant only (#2228 decision 1).
      statedAt: row.occurred_at,
      amount: row.amount,
      product: row.product,
    };
  });

  // Live doses per item — what a backfill may be logged against. Retired doses are
  // excluded by the reader itself, so an item whose whole schedule was retired simply
  // isn't offered in the picker while its history keeps listing.
  const dosesByItem = new Map<
    number,
    { id: number; amount: string | null; time_of_day: string | null }[]
  >();
  for (const dose of getSupplementDoses(profileId)) {
    const list = dosesByItem.get(dose.item_id) ?? [];
    list.push({
      id: dose.id,
      amount: dose.amount,
      time_of_day: dose.time_of_day,
    });
    dosesByItem.set(dose.item_id, list);
  }
  const ledgerItems: DoseLedgerItem[] = filterItems.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    product: item.product,
    asNeeded: isPrn(item),
    doses: dosesByItem.get(item.id) ?? [],
  }));

  // The default backfill clock: the profile's current wall time, exactly as the
  // per-item panels seed it.
  const defaultTime = zonedDateParts(tz, new Date()).hhmm;

  const kindOptions: FilterPillOption<DoseLedgerKindFilter>[] =
    DOSE_LEDGER_KIND_FILTERS.map((value) => ({
      value,
      label: DOSE_LEDGER_KIND_LABELS[value],
      // Switching kind drops the item filter: an item belongs to one kind, so
      // carrying it across would leave a filter naming nothing in the new set.
      href: doseLedgerHref(surface, {
        from: range.from,
        to: range.to,
        kind: value,
        allTime: isAllTimeRange(range),
      }),
    }));

  const rangeHref = (next: DateRange) =>
    isAllTimeRange(next)
      ? doseLedgerHref(surface, {
          kind: kindFilter,
          item: itemId,
          allTime: true,
        })
      : doseLedgerHref(surface, {
          from: next.from,
          to: next.to,
          kind: kindFilter,
          item: itemId,
        });

  return (
    <div data-testid="dose-ledger-page">
      <PageHeader
        title="Dose history"
        subtitle="Every dose you confirmed, across items. What was taken — not an adherence verdict."
        action={
          <Link
            href={intakeHref(surface)}
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            {surface === "medication" ? "Medications" : "Supplements"} →
          </Link>
        }
      />

      <div className="mb-4 space-y-3">
        <DateRangeControl
          basePath={
            surface === "medication"
              ? "/medications/dose-history"
              : "/nutrition/dose-history"
          }
          range={range}
          todayStr={todayStr}
          hiddenParams={{
            kind: kindFilter,
            item: itemId ? String(itemId) : undefined,
            // "All time" is a real answer here too, and an empty query string means
            // the DOSE_HISTORY_DAYS default — so the sentinel has to ride the form.
            [ALL_TIME_RANGE_PARAM]: isAllTimeRange(range)
              ? ALL_TIME_RANGE_VALUE
              : undefined,
          }}
          buildHref={rangeHref}
          idPrefix="dose-ledger"
        />
        <div className="flex flex-wrap items-center gap-3">
          <FilterPills
            options={kindOptions}
            value={kindFilter}
            label="Filter dose history by kind"
            testId="dose-ledger-kind-filter"
          />
          <DoseLedgerItemFilter
            items={filterItems.map((item) => ({
              id: item.id,
              label: item.active ? item.name : `${item.name} (inactive)`,
            }))}
            value={itemId}
          />
        </div>
      </div>

      <div className="card">
        {/* Keyed on the item filter: a filter change is a NAVIGATION within one route
            segment, so React keeps the client table's state across it — and the
            backfill picker, which opens on the filtered item, would otherwise keep
            pointing at whichever item the page first mounted with. */}
        <DoseLedgerTable
          key={`dose-ledger-item-${itemId ?? 0}`}
          rows={entries}
          items={ledgerItems}
          canWrite={canWrite}
          maxDate={todayStr}
          defaultTime={defaultTime}
          defaultItemId={itemId}
          note={doseLedgerWindowNote(range)}
        />
      </div>

      {/* The chart half of the same question (#2415): this table is what a day in
          that calendar held. */}
      <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
        Looking for the pattern rather than the rows?{" "}
        <Link
          href="/trends?tab=nutrition#dose-history"
          className="font-medium text-brand-700 hover:underline dark:text-brand-400"
          data-testid="dose-ledger-trends-link"
        >
          Dose history chart
        </Link>
      </p>
    </div>
  );
}
