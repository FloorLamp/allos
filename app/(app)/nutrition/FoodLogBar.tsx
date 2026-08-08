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
import { proteinSplitIndex } from "@/lib/food-rank";
import {
  FOOD_SLOTS,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
import { statedHhmm, statedInstantOnDate } from "@/lib/stated-time";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import FoodGroupIcon, {
  FOOD_GROUP_TIER_TINT,
} from "@/components/FoodGroupIcon";
import ModalShell from "@/components/ModalShell";
import SegmentedControl from "@/components/SegmentedControl";
import CompactDateMenu from "@/components/CompactDateMenu";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { UNDO_TOAST_MS } from "@/components/useUndoableDelete";
import { undoDelete } from "@/app/(app)/undo-actions";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import {
  eatingHoursOnDate,
  eatingTimeChoiceValue,
  type EatingTimeChoice,
  type EatingTimeOption,
} from "@/lib/food-eating-time";
import { shouldQueueOffline } from "@/lib/offline/queue";
import DietaryPreferencesForm from "@/app/(app)/settings/profile/DietaryPreferencesForm";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import {
  deleteFoodLogEvent,
  logFoodServing,
  undoFoodServing,
  updateFoodLogEvent,
  type FoodEventDeleteResult,
  type FoodEventEditResult,
  type FoodLogResult,
} from "./actions";
import { useFoodSelectedDate } from "./FoodSuggestionsLayout";

// Where one corrected serving landed, with the server's authoritative counts for that
// coordinate. Named off the action's result so the bar and the write core can never
// drift on the shape.
type FoodPlacement = Extract<FoodEventEditResult, { ok: true }>["from"];

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
// A pressed/unpressed eating-time chip (#2053). Pressed reads as the brand-tinted
// selection the meal cards already use, so "a statement is in force" is legible at a
// glance rather than only from the note under the row.
function chipClass(pressed: boolean): string {
  return `tap-target rounded-full border px-2.5 py-1 text-xs font-medium transition ${
    pressed
      ? "border-brand-400 bg-brand-50 text-brand-700 dark:border-brand-600 dark:bg-brand-950/60 dark:text-brand-200"
      : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
  }`;
}

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

// One logged serving, as the correction list renders it (#1934). The aggregate counts
// above name no row, so they cannot be corrected; this carries the ledger id the ⋯ row
// action edits and the window the tallies counted it in.
export interface FoodLogEvent {
  id: number;
  groupKey: string;
  name: string;
  date: string;
  mealSlot: FoodSlot;
  // Profile-local "HH:MM" the serving was EATEN at, when one was captured (#2019);
  // null when nobody stated one. The row renders `eatenAt ?? loggedTime` (#2227
  // decision 7) — the presence split surfaces in the correction sheet, not per row.
  eatenAt: string | null;
  // Profile-local "HH:MM" of the audit/tap instant. Always present, never edited.
  loggedTime: string;
}

export interface FoodLogDay {
  date: string;
  label: string;
  counts: Record<string, number>;
  slotCounts: Record<FoodSlot, Record<string, number>>;
  events: FoodLogEvent[];
}

export default function FoodLogBar({
  today,
  days,
  groupsBySlot,
  proteinRankBySlot,
  excludedGroups,
  slot,
  slotBoundaries,
  eatingTimeOptions = [],
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
  // Where the protein pseudo-entry ranked in each meal's order (#1980): the number of
  // groups ahead of it, or null when the profile doesn't track protein yet. It positions
  // `proteinQuickAdd` among the quick rows instead of pinning it first; null puts it
  // AFTER them rather than dropping it, because direct grams have no other entry point
  // and a cold start must not be a dead end (#559).
  proteinRankBySlot?: Record<FoodSlot, number | null>;
  // Profile-scoped food groups excluded from suggestions. Edited in-place through
  // the modal rather than navigating away from the meal being logged.
  excludedGroups: string[];
  // The profile's current food window (#950), derived server-side from the same
  // computation that ranked `groups`, so the chip and the order agree. Shown as a
  // small label so the slot-aware ordering is legible ("why is fish first right now").
  slot: FoodSlot;
  // The profile's meal-window boundaries (#2227 decision 4) — what lets the correction
  // sheet derive, client-side, the meal each offered hour lands in, so the Meal select
  // can follow the chosen hour. The SAME boundaries the server's tallies use
  // (profileFoodSlotBoundaries), passed down so the sheet and the tally cannot disagree.
  slotBoundaries: FoodSlotBoundaries;
  // The "earlier…" hours an eating-time statement may name (#2053), each with the local
  // wall time to show and the instant it means. Resolved server-side from the profile's
  // timezone and already filtered to hours that land on `today`, so this island never
  // converts a profile-local hour with its own locale and never offers a chip the write
  // would refuse. Empty disables the earlier half; "now" stands on its own.
  eatingTimeOptions?: EatingTimeOption[];
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
  // The eating-time statement in force for the next taps (#2053), or null for the default
  // and honest silence: nobody said, so nothing is written. STICKY across taps on purpose
  // — a meal is several servings and re-answering "when" for each one would be the kind of
  // friction a one-tap bar exists to avoid — and reset whenever the selected DAY changes,
  // because a statement made about today cannot survive onto a backfill.
  const [eatingTime, setEatingTime] = useState<EatingTimeChoice | null>(null);
  // Whether the "earlier…" hours are revealed. The offer stays one tap deep: "now" is the
  // common answer and a dozen hours permanently on screen would bury it.
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // Optimistic daily totals and meal-slot counts live in the parent date context:
  // food_log remains the source-of-truth day counter, while food_log_events powers
  // meal history. Sharing them keeps the selected-day sidebar summary in lockstep.
  // Slugs whose serving detail is expanded (tap-to-read on mobile). Purely local.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The serving being corrected, plus its in-flight draft. Null = the modal is closed.
  // `when` is the day + eating-time PAIR the shared control owns (#2227/#2236);
  // `mealTouched` is decision 4's flag — Meal follows the chosen hour until the user
  // sets Meal by hand in this sheet.
  const [editing, setEditing] = useState<FoodLogEvent | null>(null);
  const [draft, setDraft] = useState<{
    groupKey: string;
    mealSlot: FoodSlot;
    when: WhenValue;
    mealTouched: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  // The serving whose row-scoped removal is in flight (#1963), or null. An id, so the
  // one row the user named is the only one that dims.
  const [removingId, setRemovingId] = useState<number | null>(null);
  // Which serving's ⋯ menu is open (#1488 row-action convention). Ids, not indexes.
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const toast = useToast();
  // The acting profile's timezone — the zone the correction sheet's day/time pair is
  // judged in, matching the server's own resolution of the submitted wall time.
  const tz = useTimezone();
  // Offline quick-log queue (#1596): an ADD tap with no signal queues for replay.
  const { enqueue } = useOfflineQueue();
  // The shared one-tap ledger (#2041): the optimistic bump, the rollback and the
  // adoption of the server's authoritative counts, plus the post-success cooldown that
  // absorbs a double-tap (#2007 layer 1). A serving is ADDITIVE and declares no expected
  // interval, so a deliberate second serving a moment later still lands and — the rule
  // this classification exists for — never raises a confirm.
  const ledger = useOptimisticLedger<{ day: number; meal: number }>(
    "food-serving"
  );

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

  // Where the protein control sits among the quick rows (#1980). Frozen with the row
  // order and for the same reason: logging protein re-ranks it server-side, and the
  // control must not slide out from under the finger that just tapped it.
  const frozenProteinRank = useRef<Record<FoodSlot, number | null> | null>(
    null
  );
  if (frozenProteinRank.current === null) {
    frozenProteinRank.current = Object.fromEntries(
      FOOD_SLOTS.map((meal) => [meal, proteinRankBySlot?.[meal] ?? null])
    ) as Record<FoodSlot, number | null>;
  }
  const proteinRank = frozenProteinRank.current[activeSlot];
  // Translate "N groups ranked ahead of protein" into a slice point in the QUICK set —
  // against the order the quick rows are ACTUALLY rendered in, not the ranked order they
  // are drawn from (#2061). A deep-linked group is pinned to the front of `quickGroups`
  // regardless of its rank, so the two orders differ exactly when that pin is out of
  // rank order, and a COUNT of outranking rows would then split in the wrong place.
  const rankBySlug = useMemo(
    () => new Map(orderedGroups.map((group, rank) => [group.slug, rank])),
    [orderedGroups]
  );
  const proteinSplit = proteinSplitIndex(
    // Every quick row comes from `orderedGroups`, so the fallback is unreachable; it
    // exists because Map.get is typed as possibly-missing.
    quickGroups.map(
      (group) => rankBySlug.get(group.slug) ?? orderedGroups.length
    ),
    proteinRank
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

  // Adopt the server's authoritative counts for ONE (date, group, window) coordinate
  // (#1934). A correction answers with the placement the serving LEFT and the one it
  // LANDED in; applying both — rather than incrementing here and decrementing there —
  // is what makes a slot change a MOVE and not a second serving. Note it is a SET, not
  // a delta, so replaying it can never drift.
  function applyPlacement(placement: FoodPlacement) {
    setCountsByDate((all) => {
      const day = all[placement.date] ?? {};
      return {
        ...all,
        [placement.date]: {
          ...day,
          [placement.groupKey]: placement.servings,
        },
      };
    });
    setSlotCountsByDate((all) => {
      const day = all[placement.date] ?? {
        Morning: {},
        Midday: {},
        Evening: {},
      };
      return {
        ...all,
        [placement.date]: {
          ...day,
          [placement.mealSlot]: {
            ...(day[placement.mealSlot] ?? {}),
            [placement.groupKey]: placement.mealServings,
          },
        },
      };
    });
  }

  // The bounded recent days the sheet may correct within — the same seven-day policy
  // the whole picker carries (`days` arrives today-first). The shared when-control's
  // min/max enforce it in the calendar; the save re-checks it for a typed date.
  const maxCorrectionDay = days[0]?.date ?? today;
  const minCorrectionDay = days[days.length - 1]?.date ?? today;

  function openCorrection(event: FoodLogEvent) {
    setEditing(event);
    setDraft({
      groupKey: event.groupKey,
      mealSlot: event.mealSlot,
      when: {
        date: event.date,
        // The row's stated instant, rebuilt from its local wall clock on its own day
        // (the list carries "HH:MM", minute grain — the grain this sheet displays and
        // edits at). An untouched time is OMITTED from the save below, precisely so
        // this reconstruction is never written back over a second-precision original.
        statedAt: event.eatenAt
          ? (statedInstantOnDate(
              event.date,
              event.eatenAt,
              tz
            )?.toISOString() ?? null)
          : null,
      },
      mealTouched: false,
    });
  }

  // The day + eating-time pair moved (via the shared control, which owns the pair
  // rule). Decision 4 (#2227): a newly chosen hour drags the Meal select with it —
  // each offered hour carries its derived window (eatingHoursOnDate), and a
  // minute-grain instant (a "Now" fill, the row's own pinned minute) derives through
  // the same boundary function — until the user touches Meal by hand in this sheet.
  function setCorrectionWhen(next: WhenValue) {
    setDraft((d) => {
      if (!d) return d;
      let mealSlot = d.mealSlot;
      if (
        !d.mealTouched &&
        next.statedAt !== null &&
        next.statedAt !== d.when.statedAt
      ) {
        const offered = eatingHoursOnDate(
          next.date,
          tz,
          new Date(),
          slotBoundaries
        ).find((option) => option.iso === next.statedAt);
        mealSlot =
          offered?.slot ??
          foodSlotForHhmm(statedHhmm(next.statedAt, tz), slotBoundaries);
      }
      return { ...d, when: next, mealSlot };
    });
  }

  async function saveCorrection() {
    if (!editing || !draft) return;
    // The bounded-days policy the retired Day dropdown physically enforced, kept at
    // save time for a hand-typed date: this sheet recovers a recent meal, it is not an
    // unrestricted historical editor.
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(draft.when.date) ||
      draft.when.date < minCorrectionDay ||
      draft.when.date > maxCorrectionDay
    ) {
      toast("Pick a day from the log's own recent range.", { tone: "error" });
      return;
    }
    setSaving(true);
    const fd = new FormData();
    fd.set("event_id", String(editing.id));
    fd.set("group_key", draft.groupKey);
    fd.set("date", draft.when.date);
    fd.set("meal_slot", draft.mealSlot);
    // The eating-time wire (#2227): an untouched time is OMITTED (the row's stored
    // instant — seconds included — stays byte-identical), "none" clears, "HH:MM"
    // states that wall time on the submitted day. The pair travels as (day, wall
    // time), so a day change re-anchors the statement instead of stranding an instant
    // off its own day.
    const draftHhmm = statedHhmm(draft.when.statedAt, tz) || null;
    if (draftHhmm === null) {
      if (editing.eatenAt !== null) fd.set("eaten_at", "none");
    } else if (
      draftHhmm !== editing.eatenAt ||
      draft.when.date !== editing.date
    ) {
      fd.set("eaten_at", draftHhmm);
    }
    let outcome: FoodEventEditResult;
    try {
      outcome = await updateFoodLogEvent(fd);
    } catch {
      setSaving(false);
      toast("Couldn't correct that serving — try again.", { tone: "error" });
      return;
    }
    setSaving(false);
    if (!outcome.ok) {
      toast(outcome.error, { tone: "error" });
      return;
    }
    // `from` first, then `to`: when a correction only changes the window, both name the
    // same (date, group) and the second write settles it at the post-move truth.
    applyPlacement(outcome.from);
    applyPlacement(outcome.to);
    setEditing(null);
    setDraft(null);
    toast("Serving corrected.");
  }

  // Remove the ONE serving the ⋯ menu named (#1963). The row's "−" peer is group-scoped
  // and pops the newest tap in the window, which since #1934 need not be the row the user
  // is looking at; this addresses the ledger id.
  //
  // Deliberately NOT optimistic — the server's `vacated` counts are what the bar adopts,
  // so a refused write can never leave a phantom count. It IS undoable since #2038: every
  // "remove one logged event" path in the app now offers the same Undo, and a named
  // serving carries meal-slot and eaten-at facts a re-tap would silently invent.
  //
  // The Undo is wired here rather than through `useUndoableDelete` for the one reason
  // that hook can't carry: this surface reconciles by SETTING the coordinate's
  // authoritative counts, both when the serving leaves and when it comes back, and the
  // shared hook consumes the action's result itself. Same toast, same token, same
  // undoDelete call — the bespoke seam is the count reconciliation, exactly as
  // UnitMislabelReview's is its token shape.
  async function removeServing(event: FoodLogEvent) {
    if (removingId !== null) return;
    // A delete is not a capture (the lib/offline/queue.ts scope comment), so it stays
    // online-only and says so rather than pretending, exactly as the group "−" does.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast("You're offline — removing a serving needs a connection.", {
        tone: "error",
      });
      return;
    }
    setRemovingId(event.id);
    const fd = new FormData();
    fd.set("event_id", String(event.id));
    let outcome: FoodEventDeleteResult;
    try {
      outcome = await deleteFoodLogEvent(fd);
    } catch (err) {
      setRemovingId(null);
      toast(
        shouldQueueOffline(navigator.onLine !== false, err)
          ? "You're offline — removing a serving needs a connection."
          : "Couldn't remove that serving — try again.",
        { tone: "error" }
      );
      return;
    }
    setRemovingId(null);
    if (!outcome.ok) {
      toast(outcome.error, { tone: "error" });
      return;
    }
    // The authoritative post-write counts for the coordinate the serving vacated. A SET,
    // not a delta — the same reconciliation a correction does, so a dropped or refused
    // write can never leave a phantom count behind.
    const vacated = outcome.vacated;
    applyPlacement(vacated);
    const undoId = outcome.undoId;
    toast("Serving removed.", {
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            const restored = await undoDelete(undoId);
            if (!restored.ok) {
              toast("Couldn’t undo — it may have expired.", { tone: "error" });
              return;
            }
            // The restore puts back exactly the one serving this delete took, at the
            // coordinate the server already named — so the counts move by exactly one
            // from the authoritative figures above, not from a locally guessed total.
            applyPlacement({
              ...vacated,
              servings: vacated.servings + 1,
              mealServings: vacated.mealServings + 1,
            });
            toast("Restored.");
          })();
        },
      },
    });
  }

  // An eating-time statement is a TODAY-only affordance. "Now" is meaningless on a
  // backfill, and the whole point of the NULL default is that a log with nothing to state
  // records no eating time rather than a confident wrong one — which is exactly what a
  // seven-day-old serving has. So the chips are hidden and the statement is not written
  // while an older day is selected; it is still visible (and still pressed) on returning
  // to today, so nothing is silently in force.
  const statingTime = activeDate === today;
  const statedChoice = statingTime ? eatingTime : null;

  // The instant an OFFLINE capture carries for the statement in force, or null. Resolved
  // here rather than at replay because a replay has no server to ask: "now" is this
  // device's clock at the tap, and an "earlier…" hour is the instant the server already
  // computed for that option. Both are validated server-side before they land.
  function statedInstant(): string | null {
    if (!statedChoice) return null;
    if (statedChoice.kind === "now") return new Date().toISOString();
    return (
      eatingTimeOptions.find((o) => o.hhmm === statedChoice.hhmm)?.iso ?? null
    );
  }

  // The meal window the statement in force FILES under (#2269) — the section a "+" will
  // land the serving in, since a stated time wins over the tab at log time. An "earlier…"
  // hour carries its server-derived slot on the option; "now" derives from the current
  // wall clock through the same boundaries the server's tallies use. Null when no
  // statement is in force — the tab's declaration is then the only fact and the serving
  // files under it.
  function statedFilingSlot(): FoodSlot | null {
    if (!statedChoice) return null;
    if (statedChoice.kind === "at")
      return (
        eatingTimeOptions.find((o) => o.hhmm === statedChoice.hhmm)?.slot ??
        null
      );
    return foodSlotForHhmm(
      statedHhmm(new Date().toISOString(), tz),
      slotBoundaries
    );
  }

  // The pair of counts one tap moves: the day's total for the group, and the group's
  // total inside the meal window under the user's finger. They travel together — the
  // optimistic bump, the rollback and the server's authoritative figures all name both
  // — so the ledger carries them as one slice.
  type ServingCounts = { day: number; meal: number };

  async function bump(slug: string, delta: 1 | -1) {
    // WHERE the tap lands (#2269): an add with a statement in force files under the
    // stated time's derived window — the tab stays navigation, the chip stated the
    // consequence — so the optimistic bump moves THAT section's count, not the cell
    // being looked at. An undo (and an add with no statement) stays tab-scoped.
    const filingSlot = (delta === 1 ? statedFilingSlot() : null) ?? activeSlot;
    const before: ServingCounts = {
      day: counts[slug] ?? 0,
      meal: slotCountsByDate[activeDate]?.[filingSlot]?.[slug] ?? 0,
    };
    const commit = (next: ServingCounts) => {
      setCount(slug, () => next.day);
      setSlotCount(filingSlot, slug, () => next.meal);
    };
    // Queue an ADD tap while offline (#1596): the captured slug + the meal window
    // and day under the user's finger replay through the same write core on
    // reconnect, so a kitchen-moment tap never fails. The optimistic count stands
    // in for the server total until then. UNDO stays online-only — a decrement is
    // not a capture (see the lib/offline/queue.ts scope comment) — so an offline
    // "−" rolls back with an honest message instead of pretending.
    const queueOffline = async () => {
      await enqueue("food", activeDate, {
        entry: "serving",
        groupKey: slug,
        mealSlot: activeSlot,
        grams: null,
        // The statement travels as a RESOLVED instant, because a replay has no server to
        // resolve a choice against: "now" is this device's clock at the tap, and an
        // "earlier…" hour is the instant the server computed when it rendered that
        // option. The replay validates both (acceptEatenAt) rather than trusting them,
        // and an unusable one costs the statement, never the serving.
        eatenAt: statedInstant(),
      });
      toast("Saved offline — will sync when you reconnect.");
    };
    const undoNeedsConnection = () => {
      toast("You're offline — removing a serving needs a connection.", {
        tone: "error",
      });
    };
    // Whether the tap reached a write at all, and what the write said — modeled so
    // the ledger sees exactly one settlement per tap.
    type ServingTap =
      | { kind: "queued" }
      | { kind: "offline-undo" }
      | { kind: "wrote"; outcome: FoodLogResult };
    await ledger.tap<ServingTap>({
      // The key names the WRITE, not the row: a "−" correction straight after a "+"
      // is a different write and must not be absorbed by its cooldown. Two taps of
      // the same row's "+" — the accidental double — share this key and are. Keyed on
      // the FILING slot (#2269), the coordinate the write actually moves.
      key: `${activeDate}:${filingSlot}:${slug}:${delta}`,
      from: before,
      // Optimistic: reflect the tap immediately.
      optimistic: {
        day: Math.max(0, before.day + delta),
        meal: Math.max(0, before.meal + delta),
      },
      commit,
      write: async () => {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          if (delta === -1) return { kind: "offline-undo" };
          await queueOffline();
          return { kind: "queued" };
        }
        const fd = new FormData();
        fd.set("group_key", slug);
        fd.set("date", activeDate);
        fd.set("meal_slot", activeSlot);
        // The CHOICE, not an instant: online the server resolves it against its own clock
        // and the profile's timezone, so a tab open since breakfast cannot stamp a stale
        // "now". Only an add states a time — an undo removes a serving and asserts
        // nothing about when anything was eaten.
        if (statedChoice && delta === 1)
          fd.set("eaten_at", eatingTimeChoiceValue(statedChoice));
        return {
          kind: "wrote",
          outcome:
            delta === 1 ? await logFoodServing(fd) : await undoFoodServing(fd),
        };
      },
      settle: (tap) => {
        if (tap.kind === "queued") return { kind: "keep" };
        if (tap.kind === "offline-undo") {
          undoNeedsConnection();
          return { kind: "rollback" };
        }
        const outcome = tap.outcome;
        if (outcome.ok) {
          // Reconcile with the server's authoritative daily total (#748 item 2) so a
          // dropped/failed write can never leave a phantom count.
          return {
            kind: "adopt",
            value: {
              day: outcome.servings,
              // The server's meal figure is adopted only when it names the slot this
              // tap's optimistic bump moved (#2269) — a tap racing an hour boundary can
              // derive one window client-side and land in the neighbor server-side, and
              // adopting that count HERE would write it to the wrong coordinate. The
              // action's revalidation settles the rare mismatch on the next render.
              // A write that reports no meal figure (an undo that emptied the window)
              // also leaves the optimistic one standing rather than inventing one.
              meal:
                outcome.mealSlot === filingSlot && outcome.mealServings != null
                  ? outcome.mealServings
                  : Math.max(0, before.meal + delta),
            },
          };
        }
        // Roll back this tap and tell the user it didn't stick.
        toast(outcome.error || "Couldn't save that serving — try again.", {
          tone: "error",
        });
        return { kind: "rollback" };
      },
      onError: async (err) => {
        // Connection dropped mid-tap — queue an add instead of a false failure.
        if (shouldQueueOffline(navigator.onLine !== false, err)) {
          if (delta === 1) {
            await queueOffline();
            return { kind: "keep" };
          }
          undoNeedsConnection();
          return { kind: "rollback" };
        }
        toast("Couldn't save that serving — try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
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
  // The active day's individual servings, straight from the server (#1934). Deliberately
  // NOT mirrored into local state: every write here goes through an action that
  // revalidates /nutrition, so the action's own response already carries the corrected
  // list — a local copy could only drift from it.
  const loggedEvents = activeDay.events;
  // The whole catalog for the correction picker, alphabetical. The LOGGING rows are
  // frecency-ranked (#591) because they predict the next tap; a correction is a lookup
  // of a group you already know the name of, so ranking would only hide it.
  const catalogGroups = useMemo(
    () =>
      [...groupsBySlot[FOOD_SLOTS[0]]].sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    [groupsBySlot]
  );

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
                    <span
                      data-testid={`food-slot-total-${meal.toLowerCase()}`}
                      className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
                    >
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
        {loggedEvents.length > 0 && (
          <section data-testid="food-logged-list">
            <h3 className="mb-2 section-label">
              Logged {activeDay.label.toLowerCase()}
            </h3>
            <ul className="space-y-1">
              {loggedEvents.map((event) => (
                <li
                  key={event.id}
                  data-testid={`food-logged-${event.id}`}
                  data-slot={event.mealSlot}
                  data-group={event.groupKey}
                  aria-busy={removingId === event.id || undefined}
                  className={`flex items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-1.5 text-sm dark:border-white/10 dark:bg-ink-900 ${
                    removingId === event.id ? "opacity-50" : ""
                  }`}
                >
                  <FoodGroupIcon
                    slug={event.groupKey}
                    className="h-4 w-4 shrink-0 text-slate-400"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100">
                    {event.name}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                    {event.mealSlot} · {event.eatenAt ?? event.loggedTime}
                  </span>
                  <OverflowMenu
                    label={
                      // The accessible name says which time it names: "logged at" over
                      // an EATING time was a wrong claim (#2227).
                      event.eatenAt
                        ? `Actions for the ${event.name} serving eaten at ${event.eatenAt}`
                        : `Actions for the ${event.name} serving logged at ${event.loggedTime}`
                    }
                    open={openMenuId === event.id}
                    onOpenChange={(next) =>
                      setOpenMenuId(next ? event.id : null)
                    }
                  >
                    {({ close }) => (
                      <>
                        <button
                          type="button"
                          className={MENU_ITEM}
                          data-testid={`food-logged-correct-${event.id}`}
                          onClick={() => {
                            close();
                            openCorrection(event);
                          }}
                        >
                          Correct this serving
                        </button>
                        <button
                          type="button"
                          className={MENU_ITEM_DANGER}
                          data-testid={`food-logged-remove-${event.id}`}
                          onClick={() => {
                            close();
                            void removeServing(event);
                          }}
                        >
                          Remove this serving
                        </button>
                      </>
                    )}
                  </OverflowMenu>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section data-testid="food-quick-log">
          <h3 className="mb-2 section-label">Add to {activeSlot}</h3>
          {statingTime && (
            <div
              data-testid="food-eating-time"
              role="group"
              aria-label="When the servings you add were eaten"
              className="mb-2.5 flex flex-wrap items-center gap-1.5"
            >
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Eaten
              </span>
              <button
                type="button"
                data-testid="food-eating-now"
                aria-pressed={statedChoice?.kind === "now"}
                title="Record the servings you add as eaten now"
                onClick={() => {
                  setEarlierOpen(false);
                  setEatingTime((prev) =>
                    prev?.kind === "now" ? null : { kind: "now" }
                  );
                }}
                className={chipClass(statedChoice?.kind === "now")}
              >
                Now
              </button>
              {eatingTimeOptions.length > 0 && (
                <button
                  type="button"
                  data-testid="food-eating-earlier"
                  aria-expanded={earlierOpen}
                  title="State an earlier time instead"
                  onClick={() => setEarlierOpen((open) => !open)}
                  className={chipClass(statedChoice?.kind === "at")}
                >
                  {/* The pressed chip keeps announcing the filing (#2269): the hour
                      wins over the tab, so `19:00 \u00b7 Evening` is what the next "+"
                      will actually do. */}
                  {statedChoice?.kind === "at"
                    ? `${statedChoice.hhmm} \u00b7 ${
                        eatingTimeOptions.find(
                          (o) => o.hhmm === statedChoice.hhmm
                        )?.slot ?? activeSlot
                      }`
                    : "Earlier\u2026"}
                </button>
              )}
              {earlierOpen &&
                eatingTimeOptions.map((option) => (
                  <button
                    key={option.hhmm}
                    type="button"
                    data-testid={`food-eating-at-${option.hhmm}`}
                    data-slot={option.slot}
                    aria-pressed={
                      statedChoice?.kind === "at" &&
                      statedChoice.hhmm === option.hhmm
                    }
                    onClick={() => {
                      setEarlierOpen(false);
                      setEatingTime((prev) =>
                        prev?.kind === "at" && prev.hhmm === option.hhmm
                          ? null
                          : { kind: "at", hhmm: option.hhmm }
                      );
                    }}
                    className={chipClass(
                      statedChoice?.kind === "at" &&
                        statedChoice.hhmm === option.hhmm
                    )}
                  >
                    {/* The chip states the CONSEQUENCE before the tap (#2269): the
                        hour AND the meal window it files under \u2014 the #2268 correction
                        sheet's per-hour enrichment, worn at log time. The tab stays
                        navigation; a stated time wins the filing. */}
                    {`${option.hhmm} \u00b7 ${option.slot}`}
                  </button>
                ))}
              <span
                data-testid="food-eating-time-note"
                className="w-full text-xs text-slate-500 dark:text-slate-400"
              >
                {statedChoice
                  ? `Servings you add are recorded as eaten ${
                      statedChoice.kind === "now"
                        ? "now"
                        : `at ${statedChoice.hhmm}`
                    }${
                      // The filing named OUT LOUD when it leaves the active tab
                      // (#2269): a serving stating 19:00 from the Morning tab lands
                      // in Evening, and the answer text says so before the tap does.
                      (() => {
                        const filing = statedFilingSlot();
                        return filing && filing !== activeSlot
                          ? ` and land in ${filing}`
                          : "";
                      })()
                    }.`
                  : "Servings you add record no eating time until you say one."}
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            {proteinSplit > 0 && rows(quickGroups.slice(0, proteinSplit))}
            {activeDate === today && proteinQuickAdd}
            {proteinSplit < quickGroups.length &&
              rows(quickGroups.slice(proteinSplit))}
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
      {editing && draft && (
        <ModalShell
          title="Correct this serving"
          onClose={() => {
            setEditing(null);
            setDraft(null);
          }}
          className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <div data-testid="food-correct-modal" className="mt-4 space-y-3">
            <p
              data-testid="food-correct-provenance"
              className="text-xs text-slate-500 dark:text-slate-400"
            >
              {/* The one place the eating-time/tap split is answered (#2227 decision
                  7): the binary a reader cares about is whether an eating time exists
                  at all, and "Logged at" over an eating time was a wrong claim. */}
              {editing.eatenAt
                ? `Ate at ${editing.eatenAt}.`
                : `No eating time recorded — logged at ${editing.loggedTime}.`}{" "}
              Correcting moves this serving — the day&rsquo;s totals and meal
              tallies follow it.
            </p>
            <div>
              <label className="label" htmlFor="food-correct-group">
                Food group
              </label>
              <select
                id="food-correct-group"
                data-testid="food-correct-group"
                className="input py-1.5 text-sm"
                value={draft.groupKey}
                onChange={(e) =>
                  setDraft((d) => d && { ...d, groupKey: e.target.value })
                }
              >
                {catalogGroups.map((group) => (
                  <option key={group.slug} value={group.slug}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="label">When</span>
              {/* The day + eating-time PAIR, owned together by the shared control
                  (#2227/#2236): hour grain (the data's own precision), correct mode
                  ("Not stated" is first and clears), bounded to the same recent days
                  the retired Day dropdown offered. `logged_at` is deliberately not
                  here — the tap instant is audit history, never editable. */}
              <WhenControl
                mode="correct"
                grain="hour"
                value={draft.when}
                onChange={setCorrectionWhen}
                minDate={minCorrectionDay}
                maxDate={maxCorrectionDay}
                dateLabel="Day"
                timeLabel="Time eaten"
                testId="food-correct-time"
              />
            </div>
            <div>
              <label className="label" htmlFor="food-correct-slot">
                Meal
              </label>
              <select
                id="food-correct-slot"
                data-testid="food-correct-slot"
                className="input py-1.5 text-sm"
                value={draft.mealSlot}
                onChange={(e) =>
                  // A hand-set Meal wins from here on: the follow-the-hour default
                  // (decision 4) stops moving it once the user has spoken.
                  setDraft(
                    (d) =>
                      d && {
                        ...d,
                        mealSlot: e.target.value as FoodSlot,
                        mealTouched: true,
                      }
                  )
                }
              >
                {FOOD_SLOTS.map((meal) => (
                  <option key={meal} value={meal}>
                    {meal}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-black/10 pt-3 dark:border-white/10">
            <button
              type="button"
              data-testid="food-correct-cancel"
              className="btn-ghost"
              onClick={() => {
                setEditing(null);
                setDraft(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="food-correct-save"
              className="btn"
              disabled={saving}
              onClick={saveCorrection}
            >
              {saving ? "Saving…" : "Save correction"}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
