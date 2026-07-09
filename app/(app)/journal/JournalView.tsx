"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconX, IconAlertTriangle } from "@tabler/icons-react";
import type { ActivityType, Goal, Sex } from "@/lib/types";
import type {
  CardioStat,
  ExerciseStat,
  GoalProgress,
  SportStat,
} from "@/lib/queries";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivityEditData } from "@/components/ActivityForm";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { regionForExercise } from "@/lib/lifts";
import { PageHeader, EmptyState } from "@/components/ui";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import MobileDetailPage from "@/components/MobileDetailPage";
import { LG_QUERY, openDetailOnMobile } from "@/components/mobileDetail";
import ExerciseDetailPanel from "@/components/ExerciseDetailPanel";
import CardioDetailPanel from "@/components/CardioDetailPanel";
import SportDetailPanel from "@/components/SportDetailPanel";
import JournalCard, { type DisplayPart } from "./JournalCard";

export interface JournalCardData {
  activity: ActivityEditData;
  durationText: string | null;
  distanceText: string | null;
  speedText: string | null;
  // Compact chips for richer imported metrics (HR, elevation, power, etc.).
  metrics: string[];
  parts: DisplayPart[];
  // Why this row can't be re-saved by the editor as-is (imports, legacy
  // data), or null. See lib/activity-validate.
  fault: string | null;
  // Provenance chip + created/updated timestamps (issue #11).
  provenance: {
    // "Manual" | "Strava" | "Google Health Connect" | "Document" | "<Source> · edited"
    label: string;
    createdAt: string;
    // NULL until the row has been edited since creation.
    updatedAt: string | null;
  };
}
export interface DayGroup {
  date: string;
  label: string;
  cards: JournalCardData[];
}
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

export default function JournalView({
  groups,
  exerciseStats,
  cardioStats,
  sportStats,
  goals,
  goalProgress,
  bodyweightKg,
  units,
  weekSummary,
  recentByExercise,
  showHeader = true,
  showWeeklyTargets = true,
  sex,
}: {
  groups: DayGroup[];
  exerciseStats: ExerciseStat[];
  cardioStats: CardioStat[];
  sportStats: SportStat[];
  goals: Goal[];
  goalProgress: Record<number, GoalProgress>;
  bodyweightKg: number | null;
  units: UnitPrefs;
  weekSummary: WeekSummary;
  recentByExercise: RecentByExercise;
  showHeader?: boolean;
  showWeeklyTargets?: boolean;
  // Profile sex, so the exercise detail's strength standards use the right chart.
  sex?: Sex | null;
}) {
  const { open, openCreate, close, registerDock } = useActivityEditor();
  const dockRef = useRef<HTMLDivElement | null>(null);

  // The dock is a desktop concept: it exists so the editor can live beside the
  // feed in the two-column layout. Below lg there is no second column — the
  // provider falls back to ActivityOverlay, so the editor looks and behaves the
  // same as on every other page. (Crossing the breakpoint mid-edit closes the
  // editor; any pending auto-save is flushed on unmount.)
  const [isLg, setIsLg] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(LG_QUERY);
    const update = () => setIsLg(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Lend the editor this column so create/edit auto-saves inline here instead of
  // popping the centered modal. Only ever register a real dock: passing null
  // means "the dock went away" and closes the editor — running that on a mount
  // where isLg hasn't settled yet (it starts false) would force-close an editor
  // that survived navigation as the overlay.
  useEffect(() => {
    if (!isLg) return;
    registerDock(dockRef.current);
    return () => registerDock(null);
  }, [registerDock, isLg]);

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
    const handleHash = () => {
      const hash = window.location.hash;
      if (hash === handledHashRef.current) return;
      handledHashRef.current = hash;
      const mDay = hash.match(/^#day-(\d{4}-\d{2}-\d{2})$/);
      const mAct = hash.match(/^#activity-(\d+)$/);
      let targetDate: string | null = null;
      let elementId: string | null = null;
      if (mDay) {
        targetDate = mDay[1];
        elementId = `day-${mDay[1]}`;
      } else if (mAct) {
        const id = Number(mAct[1]);
        const g = groups.find((gr) =>
          gr.cards.some((c) => c.activity.id === id)
        );
        if (!g) return;
        targetDate = g.date;
        elementId = `activity-${id}`;
      } else return;
      const idx = groups.findIndex((g) => g.date === targetDate);
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
    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, [groups]);

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
    openDetailOnMobile(() => setDetailOpen(true));
  }

  // Desktop-only ✕ inside the panel header; the mobile detail page has its own.
  const closeDetailButton = (
    <button
      type="button"
      onClick={dismissPanel}
      aria-label="Close details"
      className="hidden text-slate-400 hover:text-slate-600 lg:block dark:text-slate-500 dark:hover:text-slate-300"
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
      recent={recentByExercise[selectedStat.exercise.toLowerCase()]}
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

      {/* Weekly frequency targets — see WeeklyTargets for the chip design. */}
      {showWeeklyTargets && weekSummary.targets.length > 0 && (
        <div className="mb-5">
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Weekly routine
          </h2>
          <WeeklyTargets targets={weekSummary.targets} />
        </div>
      )}

      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search activities or exercises…"
          className="input max-w-xs"
        />
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map((f) => {
            const active = typeFilter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setTypeFilter(f.value)}
                className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                  active
                    ? "border-brand-500 bg-brand-500 text-white"
                    : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
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
          <button
            type="button"
            onClick={() => setTagFilter(null)}
            title="Clear filter"
            className="inline-flex items-center gap-1 rounded-full border border-brand-500 bg-brand-500 px-3 py-1 text-sm font-medium text-white transition hover:bg-brand-600"
          >
            {tagFilter.value}
            <span aria-hidden className="text-base leading-none">
              ×
            </span>
          </button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Day-grouped feed */}
        <div>
          {shown.length === 0 ? (
            <EmptyState message="No activities match your filters." />
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
                        durationText={c.durationText}
                        distanceText={c.distanceText}
                        speedText={c.speedText}
                        metrics={c.metrics}
                        parts={c.parts}
                        fault={c.fault}
                        provenance={c.provenance}
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
              {filtered.length > visibleDays && (
                <button
                  type="button"
                  onClick={() => setVisibleDays((v) => v + 14)}
                  className="btn-ghost w-full"
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </div>

        {/* Detail / editor pane — desktop column only; on mobile the detail
            renders in MobileDetailPage below and the editor in the overlay. */}
        <aside className="hidden lg:block">
          {/* Sticky so it follows the feed; capped to the viewport with its own
              scroll when the content (e.g. a long editor) overflows. The header
              keeps the first card aligned with the feed's dated cards. */}
          <div className="sticky top-8 max-h-[calc(100vh-3rem)] overflow-y-auto pr-1">
            <div className="mb-2 flex h-9 items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {open ? "Activity" : "Details"}
              </h2>
              <button type="button" onClick={openCreate} className="btn">
                New activity
              </button>
            </div>
            {/* The provider portals the auto-saving editor here when open. */}
            <div ref={dockRef} className={open ? "card" : ""} />

            {/* isLg gate: below lg the aside is display:none but React would
                still mount the panel (charts and all) — MobileDetailPage is
                the only mobile surface, so don't build it twice. */}
            {!open &&
              (isLg && detailPanel ? (
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
