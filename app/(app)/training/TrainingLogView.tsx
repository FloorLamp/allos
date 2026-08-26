"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconX,
  IconAlertTriangle,
  IconBolt,
  IconRepeat,
  IconSearch,
} from "@tabler/icons-react";
import type { ActivityType } from "@/lib/types";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { PageHeader, EmptyState } from "@/components/ui";
import TrainingLogRow from "./TrainingLogRow";
import { loadTrainingLogPage } from "./activity-actions";
import ActiveDaysStrip from "@/components/ActiveDaysStrip";
import { useLatestRef } from "@/components/useLatestRef";
import { useResettableState } from "@/components/useResettableState";
import SegmentedControl from "@/components/SegmentedControl";
import Chip from "@/components/Chip";
import type { ActiveDaysStrip as ActiveDaysStripData } from "@/lib/workout-heatmap";

// TrainingLogCardData / DayGroup moved to lib/training-log-card.ts (issue #334), built by the
// pure buildTrainingLogCards. Re-exported here for callers that need the shared card shape.
// (HistorySection) keep their paths.
import type { TrainingLogCardData, DayGroup } from "@/lib/training-log-card";
import {
  appendDayGroups,
  reconcileTrainingLogPaging,
} from "@/lib/training-log-card";
import {
  EMPTY_TRAINING_LOG_FILTERS,
  filterTrainingLogGroups,
  trainingLogFiltersActive,
  trainingLogFiltersKey,
  type TrainingLogFilters,
} from "@/lib/training-log-filters";
import type { TrainingLogSourceOption } from "./training-log-feed-resolve";
import AddTrainingActivityButton from "./AddTrainingActivityButton";
export type { TrainingLogCardData, DayGroup };

// The Training Log's per-list multi-view context (issue #1330). Present ONLY when more
// than one profile is in view; undefined in single view, so the feed renders
// byte-identical. Carries the acting profile id — the card layer re-keys each card's
// affordances to its own subject (edit → subject profile; chip on non-acting rows;
// drill-ins stay on the acting profile's own aggregates).
export interface TrainingLogMultiView {
  actingProfileId: number;
}

// The week-summary numbers the header line renders. The per-target chips left
// this view with #2892 (one render home: Overview; edited in Plan), so the
// summary carries no chip data.
export interface WeekSummary {
  sessions: number;
  activeDays: number;
}

// The type chips. `mobility` is deliberately absent — mobility sessions have their own
// surface — but every type a card can CARRY needs a chip, or the row is unfilterable:
// it renders in the feed with a type the filter bar cannot name. `unclassified` (#2272)
// is such a type, so it gets a chip labelled for what it is: an import whose source
// never said what the session was.
const TYPE_FILTERS: { value: "all" | ActivityType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "strength", label: "Strength" },
  { value: "cardio", label: "Cardio" },
  { value: "sport", label: "Sport" },
  { value: "unclassified", label: "Unspecified" },
];

// How long a filter change settles before the store is asked for page one of the
// filtered feed (issue #1634). One round-trip per typing pause rather than one per
// keystroke; the pure client refinement covers the gap, so the feed never stalls.
const FILTER_FETCH_DEBOUNCE_MS = 200;

export default function TrainingLogView({
  groups: initialGroups,
  initialCursor = null,
  sourceOptions = [],
  faultCount = 0,
  weekSummary,
  activeDaysStrip,
  showHeader = true,
  multiView,
  initialCreateDate,
}: {
  // The NEWEST page of day groups, refreshed by the server on every auto-save (issue
  // #451). Older windows are fetched on demand and held in local state below.
  groups: DayGroup[];
  // Cursor (oldest-date-of-first-page) for fetching the next-older page, or null when
  // the first page already covers the whole history.
  initialCursor?: string | null;
  // The provenance keys actually present in the ledger, labelled server-side
  // (issue #1634). Fewer than two options means there is nothing to choose between,
  // and the control doesn't render.
  sourceOptions?: TrainingLogSourceOption[];
  // Rows the editor can't re-save as-is, counted over the WHOLE ledger server-side
  // (issue #1634) — not over the loaded pages, which both under-reported the badge
  // and hid the toggle when page one happened to be clean.
  faultCount?: number;
  weekSummary: WeekSummary;
  activeDaysStrip: ActiveDaysStripData;
  showHeader?: boolean;
  // Multi-view context (issue #1330): present only when >1 profile is in view. Each
  // card carries its own `subject` (stamped upstream) and the card layer re-keys its
  // affordances to that subject; undefined in single view (byte-identical).
  multiView?: TrainingLogMultiView;
  // A validated, non-future date from the day-history close-the-loop link.
  initialCreateDate?: string;
}) {
  const {
    openCreate,
    openLive,
    openRepeat,
    hasLastActivity,
    canStartWorkout,
    workoutOffer,
  } = useActivityEditor();
  const initialCreateHandled = useRef(false);

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
  const groupsRef = useLatestRef(groups);
  const cursorRef = useLatestRef(cursor);
  const olderGroupsRef = useLatestRef(olderGroups);
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
    const { changed, cursor: nextCursor } = reconcileTrainingLogPaging(
      seededCursorRef.current,
      initialCursor
    );
    if (!changed) return;
    seededCursorRef.current = initialCursor;
    olderGroupsRef.current = [];
    cursorRef.current = nextCursor;
    setOlderGroups([]);
    setCursor(nextCursor);
  }, [initialCursor, cursorRef, olderGroupsRef]);

  // Fetch the next-older page from the server and append it. Returns false when there
  // is nothing more to fetch, or a fetch is already in flight — so a caller/loop stops.
  const fetchNextPage = useCallback(async (): Promise<boolean> => {
    if (fetchingRef.current) return false;
    const before = cursorRef.current;
    if (before == null) return false;
    fetchingRef.current = true;
    try {
      const res = await loadTrainingLogPage(before);
      const nextOlder = appendDayGroups(olderGroupsRef.current, res.groups);
      olderGroupsRef.current = nextOlder;
      cursorRef.current = res.nextBefore;
      setOlderGroups(nextOlder);
      setCursor(res.nextBefore);
      return true;
    } finally {
      fetchingRef.current = false;
    }
  }, [cursorRef, olderGroupsRef]);

  // The most recent logged activity (groups arrive newest-first, cards ordered
  // within a day) — the source for the header's one-tap "Repeat last" (issue
  // #29). null when nothing's been logged yet, which hides the button.
  const lastActivity = groups[0]?.cards[0]?.activity ?? null;

  // First-run: a brand-new/post-onboarding profile with nothing logged yet
  // (issue #809). Distinct from "no activities match your filters" below — over an
  // empty history the search/filter controls are meaningless, so the empty state
  // hides them and leads with the action row (Add activity / Start workout) so the
  // user can actually log their first activity. Keyed on the UNFILTERED groups.
  const hasActivities = groups.length > 0;

  useEffect(() => {
    if (!initialCreateDate || initialCreateHandled.current) return;
    initialCreateHandled.current = true;
    openCreate({ date: initialCreateDate });
    // Consume the command-like query so an in-page refresh/autosave cannot open
    // another blank editor. Keep the tab and every unrelated query intact.
    const url = new URL(window.location.href);
    url.searchParams.delete("date");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [initialCreateDate, openCreate]);

  // ---- Filters (issue #1634) ----
  // ONE filter object rather than four independent useStates: it is the unit that
  // travels to the server (loadTrainingLogPage), the unit the pure predicate consumes,
  // and the unit whose identity decides whether an in-flight response is still the
  // one the user is looking at.
  const [filters, setFilters] = useState<TrainingLogFilters>(
    EMPTY_TRAINING_LOG_FILTERS
  );
  const filterByTag = useCallback(
    (kind: "muscle" | "region", value: string) =>
      setFilters((current) => ({ ...current, tag: { kind, value } })),
    []
  );

  // Derive rather than reset via an effect: when the last faulty row is fixed
  // the toggle vanishes (faultCount → 0), and the filter must stop applying in
  // the same render — an effect would leave one frame where the feed filters to
  // an empty list before the reset lands.
  const activeFilters = useMemo<TrainingLogFilters>(
    () =>
      filters.faultOnly && faultCount === 0
        ? { ...filters, faultOnly: false }
        : filters,
    [filters, faultCount]
  );
  const filtersActive = trainingLogFiltersActive(activeFilters);
  const filtersKey = trainingLogFiltersKey(activeFilters);
  const activeFiltersRef = useLatestRef(activeFilters);
  // Each active filter episode owns its own 14-day window. Clearing filters keeps
  // the current width (deep-link navigation deliberately widens it), while turning
  // filtering back on starts fresh even when the same filter key is chosen again.
  const [visibleWindow, setVisibleWindow] = useState({
    filterKey: filtersActive ? filtersKey : null,
    filtersActive,
    days: 14,
  });
  if (
    visibleWindow.filtersActive !== filtersActive ||
    (filtersActive && visibleWindow.filterKey !== filtersKey)
  ) {
    setVisibleWindow({
      filterKey: filtersActive ? filtersKey : visibleWindow.filterKey,
      filtersActive,
      days: filtersActive ? 14 : visibleWindow.days,
    });
  }
  const visibleDays = visibleWindow.days;
  const setVisibleDays = (next: number | ((days: number) => number)) => {
    setVisibleWindow((current) => ({
      ...current,
      days: typeof next === "function" ? next(current.days) : next,
    }));
  };

  // ---- Server-side filtered paging (issue #1634) ----
  // Before this, all four filters ran client-side over the LOADED pages, so a match
  // in an unfetched window silently did not exist and the component had to admit it
  // ("Only loaded activities are searched"). Now a filter change asks the STORE for
  // page one of the filtered feed: the query layer picks the days that contain a
  // match anywhere in the ledger, and this page's cursor pages over MATCHES. The
  // client predicate below still runs — over a complete day set it is exact — so
  // typing refines instantly while the round-trip is in flight, and the server's
  // answer is what settles.
  const [filteredFeed, setFilteredFeed] = useResettableState<{
    key: string;
    groups: DayGroup[];
    cursor: string | null;
  } | null>(null, filtersActive ? filtersKey : null);

  useEffect(() => {
    if (!filtersActive) return;
    let cancelled = false;
    // Debounced so a typed query issues one round-trip per pause, not one per
    // keystroke; the client refinement covers the gap so the feed never feels stuck.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await loadTrainingLogPage(null, activeFiltersRef.current);
          if (cancelled) return;
          setFilteredFeed({
            key: filtersKey,
            groups: res.groups,
            cursor: res.nextBefore,
          });
        } catch {
          // A failed fetch leaves the client refinement (and its pending line) in
          // place; the next filter change or auto-save retries.
        }
      })();
    }, FILTER_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // initialGroups: the server refreshes the first page on every auto-save, and a
    // filtered feed must pick those edits up too rather than showing a stale window.
  }, [
    filtersKey,
    filtersActive,
    initialGroups,
    activeFiltersRef,
    setFilteredFeed,
  ]);

  // The server's answer for THE filters currently on screen, or null while none has
  // arrived yet (first fetch, or a newer filter set in flight). Only a key match
  // counts — a late response for an older query must never overwrite a newer one.
  const serverFiltered =
    filtersActive && filteredFeed?.key === filtersKey ? filteredFeed : null;
  // Under a settled filter the feed IS the server's filtered window; otherwise it is
  // the unfiltered incremental chain, byte-identical to the pre-#1634 fast path.
  const baseGroups = serverFiltered ? serverFiltered.groups : groups;
  // The pure predicate — the same one the server-side day scan is a superset of.
  // A filtered page ships every row of a matching day (the merge picker needs them),
  // so this is what narrows a day to its matching cards.
  const filtered = useMemo(
    () => filterTrainingLogGroups(baseGroups, activeFilters),
    [baseGroups, activeFilters]
  );

  const shown = filtered.slice(0, visibleDays);

  // "Load more" pages the feed (issue #451): first reveal any already-loaded days
  // beyond the client window, then fetch the next-older window from the server —
  // the next-older MATCHING window when a filter is on (#1634).
  const hasMoreLoaded = filtered.length > visibleDays;
  // While a filter is active but the store's answer has not arrived, there is no
  // honest cursor to offer: the unfiltered chain's cursor would page in an unrelated
  // older window. Withhold the pager for that beat rather than page the wrong set.
  const activeCursor = serverFiltered
    ? serverFiltered.cursor
    : filtersActive
      ? null
      : cursor;
  const canFetchMore = activeCursor != null;
  async function handleLoadMore() {
    if (hasMoreLoaded) {
      setVisibleDays((v) => v + 14);
      return;
    }
    if (activeCursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      if (serverFiltered) {
        const key = serverFiltered.key;
        const res = await loadTrainingLogPage(
          activeCursor,
          activeFiltersRef.current
        );
        setFilteredFeed((prev) =>
          prev && prev.key === key
            ? {
                key,
                groups: appendDayGroups(prev.groups, res.groups),
                cursor: res.nextBefore,
              }
            : prev
        );
      } else {
        await fetchNextPage();
      }
      setVisibleDays((v) => v + 14);
    } finally {
      setLoadingMore(false);
    }
  }
  const loadMoreButton = (
    <button
      type="button"
      onClick={handleLoadMore}
      disabled={loadingMore}
      data-testid="training-log-load-more"
      className="btn-ghost w-full"
    >
      {loadingMore ? "Loading…" : "Load more"}
    </button>
  );
  // The #451 "only loaded activities are searched" note is GONE (#1634): whatever the
  // feed shows under a filter is now the store's answer over the whole ledger. What
  // remains is a plain pending line for the window where the request is in flight and
  // the visible list is still the instant client refinement.
  const searchPendingNote = filtersActive && serverFiltered == null && (
    <p
      data-testid="training-log-search-pending"
      className="text-center text-xs text-slate-500 dark:text-slate-400"
    >
      Searching your full history…
    </p>
  );

  const multi = multiView != null;

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
      // Clear EVERY filter (including source and fault), else navigating to a day
      // or activity the filter excludes would leave the target filtered out and the
      // scroll would never land. Clearing also drops the server-filtered feed, so
      // the jump resolves against the unfiltered chain the loop above paged.
      setFilters(EMPTY_TRAINING_LOG_FILTERS);
      // +8 so a few days render past the target and it can scroll near the top
      // rather than sticking to the bottom as the last rendered day.
      setVisibleDays((v) => Math.max(v, idx + 9));
      setPendingScroll(elementId);
    };
    void handleHash();
    const onHashChange = () => void handleHash();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [groups, fetchNextPage, cursorRef, groupsRef]);

  useEffect(() => {
    if (!pendingScroll) return;
    const el = document.getElementById(pendingScroll);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Clear after the browser has accepted the scroll. The callback is the
      // external event that completes this tiny state machine; doing it inline in
      // the effect caused an avoidable cascading render.
      const frame = requestAnimationFrame(() => {
        setPendingScroll((current) =>
          current === pendingScroll ? null : current
        );
      });
      return () => cancelAnimationFrame(frame);
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

  // The Training Log's secondary actions stay with its search controls. The one
  // page-level primary, Add activity, lives in PageHeader.action (#3486). These
  // remain desktop-only; MobileNav's always-mounted quick-log owns phone entry.
  const secondaryActions = (
    <>
      {lastActivity && hasLastActivity && (
        <button
          type="button"
          onClick={() => openRepeat(lastActivity)}
          data-testid="repeat-last"
          aria-label={`Repeat last — log again: ${lastActivity.title}`}
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
          data-workout-offer={workoutOffer.kind}
          className="btn-ghost"
        >
          <IconBolt className="h-4 w-4" stroke={2} />
          {/* The label IS the offer (#1893) — "Resume workout" while a session is
              live, because openLive reopens it rather than resetting its clock. */}
          {workoutOffer.label}
        </button>
      )}
    </>
  );
  const hasSecondaryActions =
    Boolean(lastActivity && hasLastActivity) || canStartWorkout;

  return (
    <div>
      {showHeader && (
        <PageHeader
          title="Training Log"
          action={<AddTrainingActivityButton />}
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
            </span>
          }
        />
      )}

      {/* A compact, literal trailing-14-day cadence strip. The weekly-routine
          chips left this tab (#2892): they render on Overview and are edited in
          Plan — one home, not three. Hidden on first-run (issue #809): an empty
          cadence strip is noise above the "log your first activity" prompt. */}
      {hasActivities && (
        <div
          data-testid="training-log-routine-row"
          className="mb-5 flex flex-wrap items-end justify-between gap-4"
        >
          {!showHeader && (
            <div data-testid="training-log-week-summary">
              <h2 className="section-label">This week</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {weekSummary.sessions}
                </span>{" "}
                session{weekSummary.sessions === 1 ? "" : "s"}
                <span
                  aria-hidden
                  className="mx-2 text-slate-300 dark:text-slate-600"
                >
                  ·
                </span>
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {weekSummary.activeDays}/7
                </span>{" "}
                days active
              </p>
            </div>
          )}
          <ActiveDaysStrip data={activeDaysStrip} />
        </div>
      )}

      {/* Controls. On first-run (issue #809) the search/filter controls are
          meaningless over an empty history, so only any available secondary
          workout action renders below the housed page primary. */}
      {!hasActivities ? (
        hasSecondaryActions && (
          <div
            data-testid="training-log-actions"
            className="mb-4 hidden flex-wrap items-center gap-2 md:flex"
          >
            {secondaryActions}
          </div>
        )
      ) : (
        <div
          data-testid="training-log-controls"
          className="mb-4 grid gap-2 lg:grid-cols-[minmax(12rem,1fr)_auto]"
        >
          <div className="relative min-w-48 lg:col-start-1 lg:row-start-1">
            <IconSearch
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-400"
              stroke={2}
            />
            <input
              type="search"
              value={filters.query}
              onChange={(e) =>
                setFilters((f) => ({ ...f, query: e.target.value }))
              }
              placeholder="Search activities or exercises…"
              className="input appearance-none pr-10 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {filters.query && (
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, query: "" }))}
                aria-label="Clear search"
                className="absolute top-1/2 right-1 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
              >
                <IconX className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:col-span-2 lg:row-start-2">
            {/* Mutually exclusive client-state views use the registry's
                SegmentedControl button binding (#2730). */}
            <SegmentedControl
              options={TYPE_FILTERS}
              value={activeFilters.type ?? "all"}
              onChange={(value) =>
                setFilters((prev) => ({
                  ...prev,
                  type: value === "all" ? null : value,
                }))
              }
              ariaLabel="Activity type"
            />
            {/* Source (issue #1634): the providers this ledger ACTUALLY contains,
              labelled by the same activityProvenanceLabel the cards render, so the
              filter and the chip can't name one provider two ways. Filtering happens
              in SQL by provenance key, so it reaches every window — not just the
              loaded ones. Hidden when there is nothing to choose between. */}
            {sourceOptions.length > 1 && (
              // The captioned-label treatment (#2897, the PanelFilterSelect
              // pattern): the select says what it filters without being opened.
              <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium">Source</span>
                <select
                  data-testid="training-log-source-filter"
                  value={activeFilters.source ?? ""}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      source: e.target.value === "" ? null : e.target.value,
                    }))
                  }
                  className="input h-auto w-auto py-1.5 text-sm"
                >
                  <option value="">Any source</option>
                  {sourceOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {/* Only shown while some row can't be saved as-is; disappears once the
              last one is fixed (faultCount → 0, which also clears the toggle). The
              count is the WHOLE ledger's (#1634), so a faulty row in an unfetched
              window still surfaces the toggle that can reach it. */}
            {faultCount > 0 && (
              <Chip
                role="filter"
                onClick={() =>
                  setFilters((f) => ({ ...f, faultOnly: !f.faultOnly }))
                }
                pressed={activeFilters.faultOnly}
                testId="training-log-fault-filter"
              >
                <IconAlertTriangle className="h-4 w-4" stroke={2} />
                Can’t be saved
                <span className="rounded-full bg-black/10 px-1.5 text-xs tabular-nums dark:bg-white/15">
                  {faultCount}
                </span>
              </Chip>
            )}
            {activeFilters.tag && (
              <span
                data-testid="training-log-tag-filter"
                className="inline-flex items-center rounded-full border border-brand-300 bg-brand-50 px-3 py-1 text-sm font-medium text-brand-700 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"
              >
                {activeFilters.tag.value}
              </span>
            )}
            {filtersActive && (
              <button
                type="button"
                onClick={() => setFilters(EMPTY_TRAINING_LOG_FILTERS)}
                className="inline-flex items-center gap-1 px-1 py-1 text-sm font-medium text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
              >
                <IconX className="h-3.5 w-3.5" />
                Clear filters
              </button>
            )}
          </div>
          {hasSecondaryActions && (
            <div
              data-testid="training-log-actions"
              className="hidden flex-wrap items-center gap-2 md:ml-auto md:flex lg:col-start-2 lg:row-start-1 lg:ml-0"
            >
              {secondaryActions}
            </div>
          )}
        </div>
      )}

      <div className="min-w-0">
        {!hasActivities ? (
          // First-run (issue #809): nothing logged yet. Distinct copy from the
          // filter-empty case below — there is nothing to filter, so this leads
          // the user to the (prominent) action row above rather than talking about
          // filters or an unloaded older window.
          <EmptyState message="No activities logged yet. Log your first workout to start building your training history." />
        ) : shown.length === 0 ? (
          <div className="space-y-3">
            {/* "None" is now a claim about the WHOLE ledger (#1634), not about the
                  loaded windows — the store selected the matching days, so there is
                  nothing left to widen to. Which is exactly why it must not be said
                  EARLY: until the store has answered, the visible list is only the
                  client refinement over the loaded window, and an empty one there
                  means "not found yet", not "not in your history". So the pending
                  line REPLACES the verdict rather than sitting under it. */}
            {searchPendingNote || (
              <EmptyState message="No activities match your filters." />
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {shown.map((g, gi) => (
              <section
                key={g.date}
                id={`day-${g.date}`}
                className="scroll-mt-[calc(6rem+env(safe-area-inset-top))]"
              >
                <h2
                  className={`mb-2 section-label${
                    gi === 0 ? " flex h-9 items-center" : ""
                  }`}
                >
                  {g.label}
                </h2>
                <div>
                  {g.cards.map((c) => (
                    <TrainingLogRow
                      key={c.activity.id}
                      card={c}
                      showSubjectChip={
                        c.subject != null &&
                        multi &&
                        multiView != null &&
                        c.subject.profileId !== multiView.actingProfileId
                      }
                      onFilterTag={filterByTag}
                    />
                  ))}
                </div>
              </section>
            ))}
            {searchPendingNote}
            {(hasMoreLoaded || canFetchMore) && loadMoreButton}
          </div>
        )}
      </div>
    </div>
  );
}
