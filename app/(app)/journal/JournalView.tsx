"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconX,
  IconAlertTriangle,
  IconBolt,
  IconPlus,
  IconRepeat,
  IconSearch,
} from "@tabler/icons-react";
import type { ActivityType, Goal, Sex } from "@/lib/types";
import type {
  CardioStat,
  ExerciseStat,
  GoalProgress,
  SportStat,
} from "@/lib/queries";
import type { UnitPrefs } from "@/lib/settings";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { exerciseHistoryKey, regionForExercise } from "@/lib/lifts";
import { PageHeader, EmptyState } from "@/components/ui";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import MobileDetailPage from "@/components/MobileDetailPage";
import ExerciseDetailPanel from "@/components/ExerciseDetailPanel";
import CardioDetailPanel from "@/components/CardioDetailPanel";
import SportDetailPanel from "@/components/SportDetailPanel";
import JournalCard from "./JournalCard";
import type { MergeSibling } from "./ActivityCardMenu";
import { detectFieldConflicts } from "@/lib/import-review/conflicts";
import { loadJournalPage } from "./actions";
import ActiveDaysStrip from "@/components/ActiveDaysStrip";
import type { ActiveDaysStrip as ActiveDaysStripData } from "@/lib/workout-heatmap";

// JournalCardData / DayGroup moved to lib/journal-card.ts (issue #334), built by the
// pure buildJournalCards. Re-exported so existing `../journal/JournalView` importers
// (HistorySection) keep their paths.
import type { JournalCardData, DayGroup } from "@/lib/journal-card";
import { appendDayGroups, reconcileJournalPaging } from "@/lib/journal-card";
export type { JournalCardData, DayGroup };

export interface TargetChip {
  label: string;
  count: number;
  perWeek: number;
  met: boolean;
}
export interface WeekSummary {
  sessions: number;
  activeDays: number;
  streak: number;
  targets: TargetChip[];
}

// Shared with the strength page; re-exported here for existing importers.
import type { RecentByExercise } from "@/lib/queries";
export type { RecentByExercise };

type Detail =
  | { kind: "exercise"; name: string }
  | { kind: "cardio"; name: string }
  | { kind: "sport"; name: string }
  | null;

const TYPE_FILTERS: { value: "all" | ActivityType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "strength", label: "Strength" },
  { value: "cardio", label: "Cardio" },
  { value: "sport", label: "Sport" },
];

const JOURNAL_DESKTOP_QUERY = "(min-width: 1280px)";

export default function JournalView({
  groups: initialGroups,
  initialCursor = null,
  exerciseStats,
  cardioStats,
  sportStats,
  goals,
  goalProgress,
  bodyweightKg,
  units,
  weekSummary,
  activeDaysStrip,
  recentByExercise,
  showHeader = true,
  showWeeklyTargets = true,
  sex,
}: {
  // The NEWEST page of day groups, refreshed by the server on every auto-save (issue
  // #451). Older windows are fetched on demand and held in local state below.
  groups: DayGroup[];
  // Cursor (oldest-date-of-first-page) for fetching the next-older page, or null when
  // the first page already covers the whole history.
  initialCursor?: string | null;
  exerciseStats: ExerciseStat[];
  cardioStats: CardioStat[];
  sportStats: SportStat[];
  goals: Goal[];
  goalProgress: Record<number, GoalProgress>;
  bodyweightKg: number | null;
  units: UnitPrefs;
  weekSummary: WeekSummary;
  activeDaysStrip: ActiveDaysStripData;
  recentByExercise: RecentByExercise;
  showHeader?: boolean;
  showWeeklyTargets?: boolean;
  // Profile sex, so the exercise detail's strength standards use the right chart.
  sex?: Sex | null;
}) {
  const {
    open,
    openCreate,
    openLive,
    openRepeat,
    close,
    registerDock,
    canStartWorkout,
  } = useActivityEditor();
  const dockRef = useRef<HTMLDivElement | null>(null);

  // ---- Server-paged feed (issue #451) ----
  // `initialGroups` is the newest page (refreshed by the server on every auto-save);
  // older windows are fetched on demand into `olderGroups`. The rendered feed is the
  // two merged + deduped, so a first-page refresh after an edit stays live while any
  // loaded older pages persist. (An edit to a card that lives ONLY in an older page
  // won't refresh until reload — an accepted edge: edits target the recent/selected
  // cards, which are on page one.)
  const [olderGroups, setOlderGroups] = useState<DayGroup[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const groups = useMemo(
    () => appendDayGroups(initialGroups, olderGroups),
    [initialGroups, olderGroups]
  );

  // Refs mirror the latest values so the deep-link auto-load loop reads fresh state
  // inside its async iterations (a render-time closure would go stale mid-load).
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const olderGroupsRef = useRef(olderGroups);
  olderGroupsRef.current = olderGroups;
  const fetchingRef = useRef(false);

  // Re-sync pagination when the server's first-page cursor shifts (issue #503). The
  // server refreshes `initialGroups`/`initialCursor` on every auto-save; when the
  // newest window moves (a new day rolls in and pushes the oldest loaded day out of
  // the first page), `initialCursor` changes but the local `cursor` — seeded only at
  // mount — kept pointing at the OLD boundary, so "Load more" fetched `date <
  // oldBoundary` and permanently skipped the rolled-out day. Reset the cursor to the
  // new boundary and drop loaded older pages (their nextBefore chain spans the invalid
  // gap) so paging resumes from the fresh first page. Refs are updated synchronously
  // too so the deep-link auto-load loop reads the reset state immediately.
  const seededCursorRef = useRef(initialCursor);
  useEffect(() => {
    const { changed, cursor: nextCursor } = reconcileJournalPaging(
      seededCursorRef.current,
      initialCursor
    );
    if (!changed) return;
    seededCursorRef.current = initialCursor;
    olderGroupsRef.current = [];
    cursorRef.current = nextCursor;
    setOlderGroups([]);
    setCursor(nextCursor);
  }, [initialCursor]);

  // Fetch the next-older page from the server and append it. Returns false when there
  // is nothing more to fetch, or a fetch is already in flight — so a caller/loop stops.
  const fetchNextPage = useCallback(async (): Promise<boolean> => {
    if (fetchingRef.current) return false;
    const before = cursorRef.current;
    if (before == null) return false;
    fetchingRef.current = true;
    try {
      const res = await loadJournalPage(before);
      const nextOlder = appendDayGroups(olderGroupsRef.current, res.groups);
      olderGroupsRef.current = nextOlder;
      cursorRef.current = res.nextBefore;
      setOlderGroups(nextOlder);
      setCursor(res.nextBefore);
      return true;
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  // The most recent logged activity (groups arrive newest-first, cards ordered
  // within a day) — the source for the header's one-tap "Repeat last" (issue
  // #29). null when nothing's been logged yet, which hides the button.
  const lastActivity = groups[0]?.cards[0]?.activity ?? null;

  // The dock is a desktop concept: it exists so the editor can live beside the
  // feed in the two-column layout. Below xl there is no second column — the
  // provider falls back to ActivityOverlay, so the editor looks and behaves the
  // same as on every other page. The Journal needs xl width for two usable
  // columns. (Crossing the breakpoint mid-edit closes the
  // editor; any pending auto-save is flushed on unmount.)
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(JOURNAL_DESKTOP_QUERY);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Lend the editor this column so create/edit auto-saves inline here instead of
  // popping the centered modal. Only ever register a real dock: passing null
  // means "the dock went away" and closes the editor — running that on a mount
  // where isDesktop hasn't settled yet (it starts false) would force-close an editor
  // that survived navigation as the overlay.
  useEffect(() => {
    if (!isDesktop) return;
    registerDock(dockRef.current);
    return () => registerDock(null);
  }, [registerDock, isDesktop]);

  const [typeFilter, setTypeFilter] = useState<"all" | ActivityType>("all");
  const [query, setQuery] = useState("");
  // Show only rows the editor can't re-save as-is (imports, legacy data). The
  // toggle only exists while such rows do — see `faultCount` below.
  const [faultOnly, setFaultOnly] = useState(false);
  // Filter the feed to a muscle/region by clicking a badge in the detail panel.
  const [tagFilter, setTagFilter] = useState<{
    kind: "muscle" | "region";
    value: string;
  } | null>(null);
  const [visibleDays, setVisibleDays] = useState(14);
  const [detail, setDetail] = useState<Detail>(null);

  // How many rows across the whole feed can't be saved as-is. Drives both the
  // toggle's visibility and its badge.
  const faultCount = useMemo(
    () => groups.reduce((n, g) => n + g.cards.filter((c) => c.fault).length, 0),
    [groups]
  );
  // Derive rather than reset via an effect: when the last faulty row is fixed
  // the toggle vanishes (faultCount → 0), and the filter must stop applying in
  // the same render — an effect would leave one frame where the feed filters to
  // an empty list before the reset lands.
  const faultOnlyActive = faultOnly && faultCount > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        cards: g.cards.filter((c) => {
          if (faultOnlyActive && !c.fault) return false;
          if (typeFilter !== "all" && c.activity.type !== typeFilter)
            return false;
          if (
            tagFilter &&
            !c.parts.some(
              (p) =>
                p.kind === "strength" &&
                (tagFilter.kind === "muscle"
                  ? p.muscle === tagFilter.value
                  : regionForExercise(p.name) === tagFilter.value)
            )
          )
            return false;
          if (!q) return true;
          if (c.activity.title.toLowerCase().includes(q)) return true;
          return c.parts.some((p) => p.name.toLowerCase().includes(q));
        }),
      }))
      .filter((g) => g.cards.length > 0);
  }, [groups, typeFilter, query, tagFilter, faultOnlyActive]);

  const shown = filtered.slice(0, visibleDays);

  // "Load more" pages the feed (issue #451): first reveal any already-loaded days
  // beyond the client window, then fetch the next-older window from the server.
  const hasMoreLoaded = filtered.length > visibleDays;
  const canFetchMore = cursor != null;
  const filtersActive =
    query.trim() !== "" ||
    typeFilter !== "all" ||
    tagFilter != null ||
    faultOnlyActive;
  async function handleLoadMore() {
    if (hasMoreLoaded) {
      setVisibleDays((v) => v + 14);
      return;
    }
    if (canFetchMore && !loadingMore) {
      setLoadingMore(true);
      try {
        await fetchNextPage();
        setVisibleDays((v) => v + 14);
      } finally {
        setLoadingMore(false);
      }
    }
  }
  const loadMoreButton = (
    <button
      type="button"
      onClick={handleLoadMore}
      disabled={loadingMore}
      data-testid="journal-load-more"
      className="btn-ghost w-full"
    >
      {loadingMore ? "Loading…" : "Load more"}
    </button>
  );
  // Honest search scope (issue #451): filters/search run over LOADED activities only,
  // so when older windows remain unfetched we say so rather than silently capping.
  const searchScopeNote = filtersActive && canFetchMore && (
    <p className="text-center text-xs text-slate-400 dark:text-slate-500">
      Only loaded activities are searched — load older days to widen the search.
    </p>
  );

  // Manual-merge targets per day (issue #64): all same-day activities keyed by date,
  // from the UNFILTERED groups so a type/search filter can't hide a legitimate
  // duplicate from the merge picker. Each card's own id is excluded at render.
  // Carries each row's provenance label + fold values so the conflict preview
  // (issue #100) can be computed per keeper/sibling pair at render.
  const mergeTargetsByDate = useMemo(() => {
    const m = new Map<
      string,
      {
        id: number;
        title: string;
        sourceLabel: string;
        foldValues: Record<string, unknown>;
        setCount: number;
      }[]
    >();
    for (const g of groups) {
      m.set(
        g.date,
        g.cards.map((c) => ({
          id: c.activity.id,
          title: c.activity.title,
          sourceLabel: c.provenance.label,
          foldValues: c.foldValues,
          setCount: c.activity.sets?.length ?? 0,
        }))
      );
    }
    return m;
  }, [groups]);

  // Workout-history deep links can target a day or specific activity. A
  // day older than the visible window (or hidden by a filter) wouldn't be in the
  // DOM, so on hash navigation: clear filters, expand the window to include it,
  // then scroll once it has rendered.
  // pendingScroll holds the full target element id (e.g. "day-2026-06-27" or
  // "activity-42") to scroll to once it has rendered.
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  // Hash-driven jumps are for actual navigations (deep link, calendar click) —
  // not re-renders. `groups` refreshes on every auto-save, and re-jumping to
  // the hash the scroll-spy just wrote would yank the feed around while the
  // user types in the editor. Track the last hash acted on (the scroll-spy
  // marks its own writes below) and only jump when it truly changes.
  const handledHashRef = useRef<string | null>(null);
  useEffect(() => {
    const handleHash = async () => {
      const hash = window.location.hash;
      if (hash === handledHashRef.current) return;
      handledHashRef.current = hash;
      const mDay = hash.match(/^#day-(\d{4}-\d{2}-\d{2})$/);
      const mAct = hash.match(/^#activity-(\d+)$/);
      if (!mDay && !mAct) return;
      const actId = mAct ? Number(mAct[1]) : null;

      // The target day/activity may live below the loaded window now that the feed
      // pages in older history server-side (issue #451). Load older pages until the
      // target is present, or we've paged past it, or the history is exhausted — so
      // a deep link from the calendar / a trend / the timeline still lands.
      const reached = () => {
        const gs = groupsRef.current;
        if (mDay) {
          const present = gs.some((g) => g.date === mDay[1]);
          const passed = gs.length > 0 && gs[gs.length - 1].date < mDay[1];
          return present || passed;
        }
        return gs.some((g) => g.cards.some((c) => c.activity.id === actId));
      };
      while (!reached() && cursorRef.current != null) {
        // Sequential by design — each page narrows the search for the target.
        // eslint-disable-next-line no-await-in-loop
        const ok = await fetchNextPage();
        if (!ok) break;
      }

      const gs = groupsRef.current;
      let targetDate: string | null = null;
      let elementId: string | null = null;
      if (mDay) {
        targetDate = mDay[1];
        elementId = `day-${mDay[1]}`;
      } else {
        const g = gs.find((gr) =>
          gr.cards.some((c) => c.activity.id === actId)
        );
        if (!g) return;
        targetDate = g.date;
        elementId = `activity-${actId}`;
      }
      const idx = gs.findIndex((g) => g.date === targetDate);
      if (idx < 0) return;
      setTypeFilter("all");
      setQuery("");
      setTagFilter(null);
      // Clear the fault filter too, else navigating to a non-fault day/activity
      // would leave the target filtered out and the scroll would never land.
      setFaultOnly(false);
      // +8 so a few days render past the target and it can scroll near the top
      // rather than sticking to the bottom as the last rendered day.
      setVisibleDays((v) => Math.max(v, idx + 9));
      setPendingScroll(elementId);
    };
    void handleHash();
    const onHashChange = () => void handleHash();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [groups, fetchNextPage]);

  useEffect(() => {
    if (!pendingScroll) return;
    const el = document.getElementById(pendingScroll);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingScroll(null);
    }
  }, [pendingScroll, shown]);

  // Scroll-spy: reflect the day section currently at the top of the feed in the
  // URL hash. replaceState avoids both history spam and firing hashchange (which
  // would re-trigger the jump handler).
  useEffect(() => {
    const update = () => {
      const sections = document.querySelectorAll<HTMLElement>(
        'section[id^="day-"]'
      );
      if (sections.length === 0) return;
      let activeId = sections[0].id;
      for (const sec of Array.from(sections)) {
        if (sec.getBoundingClientRect().top <= 80) activeId = sec.id;
        else break; // sections are in date order, top to bottom
      }
      if (`#${activeId}` !== window.location.hash) {
        // Ours — the jump handler must not treat it as a navigation.
        handledHashRef.current = `#${activeId}`;
        history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}#${activeId}`
        );
      }
    };
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  const selectedStat =
    detail?.kind === "exercise"
      ? (exerciseStats.find((e) => e.exercise === detail.name) ?? null)
      : null;
  const selectedCardio =
    detail?.kind === "cardio"
      ? (cardioStats.find(
          (c) => c.activity.toLowerCase() === detail.name.toLowerCase()
        ) ?? null)
      : null;
  const selectedSport =
    detail?.kind === "sport"
      ? (sportStats.find(
          (s) => s.sport.toLowerCase() === detail.name.toLowerCase()
        ) ?? null)
      : null;

  // On mobile the detail takes over the screen (MobileDetailPage) instead of
  // rendering in the (hidden) desktop column.
  const [detailOpen, setDetailOpen] = useState(false);
  function dismissPanel() {
    // The auto-saving editor shares this column, so dismissing the panel must
    // close it too — otherwise it would sit on top of whatever comes next.
    if (open) close();
    setDetail(null);
    setDetailOpen(false);
  }
  // Showing a detail closes any open (auto-saving) editor, which shares the
  // desktop column — otherwise the form would sit on top of the detail.
  function showDetail(kind: "exercise" | "cardio" | "sport", name: string) {
    if (open) close();
    setDetail({ kind, name });
    if (
      typeof window !== "undefined" &&
      !window.matchMedia(JOURNAL_DESKTOP_QUERY).matches
    )
      setDetailOpen(true);
  }

  // Desktop-only ✕ inside the panel header; the mobile detail page has its own.
  const closeDetailButton = (
    <button
      type="button"
      onClick={dismissPanel}
      aria-label="Close details"
      className="hidden text-slate-400 hover:text-slate-600 xl:block dark:text-slate-500 dark:hover:text-slate-300"
    >
      <IconX className="h-4 w-4" />
    </button>
  );

  // The active detail panel — rendered in the desktop column (in a card) and
  // in the mobile full-page detail (bare; the page provides the chrome).
  const detailPanel = selectedStat ? (
    <ExerciseDetailPanel
      stat={selectedStat}
      bodyweightKg={bodyweightKg}
      units={units}
      goals={goals}
      goalProgress={goalProgress}
      recent={recentByExercise[exerciseHistoryKey(selectedStat.exercise)]}
      onFilterTag={(kind, value) => setTagFilter({ kind, value })}
      headerRight={closeDetailButton}
      sex={sex}
    />
  ) : selectedCardio ? (
    <CardioDetailPanel
      stat={selectedCardio}
      units={units}
      headerRight={closeDetailButton}
    />
  ) : selectedSport ? (
    <SportDetailPanel stat={selectedSport} headerRight={closeDetailButton} />
  ) : detail?.kind === "exercise" ? (
    <p className="text-sm text-slate-500 dark:text-slate-400">
      No progression data for {detail.name} yet — log it with weight and reps to
      see its trend.
    </p>
  ) : detail?.kind === "cardio" || detail?.kind === "sport" ? (
    <p className="text-sm text-slate-500 dark:text-slate-400">
      No trend data for {detail.name} yet — log a couple of sessions to see its
      trends and records.
    </p>
  ) : null;

  return (
    <div>
      {showHeader && (
        <PageHeader
          title="Journal"
          // The week summary stands in for a static tagline — a compact strip.
          subtitle={
            <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span>
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {weekSummary.sessions}
                </span>{" "}
                session{weekSummary.sessions === 1 ? "" : "s"} this week
              </span>
              <span aria-hidden className="text-slate-300 dark:text-slate-600">
                ·
              </span>
              <span>
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {weekSummary.activeDays}/7
                </span>{" "}
                days active
              </span>
              <span aria-hidden className="text-slate-300 dark:text-slate-600">
                ·
              </span>
              <span>
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {weekSummary.streak}
                </span>
                -day streak
              </span>
            </span>
          }
        />
      )}

      {/* Routine progress and a compact, literal trailing-14-day cadence strip. */}
      {showWeeklyTargets && (
        <div
          data-testid="journal-routine-row"
          className="mb-5 space-y-3 xl:flex xl:items-center xl:gap-5 xl:space-y-0"
        >
          {weekSummary.targets.length > 0 && (
            <div className="lg:flex lg:min-w-0 lg:items-center lg:gap-3">
              <h2 className="mb-1.5 shrink-0 text-xs font-semibold tracking-wide text-slate-400 uppercase lg:mb-0 dark:text-slate-500">
                Weekly routine
              </h2>
              <WeeklyTargets targets={weekSummary.targets} />
            </div>
          )}
          <ActiveDaysStrip data={activeDaysStrip} />
        </div>
      )}

      {/* Controls */}
      <div
        data-testid="journal-controls"
        className="mb-4 grid gap-2 lg:grid-cols-[minmax(12rem,1fr)_auto]"
      >
        <div className="relative min-w-48 lg:col-start-1 lg:row-start-1">
          <IconSearch
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            stroke={2}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search activities or exercises…"
            className="input appearance-none bg-white pr-10 pl-9 [&::-webkit-search-cancel-button]:appearance-none dark:bg-ink-900"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-1 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-slate-300"
            >
              <IconX className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:col-span-2 lg:row-start-2">
          <div
            role="group"
            aria-label="Activity type"
            className="inline-flex overflow-hidden rounded-lg border border-black/10 bg-white divide-x divide-black/10 dark:border-white/10 dark:bg-ink-900 dark:divide-white/10"
          >
            {TYPE_FILTERS.map((f) => {
              const active = typeFilter === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setTypeFilter(f.value)}
                  aria-pressed={active}
                  className={`px-3 py-1.5 text-sm font-medium transition ${
                    active
                      ? "bg-brand-500 text-white"
                      : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-ink-800"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          {/* Only shown while some row can't be saved as-is; disappears once the
              last one is fixed (faultCount → 0, which also clears the toggle). */}
          {faultCount > 0 && (
            <button
              type="button"
              onClick={() => setFaultOnly((v) => !v)}
              aria-pressed={faultOnly}
              title="Show only rows that can't be saved as-is"
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition ${
                faultOnly
                  ? "border-rose-500 bg-rose-500 text-white"
                  : "border-rose-300 bg-white text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:bg-ink-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
              }`}
            >
              <IconAlertTriangle className="h-4 w-4" stroke={2} />
              Can’t be saved
              <span
                className={`rounded-full px-1.5 text-xs tabular-nums ${
                  faultOnly
                    ? "bg-white/25"
                    : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                }`}
              >
                {faultCount}
              </span>
            </button>
          )}
          {tagFilter && (
            <span className="inline-flex items-center rounded-full border border-brand-300 bg-brand-50 px-3 py-1 text-sm font-medium text-brand-700 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300">
              {tagFilter.value}
            </span>
          )}
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setTypeFilter("all");
                setFaultOnly(false);
                setTagFilter(null);
              }}
              className="inline-flex items-center gap-1 px-1 py-1 text-sm font-medium text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
            >
              <IconX className="h-3.5 w-3.5" />
              Clear filters
            </button>
          )}
        </div>
        <div
          data-testid="journal-actions"
          className="hidden flex-wrap items-center gap-2 md:ml-auto md:flex lg:col-start-2 lg:row-start-1 lg:ml-0"
        >
          {lastActivity && (
            <button
              type="button"
              onClick={() => openRepeat(lastActivity)}
              data-testid="repeat-last"
              title={`Log again: ${lastActivity.title}`}
              className="btn-ghost"
            >
              <IconRepeat className="h-4 w-4" stroke={2} />
              Repeat last
            </button>
          )}
          {canStartWorkout && (
            <button
              type="button"
              onClick={openLive}
              data-testid="start-workout"
              className="btn-ghost"
            >
              <IconBolt className="h-4 w-4" stroke={2} />
              Start workout
            </button>
          )}
          <button type="button" onClick={openCreate} className="btn">
            <IconPlus className="h-4 w-4" stroke={2.5} />
            New activity
          </button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* Day-grouped feed */}
        <div>
          {shown.length === 0 ? (
            <div className="space-y-3">
              <EmptyState message="No activities match your filters." />
              {/* The match may still be in an unloaded older window — offer to widen
                  the search rather than declaring "none" over a bounded set (#451). */}
              {canFetchMore && (
                <>
                  {searchScopeNote}
                  {loadMoreButton}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {shown.map((g, gi) => (
                <section
                  key={g.date}
                  id={`day-${g.date}`}
                  className="scroll-mt-[calc(6rem+env(safe-area-inset-top))]"
                >
                  <h2
                    className={`mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400${
                      gi === 0 ? " flex h-9 items-center" : ""
                    }`}
                  >
                    {g.label}
                  </h2>
                  <div className="space-y-3">
                    {g.cards.map((c) => (
                      <JournalCard
                        key={c.activity.id}
                        activity={c.activity}
                        timeText={c.timeText}
                        durationText={c.durationText}
                        distanceText={c.distanceText}
                        speedText={c.speedText}
                        heartRateText={c.heartRateText}
                        calorieText={c.calorieText}
                        metrics={c.metrics}
                        gear={c.gear}
                        parts={c.parts}
                        fault={c.fault}
                        provenance={c.provenance}
                        routePolyline={c.routePolyline}
                        // Manual-merge targets: the OTHER activities logged this
                        // same day (issue #64), from the unfiltered day group, each
                        // with the per-field conflicts vs this keeper (issue #100).
                        mergeSiblings={(mergeTargetsByDate.get(g.date) ?? [])
                          .filter((o) => o.id !== c.activity.id)
                          .map((o): MergeSibling => ({
                            id: o.id,
                            title: o.title,
                            sourceLabel: o.sourceLabel,
                            conflicts: detectFieldConflicts(
                              c.foldValues,
                              o.foldValues
                            ),
                            setCount: o.setCount,
                          }))}
                        keeperLabel={c.provenance.label}
                        units={units}
                        onSelectExercise={(name) =>
                          showDetail("exercise", name)
                        }
                        onSelectCardio={(name) => showDetail("cardio", name)}
                        onSelectSport={(name) => showDetail("sport", name)}
                        onFilterTag={(kind, value) =>
                          setTagFilter({ kind, value })
                        }
                      />
                    ))}
                  </div>
                </section>
              ))}
              {searchScopeNote}
              {(hasMoreLoaded || canFetchMore) && loadMoreButton}
            </div>
          )}
        </div>

        {/* Detail / editor pane — desktop column only; on mobile the detail
            renders in MobileDetailPage below and the editor in the overlay. */}
        <aside className="hidden xl:block">
          {/* Sticky so it follows the feed; capped to the viewport with its own
              scroll when the content (e.g. a long editor) overflows. */}
          <div
            data-testid="activity-editor-scroll"
            className="sticky top-0 max-h-screen overflow-y-auto pr-1"
          >
            {/* Match the first feed row's h-9 date heading + mb-2 so the two
                cards align. This spacer scrolls away; it is not sticky chrome. */}
            <div aria-hidden className="mb-2 h-9" />
            {/* The provider portals the auto-saving editor here when open. */}
            <div
              ref={dockRef}
              data-testid="activity-editor-dock"
              className={open ? "card pt-0" : ""}
            />

            {/* isDesktop gate: below xl the aside is display:none but React would
                still mount the panel (charts and all) — MobileDetailPage is
                the only mobile surface, so don't build it twice. */}
            {!open &&
              (isDesktop && detailPanel ? (
                <div className="card">{detailPanel}</div>
              ) : (
                <div className="card">
                  <p className="text-sm text-slate-400 dark:text-slate-500">
                    Tap an exercise, cardio, or sport activity to see its
                    details.
                  </p>
                </div>
              ))}
          </div>
        </aside>
      </div>

      <MobileDetailPage
        open={detailOpen}
        desktopAt="xl"
        // dismissPanel (not just setDetailOpen(false)) so `detail` doesn't
        // linger and reappear in the desktop column after a resize.
        onClose={dismissPanel}
        title={
          selectedStat?.exercise ??
          selectedCardio?.activity ??
          selectedSport?.sport ??
          detail?.name
        }
      >
        {detailPanel}
      </MobileDetailPage>
    </div>
  );
}
