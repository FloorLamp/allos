"use client";

import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import {
  IconAdjustmentsHorizontal,
  IconPlus,
  IconMinus,
  IconChevronDown,
} from "@tabler/icons-react";
import type { FoodGroup, FoodGroupTier } from "@/lib/food-groups";
import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";
import FoodGroupIcon, {
  FOOD_GROUP_TIER_TINT,
} from "@/components/FoodGroupIcon";
import ModalShell from "@/components/ModalShell";
import SegmentedControl from "@/components/SegmentedControl";
import CompactDateMenu from "@/components/CompactDateMenu";
import { useToast } from "@/components/Toast";
import DietaryPreferencesForm from "@/app/(app)/settings/profile/DietaryPreferencesForm";
import { logFoodServing, undoFoodServing } from "./actions";
import { useFoodSelectedDate } from "./FoodSuggestionsLayout";

// One-tap food-group serving logger (issue #579), modeled on the dose-confirm one-tap
// bar (components/DoseStatusControl): optimistic local counts, a Server Action per tap,
// undo = decrement. Groups are shown by tier (encourage → neutral → limit) so the foods
// to eat more of lead; WITHIN each tier the server ranks the profile's staples first
// (frequency + recency, issue #591) — the `groups` prop arrives pre-ordered.
//
// The row order is FROZEN for the life of this mount: the server re-ranks by
// recency-decayed frequency on every read, so the server re-render each tap's action
// triggers would otherwise reorder the list under the user's finger — jarring right
// where they just tapped. Tapping a row's label expands the (normally truncated) serving detail so it's
// readable on a narrow phone without leaving the page.

const TIER_ORDER: FoodGroupTier[] = ["encourage", "neutral", "limit"];
const TIER_LABEL: Record<FoodGroupTier, string> = {
  encourage: "Eat more",
  neutral: "Balance",
  limit: "Eat less",
};
const TIER_BADGE_CLASS: Record<FoodGroupTier, string> = {
  encourage:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  neutral: "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-300",
  limit: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};
const QUICK_GROUP_COUNT = 6;
const QUICK_TIER_SEQUENCE: FoodGroupTier[] = [
  "encourage",
  "encourage",
  "neutral",
  "encourage",
  "limit",
  "encourage",
  "neutral",
  "limit",
];

export interface FoodLogDay {
  date: string;
  label: string;
  counts: Record<string, number>;
  slotCounts: Record<FoodSlot, Record<string, number>>;
}

export default function FoodLogBar({
  today,
  days,
  groupsBySlot,
  excludedGroups,
  slot,
  initialFoodGroup,
  nutrientSummaryByDate = [],
  proteinQuickAdd,
}: {
  // The acting profile's today (YYYY-MM-DD) and bounded recent meal history.
  today: string;
  days: FoodLogDay[];
  // One server-ranked catalog per meal slot. Switching meals changes both the learned
  // order and the displayed counts without waiting for another server render.
  groupsBySlot: Record<FoodSlot, FoodGroup[]>;
  // Profile-scoped food groups excluded from suggestions. Edited in-place through
  // the modal rather than navigating away from the meal being logged.
  excludedGroups: string[];
  // The profile's current food window (#950), derived server-side from the same
  // computation that ranked `groups`, so the chip and the order agree. Shown as a
  // small label so the slot-aware ordering is legible ("why is fish first right now").
  slot: FoodSlot;
  // Optional protocol-owned group (#1584). It is promoted into the quick rows
  // for this mount so opening "Log servings" lands on the intended existing
  // write control without inventing another food-log path.
  initialFoodGroup?: string;
  // Mobile-only compact feedback for each bounded date, placed between the meal
  // context and its add controls. Kept as server-rendered slots so this client island
  // continues to own only logging state while an older date gets its own nutrients.
  nutrientSummaryByDate?: { date: string; content: ReactNode }[];
  // Gram-based protein logging styled as a peer to the serving rows. It remains
  // day-scoped, so it is only rendered while Today is selected.
  proteinQuickAdd?: ReactNode;
}) {
  const {
    activeDate,
    setActiveDate,
    countsByDate,
    setCountsByDate,
    slotCountsByDate,
    setSlotCountsByDate,
  } = useFoodSelectedDate();
  const [activeSlot, setActiveSlot] = useState<FoodSlot>(slot);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // Optimistic daily totals and meal-slot counts live in the parent date context:
  // food_log remains the source-of-truth day counter, while food_log_events powers
  // meal history. Sharing them keeps the selected-day sidebar summary in lockstep.
  // Slugs whose serving detail is expanded (tap-to-read on mobile). Purely local.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toast = useToast();

  const activeDay = days.find((day) => day.date === activeDate) ?? days[0];
  const nutrientSummary = nutrientSummaryByDate.find(
    (item) => item.date === activeDate
  )?.content;
  // Memoized so its reference is stable while the active day's tally is unchanged —
  // the dayTotal useMemo below keys on it.
  const counts = useMemo(
    () => countsByDate[activeDate] ?? {},
    [countsByDate, activeDate]
  );
  const slotCounts = useMemo(
    () => slotCountsByDate[activeDate]?.[activeSlot] ?? {},
    [slotCountsByDate, activeDate, activeSlot]
  );

  // Freeze each meal's initial order independently. A slot switch intentionally swaps
  // to that meal's learned order; a log+refresh within the same slot never makes the
  // row under the user's finger jump.
  const frozenOrder = useRef<Record<FoodSlot, string[]> | null>(null);
  if (frozenOrder.current === null) {
    frozenOrder.current = Object.fromEntries(
      FOOD_SLOTS.map((meal) => [
        meal,
        groupsBySlot[meal].map((group) => group.slug),
      ])
    ) as Record<FoodSlot, string[]>;
  }
  const orderedGroupsBySlot = useMemo(
    () =>
      Object.fromEntries(
        FOOD_SLOTS.map((meal) => {
          const idx = new Map(
            frozenOrder.current![meal].map((slug, i) => [slug, i])
          );
          const ordered = groupsBySlot[meal]
            .map((group, i) => ({ group, i }))
            .sort((a, b) => {
              const ai = idx.get(a.group.slug) ?? Number.MAX_SAFE_INTEGER;
              const bi = idx.get(b.group.slug) ?? Number.MAX_SAFE_INTEGER;
              return ai - bi || a.i - b.i;
            })
            .map(({ group }) => group);
          return [meal, ordered];
        })
      ) as Record<FoodSlot, FoodGroup[]>,
    [groupsBySlot]
  );
  const orderedGroups = orderedGroupsBySlot[activeSlot];

  // The quick set is frozen with the row order. Logged groups rank ahead of unlogged
  // peers inside their tier, then eight slots are filled from a balanced encourage /
  // neutral / limit sequence. The complete remainder is always one disclosure away.
  const quickSlugs = useRef<Record<FoodSlot, Set<string>> | null>(null);
  if (quickSlugs.current === null) {
    quickSlugs.current = Object.fromEntries(
      FOOD_SLOTS.map((meal) => {
        const selected = new Set<string>();
        const candidates = new Map(
          TIER_ORDER.map((tier) => [
            tier,
            orderedGroupsBySlot[meal]
              .filter((group) => group.tier === tier)
              .map((group, order) => ({
                group,
                order,
                logged: days.some(
                  (day) => (day.slotCounts[meal][group.slug] ?? 0) > 0
                ),
              }))
              .sort(
                (a, b) =>
                  Number(b.logged) - Number(a.logged) || a.order - b.order
              )
              .map(({ group }) => group),
          ])
        );
        for (const tier of QUICK_TIER_SEQUENCE) {
          const next = candidates
            .get(tier)
            ?.find((group) => !selected.has(group.slug));
          if (next) selected.add(next.slug);
          if (selected.size === QUICK_GROUP_COUNT) break;
        }
        return [meal, selected];
      })
    ) as Record<FoodSlot, Set<string>>;
  }
  const initialGroup = initialFoodGroup
    ? orderedGroups.find((group) => group.slug === initialFoodGroup)
    : undefined;
  const quickGroups = [
    ...(initialGroup ? [initialGroup] : []),
    ...orderedGroups.filter(
      (group) =>
        group.slug !== initialGroup?.slug &&
        quickSlugs.current![activeSlot].has(group.slug)
    ),
  ];
  const moreGroups = orderedGroups.filter(
    (group) =>
      group.slug !== initialGroup?.slug &&
      !quickSlugs.current![activeSlot].has(group.slug)
  );

  // Set one slug's daily count, leaving every other day untouched.
  function setCount(slug: string, next: (prev: number) => number) {
    setCountsByDate((m) => {
      const day = m[activeDate] ?? {};
      return {
        ...m,
        [activeDate]: { ...day, [slug]: Math.max(0, next(day[slug] ?? 0)) },
      };
    });
  }

  function setSlotCount(
    targetSlot: FoodSlot,
    slug: string,
    next: (prev: number) => number
  ) {
    setSlotCountsByDate((allDays) => {
      const day = allDays[activeDate] ?? {
        Morning: {},
        Midday: {},
        Evening: {},
      };
      const meal = day[targetSlot] ?? {};
      return {
        ...allDays,
        [activeDate]: {
          ...day,
          [targetSlot]: {
            ...meal,
            [slug]: Math.max(0, next(meal[slug] ?? 0)),
          },
        },
      };
    });
  }

  async function bump(slug: string, delta: 1 | -1) {
    // Optimistic: reflect the tap immediately.
    setCount(slug, (n) => n + delta);
    setSlotCount(activeSlot, slug, (n) => n + delta);
    const fd = new FormData();
    fd.set("group_key", slug);
    fd.set("date", activeDate);
    fd.set("meal_slot", activeSlot);
    const res =
      delta === 1 ? await logFoodServing(fd) : await undoFoodServing(fd);
    if (res.ok) {
      // Reconcile with the server's authoritative daily total (#748 item 2) so a
      // dropped/failed write can never leave a phantom count.
      setCount(slug, () => res.servings);
      const mealServings = res.mealServings;
      if (mealServings != null)
        setSlotCount(activeSlot, slug, () => mealServings);
    } else {
      // Roll back this tap and tell the user it didn't stick.
      setCount(slug, (n) => n - delta);
      setSlotCount(activeSlot, slug, (n) => n - delta);
      toast(res.error || "Couldn't save that serving — try again.", {
        tone: "error",
      });
    }
  }

  function toggleDetail(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  // Live total of servings logged on the selected day, summed from the same optimistic count
  // state the rows use so the header ticks up on the same tap (no refresh lag).
  const dayTotal = useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + n, 0),
    [counts]
  );
  const assignedTotal = useMemo(() => {
    const daySlots = slotCountsByDate[activeDate];
    if (!daySlots) return 0;
    return FOOD_SLOTS.reduce(
      (sum, meal) =>
        sum +
        Object.values(daySlots[meal] ?? {}).reduce(
          (mealSum, n) => mealSum + n,
          0
        ),
      0
    );
  }, [slotCountsByDate, activeDate]);
  const unassignedTotal = Math.max(0, dayTotal - assignedTotal);

  const rows = (list: FoodGroup[]) => (
    <ul className="space-y-1.5">
      {list.map((g) => {
        const mealCount = slotCounts[g.slug] ?? 0;
        const isExpanded = expanded.has(g.slug);
        return (
          <li
            key={g.slug}
            data-testid={`food-group-${g.slug}`}
            data-prefilled={g.slug === initialGroup?.slug ? "true" : undefined}
            className="flex items-center gap-3 rounded-lg border border-black/10 bg-white px-3 py-2 dark:border-white/10 dark:bg-ink-900"
          >
            <FoodGroupIcon
              slug={g.slug}
              className={`mt-1 h-5 w-5 shrink-0 self-start ${FOOD_GROUP_TIER_TINT[g.tier]}`}
            />
            <button
              type="button"
              data-testid={`detail-${g.slug}`}
              onClick={() => toggleDetail(g.slug)}
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "Hide" : "Show"} serving detail for ${g.name}`}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left md:hidden"
            >
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    data-testid={`food-name-${g.slug}`}
                    className="truncate font-medium text-slate-800 dark:text-slate-100"
                  >
                    {g.name}
                  </span>
                  <span
                    data-testid={`food-tier-${g.slug}`}
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none ${TIER_BADGE_CLASS[g.tier]}`}
                  >
                    {TIER_LABEL[g.tier]}
                  </span>
                </span>
                <span
                  className={`block text-xs text-slate-500 dark:text-slate-400 ${
                    isExpanded ? "" : "truncate"
                  }`}
                >
                  {g.serving}
                </span>
              </span>
              <IconChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform dark:text-slate-600 ${
                  isExpanded ? "rotate-180" : ""
                }`}
                stroke={2}
              />
            </button>
            <div
              data-testid={`detail-static-${g.slug}`}
              className="hidden min-w-0 flex-1 md:block"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {g.name}
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none ${TIER_BADGE_CLASS[g.tier]}`}
                >
                  {TIER_LABEL[g.tier]}
                </span>
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                {g.serving}
              </span>
            </div>
            <button
              type="button"
              data-testid={`undo-${g.slug}`}
              aria-label={`Remove a ${g.name} serving from ${activeSlot}`}
              title="Remove a serving"
              disabled={mealCount <= 0}
              onClick={() => bump(g.slug, -1)}
              className="tap-target flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-ink-800"
            >
              <IconMinus className="h-4 w-4" stroke={2} />
            </button>
            <span
              data-testid={`count-${g.slug}`}
              title={`${mealCount} ${mealCount === 1 ? "serving" : "servings"} in ${activeSlot} ${activeDay.label.toLowerCase()}`}
              className={`w-5 text-center text-sm font-semibold tabular-nums ${
                mealCount === 0
                  ? "text-slate-500 dark:text-slate-400"
                  : "text-slate-700 dark:text-slate-200"
              }`}
            >
              {mealCount}
            </span>
            <button
              type="button"
              data-testid={`log-${g.slug}`}
              aria-label={`Add a ${g.name} serving to ${activeSlot}`}
              title="Add a serving"
              onClick={() => bump(g.slug, 1)}
              className="tap-target flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700"
            >
              <IconPlus className="h-4 w-4" stroke={2} />
            </button>
          </li>
        );
      })}
    </ul>
  );
  const dayTestId = (day: FoodLogDay) =>
    day.date === today
      ? "food-day-today"
      : day.label === "Yesterday"
        ? "food-day-yesterday"
        : `food-day-${day.date}`;
  const totalForSlot = (meal: FoodSlot) =>
    Object.values(slotCountsByDate[activeDate]?.[meal] ?? {}).reduce(
      (sum, n) => sum + n,
      0
    );
  const groupsForSlot = (meal: FoodSlot) => {
    const mealCounts = slotCountsByDate[activeDate]?.[meal] ?? {};
    return orderedGroupsBySlot[meal].filter(
      (group) => (mealCounts[group.slug] ?? 0) > 0
    );
  };

  return (
    <div>
      <div
        data-testid="food-log-context"
        className="-mx-2 mb-3 bg-white/95 px-2 py-2 md:sticky md:top-0 md:z-10 md:backdrop-blur lg:static lg:mx-0 lg:bg-transparent lg:p-0 dark:bg-ink-900/95 dark:lg:bg-transparent"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2
              data-testid="food-context-heading"
              aria-label={`${activeDay.label} ${activeSlot} Food Log`}
              className="flex flex-wrap items-center gap-2 font-semibold text-slate-800 dark:text-slate-100"
            >
              <CompactDateMenu
                days={days}
                value={activeDate}
                onChange={setActiveDate}
                label="Choose day to log"
                testIdPrefix="food"
              />
              <span className="hidden sm:inline">{activeDay.label}</span>
              <span
                data-testid="food-context-label"
                className="text-sm font-medium text-slate-500 dark:text-slate-400"
              >
                <span
                  data-testid="food-slot-chip"
                  data-slot={activeSlot}
                  className="text-slate-500 dark:text-slate-400"
                >
                  {activeSlot}
                </span>
              </span>
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              data-testid="food-day-total"
              className="text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
            >
              {dayTotal} {dayTotal === 1 ? "serving" : "servings"}
            </span>
            <button
              type="button"
              data-testid="food-preferences-open-mobile"
              aria-label="Dietary preferences"
              title="Dietary preferences"
              onClick={() => setPreferencesOpen(true)}
              className="btn-ghost tap-target h-10 w-10 shrink-0 p-0 sm:hidden"
            >
              <IconAdjustmentsHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="mt-2 hidden min-w-0 overflow-x-auto pb-0.5 sm:block">
          <SegmentedControl
            options={days.map((day, daysAgo) => ({
              value: day.date,
              label: day.label,
              testId: dayTestId(day),
              dataAttributes: { "data-days-ago": daysAgo },
            }))}
            value={activeDate}
            onChange={setActiveDate}
            ariaLabel="Day to log"
            testId="food-day-toggle"
            className="min-w-max"
          />
        </div>
      </div>
      <div data-testid="food-log-bar" className="space-y-5">
        <section data-testid="food-meal-summary" className="sm:space-y-2">
          <div className="hidden items-center justify-between gap-3 sm:flex">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Meals
            </h3>
            <button
              type="button"
              data-testid="food-preferences-open-desktop"
              onClick={() => setPreferencesOpen(true)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <IconAdjustmentsHorizontal className="h-3.5 w-3.5" />
              Preferences
            </button>
          </div>
          <div
            data-testid="food-meal-slots"
            role="group"
            aria-label="Meals for the selected day; choose where to log"
            className="grid min-w-0 grid-cols-3 gap-2"
          >
            {FOOD_SLOTS.map((meal) => {
              const total = totalForSlot(meal);
              const mealCounts = slotCountsByDate[activeDate]?.[meal] ?? {};
              const groupsInMeal = groupsForSlot(meal);
              return (
                <button
                  key={meal}
                  type="button"
                  data-testid={`food-slot-${meal.toLowerCase()}`}
                  aria-pressed={activeSlot === meal}
                  onClick={() => setActiveSlot(meal)}
                  className={`flex min-h-12 min-w-0 flex-col items-stretch justify-center rounded-lg border p-2 text-left transition sm:h-full sm:justify-start sm:p-2.5 ${
                    activeSlot === meal
                      ? "border-brand-400 bg-white ring-1 ring-brand-200 dark:border-brand-600 dark:bg-ink-700 dark:ring-brand-900"
                      : "border-black/10 bg-white/60 hover:bg-white dark:border-white/10 dark:bg-ink-900/60 dark:hover:bg-ink-800"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                      {meal}
                    </span>
                    <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {total}
                    </span>
                  </span>
                  {groupsInMeal.length > 0 ? (
                    <span className="mt-2 hidden flex-wrap gap-1 sm:flex">
                      {groupsInMeal.map((group) => (
                        <span
                          key={group.slug}
                          data-testid={`food-meal-item-${meal.toLowerCase()}-${group.slug}`}
                          className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-200"
                        >
                          {group.name}
                          {(mealCounts[group.slug] ?? 0) > 1 &&
                            ` ×${mealCounts[group.slug]}`}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="mt-2 hidden text-xs text-slate-500 sm:block dark:text-slate-400">
                      Nothing logged
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {unassignedTotal > 0 && (
            <p
              data-testid="food-unassigned-total"
              className="mt-2 text-xs text-slate-500 dark:text-slate-400"
            >
              {unassignedTotal} older{" "}
              {unassignedTotal === 1 ? "serving has" : "servings have"} no meal
              assignment.
            </p>
          )}
        </section>
        <section data-testid="food-quick-log">
          <h3 className="mb-2 section-label">Add to {activeSlot}</h3>
          <div className="space-y-1.5">
            {activeDate === today && proteinQuickAdd}
            {rows(quickGroups)}
          </div>
        </section>
        {nutrientSummary}
        {moreGroups.length > 0 && (
          <details data-testid="food-more-groups" className="group">
            <summary
              data-testid="food-more-groups-summary"
              className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-black/10 bg-white/70 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-white [&::-webkit-details-marker]:hidden dark:border-white/10 dark:bg-ink-850 dark:text-slate-200 dark:hover:bg-ink-750"
            >
              <span>More food groups ({moreGroups.length})</span>
              <IconChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-4 space-y-5">
              {TIER_ORDER.map((tier) => {
                const tierGroups = moreGroups.filter((g) => g.tier === tier);
                if (tierGroups.length === 0) return null;
                return (
                  <div key={tier}>
                    <h3 className="mb-2 section-label">{TIER_LABEL[tier]}</h3>
                    {rows(tierGroups)}
                  </div>
                );
              })}
            </div>
          </details>
        )}
      </div>
      {preferencesOpen && (
        <ModalShell
          title="Dietary preferences"
          onClose={() => setPreferencesOpen(false)}
          className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <div className="mt-4 min-h-0 overflow-y-auto pr-1">
            <DietaryPreferencesForm
              excluded={excludedGroups}
              groups={groupsBySlot[FOOD_SLOTS[0]].map((group) => ({
                slug: group.slug,
                name: group.name,
                tier: group.tier,
              }))}
              embedded
            />
          </div>
          <div className="mt-4 flex justify-end border-t border-black/10 pt-3 dark:border-white/10">
            <button
              type="button"
              data-testid="food-preferences-done"
              onClick={() => setPreferencesOpen(false)}
              className="btn"
            >
              Done
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
