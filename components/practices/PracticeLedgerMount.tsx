import Link from "next/link";
import EventLedgerFrame from "@/components/ledger/EventLedgerFrame";
import PracticeSessionHistory from "./PracticeSessionHistory";
import { today } from "@/lib/db";
import {
  getPracticeLedgerPage,
  getPracticeLedgerOptions,
} from "@/lib/queries/wellness";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { HISTORY_PAGE_SIZE, clampPage, pageCount } from "@/lib/pagination";
import {
  ALL_TIME_RANGE_PARAM,
  ALL_TIME_RANGE_VALUE,
  isAllTimeRange,
  normalizeTimelineRange,
  timelineDateFromParam,
  type DateRange,
} from "@/lib/timeline-format";
import {
  eventLedgerEmptyNote,
  eventLedgerWindowNote,
  resolveEventLedgerRange,
} from "@/lib/event-ledger";
import { practiceLedgerHref } from "@/lib/hrefs";

const ISO_FLOOR = "0001-01-01";
const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default function PracticeLedgerMount({
  profileId,
  loginId,
  canWrite,
  params,
}: {
  profileId: number;
  loginId: number;
  canWrite: boolean;
  params: Record<
    "from" | "to" | "range" | "item" | "page",
    string | string[] | undefined
  >;
}) {
  const todayStr = today(profileId);
  const formatPrefs = getDisplayFormatPrefs(loginId);
  const practices = getPracticeLedgerOptions(profileId);
  const range = resolveEventLedgerRange(
    normalizeTimelineRange(
      timelineDateFromParam(params.from),
      timelineDateFromParam(params.to)
    ),
    todayStr,
    first(params.range)
  );
  const rawPractice = first(params.item);
  const practice = practices.find((item) => item.identity === rawPractice);
  const requestedPage = clampPage(Number(first(params.page)) || 1);
  const ledger = getPracticeLedgerPage(
    profileId,
    range.from ?? ISO_FLOOR,
    { untilDate: range.to, practice: practice?.identity },
    requestedPage,
    HISTORY_PAGE_SIZE
  );
  const pages = pageCount(ledger.total, HISTORY_PAGE_SIZE);
  const href = (page?: number, nextRange: DateRange = range) =>
    practiceLedgerHref({
      from: nextRange.from,
      to: nextRange.to,
      item: practice?.identity,
      allTime: isAllTimeRange(nextRange),
      page,
    });

  return (
    <EventLedgerFrame
      idPrefix="practice-ledger"
      back={{ href: "/wellness", label: "Back to Wellness" }}
      title="Practice history"
      subtitle="Every logged wellness practice session."
      basePath="/wellness/practice-history"
      range={range}
      todayStr={todayStr}
      rangeHiddenParams={{
        item: practice?.identity,
        [ALL_TIME_RANGE_PARAM]: isAllTimeRange(range)
          ? ALL_TIME_RANGE_VALUE
          : undefined,
      }}
      buildRangeHref={(next) => href(undefined, next)}
      itemFilter={{
        options: practices.map((item) => ({
          id: item.identity,
          label: item.name,
        })),
        value: practice?.identity,
        label: "Practice",
      }}
      pagination={{
        page: ledger.page,
        pageCount: pages,
        pageSize: HISTORY_PAGE_SIZE,
        total: ledger.total,
        visibleCount: ledger.rows.length,
        prevHref: ledger.page > 1 ? href(ledger.page - 1) : null,
        nextHref: ledger.page < pages ? href(ledger.page + 1) : null,
      }}
      empty={ledger.rows.length === 0}
      note={eventLedgerWindowNote(range, "sessions", formatPrefs, todayStr)}
      emptyNote={eventLedgerEmptyNote(
        range,
        "practice sessions",
        "Change the range or log a session from Wellness.",
        formatPrefs,
        todayStr
      )}
      backfill={
        canWrite ? (
          <Link className="btn" href={`/wellness?log=${todayStr}`}>
            Log a practice
          </Link>
        ) : null
      }
    >
      <PracticeSessionHistory
        sessions={ledger.rows}
        totalCount={ledger.rows.length}
        ledger
        showPracticeName={!practice}
        readOnly={!canWrite}
      />
    </EventLedgerFrame>
  );
}
