import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";
import {
  IconActivity,
  IconAlertTriangle,
  IconBrain,
  IconCalendarEvent,
  IconChevronDown,
  IconChartLine,
  IconFileText,
  IconFlag,
  IconFlask2,
  IconNotes,
  IconPill,
  IconScale,
  IconScan,
  IconStethoscope,
  IconTemperature,
  IconTrophy,
  IconVaccine,
  IconVirus,
  IconBandage,
  type TablerIcon,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { today } from "@/lib/db";
import { getUnitPrefs, getHomeLocation, getTimezone } from "@/lib/settings";
import DaylightChip from "@/components/DaylightChip";
import {
  getTimelinePage,
  TIMELINE_CATEGORIES,
  timelineCategoryLabel,
  type TimelineCategory,
  type TimelineEvent,
} from "@/lib/timeline";
import {
  getDaylightOutdoorMinutesByDay,
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getSymptomLogOrder,
  getCustomSymptomNames,
} from "@/lib/queries";
import { hasActiveIllnessSituation } from "@/lib/settings/profile-attrs";
import { SYMPTOMS } from "@/lib/symptoms";
import SymptomLogBar from "../symptoms/SymptomLogBar";
import {
  groupTimelineDays,
  normalizeTimelineRange,
  timelineCategoryFromParam,
  timelineDateFromParam,
} from "@/lib/timeline-format";
import { formatLongDate } from "@/lib/format-date";
import { EmptyState, MedicalValue, PageHeader } from "@/components/ui";
import ActivityIcon from "@/components/ActivityIcon";
import DateRangeControl from "@/components/DateRangeControl";
import TimelineFilterLink, {
  TimelineScrollRestorer,
} from "@/components/TimelineFilterLink";

export const dynamic = "force-dynamic";

const CATEGORY_ICONS: Record<TimelineCategory, TablerIcon> = {
  activity: IconActivity,
  body: IconScale,
  medical: IconChartLine,
  document: IconFileText,
  medication: IconPill,
  immunization: IconVaccine,
  condition: IconStethoscope,
  allergy: IconAlertTriangle,
  visit: IconCalendarEvent,
  imaging: IconScan,
  goal: IconFlag,
  insight: IconBrain,
  milestone: IconTrophy,
  protocol: IconFlask2,
  symptom: IconTemperature,
  illness: IconVirus,
  injury: IconBandage,
};

const CARD_CLASS =
  "border-black/10 bg-white text-slate-700 dark:border-white/10 dark:bg-ink-900 dark:text-slate-200";

const BADGE_CLASS: Record<TimelineCategory, string> = {
  activity:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  body: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  medical: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  document: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  medication: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  immunization:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  condition:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  allergy: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  visit: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  imaging: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  goal: "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  insight:
    "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  milestone:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  protocol:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  symptom:
    "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  illness: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  injury: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

// The default page size and the increment each "Load more" reveals. The feed is
// always rendered from the top (newest first), so growing `show` cumulatively
// reveals older history while preserving scroll position.
const DEFAULT_SHOW = 300;
const SHOW_STEP = 300;
const MAX_SHOW = 1000;

const TRAINING_CATEGORIES = new Set<TimelineCategory>(["activity", "goal"]);

function filterHref(
  category?: TimelineCategory,
  range: { from?: string; to?: string } = {},
  show?: number
): AppRoute {
  const sp = new URLSearchParams();
  if (category) sp.set("category", category);
  if (range.from) sp.set("from", range.from);
  if (range.to) sp.set("to", range.to);
  if (show && show !== DEFAULT_SHOW) sp.set("show", String(show));
  const qs = sp.toString();
  return qs ? `/timeline?${qs}` : "/timeline";
}

function parseShow(value: string | string[] | undefined): number {
  const first = Array.isArray(value) ? value[0] : value;
  const n = Number(first);
  if (!Number.isFinite(n)) return DEFAULT_SHOW;
  return Math.min(Math.max(Math.trunc(n), DEFAULT_SHOW), MAX_SHOW);
}

function EventCard({
  event,
  defaultOpen = false,
}: {
  event: TimelineEvent;
  defaultOpen?: boolean;
}) {
  const Icon = CATEGORY_ICONS[event.category];
  const detailItems = event.detailItems ?? [];
  const canExpand = detailItems.length > 0;
  const icon =
    event.category === "activity" ? (
      <ActivityIcon
        type={event.iconType ?? "activity"}
        title={event.iconTitle ?? event.title}
        sportNames={event.iconSportNames ?? undefined}
        className="h-4 w-4"
        stroke={1.75}
      />
    ) : (
      <Icon className="h-4 w-4" stroke={1.75} />
    );
  const title = event.href ? (
    <Link
      href={event.href}
      className="transition hover:text-brand-700 hover:underline dark:hover:text-brand-300"
    >
      {event.title}
    </Link>
  ) : (
    event.title
  );
  const collapsed = (
    <>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/70 text-current ring-1 ring-black/5 dark:bg-black/10 dark:ring-white/10">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 pr-1">
            <h3 className="font-medium text-slate-900 dark:text-slate-100">
              {title}
            </h3>
            <span className={`badge text-xs ${BADGE_CLASS[event.category]}`}>
              {timelineCategoryLabel(event.category)}
            </span>
            {canExpand && (
              <span
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-500 transition group-open:rotate-180 group-hover:bg-white/70 group-hover:text-slate-700 dark:text-slate-400 dark:group-hover:bg-black/10 dark:group-hover:text-slate-200"
                aria-hidden
              >
                <IconChevronDown className="h-3.5 w-3.5" stroke={2} />
              </span>
            )}
          </div>
          {event.subtitle && (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {event.subtitle}
            </p>
          )}
          {event.detail && (
            <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              {event.detail}
            </p>
          )}
          {event.meta && event.meta.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {event.meta.map((m, index) => (
                <span
                  key={`${event.id}:meta:${index}:${m}`}
                  className="rounded bg-white/60 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-black/10 dark:text-slate-400"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );

  const shellClass = `rounded-lg border px-4 py-3 shadow-sm transition duration-150 hover:bg-brand-50 dark:hover:bg-brand-950/40 ${CARD_CLASS}`;

  if (!canExpand) {
    return <div className={`group block ${shellClass}`}>{collapsed}</div>;
  }

  return (
    <details className={`group block ${shellClass}`} open={defaultOpen}>
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
        {collapsed}
      </summary>
      <div className="mt-3 border-t border-black/5 pt-3 text-sm sm:ml-11 dark:border-white/10">
        <dl className="space-y-1.5">
          {detailItems.map((item, index) => (
            <div
              key={`${event.id}:detail:${index}:${item.label}:${item.value}`}
              className="grid gap-1 sm:grid-cols-[10rem_1fr]"
            >
              <dt className="font-medium text-slate-700 dark:text-slate-200">
                {item.label}
              </dt>
              <dd className="text-slate-600 dark:text-slate-300">
                {item.unit || item.flag ? (
                  <MedicalValue
                    value={item.value}
                    unit={item.unit ?? null}
                    flag={item.flag ?? null}
                  />
                ) : (
                  item.value
                )}
              </dd>
            </div>
          ))}
        </dl>
        {event.href && (
          <Link
            href={event.href}
            className="mt-3 inline-flex text-xs font-semibold text-brand-700 transition hover:underline dark:text-brand-300"
          >
            Open source record
          </Link>
        )}
      </div>
    </details>
  );
}

export default async function TimelinePage(props: {
  searchParams: Promise<{
    category?: string | string[];
    from?: string | string[];
    to?: string | string[];
    show?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const trainingRestricted = isTrainingRestricted(profile.id);
  // Home location + timezone for the per-day sunrise/sunset daylight chips (#570).
  // Absent home location → the chip renders nothing.
  const home = getHomeLocation(profile.id);
  const profileTimezone = getTimezone(profile.id);
  const visibleCategories = trainingRestricted
    ? TIMELINE_CATEGORIES.filter((c) => !TRAINING_CATEGORIES.has(c))
    : TIMELINE_CATEGORIES;
  const requestedCategory = timelineCategoryFromParam(searchParams.category);
  const category =
    trainingRestricted && requestedCategory
      ? TRAINING_CATEGORIES.has(requestedCategory)
        ? undefined
        : requestedCategory
      : requestedCategory;
  const from = timelineDateFromParam(searchParams.from);
  const to = timelineDateFromParam(searchParams.to);
  const todayStr = today(profile.id);
  const show = parseShow(searchParams.show);
  // The default and "All time" views leave the upper bound OPEN (no injected
  // today cap) so future-dated events — a goal's target date, an upcoming visit —
  // are visible; they sort to the top of the newest-first feed. Only an explicit
  // user-set from/to bounds the window.
  const range = normalizeTimelineRange(from, to);
  const { events, hasMore } = getTimelinePage(profile.id, {
    category,
    startDate: range.from,
    endDate: range.to,
    limit: show,
    units,
    restricted: trainingRestricted,
  });
  const days = groupTimelineDays(events);
  // Daylight-outdoor minutes per visible day (issue #571) — the same
  // getDaylightOutdoorMinutesByDay computation the coaching observation averages.
  // One query over the rendered days; empty when no home location is set.
  const daylightOutdoor = home
    ? getDaylightOutdoorMinutesByDay(
        profile.id,
        days.map((d) => d.date)
      )
    : new Map<string, number>();
  const singleDaySelected = Boolean(
    range.from && range.to && range.from === range.to
  );
  const latestDay = days[0]?.date;
  const oldestDay = days.at(-1)?.date;
  const throughLabel =
    range.to === todayStr
      ? "Through today"
      : range.to
        ? `Through ${formatLongDate(range.to)}`
        : range.from
          ? `From ${formatLongDate(range.from)}`
          : "All dates";

  return (
    <div>
      <PageHeader
        title="Timeline"
        subtitle="A chronological view of workouts, labs, documents, medications, visits, goals, and other health events."
      />

      <TimelineScrollRestorer
        controlsId="timeline-controls"
        feedId="timeline-feed"
        restoreKey={`${category ?? "all"}:${range.from ?? ""}:${range.to ?? ""}`}
      />

      <div
        id="timeline-controls"
        className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-2 mb-5 space-y-2 bg-slate-50/50 px-2 py-2 backdrop-blur-md sm:space-y-4 sm:py-3 md:top-0 dark:bg-ink-950/50"
      >
        <DateRangeControl
          basePath="/timeline"
          range={range}
          todayStr={todayStr}
          hiddenParams={{ category }}
          buildHref={(r) => filterHref(category, r)}
          LinkComponent={TimelineFilterLink}
          idPrefix="timeline"
          rightSlot={
            <>
              <span className="whitespace-nowrap rounded-full border border-black/10 bg-white/60 px-3 py-1 text-slate-500 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-400">
                {throughLabel}
              </span>
              {latestDay && oldestDay && latestDay !== oldestDay && (
                <>
                  <a
                    href={`#timeline-day-${latestDay}`}
                    className="rounded-full px-3 py-1 font-medium text-brand-700 transition hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-950/50"
                  >
                    Latest
                  </a>
                  <a
                    href={`#timeline-day-${oldestDay}`}
                    className="rounded-full px-3 py-1 font-medium text-brand-700 transition hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-950/50"
                  >
                    Oldest
                  </a>
                </>
              )}
            </>
          }
        />

        <div className="-mx-2 flex gap-2 overflow-x-auto px-2 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          <TimelineFilterLink
            href={filterHref(undefined, range)}
            className={`shrink-0 rounded-full px-3 py-1 text-sm font-medium transition ${
              !category
                ? "bg-brand-500 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
            }`}
          >
            All
          </TimelineFilterLink>
          {visibleCategories.map((c) => {
            const active = c === category;
            return (
              <TimelineFilterLink
                key={c}
                href={filterHref(c, range)}
                className={`shrink-0 rounded-full px-3 py-1 text-sm font-medium transition ${
                  active
                    ? "bg-brand-500 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
                }`}
              >
                {timelineCategoryLabel(c)}
              </TimelineFilterLink>
            );
          })}
        </div>
      </div>

      {/* Retro symptom entry (#799): on a single selected day, offer the one-tap symptom
          bar so a past sick day can be filled in — the Timeline day-view entry point. When
          no illness-type situation is active it offers the suggest-only "Mark as illness"
          bridge (direction A of the two-way bridge). */}
      {singleDaySelected && range.from && (
        <div className="card mb-5" data-testid="timeline-symptom-entry">
          <h2 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
            Log symptoms for {formatLongDate(range.from)}
          </h2>
          <SymptomLogBar
            date={range.from}
            initial={getSymptomSeveritiesOnDate(profile.id, range.from)}
            initialNotes={getSymptomNotesOnDate(profile.id, range.from)}
            symptoms={SYMPTOMS}
            customNames={getCustomSymptomNames(profile.id)}
            rankedKeys={getSymptomLogOrder(profile.id)}
            suggestActivateIllness={!hasActiveIllnessSituation(profile.id)}
            temperatureUnit={units.temperatureUnit}
          />
        </div>
      )}

      {days.length === 0 ? (
        <EmptyState
          message={
            category
              ? `No ${timelineCategoryLabel(category).toLowerCase()} events yet.`
              : "No timeline events yet."
          }
        />
      ) : (
        <div id="timeline-feed" className="relative">
          <div className="absolute bottom-0 left-0 top-0 hidden w-px bg-black/10 md:left-[14.75rem] md:block dark:bg-white/10" />
          <div className="space-y-0">
            {days.map((day, index) => (
              <section
                key={day.date}
                id={`timeline-day-${day.date}`}
                className="relative grid scroll-mt-[calc(13rem+env(safe-area-inset-top))] gap-3 py-6 first:pt-0 md:grid-cols-[14rem_1fr] md:scroll-mt-44"
              >
                {index > 0 && (
                  <div
                    className="absolute left-0 right-0 top-0 h-px bg-black/10 dark:bg-white/10"
                    style={{
                      maskImage:
                        "linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)",
                      WebkitMaskImage:
                        "linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)",
                    }}
                  />
                )}
                <div className="md:sticky md:top-4 md:self-start">
                  <div className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-slate-800 dark:text-slate-100">
                    <IconNotes
                      className="h-4 w-4 text-brand-600 dark:text-brand-400"
                      stroke={1.75}
                    />
                    {formatLongDate(day.date)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {day.events.length} event
                    {day.events.length === 1 ? "" : "s"}
                  </div>
                  <DaylightChip
                    home={home}
                    date={day.date}
                    timezone={profileTimezone}
                    outdoorMinutes={daylightOutdoor.get(day.date) ?? 0}
                  />
                </div>
                <div className="space-y-3 pl-4">
                  {day.events.map((event) => (
                    <div key={event.id} className="relative">
                      <span className="absolute left-0 top-[1.875rem] h-px w-4 -translate-x-4 bg-black/10 dark:bg-white/10" />
                      <span className="absolute left-0 top-[1.5625rem] h-2.5 w-2.5 -translate-x-[1.3125rem] rounded-full border-2 border-white bg-brand-500 dark:border-ink-950" />
                      <EventCard
                        event={event}
                        defaultOpen={singleDaySelected}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {hasMore &&
            (show < MAX_SHOW ? (
              <div className="flex justify-center pb-2 pt-4">
                <TimelineFilterLink
                  href={filterHref(category, range, show + SHOW_STEP)}
                  className="rounded-full border border-black/10 bg-white/70 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-white dark:border-white/10 dark:bg-ink-900/70 dark:text-slate-200 dark:hover:bg-ink-850"
                >
                  Load more
                </TimelineFilterLink>
              </div>
            ) : (
              <p className="pb-2 pt-4 text-center text-sm text-slate-500 dark:text-slate-400">
                Showing the latest {MAX_SHOW} events — narrow the date range to
                see more.
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
