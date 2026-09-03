import { Fragment } from "react";
import Link from "next/link";
import { IconChevronDown } from "@tabler/icons-react";
import DestinationLink from "@/components/DestinationLink";
import { EmptyState } from "@/components/ui";
import TimelineFilterLink from "@/components/TimelineFilterLink";
import HistoryRows from "@/app/(app)/history/HistoryRows";
import TrainingLogFilterBar from "./TrainingLogFilterBar";
import { requireScope } from "@/lib/scope";
import { today } from "@/lib/db";
import { getDisplayFormatPrefs, getTimezone } from "@/lib/settings";
import { historyMemberFeed } from "@/lib/history";
import {
  HISTORY_DEFAULT_SHOW,
  HISTORY_MAX_SHOW,
  HISTORY_SHOW_STEP,
  clampHistoryDay,
  layoutHistoryDay,
  parseHistoryShow,
  type HistoryRow,
} from "@/lib/history-format";
import { mergeMemberTimelines } from "@/lib/timeline-multi";
import {
  parseTimelineOpen,
  renderedTimelineDays,
  timelineFoldCounts,
  timelineMonthKey,
  timelineYearKey,
  toggledTimelineOpen,
  windowTimelineDays,
  type TimelineFold,
} from "@/lib/timeline-window";
import {
  parseTrainingLogQuery,
  trainingLogQueryActive,
  activityProvenanceKeyLabel,
  TRAINING_LOG_SOURCE_MANUAL,
} from "@/lib/training-log-format";
import {
  getActivityFaults,
  getTrainingLogMatchingActivityIds,
  getTrainingLogSourceKeys,
  resolveTrainingLogFilterSpec,
} from "@/lib/queries";
import { formatLongDate } from "@/lib/format-date";
import { zonedDateParts } from "@/lib/date";
import { historyHref, trainingLogHref, type AppRoute } from "@/lib/hrefs";

// ── THE LOG TAB, ON THE SHARED HISTORY SUBSTRATE (#4079) ────────────────────
//
// The tab keeps its URL and its surface; only its private machinery retired. What
// used to live here — `lib/training-log-feed.ts`, `training-log-multi-view.ts`,
// `training-log-filters.ts`, a Server Action pager and a client filter state machine —
// answered questions `/history` had already answered for every other domain: how far
// back to read, how to bucket a day, how to fold a month, how to merge a household,
// what a row looks like and what its trailing affordance may do. This mount asks the
// substrate those questions and layers on the two things that are genuinely training's
// own: full-text search over sessions and their exercises, and the type/source/fault/
// tag refinements.
//
// SETS EXPANSION IS NOT A LAYER — it is the substrate's own row disclosure. An
// activity's timeline event already carries `detailItems` (its per-exercise set
// summaries), so `HistoryRows` draws that panel with no training-specific code at all.
//
// NAMED RETIREMENTS (#4079's anti-drop census): the unlimited pager and the
// full-ledger hash auto-pager (folds + `?show=` + the History door replace them), the
// week summary + ActiveDaysStrip header (Overview's This week card owns it), and the
// private multi-view merge (`?view=everyone` on the shared substrate owns it).

// The training family's rows are all ›-rows — an imported ride, a milestone and a
// hand-logged session are all corrected on the surface that owns them (#3958's
// provenance rule) — so no correction form ever mounts and the dose vocabulary those
// forms take is empty here rather than read and thrown away.
const NO_DOSE_ITEMS: never[] = [];

// One collapsed period on the Log's feed — the same fold vocabulary `/history` draws,
// from the same `lib/timeline-window` computation and the same position-preserving
// link. Spelled here because the record page still holds its own copy inline; the two
// want extracting into one component, which is a change to that file.
function LogFoldCard({
  fold,
  href,
  nested = false,
}: {
  fold: TimelineFold<{ date: string; events: unknown[] }> & {
    monthCount?: number;
  };
  href: AppRoute;
  nested?: boolean;
}) {
  return (
    <section
      id={`timeline-fold-${fold.key}`}
      data-testid={`training-log-fold-${fold.key}`}
      data-fold-key={fold.key}
      data-fold-open={fold.open ? "true" : "false"}
      data-fold-nested={nested ? "true" : undefined}
      className={`scroll-mt-24 py-1.5 ${nested ? "pl-4" : ""}`}
    >
      {/* `scroll={false}`, through the shared control (#4045 §4): a fold tap that
          jumped to the top of the page left the reader above their own recent history
          looking at a card that had visibly done nothing. */}
      <TimelineFilterLink
        href={href}
        testId={`training-log-fold-${fold.key}-toggle`}
        label={fold.label}
        ariaExpanded={fold.open}
        className="flex items-center gap-3 rounded-lg border border-(--border) bg-surface px-3 py-2 transition hover:bg-(--ghost-hover)"
      >
        <span
          aria-hidden
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-500 transition dark:text-slate-400 ${
            fold.open ? "rotate-180" : ""
          }`}
        >
          <IconChevronDown className="h-3.5 w-3.5" stroke={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
            {fold.label}
          </span>
          <span
            data-testid={`training-log-fold-${fold.key}-counts`}
            className="block text-xs text-slate-500 dark:text-slate-400"
          >
            {timelineFoldCounts(fold)}
          </span>
        </span>
      </TimelineFilterLink>
    </section>
  );
}

export default async function HistorySection({
  searchParams = {},
  initialCreateDate,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
  initialCreateDate?: string;
}) {
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const prefs = getDisplayFormatPrefs(loginId);
  const todayStr = today(actingProfileId);

  // The household view is a deep-linked MODE, not a switcher (#1463) — and it is the
  // shared substrate's, so the Log's own merge retired rather than being ported.
  const everyone =
    (Array.isArray(searchParams.view)
      ? searchParams.view[0]
      : searchParams.view) === "everyone" && viewIds.length > 1;
  const memberIds = everyone ? viewIds : [actingProfileId];

  const query = parseTrainingLogQuery(searchParams);
  const filtered = trainingLogQueryActive(query);
  const show = parseHistoryShow(searchParams.show);
  const openFolds = parseTimelineOpen(searchParams.open);

  // ONE DAY, AS A READ BOUND (#4079). `?day=` is not one of the layered refinements —
  // those are statements about an ACTIVITY, resolved against `activities`, while this
  // is the substrate's own gather bound and is spelled the way the record's day view
  // spells it. It is what makes `trainingLogDayHref` land: the day a reader asked for
  // is read directly instead of being hunted for inside whatever the window drew.
  // Clamped by the shared parser, so a hand-typed future or malformed day degrades to
  // the page rather than to an empty one asserting there is nothing there.
  const day = clampHistoryDay(searchParams.day, todayStr);
  // Either kind of narrowing answers a question the reader asked, and both are
  // answered over the whole record rather than over the window.
  const narrowed = filtered || day != null;

  // A FILTER IS A QUESTION ABOUT THE WHOLE RECORD, NOT ABOUT THE WINDOW (#1634).
  //
  // That issue's defect was a search that only ever saw the fetched pages, so a match
  // older than them reported "no matches" while the row sat in `activities`. Narrowing
  // the substrate's bounded gather would reintroduce exactly that: the bound is a
  // reading convenience for a scrolling feed, and a reader who has TYPED something is
  // no longer scrolling. So a filtered read goes to the substrate's ceiling and the
  // narrowing happens over that — which is a ceiling, and is stated as one: past
  // `HISTORY_MAX_SHOW` training rows the record's own Training family is the door.
  const gatherLimit = filtered ? HISTORY_MAX_SHOW : show;

  // ONE GATHER PER MEMBER, narrowed to the Training family — the substrate's own
  // bound, its own per-row visibility rules, its own clock grammar.
  const feeds = memberIds.map((id) => {
    const feed = historyMemberFeed(id, {
      loginId,
      family: "training",
      day,
      limit: gatherLimit,
      actingProfileId,
    });
    if (!filtered) return feed;
    // THE LAYERED FILTERS NARROW THE GATHERED ROWS, per member and by id. A training
    // filter is a statement about an ACTIVITY (its type, its provenance, its
    // exercises), so an endurance event or a milestone cannot satisfy one — those
    // rows drop with the non-matching sessions rather than surviving a filter that
    // was never asked of them.
    const admitted = getTrainingLogMatchingActivityIds(
      id,
      resolveTrainingLogFilterSpec(id, query)
    );
    const events = feed.events.filter((row) => {
      const match = /^feed:activity:(\d+)$/.exec(row.id);
      return match != null && (admitted?.has(Number(match[1])) ?? true);
    });
    return { ...feed, events };
  });

  const days = mergeMemberTimelines(feeds);
  // …AND THE FOLD IS PART OF THE WINDOW. Exempting the GATHER from the bound is only
  // half of #1634: the substrate then folds everything outside the recent band into
  // month and year cards, so a search whose matches are all old renders one auto-opened
  // month and a spine of closed cards over the rest — three matches, one visible. That
  // is the "no matches" defect wearing a fold, and it fails the same way: the reader
  // typed a question and the page answered with furniture. So a filtered read opens
  // every period it returned. The bound that keeps this finite is the gather's ceiling
  // above; the fold spine is a convenience for SCROLLING, and a reader who has typed
  // is not scrolling. A day-bounded read is the same case at its limit — one day, and
  // a fold shut over it is the whole page.
  const windowed = windowTimelineDays(
    days,
    todayStr,
    narrowed
      ? new Set(
          days.flatMap((group) => [
            timelineMonthKey(group.date),
            timelineYearKey(group.date),
          ])
        )
      : openFolds
  );
  const renderedDays = renderedTimelineDays(windowed);
  const rowCount = renderedDays.reduce((n, d) => n + d.events.length, 0);
  const hasMore = feeds.some((feed) => feed.gather.hasMore);
  // Whether the profile has ANY training row at all, asked independently of the
  // filter (the substrate's own presence rule). Over an empty history the search and
  // refinement controls are meaningless (#809), so they stand down and the add
  // affordance leads — but the ADD never disappears, which was that issue's defect.
  const hasHistory = feeds.some((feed) => feed.gather.presentKinds.length > 0);

  // The controls' own context, over every member whose rows can appear.
  const sourceKeys = new Set<string>();
  let anyFault = false;
  for (const id of memberIds) {
    for (const key of getTrainingLogSourceKeys(id)) sourceKeys.add(key);
    if (getActivityFaults(id).count > 0) anyFault = true;
  }
  // Manual first, then the rest alphabetically — a stable order across profiles and
  // as history grows, so the control does not reshuffle under the reader.
  const sourceOptions = [...sourceKeys]
    .sort((a, b) =>
      a === TRAINING_LOG_SOURCE_MANUAL
        ? -1
        : b === TRAINING_LOG_SOURCE_MANUAL
          ? 1
          : a.localeCompare(b)
    )
    .map((value) => ({ value, label: activityProvenanceKeyLabel(value) }));

  const writableProfileIds = memberIds.filter(
    (id) => scope.access.get(id) === "write"
  );
  const maxDates = Object.fromEntries(memberIds.map((id) => [id, today(id)]));
  const defaultTime = zonedDateParts(
    getTimezone(actingProfileId),
    new Date()
  ).hhmm;
  const subjectNames: Record<number, string> = {};
  if (everyone) {
    for (const profile of scope.profiles) {
      if (viewIds.includes(profile.id)) subjectNames[profile.id] = profile.name;
    }
  }

  const foldHref = (
    key: string,
    fold?: { open: boolean; descendants: readonly string[] }
  ): AppRoute =>
    trainingLogHref({
      ...query,
      day,
      everyone,
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
      open: toggledTimelineOpen(openFolds, key, fold),
    });

  // A VIEW NARROWED TO ONE KIND DRAWS NO GLYPH COLUMN (#4045 §3). Filtered to one
  // activity type every row wears the same glyph, which spends the leading column to
  // say nothing. Asked of the VIEW: an unfiltered Log is still every training kind.
  const showGlyphs = query.type == null;

  const daySection = (group: (typeof renderedDays)[number]) => (
    <section
      key={group.date}
      // The day group's own address. `trainingLogDayHref` names its day in the query
      // now, so nothing the app builds depends on this resolving — it is kept because
      // `#day-YYYY-MM-DD` links are already out in readers' bookmarks, and a rendered
      // day should still answer to the name it has always had.
      id={`day-${group.date}`}
      data-testid="training-log-day"
      className="scroll-mt-[calc(6rem+env(safe-area-inset-top))] pb-2 pt-1"
    >
      <h2 className="sticky top-edge-safe z-10 -mx-1 mb-1 bg-(--page) px-1 py-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {/* THE DAY IS A DOOR INTO DAY CONTEXT (#4079: "the same rows also appear in
            day context"). The destination is the shared record's day view, which is
            where a session sits beside everything else that happened that day. The
            separator is load-bearing: without it the cluster's textContent runs the
            date's last digit into the count's first. */}
        <DestinationLink
          href={historyHref({ day: group.date, everyone })}
          className="inline-flex items-baseline gap-2 hover:underline"
          data-testid="training-log-day-link"
        >
          <span>{formatLongDate(group.date, prefs)}</span>
          <span aria-hidden className="text-slate-500 dark:text-slate-400">
            —
          </span>
          <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
            {group.events.length} record
            {group.events.length === 1 ? "" : "s"}
          </span>
        </DestinationLink>
      </h2>
      <HistoryRows
        // No rollups: the rollup line collapses HIGH-FREQUENCY LOG kinds, and every
        // training kind is one of the rare events that rule exists to keep visible.
        rows={
          layoutHistoryDay(group.events as HistoryRow[], { rollup: false })
            .visible
        }
        writableProfileIds={writableProfileIds}
        doseItems={NO_DOSE_ITEMS}
        maxDates={maxDates}
        defaultTime={defaultTime}
        subjectNames={subjectNames}
        showGlyphs={showGlyphs}
      />
    </section>
  );

  return (
    <div data-testid="training-log">
      <TrainingLogFilterBar
        query={query}
        sourceOptions={sourceOptions}
        showFault={anyFault}
        hasHistory={hasHistory}
        day={day ? { date: day, label: formatLongDate(day, prefs) } : undefined}
        everyone={everyone}
        show={show === HISTORY_DEFAULT_SHOW ? undefined : show}
        initialCreateDate={initialCreateDate}
      />

      {rowCount === 0 ? (
        // "Nothing matches" and "nothing logged yet" are different states with
        // different exits, and only the second one should lead with the invitation.
        <EmptyState
          message={
            narrowed
              ? "No sessions match these filters."
              : "No training logged yet."
          }
        />
      ) : (
        <div data-testid="training-log-feed">
          {windowed.recent.map(daySection)}
          {/* READING ORDER, and the nesting: the recent band, then this year's month
              folds, then one card per earlier year — with an open fold's days rendered
              directly under their own card so a tap reveals content where it was
              tapped (#4045 §4). */}
          {windowed.months.map((fold) => (
            <Fragment key={fold.key}>
              <LogFoldCard fold={fold} href={foldHref(fold.key)} />
              {fold.open ? fold.days.map(daySection) : null}
            </Fragment>
          ))}
          {windowed.years.map((year) => (
            <Fragment key={year.key}>
              <LogFoldCard
                fold={year}
                href={foldHref(year.key, {
                  open: year.open,
                  descendants: year.months.map((month) => month.key),
                })}
              />
              {year.open
                ? year.months.map((month) => (
                    <Fragment key={month.key}>
                      <LogFoldCard
                        fold={month}
                        href={foldHref(month.key)}
                        nested
                      />
                      {month.open ? month.days.map(daySection) : null}
                    </Fragment>
                  ))
                : null}
            </Fragment>
          ))}
        </div>
      )}

      {/* OLDER · HISTORY › — the door that replaced the unlimited pager. The bound
          widens in one step while there is room under the substrate's ceiling; past
          it the record itself is the honest answer, because a Log that reads to the
          start of the ledger is the cost the bound exists to refuse. */}
      {hasMore && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {show < HISTORY_MAX_SHOW && (
            <Link
              className="btn-ghost btn-sm"
              data-testid="training-log-show-more"
              href={trainingLogHref({
                ...query,
                day,
                everyone,
                show: Math.min(show + HISTORY_SHOW_STEP, HISTORY_MAX_SHOW),
                open: [...openFolds].sort(),
              })}
            >
              Show more
            </Link>
          )}
          <DestinationLink
            href={historyHref({ family: "training", everyone })}
            className="text-sm text-link"
            data-testid="training-log-history-door"
          >
            Older · History
          </DestinationLink>
        </div>
      )}
    </div>
  );
}
