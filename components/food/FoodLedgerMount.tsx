import Link from "next/link";
import EventLedgerFrame from "@/components/ledger/EventLedgerFrame";
import FoodLedgerRows, { type FoodLedgerEntry } from "./FoodLedgerRows";
import { today } from "@/lib/db";
import { getFoodLedgerPage } from "@/lib/queries/nutrition";
import { getDisplayFormatPrefs, getTimezone } from "@/lib/settings";
import { FOOD_GROUPS, foodGroupBySlug } from "@/lib/food-groups";
import { foodEventWindow } from "@/lib/food-slot-count";
import { profileFoodSlotBoundaries } from "@/lib/profile-food-slot";
import { zonedDateParts } from "@/lib/date";
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
import { foodLedgerHref } from "@/lib/hrefs";
import { bestKnownInstant } from "@/lib/row-instants";

const ISO_FLOOR = "0001-01-01";
const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default function FoodLedgerMount({
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
  const range = resolveEventLedgerRange(
    normalizeTimelineRange(
      timelineDateFromParam(params.from),
      timelineDateFromParam(params.to)
    ),
    todayStr,
    first(params.range)
  );
  const rawGroup = first(params.item);
  const groupKey = FOOD_GROUPS.some((group) => group.slug === rawGroup)
    ? rawGroup
    : undefined;
  const requestedPage = clampPage(Number(first(params.page)) || 1);
  const ledger = getFoodLedgerPage(
    profileId,
    range.from ?? ISO_FLOOR,
    { untilDate: range.to, groupKey },
    requestedPage,
    HISTORY_PAGE_SIZE
  );
  const tz = getTimezone(profileId);
  const boundaries = profileFoodSlotBoundaries(profileId);
  const entries: FoodLedgerEntry[] = ledger.rows.map((row) => {
    const instant = bestKnownInstant("food_log_events", { ...row });
    return {
      id: row.id,
      groupKey: row.group_key,
      groupName: foodGroupBySlug(row.group_key)?.name ?? row.group_key,
      date: row.date,
      mealSlot: foodEventWindow(
        row.recorded_at,
        tz,
        boundaries,
        row.meal_slot,
        row.occurred_at
      ),
      clock: instant.known
        ? zonedDateParts(tz, new Date(instant.at)).hhmm
        : null,
      clockKind:
        instant.known && instant.semantic === "event" ? "eaten" : "logged",
    };
  });
  const pages = pageCount(ledger.total, HISTORY_PAGE_SIZE);
  const href = (page?: number, nextRange: DateRange = range) =>
    foodLedgerHref({
      from: nextRange.from,
      to: nextRange.to,
      item: groupKey,
      allTime: isAllTimeRange(nextRange),
      page,
    });

  return (
    <EventLedgerFrame
      idPrefix="food-ledger"
      back={{ href: "/nutrition", label: "Back to Nutrition" }}
      title="Food history"
      subtitle="Individual servings from your food log."
      basePath="/nutrition/food-history"
      range={range}
      todayStr={todayStr}
      rangeHiddenParams={{
        item: groupKey,
        [ALL_TIME_RANGE_PARAM]: isAllTimeRange(range)
          ? ALL_TIME_RANGE_VALUE
          : undefined,
      }}
      buildRangeHref={(next) => href(undefined, next)}
      itemFilter={{
        options: FOOD_GROUPS.map((group) => ({
          id: group.slug,
          label: group.name,
        })),
        value: groupKey,
        label: "Food",
      }}
      pagination={{
        page: ledger.page,
        pageCount: pages,
        pageSize: HISTORY_PAGE_SIZE,
        total: ledger.total,
        visibleCount: entries.length,
        prevHref: ledger.page > 1 ? href(ledger.page - 1) : null,
        nextHref: ledger.page < pages ? href(ledger.page + 1) : null,
      }}
      empty={entries.length === 0}
      note={eventLedgerWindowNote(range, "servings", formatPrefs, todayStr)}
      emptyNote={eventLedgerEmptyNote(
        range,
        "servings",
        "Change the range or log food from Nutrition.",
        formatPrefs,
        todayStr
      )}
      backfill={
        canWrite ? (
          <Link className="btn" href={`/nutrition?date=${todayStr}`}>
            Log food
          </Link>
        ) : null
      }
    >
      <FoodLedgerRows rows={entries} canWrite={canWrite} maxDate={todayStr} />
    </EventLedgerFrame>
  );
}
