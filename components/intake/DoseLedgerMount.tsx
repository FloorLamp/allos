import Link from "next/link";
import EventLedgerFrame, {
  type EventLedgerChipOption,
} from "@/components/ledger/EventLedgerFrame";
import DoseBackfillLauncher from "@/components/intake/DoseBackfillLauncher";
import DoseLedgerRows from "@/components/intake/DoseLedgerRows";
import type {
  DoseLedgerEntry,
  DoseLedgerItem,
} from "@/components/intake/dose-ledger-entry";
import { today } from "@/lib/db";
import {
  getIntakeDoseLedgerPage,
  getIntakeItems,
  getIntakeDoses,
} from "@/lib/queries";
import { HISTORY_PAGE_SIZE, clampPage, pageCount } from "@/lib/pagination";
import { getDisplayFormatPrefs, getTimezone } from "@/lib/settings";
import { zonedDateParts } from "@/lib/date";
import { bestKnownInstant } from "@/lib/row-instants";
import { formatGivenAtClock } from "@/lib/administration-format";
import { isOnDemand } from "@/lib/intake-schedule";
import {
  DOSE_LEDGER_KIND_FILTERS,
  DOSE_LEDGER_KIND_LABELS,
  doseLedgerEmptyNote,
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
import type { IntakeItemKind } from "@/lib/types";

// The ISO floor an all-time window reads from — the ledger's reader takes a `since`
// day, and "all time" is a window with no lower bound rather than a second query.
const ISO_FLOOR = "0001-01-01";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// THE DOSE MOUNT of the shared event-ledger frame (#3484 part 2), rendered by BOTH
// intake surfaces (/nutrition/dose-history and /medications/dose-history) — #2417's
// one-ledger-two-doors, now expressed as one mount opened at two pre-filters rather
// than as a bespoke shell.
//
// The rest of intake_items already refuses to split its machinery by kind — dose,
// adherence, refill, interaction and warning behavior are shared, and historical dose
// correction is adherence machinery — so a supplements-only ledger and a
// medications-only ledger would be that split all over again. What differs between the
// two routes is exactly one thing: which kind the page opens PRE-FILTERED to, which is
// the same kind→surface seam `intakeHref` encodes one level up.
//
// WHAT THIS FILE OWNS, and the frame therefore does not: the dose READ and its bound
// (#2445), the kind and item vocabularies, the window and empty sentences, the row
// renderer, the amend contract (#2228) and the backfill slot's contents. The frame
// owns the box — see components/ledger/EventLedgerFrame.tsx.
//
// Auth is the PAGE's: each route resolves its own scope and hands this component an
// already-authorized profileId, the login whose display preferences format the clocks,
// and whether that caller may write. This component reads and renders; it imports no
// auth module.
export default function DoseLedgerMount({
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
  surface: IntakeItemKind;
  params: {
    from?: string | string[];
    to?: string | string[];
    range?: string | string[];
    kind?: string | string[];
    item?: string | string[];
    page?: string | string[];
  };
}) {
  const todayStr = today(profileId);
  const tz = getTimezone(profileId);
  const formatPrefs = getDisplayFormatPrefs(loginId);
  const { timeFormat } = formatPrefs;

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
  const allItems = getIntakeItems(profileId);
  const filterItems = allItems.filter(
    (item) => !queryKind || item.kind === queryKind
  );
  const rawItem = Number(firstParam(params.item) ?? 0);
  const itemId = filterItems.some((item) => item.id === rawItem)
    ? rawItem
    : undefined;

  // The ledger is PAGED at the SQL level (#2445). The range control offers an
  // explicit "All time", which is a window with no lower bound — a legitimate answer
  // for a record of what was taken, and therefore not a bound at all. A must-obligation
  // medication logged twice daily for years is thousands of rows, and without a page
  // every one of them was fetched, serialized and rendered on that tap.
  const requestedPage = clampPage(Number(firstParam(params.page)) || 1);
  const ledger = getIntakeDoseLedgerPage(
    profileId,
    range.from ?? ISO_FLOOR,
    { kind: queryKind, itemId, untilDate: range.to },
    requestedPage,
    HISTORY_PAGE_SIZE
  );
  const rows = ledger.rows;
  const ledgerPages = pageCount(ledger.total, HISTORY_PAGE_SIZE);

  const entries: DoseLedgerEntry[] = rows.map((row) => {
    // The row-level time question, asked once (#2205 phase 3): the stated event
    // instant (`occurred_at`) when somebody named one, else the record chain
    // (recorded_at), with the answer saying WHICH it was. A ledger IS the
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
  for (const dose of getIntakeDoses(profileId)) {
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
    asNeeded: isOnDemand(item),
    doses: dosesByItem.get(item.id) ?? [],
  }));
  const loggable = ledgerItems.filter((item) => item.doses.length > 0);

  // The default backfill clock: the profile's current wall time, exactly as the
  // per-item panels seed it.
  const defaultTime = zonedDateParts(tz, new Date()).hhmm;

  const kindOptions: EventLedgerChipOption<DoseLedgerKindFilter>[] =
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

  // Every other control drops the page — a narrowed ledger re-pages from its first
  // row rather than landing the reader on a page the new filter may not have.
  const pageHref = (page: number) =>
    isAllTimeRange(range)
      ? doseLedgerHref(surface, {
          kind: kindFilter,
          item: itemId,
          allTime: true,
          page,
        })
      : doseLedgerHref(surface, {
          from: range.from,
          to: range.to,
          kind: kindFilter,
          item: itemId,
          page,
        });

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
    <EventLedgerFrame
      idPrefix="dose-ledger"
      back={{
        href: intakeHref(surface),
        label:
          surface === "medication"
            ? "Back to medications"
            : "Back to supplements",
      }}
      title="Dose history"
      subtitle="Every dose you confirmed, across items. What was taken — not an adherence verdict."
      basePath={
        surface === "medication"
          ? "/medications/dose-history"
          : "/nutrition/dose-history"
      }
      range={range}
      todayStr={todayStr}
      rangeHiddenParams={{
        kind: kindFilter,
        item: itemId ? String(itemId) : undefined,
        // "All time" is a real answer here too, and an empty query string means the
        // DOSE_HISTORY_DAYS default — so the sentinel has to ride the form.
        [ALL_TIME_RANGE_PARAM]: isAllTimeRange(range)
          ? ALL_TIME_RANGE_VALUE
          : undefined,
      }}
      buildRangeHref={rangeHref}
      chips={{
        options: kindOptions,
        value: kindFilter,
        label: "Filter dose history by kind",
      }}
      itemFilter={{
        options: filterItems.map((item) => ({
          id: item.id,
          label: item.active ? item.name : `${item.name} (inactive)`,
        })),
        value: itemId,
      }}
      pagination={{
        page: ledger.page,
        pageCount: ledgerPages,
        pageSize: HISTORY_PAGE_SIZE,
        total: ledger.total,
        visibleCount: rows.length,
        prevHref: ledger.page > 1 ? pageHref(ledger.page - 1) : null,
        nextHref: ledger.page < ledgerPages ? pageHref(ledger.page + 1) : null,
      }}
      empty={entries.length === 0}
      note={doseLedgerWindowNote(range, formatPrefs, todayStr)}
      emptyNote={doseLedgerEmptyNote(range, kindFilter, formatPrefs, todayStr)}
      backfill={
        canWrite && loggable.length > 0 ? (
          // Keyed on the item filter: a filter change is a NAVIGATION within one
          // route segment, so React keeps the client subtree's state across it — and
          // the backfill picker, which opens on the filtered item, would otherwise
          // keep pointing at whichever item the page first mounted with.
          <DoseBackfillLauncher
            key={`dose-ledger-item-${itemId ?? 0}`}
            loggable={loggable}
            maxDate={todayStr}
            defaultTime={defaultTime}
            defaultItemId={itemId}
          />
        ) : null
      }
      footer={
        // The chart half of the same question (#2415): this table is what a day in
        // that calendar held.
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
      }
    >
      <DoseLedgerRows
        key={`dose-ledger-item-${itemId ?? 0}`}
        rows={entries}
        items={ledgerItems}
        canWrite={canWrite}
        maxDate={todayStr}
        defaultTime={defaultTime}
      />
    </EventLedgerFrame>
  );
}
