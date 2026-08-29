import Link from "next/link";
import { IconChevronDown } from "@tabler/icons-react";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";
import Chip from "@/components/Chip";
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
      data-testid={`history-fold-${fold.key}`}
      data-fold-key={fold.key}
      data-fold-open={fold.open ? "true" : "false"}
      className={`py-1.5 ${nested ? "pl-4" : ""}`}
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

  const chipHref = (next: {
    kind?: HistoryLogKind;
    media?: boolean;
  }): AppRoute =>
    historyHref({
      family: next.kind ? undefined : family,
      kind: "kind" in next ? next.kind : kind,
      class: doseClass,
      item: "kind" in next ? undefined : rawItem,
      media: next.media ?? media,
      day,
      everyone,
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });

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
  const subjectNames: Record<number, string> = {};
  if (everyone) {
    for (const profile of scope.profiles) {
      if (viewIds.includes(profile.id)) subjectNames[profile.id] = profile.name;
    }
  }

  const rowCount = renderedDays.reduce((n, d) => n + d.events.length, 0);
  const hasMore = feeds.some((feed) => feed.gather.hasMore);

  return (
    <PageContainer width="reading" className="mx-auto">
      <PageHeader
        title="History"
        subtitle="Everything you recorded, newest first."
        compactBelowSm
        className={railGutter}
      />

      {/* ONE FILTER ROW. Kind chips, data-presence-earned so an empty category never
          advertises itself, plus the Photos toggle behind a hairline — a cross-cutting
          filter, never a renderer switch. No counts on chips: the day headers count.
          Phase 1 renders the Logs family's kind row directly rather than a family row
          that would hold one entry; the `?family=` param still resolves. */}
      <div
        className={`mb-3 flex flex-wrap items-center gap-1.5 ${railGutter}`}
        data-testid="history-filters"
      >
        <Chip
          role="filter"
          href={chipHref({ kind: undefined })}
          current={kind == null}
          linkBehavior="timeline"
          testId="history-chip-all"
        >
          All
        </Chip>
        {presentKinds.map((candidate) => (
          <Chip
            key={candidate}
            role="filter"
            href={chipHref({ kind: candidate })}
            current={kind === candidate}
            linkBehavior="timeline"
            testId={`history-chip-${candidate}`}
          >
            {HISTORY_KIND_LABELS[candidate]}
          </Chip>
        ))}
        {hasMedia || media ? (
          <>
            <span
              aria-hidden
              className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10"
            />
            <Chip
              role="filter"
              href={chipHref({ media: !media })}
              current={media}
              linkBehavior="timeline"
              testId="history-chip-media"
            >
              Photos
            </Chip>
          </>
        ) : null}
      </div>

      {/* THE ADD DOOR, KIND-RESOLVED. Filtered to a kind it IS that kind's backfill;
          in All it asks the kind first, which on a record page is the same act as
          narrowing to it. Log kinds only — clinical, training and life records are
          created on their own surfaces — and never the future: every door below is
          bounded by today. */}
      {canWrite ? (
        <div
          className={`mb-4 flex flex-wrap items-center gap-2 text-sm ${railGutter}`}
          data-testid="history-add"
        >
          {kind === "dose" && loggable.length > 0 ? (
            <DoseBackfillLauncher
              loggable={loggable}
              maxDate={todayStr}
              defaultTime={
                zonedDateParts(getTimezone(actingProfileId), new Date()).hhmm
              }
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
              <span className="text-slate-500 dark:text-slate-400">
                Add past entry
              </span>
              {(presentKinds.length > 0 ? presentKinds : HISTORY_LOG_KINDS).map(
                (candidate) => (
                  <Link
                    key={candidate}
                    className="btn-ghost btn-sm"
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
              : "Nothing recorded yet. Anything you log shows up here."
          }
        />
      ) : null}

      <div className={railGutter} data-testid="history-feed">
        {windowed?.months.map((fold) => (
          <FoldCard key={fold.key} fold={fold} href={foldHref(fold.key)} />
        ))}
        {renderedDays.map((group) => (
          <section
            key={group.date}
            id={`timeline-day-${group.date}`}
            data-testid="history-day"
            className="scroll-mt-24 py-2"
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
              defaultTime={
                zonedDateParts(getTimezone(actingProfileId), new Date()).hhmm
              }
              subjectNames={subjectNames}
            />
          </section>
        ))}
        {windowed?.years.map((year) => (
          <div key={year.key}>
            <FoldCard
              fold={year}
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
