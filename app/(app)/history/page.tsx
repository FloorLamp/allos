import Link from "next/link";
import { IconChevronDown } from "@tabler/icons-react";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";
import Chip from "@/components/Chip";
import FilterPills from "@/components/FilterPills";
import JumpRailScrubber, {
  type ScrubberStop,
} from "@/components/JumpRailScrubber";
import DoseBackfillLauncher from "@/components/intake/DoseBackfillLauncher";
import type { DoseLedgerItem } from "@/components/intake/dose-ledger-entry";
import HistoryRows from "./HistoryRows";
import { requireScope } from "@/lib/scope";
import { today } from "@/lib/db";
import { zonedDateParts } from "@/lib/date";
import { getDisplayFormatPrefs, getTimezone } from "@/lib/settings";
import { getIntakeDoses, getIntakeItems } from "@/lib/queries";
import { isOnDemand } from "@/lib/intake-schedule";
import { formatLongDate } from "@/lib/format-date";
import { historyHref, type AppRoute } from "@/lib/hrefs";
import { historyMemberFeed } from "@/lib/history";
import {
  HISTORY_DEFAULT_SHOW,
  HISTORY_KIND_LABELS,
  HISTORY_LOG_KINDS,
  HISTORY_SHOW_STEP,
  clampHistoryDay,
  parseHistoryShow,
  resolveHistoryDoseClass,
  resolveHistoryFamily,
  resolveHistoryKind,
  type HistoryLogKind,
  type HistoryRow,
} from "@/lib/history-format";
import { mergeMemberTimelines } from "@/lib/timeline-multi";
import {
  parseTimelineOpen,
  renderedTimelineDays,
  timelineFoldCounts,
  toggledTimelineOpen,
  windowTimelineDays,
  type TimelineFold,
} from "@/lib/timeline-window";
import {
  SCRUBBER_GUTTER_CLASS,
  showTimelineScrubber,
  timelineScrubberTicks,
} from "@/lib/timeline-scrubber";

export const dynamic = "force-dynamic";

// `/history` — THE APP'S RECORD (issue #3958, phase 1).
//
// Every discrete thing a profile logged, day-grouped, newest first, correctable in
// place. It replaced the four standalone ledger routes — two dose doors, one for food
// and one for practices — which were four copies of one page differing only in which
// table they read, and which each answered "when" and "how much" in their own words.
// There are no redirects: those routes are gone and every door that pointed at one now
// points here, because a shim is a compatibility layer standing where a fixed call site
// should be. Their paths are deliberately not spelled anywhere in the tree, so
// `git grep` answering nothing IS the acceptance criterion.
//
// WHAT THIS FILE OWNS. The URL → read → render seam, and nothing about a domain: the
// row grammar is lib/history-format.ts's, the composers are lib/history.ts's, the
// folds and the rail are #2657's (shared verbatim with /timeline until phase 2 retires
// it), and every write is the domain's own Server Action reached through HistoryRows.
//
// THE CHROME BUDGET IS AN ACCEPTANCE CRITERION: ≤ ~140px above the first record at
// 390px. What buys that is stated so an addition has to name what it displaces — no
// h1/subtitle below `sm` (#1616/#1661: the nav already names the page), ONE filter row,
// NO range chrome at all (the record is navigated, not windowed), and day headers that
// stick rather than repeating a date on every row.
//
// A BAD DEEP LINK DEGRADES TO THE PAGE. Every parser here answers "or All": an unknown
// kind, a retired family, a future day. A record surface that 404s on a hand-edited
// URL is a record you cannot get back to.

// One collapsed period — a month of the current year, or an earlier year (#2657).
// Deliberately the same shape and the same `timeline-fold-` anchor id the timeline
// draws: the rail's stops are computed from those ids, and phase 2 moves that feed
// onto this page rather than reconciling two vocabularies.
function FoldCard({
  fold,
  href,
  gutter,
  nested = false,
}: {
  fold: TimelineFold<{ date: string; events: unknown[] }> & {
    monthCount?: number;
  };
  href: AppRoute;
  /** The rail's lane, when the rail renders — see the feed container's note. */
  gutter: string;
  nested?: boolean;
}) {
  return (
    <section
      id={`timeline-fold-${fold.key}`}
      data-testid={`history-fold-${fold.key}`}
      data-fold-key={fold.key}
      data-fold-open={fold.open ? "true" : "false"}
      className={`py-1.5 ${nested ? "pl-4" : ""} ${gutter}`}
    >
      <Link
        href={href}
        aria-expanded={fold.open}
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
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {timelineFoldCounts(fold)}
          </span>
        </span>
      </Link>
    </section>
  );
}

export default async function HistoryPage(props: {
  searchParams: Promise<{
    family?: string | string[];
    kind?: string | string[];
    class?: string | string[];
    item?: string | string[];
    media?: string | string[];
    day?: string | string[];
    view?: string | string[];
    open?: string | string[];
    show?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const todayStr = today(actingProfileId);
  const prefs = getDisplayFormatPrefs(loginId);

  // A kind IMPLIES its family, so `?family=` only matters when no kind is named. Phase
  // 1 ships the Logs family alone: a `?family=clinical` link written against phase 2
  // resolves, finds nothing of that family here, and falls back to All rather than
  // 404ing.
  const kind = resolveHistoryKind(searchParams.kind);
  const family = resolveHistoryFamily(searchParams.family);
  const doseClass = resolveHistoryDoseClass(searchParams.class);
  const rawItem = Array.isArray(searchParams.item)
    ? searchParams.item[0]
    : searchParams.item;
  const media =
    (Array.isArray(searchParams.media)
      ? searchParams.media[0]
      : searchParams.media) === "1";
  const day = clampHistoryDay(searchParams.day, todayStr);
  const show = parseHistoryShow(searchParams.show);
  const openFolds = parseTimelineOpen(searchParams.open);

  // THE HOUSEHOLD VIEW IS A DEEP-LINKED MODE, NOT A SWITCHER (#1463): the sidebar is
  // the one profile switcher on every page, so this costs the chrome budget nothing.
  // It composes the SAME per-profile gather once per member — which is what makes
  // every visibility rule (age gates, substance exclusions) inherited per row rather
  // than re-derived across a widened query.
  const everyone =
    (Array.isArray(searchParams.view)
      ? searchParams.view[0]
      : searchParams.view) === "everyone" && viewIds.length > 1;
  const memberIds = everyone ? viewIds : [actingProfileId];

  const feeds = memberIds.map((id) =>
    historyMemberFeed(id, {
      loginId,
      kind,
      doseClass,
      item: rawItem,
      media,
      day,
      limit: show,
    })
  );
  const presentKinds = HISTORY_LOG_KINDS.filter((candidate) =>
    feeds.some((feed) => feed.gather.presentKinds.includes(candidate))
  );
  const hasMedia = feeds.some((feed) =>
    feed.gather.rows.some((row) => row.media > 0)
  );

  // ONE grouping engine for one member and for five (#1329/#221). The within-day
  // order is its comparator's: instant descending, date-only rows sinking below timed
  // ones, and a same-instant tie-break on id — which is what makes the order
  // byte-stable when one usual-routine tap writes six rows in the same minute.
  const allDays = mergeMemberTimelines(feeds);
  const days = allDays.slice(0, undefined);

  // WINDOWING (#2657), except on the day view: a day IS the window, and folding it
  // would fold the surface's whole content away. There is no `ahead` fold to draw —
  // the gather already ends the record at now.
  const windowed = day ? null : windowTimelineDays(days, todayStr, openFolds);
  const renderedDays = windowed ? renderedTimelineDays(windowed) : days;

  // SWITCHING KIND DROPS WHAT BELONGED TO THE OLD ONE — the deleted ledger's rule
  // ("an item belongs to one kind, so carrying it across would leave a filter naming
  // nothing"), applied to both kind-scoped params. `class` is the DOSE two-door
  // pre-filter and means nothing on any other kind, so a chip that leaves doses must
  // not carry it: a row of chips whose "All" still says `class=medication` is a
  // control that does not do what it is called.
  const chipHref = (next: {
    kind?: HistoryLogKind;
    media?: boolean;
  }): AppRoute => {
    const nextKind = "kind" in next ? next.kind : kind;
    return historyHref({
      family: nextKind ? undefined : family,
      kind: nextKind,
      class: nextKind === "dose" ? doseClass : undefined,
      item: "kind" in next ? undefined : rawItem,
      media: next.media ?? media,
      day,
      everyone,
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });
  };

  const foldHref = (
    key: string,
    fold?: { open: boolean; descendants: readonly string[] },
    anchor?: string
  ): AppRoute => {
    const base = historyHref({
      family: kind ? undefined : family,
      kind,
      class: doseClass,
      item: rawItem,
      media,
      day,
      everyone,
      open: toggledTimelineOpen(openFolds, key, fold),
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });
    return anchor ? (`${base}#${anchor}` as AppRoute) : base;
  };

  // THE JUMP RAIL (#2657 item 4) — stops derived from what THIS render put in the
  // document, so a month sealed inside a collapsed year never gets a tick the scroll
  // cannot keep. It owns a lane: `SCRUBBER_GUTTER_CLASS` is the rail's intrusion into
  // the content column, applied to every surface underneath it, so the strip never
  // overlays a row's action column.
  const ticks = windowed ? timelineScrubberTicks(windowed) : [];
  const stops: ScrubberStop[] = showTimelineScrubber(ticks)
    ? ticks.map((tick) => ({
        ...tick,
        href: tick.openKey
          ? foldHref(tick.openKey, undefined, tick.anchorId)
          : null,
      }))
    : [];
  const railGutter = stops.length > 0 ? SCRUBBER_GUTTER_CLASS : "";

  // The dose form's vocabulary, read once for the whole page: which items exist (an
  // item retired since the dose was taken still took it, so history keeps listing it)
  // and which of them still have a live dose to log against.
  const allItems = getIntakeItems(actingProfileId);
  const dosesByItem = new Map<
    number,
    { id: number; amount: string | null; time_of_day: string | null }[]
  >();
  for (const dose of getIntakeDoses(actingProfileId)) {
    const list = dosesByItem.get(dose.item_id) ?? [];
    list.push({
      id: dose.id,
      amount: dose.amount,
      time_of_day: dose.time_of_day,
    });
    dosesByItem.set(dose.item_id, list);
  }
  const doseItems: DoseLedgerItem[] = allItems.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    product: item.product,
    asNeeded: isOnDemand(item),
    doses: dosesByItem.get(item.id) ?? [],
  }));
  const loggable = doseItems.filter((item) => item.doses.length > 0);
  const canWrite = scope.access.get(actingProfileId) === "write";
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

  const rowCount = renderedDays.reduce((n, d) => n + d.events.length, 0);
  const hasMore = feeds.some((feed) => feed.gather.hasMore);

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="history-page"
    >
      <PageHeader
        title="History"
        subtitle="Everything recorded, newest first."
        compactBelowSm
        className={railGutter}
      />

      {/* ONE FILTER ROW, AND IT IS ONE LINE. Kind chips on the shared responsive
          pill group (#3938's control box, phone-scroll / `sm`-wrap), data-presence
          earned so an empty category never advertises itself, plus the Photos toggle
          behind a hairline — a cross-cutting filter, never a renderer switch. No
          counts on chips: the day headers count. A WRAPPING row was the first thing
          that blew the chrome budget here, which is why the kinds scroll and the
          toggle is pinned outside the scroller rather than wrapping under it.

          Phase 1 renders the Logs family's KIND row directly rather than a family row
          that would hold one entry; `?family=` still resolves.

          `gap-3` on both control rows, which is the gap `FilterPills` already spends
          between its own pills: the reach a coarse pointer gets around a 34px box is
          (44 - 34) / 2 per side, so two adjacent extended targets need TWICE that
          between them, and #3938 made `gap-3` the one gap every pill layout uses.
          MEASURED HONESTLY: `gap-2` here also cleared the floor, because the hairline
          divider sits between the two clusters and is itself gapped on both sides —
          so this is agreement with the shared row, not a defect that was found. */}
      <div
        className={`mb-3 flex items-center gap-3 ${railGutter}`}
        data-testid="history-filters"
      >
        <div className="min-w-0 flex-1">
          <FilterPills
            mode="link"
            layout="responsive"
            linkBehavior="timeline"
            label="Filter the record by kind"
            value={kind ?? null}
            testId="history-kind-pills"
            options={[
              {
                value: null,
                label: "All",
                href: chipHref({ kind: undefined }),
                testId: "history-chip-all",
              },
              ...presentKinds.map((candidate) => ({
                value: candidate as HistoryLogKind | null,
                label: HISTORY_KIND_LABELS[candidate],
                href: chipHref({ kind: candidate }),
                testId: `history-chip-${candidate}`,
              })),
            ]}
          />
        </div>
        {hasMedia || media ? (
          <>
            <span
              aria-hidden
              className="h-5 w-px shrink-0 bg-black/10 dark:bg-white/10"
            />
            <span className="shrink-0">
              <Chip
                role="filter"
                href={chipHref({ media: !media })}
                current={media}
                linkBehavior="timeline"
                testId="history-chip-media"
              >
                Photos
              </Chip>
            </span>
          </>
        ) : null}
      </div>

      {/* THE ADD DOOR, KIND-RESOLVED, ON ONE LINE. Filtered to a kind it IS that
          kind's backfill; in All it asks the kind first, which on a record page is
          the same act as narrowing to it. Log kinds only — clinical, training and
          life records are created on their own surfaces — and never the future:
          every door here is bounded by today. It scrolls rather than wraps for the
          same reason the filter row does. */}
      {canWrite ? (
        <div
          className={`-mx-2 mb-2 flex items-center gap-3 overflow-x-auto px-2 pb-1 text-sm sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 ${railGutter}`}
          data-testid="history-add"
        >
          {kind === "dose" && loggable.length > 0 ? (
            <DoseBackfillLauncher
              loggable={loggable}
              maxDate={todayStr}
              defaultTime={defaultTime}
            />
          ) : kind === "food" ? (
            <Link className="btn btn-sm" href={`/nutrition?date=${todayStr}`}>
              Log food
            </Link>
          ) : kind === "practice" ? (
            <Link className="btn btn-sm" href={`/wellness?log=${todayStr}`}>
              Log a practice
            </Link>
          ) : kind === "substance" ? (
            <Link
              className="btn btn-sm"
              href="/records/specialty/substance-use"
            >
              Log a use
            </Link>
          ) : kind === "body" ? (
            <Link className="btn btn-sm" href="/trends/metric/weight">
              Log a reading
            </Link>
          ) : (
            <>
              <span className="shrink-0 text-slate-500 dark:text-slate-400">
                Add past
              </span>
              {(presentKinds.length > 0 ? presentKinds : HISTORY_LOG_KINDS).map(
                (candidate) => (
                  <Link
                    key={candidate}
                    className="btn-ghost btn-sm shrink-0"
                    href={chipHref({ kind: candidate })}
                    data-testid={`history-add-${candidate}`}
                  >
                    {HISTORY_KIND_LABELS[candidate]}
                  </Link>
                )
              )}
            </>
          )}
        </div>
      ) : null}

      {rowCount === 0 ? (
        <EmptyState
          message={
            kind || media || day
              ? "Nothing recorded here yet."
              : "Nothing recorded yet. Anything logged shows up here."
          }
        />
      ) : null}

      {/* THE FEED CONTAINER TAKES NO RAIL GUTTER, and that is the #3920 shape rather
          than an oversight: below `sm` the row band is FULL-BLEED, so a gutter on its
          container would stop the fill reaching the edge and leave a 28px strip of
          page beside it. The rail's lane is spent by the row CONTENT and by the day
          headers instead — "the band fill stays full-bleed while row content ends
          short of the edge". */}
      <div data-testid="history-feed">
        {renderedDays.map((group) => (
          <section
            key={group.date}
            id={`timeline-day-${group.date}`}
            data-testid="history-day"
            className="scroll-mt-24 pb-2 pt-1"
          >
            {/* THE DAY HEADER STICKS, and it is the whole "which day am I in"
                affordance — there is no per-row date cell, which is most of what the
                one-line row buys. It taps into the day view (phase 2 renders that
                presentation; the link is already the real one). */}
            <h2 className="sticky top-0 z-10 -mx-1 mb-1 flex items-baseline gap-2 bg-(--page) px-1 py-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <Link
                href={historyHref({ day: group.date, everyone })}
                className="hover:underline"
                data-testid="history-day-link"
              >
                {formatLongDate(group.date, prefs)}
              </Link>
              <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                {group.events.length} record
                {group.events.length === 1 ? "" : "s"}
              </span>
            </h2>
            <HistoryRows
              rows={group.events as HistoryRow[]}
              actingProfileId={actingProfileId}
              canWrite={canWrite}
              doseItems={doseItems}
              maxDate={todayStr}
              defaultTime={defaultTime}
              subjectNames={subjectNames}
              rowClassName={railGutter}
            />
          </section>
        ))}
        {/* READING ORDER: the recent band first, then this year's older months, then
            one card per earlier year. A fold card above the days would put a stack of
            shut doors between the reader and their own recent history, which is the
            defect #2657 exists to prevent — and it would spend the chrome budget on
            content nobody asked to see. */}
        {windowed?.months.map((fold) => (
          <FoldCard
            key={fold.key}
            fold={fold}
            gutter={railGutter}
            href={foldHref(fold.key)}
          />
        ))}
        {windowed?.years.map((year) => (
          <div key={year.key}>
            <FoldCard
              fold={year}
              gutter={railGutter}
              href={foldHref(year.key, {
                open: year.open,
                descendants: year.months.map((month) => month.key),
              })}
            />
            {year.open
              ? year.months.map((month) => (
                  <FoldCard
                    key={month.key}
                    fold={month}
                    gutter={railGutter}
                    href={foldHref(month.key)}
                    nested
                  />
                ))
              : null}
          </div>
        ))}
      </div>

      {hasMore ? (
        <div className={`mt-4 ${railGutter}`}>
          <Link
            className="btn-ghost btn-sm"
            data-testid="history-load-more"
            href={historyHref({
              family: kind ? undefined : family,
              kind,
              class: doseClass,
              item: rawItem,
              media,
              day,
              everyone,
              open: [...openFolds],
              show: show + HISTORY_SHOW_STEP,
            })}
          >
            Load more
          </Link>
        </div>
      ) : null}

      {stops.length > 0 ? <JumpRailScrubber stops={stops} /> : null}
    </PageContainer>
  );
}
