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
  IconRun,
  IconSparkles,
  IconUsers,
  IconLayoutList,
  type TablerIcon,
} from "@tabler/icons-react";
import { requireScope, stampSubjects, type SubjectInfo } from "@/lib/scope";
import { isTrainingRestricted } from "@/lib/age-gate";
import { today } from "@/lib/db";
import {
  getUnitPrefs,
  getDisplayFormatPrefs,
  getHomeLocation,
  getTimezone,
} from "@/lib/settings";
import DaylightChip from "@/components/DaylightChip";
import CyclePhaseChip from "@/components/CyclePhaseChip";
import Avatar from "@/components/Avatar";
import SubjectChip from "@/components/SubjectChip";
import { listCyclePeriods } from "@/lib/cycle-store";
import { cyclePhaseOnDate, periodOnDate } from "@/lib/cycle";
import {
  getTimelinePage,
  getMultiProfileTimeline,
  TIMELINE_CATEGORIES,
  timelineCategoryLabel,
  type TimelineCategory,
  type TimelineEvent,
} from "@/lib/timeline";
import {
  mergeMemberTimelines,
  byPersonTimelines,
  type ProfiledTimelineEvent,
  type DayMark,
} from "@/lib/timeline-multi";
import {
  subjectChipVisible,
  parseViewMode,
  type ViewMode,
} from "@/lib/multi-view";
import { getUvDoseForDay } from "@/lib/queries/weather";
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
import { isTaskConfigured } from "@/lib/ai-resolve";
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
  endurance: IconRun,
  practice: IconSparkles,
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
  endurance: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  practice: "bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300",
};

// The default page size and the increment each "Load more" reveals. The feed is
// always rendered from the top (newest first), so growing `show` cumulatively
// reveals older history while preserving scroll position.
const DEFAULT_SHOW = 300;
const SHOW_STEP = 300;
const MAX_SHOW = 1000;

const TRAINING_CATEGORIES = new Set<TimelineCategory>(["activity", "goal"]);

// The relative-day badge copy for a divergent day (issue #1329). Honest, per member.
const RELATIVE_LABEL: Record<DayMark["relative"], string> = {
  today: "Today",
  yesterday: "Yesterday",
  tomorrow: "Tomorrow",
};

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

// A day-deep-link's `subject` param (issue #1329): whose day a single-day view lands on.
// Positive-integer profile ids only; anything else → undefined (falls back to acting).
function parseSubjectParam(
  value: string | string[] | undefined
): number | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const n = Number(first);
  return Number.isInteger(n) && n > 0 ? n : undefined;
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
          {/* Linked context (#662): non-causal deep-links to the OTHER records this
              event's import document produced. Informational reference — labeled
              "From this visit's document" so it never reads as a causal claim. */}
          {event.linkedRefs && event.linkedRefs.length > 0 && (
            <div className="mt-2" data-testid="timeline-linked-refs">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                From this visit’s document
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {event.linkedRefs.map((ref, index) => (
                  <Link
                    key={`${event.id}:ref:${index}:${ref.label}`}
                    href={ref.href}
                    className="rounded bg-white/60 px-1.5 py-0.5 text-xs text-brand-700 transition hover:underline dark:bg-black/10 dark:text-brand-300"
                  >
                    {ref.label}
                  </Link>
                ))}
              </div>
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

// The divergent-day header marks (issue #1329): when a calendar date is one member's
// "today" and another's "tomorrow" (timezone divergence — travel / midnight straddle),
// the header carries per-member relative badges rather than pretending one boundary.
// Rendered ONLY on divergent days (marks non-empty), so an aligned day / single view
// shows nothing extra. On-element identity (#531): each badge names its subject.
function DayMarks({
  marks,
  subjectByProfile,
}: {
  marks: DayMark[];
  subjectByProfile: Map<number, SubjectInfo>;
}) {
  return (
    <div
      data-testid="timeline-day-divergence"
      className="mt-1 flex flex-wrap gap-1"
    >
      {marks.map((mark) => {
        const subject = subjectByProfile.get(mark.profileId);
        const name = subject?.name ?? `Profile ${mark.profileId}`;
        return (
          <span
            key={mark.profileId}
            data-testid={`timeline-daymark-${mark.profileId}`}
            className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300"
          >
            {subject && (
              <Avatar
                profile={{
                  id: subject.profileId,
                  name: subject.name,
                  photo_path: subject.photoPath,
                  photo_version: subject.photoVersion,
                }}
                size="sm"
              />
            )}
            {RELATIVE_LABEL[mark.relative]} · {name}
          </span>
        );
      })}
    </div>
  );
}

// One event row in a timeline day column, with an optional subject chip (issue #1329)
// when the event belongs to a NON-acting member in a multi-view feed — the acting
// profile's own rows are implied by the view strip and get no chip (subjectChipVisible).
function TimelineEventRow({
  event,
  defaultOpen,
  subject,
}: {
  event: TimelineEvent;
  defaultOpen: boolean;
  subject: SubjectInfo | null;
}) {
  return (
    <div className="relative" data-testid="timeline-event">
      <span className="absolute left-0 top-[1.875rem] h-px w-4 -translate-x-4 bg-black/10 dark:bg-white/10" />
      <span className="absolute left-0 top-[1.5625rem] h-2.5 w-2.5 -translate-x-[1.3125rem] rounded-full border-2 border-white bg-brand-500 dark:border-ink-950" />
      {subject && (
        <div className="mb-1.5">
          <SubjectChip subject={subject} />
        </div>
      )}
      <EventCard event={event} defaultOpen={defaultOpen} />
    </div>
  );
}

export default async function TimelinePage(props: {
  searchParams: Promise<{
    category?: string | string[];
    from?: string | string[];
    to?: string | string[];
    show?: string | string[];
    subject?: string | string[];
    group?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  // The cross-profile scope (issue #1329 / #1096): the persisted view-set (∩ accessible).
  // In the common single-view case `viewIds` is just the acting profile and the page
  // renders exactly as before; when the user has toggled other profiles into view, the
  // full feed merges each member's timeline — bucketed in THAT member's own timezone-
  // local days (the per-profile-context trap) — with honest divergent-day headers.
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const multi = viewIds.length > 1;

  const units = getUnitPrefs(loginId);
  const formatPrefs = getDisplayFormatPrefs(loginId);
  // Category pills + the training-category drop follow the ACTING profile's restriction
  // (the viewer's anchor); each in-view member's own restriction is applied inside the
  // per-member gather, so a restricted member simply contributes no training events.
  const actingRestricted = isTrainingRestricted(actingProfileId);
  const visibleCategories = actingRestricted
    ? TIMELINE_CATEGORIES.filter((c) => !TRAINING_CATEGORIES.has(c))
    : TIMELINE_CATEGORIES;
  const requestedCategory = timelineCategoryFromParam(searchParams.category);
  const category =
    actingRestricted && requestedCategory
      ? TRAINING_CATEGORIES.has(requestedCategory)
        ? undefined
        : requestedCategory
      : requestedCategory;
  const from = timelineDateFromParam(searchParams.from);
  const to = timelineDateFromParam(searchParams.to);
  const show = parseShow(searchParams.show);
  // The default and "All time" views leave the upper bound OPEN (no injected today
  // cap) so future-dated events are visible. Only an explicit user-set from/to bounds
  // the window.
  const range = normalizeTimelineRange(from, to);
  const singleDaySelected = Boolean(
    range.from && range.to && range.from === range.to
  );

  // The single-day timeline view stays SINGLE-SUBJECT (issue #1329 — never a mixed-
  // subject edit surface): a day-deep-link built inside the multi-view feed carries a
  // `subject` param naming whose local day it is, so the day view lands on THAT member's
  // day context. Honored only in multi-view for an in-view member; otherwise (and in
  // single view) the acting profile is the subject, byte-identical to before.
  const subjectParam = parseSubjectParam(searchParams.subject);
  const daySubjectId =
    multi &&
    singleDaySelected &&
    subjectParam != null &&
    viewIds.includes(subjectParam)
      ? subjectParam
      : actingProfileId;
  const viewingOtherSubject = daySubjectId !== actingProfileId;
  const daySubjectName = scope.profiles.find(
    (p) => p.id === daySubjectId
  )?.name;

  // The multi-view MERGED feed renders only when several profiles are in view AND we're
  // not on a single-day (single-subject) view.
  const multiFeed = multi && !singleDaySelected;
  const viewMode: ViewMode = multiFeed
    ? parseViewMode(searchParams.group)
    : "interleaved";

  // Per-subject context (the single-subject branch): home/timezone/cycle/today all key
  // on the subject whose day we're rendering (acting in the common case).
  const trainingRestricted = isTrainingRestricted(daySubjectId);
  const home = getHomeLocation(daySubjectId);
  const profileTimezone = getTimezone(daySubjectId);
  const todayStr = today(daySubjectId);

  // Single-subject gather (single view, or a deep-linked subject's day). The multi feed
  // uses the cross-profile gather below instead.
  const singlePage = multiFeed
    ? { events: [] as TimelineEvent[], hasMore: false }
    : getTimelinePage(daySubjectId, {
        category,
        startDate: range.from,
        endDate: range.to,
        limit: show,
        units,
        restricted: trainingRestricted,
      });
  const days = groupTimelineDays(singlePage.events);

  // Cross-profile gather (issue #1329): loop-composed per member, each bucketed in its
  // own timezone-local days. Subject identity resolved ONCE through stampSubjects (#534).
  const multiGather = multiFeed
    ? getMultiProfileTimeline(viewIds, {
        category,
        startDate: range.from,
        endDate: range.to,
        limit: show,
        units,
      })
    : { members: [], hasMore: false };
  const mergedDays = multiFeed ? mergeMemberTimelines(multiGather.members) : [];
  const memberSections = multiFeed
    ? byPersonTimelines(multiGather.members)
    : [];
  const subjectByProfile = new Map<number, SubjectInfo>();
  if (multi) {
    for (const s of stampSubjects(
      scope,
      viewIds.map((id) => ({ profileId: id }))
    )) {
      subjectByProfile.set(s.profileId, s.subject);
    }
  }
  const hasMore = multiFeed ? multiGather.hasMore : singlePage.hasMore;
  const hasAnyEvents = multiFeed
    ? multiGather.members.some((m) => m.events.length > 0)
    : days.length > 0;

  // Daylight/cycle/UV chips are ACTING/subject body-context; ambiguous on a shared
  // multi-feed day, so they render only in the single-subject branch (#1329).
  const daylightOutdoor =
    !multiFeed && home
      ? getDaylightOutdoorMinutesByDay(
          daySubjectId,
          days.map((d) => d.date)
        )
      : new Map<string, number>();
  const uvByDay = new Map<
    string,
    { uvMinutes: number | null; peakUvIndex: number | null }
  >();
  if (!multiFeed && home) {
    for (const [date, mins] of daylightOutdoor) {
      if (mins <= 0) continue;
      const dose = getUvDoseForDay(daySubjectId, date);
      if (dose && dose.uvSource === "live") {
        uvByDay.set(date, {
          uvMinutes: dose.uvMinutes,
          peakUvIndex: dose.peakUvIndex,
        });
      }
    }
  }
  const cyclePeriods = !multiFeed ? listCyclePeriods(daySubjectId) : [];

  const latestDay = (multiFeed ? mergedDays : days)[0]?.date;
  const oldestDay = (multiFeed ? mergedDays : days).at(-1)?.date;
  const throughLabel =
    range.to === todayStr
      ? "Through today"
      : range.to
        ? `Through ${formatLongDate(range.to, formatPrefs)}`
        : range.from
          ? `From ${formatLongDate(range.from, formatPrefs)}`
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

      {/* Multi-view merged feed: the interleaved | by-person toggle (issue #1327 fix 2,
          restated for timelines #1329). Only meaningful when several profiles are in view. */}
      {multiFeed && <ModeToggle mode={viewMode} category={category} />}

      {/* A deep-linked non-acting subject's day view (issue #1329): name whose day this
          is so the single-subject context is explicit. */}
      {viewingOtherSubject && daySubjectName && (
        <div
          data-testid="timeline-subject-day-banner"
          className="mb-4 flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200"
        >
          <IconUsers className="h-4 w-4 shrink-0" stroke={1.75} />
          Viewing {daySubjectName}’s day.
        </div>
      )}

      {/* Retro symptom entry (#799): on a single selected day, offer the one-tap symptom
          bar. It writes to the ACTING profile, so it's shown only when the day being
          viewed IS the acting profile's (never a mixed-subject / wrong-profile write —
          #1329). When no illness-type situation is active it offers the suggest-only
          "Mark as illness" bridge (direction A of the two-way bridge). */}
      {singleDaySelected && range.from && !viewingOtherSubject && (
        <div className="card mb-5" data-testid="timeline-symptom-entry">
          <h2 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
            Log symptoms for {formatLongDate(range.from, formatPrefs)}
          </h2>
          <SymptomLogBar
            date={range.from}
            initial={getSymptomSeveritiesOnDate(daySubjectId, range.from)}
            initialNotes={getSymptomNotesOnDate(daySubjectId, range.from)}
            symptoms={SYMPTOMS}
            customNames={getCustomSymptomNames(daySubjectId)}
            rankedKeys={getSymptomLogOrder(daySubjectId)}
            suggestActivateIllness={!hasActiveIllnessSituation(daySubjectId)}
            temperatureUnit={units.temperatureUnit}
            textIntakeEnabled={isTaskConfigured("symptom-map")}
          />
        </div>
      )}

      {!hasAnyEvents ? (
        <EmptyState
          message={
            category
              ? `No ${timelineCategoryLabel(category).toLowerCase()} events yet.`
              : "No timeline events yet."
          }
        />
      ) : multiFeed && viewMode === "by-person" ? (
        <div className="space-y-8" data-testid="timeline-by-person">
          {memberSections.map((section) => {
            const subject = subjectByProfile.get(section.profileId) ?? null;
            const name = subject?.name ?? `Profile ${section.profileId}`;
            return (
              <section
                key={section.profileId}
                data-testid={`timeline-member-section-${section.profileId}`}
              >
                <div className="mb-2 flex items-center gap-2 border-b border-black/5 pb-1 dark:border-white/5">
                  {subject && (
                    <Avatar
                      profile={{
                        id: subject.profileId,
                        name: subject.name,
                        photo_path: subject.photoPath,
                        photo_version: subject.photoVersion,
                      }}
                      size="sm"
                    />
                  )}
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {name}
                  </span>
                </div>
                {section.empty ? (
                  <div
                    data-testid={`timeline-member-empty-${section.profileId}`}
                    className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-ink-850 dark:text-slate-400"
                  >
                    No timeline events yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {section.days.map((day) => (
                      <div key={day.date}>
                        <div className="mb-2 flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-slate-800 dark:text-slate-100">
                          <IconNotes
                            className="h-4 w-4 text-brand-600 dark:text-brand-400"
                            stroke={1.75}
                          />
                          {formatLongDate(day.date, formatPrefs)}
                        </div>
                        <div className="space-y-3 pl-4">
                          {day.events.map((event) => (
                            <TimelineEventRow
                              key={`${event.profileId}:${event.id}`}
                              event={event}
                              defaultOpen={false}
                              subject={null}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : multiFeed ? (
        <div id="timeline-feed" className="relative">
          <div className="absolute bottom-0 left-0 top-0 hidden w-px bg-black/10 md:left-[14.75rem] md:block dark:bg-white/10" />
          <div className="space-y-0">
            {mergedDays.map((day, index) => (
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
                    {formatLongDate(day.date, formatPrefs)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {day.events.length} event
                    {day.events.length === 1 ? "" : "s"}
                  </div>
                  {day.marks.length > 0 && (
                    <DayMarks
                      marks={day.marks}
                      subjectByProfile={subjectByProfile}
                    />
                  )}
                </div>
                <div className="space-y-3 pl-4">
                  {day.events.map((event: ProfiledTimelineEvent) => {
                    const showChip = subjectChipVisible({
                      multi,
                      isActing: event.profileId === actingProfileId,
                    });
                    return (
                      <TimelineEventRow
                        key={`${event.profileId}:${event.id}`}
                        event={event}
                        defaultOpen={false}
                        subject={
                          showChip
                            ? (subjectByProfile.get(event.profileId) ?? null)
                            : null
                        }
                      />
                    );
                  })}
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
                    {formatLongDate(day.date, formatPrefs)}
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
                    uv={uvByDay.get(day.date) ?? null}
                  />
                  <CyclePhaseChip
                    phase={cyclePhaseOnDate(cyclePeriods, day.date)}
                    period={periodOnDate(cyclePeriods, day.date)}
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

// The interleaved | by-person ordering toggle for the merged multi-view feed (issue
// #1327 fix 2 / #1329). Two server-rendered <Link>s (native <a href> that work
// pre-hydration, #830) — no permanent client chrome. Only rendered in multi-view. The
// links preserve the active category filter so toggling mode doesn't reset it.
function ModeToggle({
  mode,
  category,
}: {
  mode: ViewMode;
  category?: TimelineCategory;
}) {
  const sp = new URLSearchParams();
  if (category) sp.set("category", category);
  const byDateQs = sp.toString();
  sp.set("group", "by-person");
  const byPersonQs = sp.toString();
  const byDateHref = (
    byDateQs ? `/timeline?${byDateQs}` : "/timeline"
  ) as AppRoute;
  const byPersonHref = `/timeline?${byPersonQs}` as AppRoute;
  const base =
    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition";
  const on =
    "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300";
  const off =
    "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-750";
  return (
    <div
      data-testid="timeline-mode-toggle"
      className="mb-4 inline-flex items-center gap-1 rounded-xl border border-black/10 p-1 dark:border-white/10"
    >
      <Link
        href={byDateHref}
        data-testid="timeline-mode-interleaved"
        aria-pressed={mode === "interleaved"}
        className={`${base} ${mode === "interleaved" ? on : off}`}
      >
        <IconLayoutList className="h-4 w-4" stroke={1.75} />
        By date
      </Link>
      <Link
        href={byPersonHref}
        data-testid="timeline-mode-by-person"
        aria-pressed={mode === "by-person"}
        className={`${base} ${mode === "by-person" ? on : off}`}
      >
        <IconUsers className="h-4 w-4" stroke={1.75} />
        By person
      </Link>
    </div>
  );
}
