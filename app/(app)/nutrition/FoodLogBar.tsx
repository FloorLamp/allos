"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconPlus, IconMinus, IconChevronDown } from "@tabler/icons-react";
import type { FoodGroup, FoodGroupTier } from "@/lib/food-groups";
import { FOOD_QUICK_COUNT, proteinSplitIndex } from "@/lib/food-rank";
import {
  FOOD_SLOTS,
  foodSlotForHhmm,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
import {
  statedHhmm,
  statedInstantOnDate,
  STATED_TIME_REFUSAL_NOTE,
} from "@/lib/stated-time";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import FoodGroupIcon, {
  FOOD_GROUP_TIER_TINT,
} from "@/components/FoodGroupIcon";
import ModalShell from "@/components/ModalShell";
import IntakeContextBar from "@/components/IntakeContextBar";
import {
  useClaimToastKey,
  useDismissToast,
  useToast,
  useToastProfileScopeGetter,
} from "@/components/Toast";
import RollingNumber from "@/components/RollingNumber";
import { useUndoableAction } from "@/components/useUndoableAction";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
// The list-naming phrase is shared with the dashboard's composed control (#2458), so
// the Food tab and the dashboard can never name a write differently.
import { namesPhrase } from "@/lib/usual-routine";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  foodServingCoordinate,
  foodServingFeedback,
  foodServingInverseKey,
  foodServingToastKey,
  beginFoodServingAdd,
  beginFoodServingNonAddMutation,
  dropFoodServingAdd,
  emptyFoodServingBurst,
  finishFoodServingNonAddMutation,
  requestFoodServingTruth,
  settleFoodServingAdd,
  type FoodServingAddTap,
  type FoodServingBurstSettlement,
  type FoodServingBurstState,
} from "@/lib/food-serving-feedback";
import { microMotionPlan } from "@/lib/micro-motion";
import { useActiveProfileId } from "@/components/ActiveProfileProvider";
import { UNDO_TOAST_MS } from "@/components/useUndoableDelete";
import { undoDelete } from "@/app/(app)/undo-actions";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { eatingHoursOnDate } from "@/lib/food-eating-time";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import DietaryPreferencesForm from "@/app/(app)/settings/profile/DietaryPreferencesForm";
import { usualFoodOffer } from "@/lib/food-regularity";
import { foodLimitNoteText } from "@/lib/food-limit-note";
import { applyFoodServingPlacements } from "@/lib/food-serving-projection";
import type { ProfileToastScope } from "@/lib/toast-upsert";
import { endFastAction, undoEndFastAction } from "./fast-actions";
import {
  deleteFoodLogEvent,
  logFoodServing,
  logUsualFood,
  readFoodServingTruth,
  undoFoodServing,
  updateFoodLogEvent,
  type FoodEventDeleteResult,
  type FoodEventEditResult,
  type FoodLogResult,
  type FoodServingTruthResult,
  type UsualFoodResult,
} from "./actions";
import {
  useFoodSelectedDate,
  type FoodProjectionState,
} from "./FoodSuggestionsLayout";
import Disclosure from "@/components/Disclosure";
import SegmentedControl from "@/components/SegmentedControl";
import DayLedger from "./DayLedger";
import type { LedgerGroup } from "@/lib/day-ledger";
import type { KeepApartWarning } from "@/lib/intake-pairs";
import type { DisplayFormatPrefs } from "@/lib/settings";

// Where one corrected serving landed, with the server's authoritative counts for that
// coordinate. Named off the action's result so the bar and the write core can never
// drift on the shape.
type FoodPlacement = Extract<FoodEventEditResult, { ok: true }>["from"];
type FoodServingTruth = Extract<FoodServingTruthResult, { ok: true }>;
type FoodNoticeScope = ProfileToastScope;

// One-tap food-group serving logger (issue #579), modeled on the dose-confirm one-tap
// bar (components/DoseStatusControl): optimistic local counts, a Server Action per tap,
// undo = decrement. The `groups` prop arrives pre-ordered by ONE ranking — the profile's
// staples first (frequency + recency + slot proximity, #591/#950/#2019) — and the quick
// rows are simply its head (#2225). Tier (encourage → neutral → limit) sections the
// "More food groups" overflow; it never moves a group into or out of the fast path.
//
// DENSE ROWS, FOR EVERYONE (#3987, owner rejected per-profile sizing). A row is an icon,
// a name and a stepper on ONE line. The per-row serving sentence and the eat-more/eat-less
// tags are gone — Telegram dropped the guidance tags first and the web follows, and the
// phone disclosure that existed only to unfold the serving sentence went with it. The
// tier vocabulary survives exactly where it still does work: as the overflow's section
// headings.
//
// The row order is FROZEN for the life of this mount: the server re-ranks by
// recency-decayed frequency on every read, so the server re-render each tap's action
// triggers would otherwise reorder the list under the user's finger — jarring right
// where they just tapped.

const TIER_ORDER: FoodGroupTier[] = ["encourage", "neutral", "limit"];
const TIER_LABEL: Record<FoodGroupTier, string> = {
  encourage: "Eat more",
  neutral: "Balance",
  limit: "Eat less",
};

// What a food row SAYS about its group — the name, its tier badge, and the serving
// line — in ONE component (#2305). It used to be written twice, once inside the phone
// disclosure button and once inside the `md:block` static twin, and only the phone copy
// carried testids: at a desktop viewport `getByTestId("food-tier-…").toHaveText(…)` was
// therefore passing against a `md:hidden` element (`toHaveText` does not require
// visibility) while the badge people actually see was covered by nothing. The two copies
// had already drifted — the desktop name span had lost `truncate`, so a long name wrapped
// there and pushed the row taller instead of clipping — which is exactly the failure mode
// a second, untested copy produces.
//
// The wrappers still differ, because they genuinely do: on a phone the label is a
// disclosure BUTTON that expands the truncated serving line, above `md` it is static text.
// Only the wrapper is per-breakpoint; the content is this.
//
// Both mounts are in the DOM at every width, so the testids follow the ProfileIdentityBar
// convention: the same ids declared once here, with the phone mount suffixed `-mobile`.
// The UNSUFFIXED ids belong to the mount that is visible at desktop widths, which is where
// the default Playwright project runs — so an assertion on `food-tier-<slug>` now names
// something a person can see.
function FoodRowLabel({ group }: { group: FoodGroup }) {
  return (
    <span
      data-testid={`food-name-${group.slug}`}
      className="block truncate font-medium text-slate-800 dark:text-slate-100"
    >
      {group.name}
    </span>
  );
}

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
  usualBySlot,
  slot,
  slotBoundaries,
  initialFoodGroup,
  nutrientSummaryByDate = [],
  proteinQuickAdd,
  ledgerDoor,
  dayLedger,
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
  // The groups this profile logs in each window nearly every time it logs that window
  // at all (#2380) — the HABITUAL set, share-descending, cap-direction groups already
  // removed server-side. A window under the declared gate is an empty list, which
  // renders as nothing: silence, not a hedge. Optional and defaulted, so a surface that
  // has no use for the shortcut (the global quick-entry sheet) simply omits it.
  usualBySlot?: Record<FoodSlot, string[]>;
  // The profile's current food window (#950), derived server-side from the same
  // computation that ranked `groups`, so the chip and the order agree. Shown as a
  // small label so the slot-aware ordering is legible ("why is fish first right now").
  slot: FoodSlot;
  // The profile's meal-window boundaries (#2227 decision 4) — what lets the correction
  // sheet derive, client-side, the meal each offered hour lands in, so the Meal select
  // can follow the chosen hour. The SAME boundaries the server's tallies use
  // (profileFoodSlotBoundaries), passed down so the sheet and the tally cannot disagree.
  slotBoundaries: FoodSlotBoundaries;
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
  // The door to the food ledger (#3671), mounted in the day header beside the log
  // it opens rather than in a row of its own above the fasting card.
  ledgerDoor?: ReactNode;
  // THE DAY, ALREADY BUILT (#3987). Server-gathered per bounded date and handed down
  // whole rather than re-derived here: the grouping, the composed collapse and the
  // ordering are `lib/day-ledger.ts`'s, asserted at the unit tier. Optional, because
  // the quick-log sheet mounts this bar to WRITE and has no day to review.
  dayLedger?: {
    groupsByDate: Record<string, LedgerGroup[]>;
    // The days a dose write would be accepted on — `doseLogDays`, resolved server-side
    // off DOSE_LOG_DATE_WINDOW_DAYS, so this surface can never offer a tap the core
    // would refuse and never withhold one it would accept.
    doseWritableDates: string[];
    prefs: DisplayFormatPrefs;
    keepApart: { bucket: string; warnings: KeepApartWarning[] }[];
    dayContext: string | null;
  };
}) {
  const {
    activeDate,
    setActiveDate,
    countsByDate,
    slotCountsByDate,
    setProjection,
  } = useFoodSelectedDate();
  const activeProfileId = useActiveProfileId();
  // This component only mounts in the authenticated app shell, under
  // ActiveProfileProvider. The fallback keeps story/static mounts inert rather
  // than inventing a cross-profile target.
  const receiptProfileId = activeProfileId ?? 0;
  const projectionRef = useRef<FoodProjectionState>({
    countsByDate,
    slotCountsByDate,
  });
  // LIVE FROM RENDER, DELIBERATELY. The async settle paths below read this the moment
  // a tap lands, which can be after commit but before passive effects, so an effect
  // would hand them the PREVIOUS render's value. `react-hooks/refs` only began
  // reporting these two writes when #3273 simplified the eating-time block enough for
  // the compiler to analyse this component at all — the writes themselves are
  // unchanged and pre-date it.
  // eslint-disable-next-line react-hooks/refs
  projectionRef.current = { countsByDate, slotCountsByDate };
  const [activeSlot, setActiveSlot] = useState<FoodSlot>(slot);
  // The eating-time statement in force for the next taps (#2053), through the app's ONE
  // "when did this happen?" control (#2236/#3273) — the hand-rolled Now/Earlier… chip
  // group that used to sit here was this file's SECOND time vocabulary, three hundred
  // lines from the correction modal's WhenControl. `statedAt: null` is the default and
  // honest silence: nobody said, so nothing is written. STICKY ACROSS TAPS on purpose —
  // a meal is several servings and re-answering "when" for each one would be the kind of
  // friction a one-tap bar exists to avoid.
  //
  // STICKY FOR THE BATCH, AND THE BATCH IS A DAY (#4118's amendment). The statement used
  // to be discarded outright whenever the selected day was not today; a past day now
  // takes one, because "8pm on Tuesday" is a perfectly honest thing to say about a meal
  // you are reconstructing — what is dishonest is fabricating an instant nobody named,
  // which the NULL default already refuses. Switching days CLEARS it rather than
  // re-anchoring: a time chosen for Tuesday is a claim about Tuesday, and carrying it to
  // Wednesday would restate it about a day the person never looked at.
  const [eatingWhen, setEatingWhen] = useState<WhenValue>({
    date: today,
    statedAt: null,
  });
  // The fold's own state, so switching days can close it along with the statement it
  // was showing.
  const [whenOpen, setWhenOpen] = useState(false);
  // WHICH SURFACE THIS BAR IS ON (#3087). The same component renders on the Food
  // tab, on the dashboard and inside the quick-log sheet; the server cannot tell
  // them apart, so the mounting declares itself and this stamps every post with it.
  const stampLoggedVia = useLoggedViaStamp();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // Optimistic daily totals and meal-slot counts live in the parent date context:
  // food_daily_totals remains the source-of-truth day counter, while food_log_events powers
  // meal history. Sharing them keeps the selected-day sidebar summary in lockstep.
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
  const correctionUiGeneration = useRef(0);
  // The serving whose row-scoped removal is in flight (#1963), or null. An id, so the
  // one row the user named is the only one that dims.
  const [removingId, setRemovingId] = useState<number | null>(null);
  const removalUiGeneration = useRef(0);
  const toast = useToast();
  const dismissToast = useDismissToast();
  const claimToastKey = useClaimToastKey();
  const announceUndoable = useUndoableAction();
  const toastLifecycles = useRef(new Map<string, symbol>());
  const cleanupLifecycles = useRef(new Map<string, symbol>());
  const reserveToastLifecycle = (
    key: string,
    dismissCurrent = true,
    cleanupOnUnmount = true
  ) => {
    const owner = Symbol(key);
    toastLifecycles.current.set(key, owner);
    if (cleanupOnUnmount) cleanupLifecycles.current.set(key, owner);
    claimToastKey(key, owner, dismissCurrent);
    return owner;
  };
  // "End your fast?" (#2756). A FOLLOW-UP OFFER beside a log that has ALREADY landed —
  // never a confirm-before-write, and the serving is on the counter whatever happens
  // next. DECLINING IS DOING NOTHING: the toast times out on its own and the fast is
  // untouched, because the app never auto-ends one. The TAP is the write, and it goes
  // through the same end core the Nutrition control does — which re-derives the active
  // fast under its own lock, so accepting after the fast was ended on another device
  // reports "No fast is running" instead of confirming (#2756's prompt race).
  //
  // KEYED, so one landing produces one prompt: two quick taps replace the toast in
  // place rather than stacking the same question twice.
  //
  // AND THE END IT WRITES CARRIES THE SAME UNDO THE NUTRITION CARD OFFERS. This is the
  // likelier route into that write, not the rarer one: `promptsEndOfFast` has no
  // staleness term, so it fires just as readily for a fast that has been open for weeks
  // — and by then #2757's stand-down has released, food nudges are back on, and the user
  // is MORE likely to be here logging a serving. One tap then records a very long fast,
  // which is precisely the write somebody most wants back. Offering the way back on the
  // card and not here would make recovery depend on which control the tap came from.
  //
  // The id comes from the action (./fast-actions), which supplies it only when the reopen
  // behind it would be accepted — so a restricted profile's close-out through this same
  // toast draws no Undo, exactly as its card does, and this island asks no life-stage
  // question of its own.
  const undoEnd = (
    scope: FoodNoticeScope | null,
    undoFastId: number,
    owner: symbol
  ) => {
    if (!isMountedProfile()) return;
    const fd = new FormData();
    fd.set("id", String(undoFastId));
    void undoEndFastAction(fd).then((back) => {
      if (!isMountedProfile()) return;
      profileToast(scope, back.ok ? back.message : back.error, {
        key: "end-fast-offer",
        owner,
        onlyIfOwner: true,
        ...(back.ok ? {} : { tone: "error" as const }),
      });
    });
  };
  const offerEndFast = (
    scope: FoodNoticeScope | null,
    offered: true | undefined,
    owner: symbol
  ) => {
    if (!offered || !isMountedProfile()) return;
    profileToast(scope, "Serving logged. End your fast?", {
      key: "end-fast-offer",
      owner,
      onlyIfOwner: true,
      action: {
        label: "End fast",
        onClick: () => {
          if (!isMountedProfile()) return;
          void endFastAction(new FormData()).then((r) => {
            if (!isMountedProfile()) return;
            const undoFastId = r.ok ? r.undoFastId : undefined;
            profileToast(scope, r.ok ? r.message : r.error, {
              key: "end-fast-offer",
              owner,
              onlyIfOwner: true,
              ...(r.ok ? {} : { tone: "error" as const }),
              ...(undoFastId != null
                ? {
                    action: {
                      label: "Undo",
                      onClick: () => undoEnd(scope, undoFastId, owner),
                    },
                  }
                : {}),
            });
          });
        },
      },
    });
  };
  // The acting profile's timezone — the zone the correction sheet's day/time pair is
  // judged in, matching the server's own resolution of the submitted wall time.
  const tz = useTimezone();
  // Offline quick-log queue (#1596): an ADD tap with no signal queues for replay.
  const { enqueue } = useOfflineQueue();
  // The shared one-tap ledger (#2041): optimistic bump, rollback, and adoption of
  // the server's authoritative counts. A serving is ADDITIVE and declares no
  // expected interval, so repeats never raise a confirm; #3611 keys each add tap
  // independently so a rapid sequence lands in full.
  const ledger = useOptimisticLedger<{ day: number; meal: number }>(
    "food-serving"
  );
  // Serving taps are ADDITIVE: three quick taps are three servings, not one tap
  // plus two swallowed repeats (#3611). A per-tap key lets the existing ledger
  // guard each request independently while the toast key below deliberately stays
  // stable and cumulative.
  // The toast key is stable, but each OFFERED inverse is a distinct write. A
  // second add after Undo must not inherit the first inverse's cooldown.
  const servingInverseSequence = useRef(0);
  // Pending add identity for each full rendered/write coordinate. Response totals
  // are deliberately not ordered or combined here; the final response triggers
  // one current snapshot below.
  const servingBursts = useRef(new Map<string, FoodServingBurstState>());
  const deferredServingTruth = useRef(
    new Map<string, { date: string; slug: string }>()
  );
  const getToastProfileScope = useToastProfileScopeGetter();
  const currentReceiptProfileScope = (): FoodNoticeScope | null => {
    const scope = getToastProfileScope();
    return scope?.profileId === activeProfileId ? scope : null;
  };
  // An old async completion may outlive a same-component profile transition. The
  // profile coordinate joins the burst epoch guard so it cannot reconcile one
  // subject's counts into the next subject's mounted bar.
  const activeProfileRef = useRef<number | null | undefined>(activeProfileId);
  // eslint-disable-next-line react-hooks/refs -- same reason as projectionRef above.
  activeProfileRef.current = activeProfileId;
  // A hydration-replayed/discrete interaction may run after commit but before
  // passive effects. The bar is live from render; cleanup is the only transition
  // that makes this origin stale.
  const barMountedRef = useRef(true);
  useLayoutEffect(() => {
    const lifecycles = cleanupLifecycles.current;
    activeProfileRef.current = activeProfileId;
    barMountedRef.current = true;
    return () => {
      // The provider is keyed by subject, but this bar's promises outlive its
      // subtree. Invalidate both identity and mutation state before any old
      // completion can publish another subject's projection. Root toast tokens
      // reject cross-profile notes; this mounted origin additionally gates every
      // local-state success claim and action-bearing receipt.
      for (const [key, owner] of lifecycles) dismissToast(key, owner);
      barMountedRef.current = false;
      activeProfileRef.current = undefined;
      correctionUiGeneration.current += 1;
      removalUiGeneration.current += 1;
    };
  }, [activeProfileId, dismissToast]);

  function isMountedProfile() {
    return (
      barMountedRef.current && activeProfileRef.current === activeProfileId
    );
  }

  function profileToast(
    scope: FoodNoticeScope | null,
    message: string,
    options: Parameters<typeof toast>[1] = {}
  ) {
    // The token is the toast provider's profile GENERATION, not only the subject
    // id. A completion from an unmounted A bar is therefore refused after A→B,
    // logout, or a later A session even if an async path misses a local guard.
    if (!scope) return;
    toast(message, {
      ...options,
      profileId: scope.profileId,
      profileToken: scope.token,
    });
  }

  // The row itself is the immediate receipt. A successful add gets the shipped
  // settle token; reduced motion keeps the same count/button end state and simply
  // schedules no class. One timer per slug keeps independent rows independent.
  const reducedMotion = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reducedMotion);
  const [settlingCoordinates, setSettlingCoordinates] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = settleTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  function settleServing(coordinate: string) {
    if (!settlePlan.animate) return;
    const running = settleTimers.current.get(coordinate);
    if (running) clearTimeout(running);
    setSettlingCoordinates((current) => new Set(current).add(coordinate));
    settleTimers.current.set(
      coordinate,
      setTimeout(() => {
        settleTimers.current.delete(coordinate);
        setSettlingCoordinates((current) => {
          const next = new Set(current);
          next.delete(coordinate);
          return next;
        });
      }, settlePlan.ms)
    );
  }
  // The "log my usual <window>" shortcut (#2380) is its OWN affordance, not a batch of
  // serving taps: it is idempotent (its contents are the habitual groups this window
  // still has nothing logged for, so a second tap has nothing to offer) and answered
  // from its typed outcome, because a stale offer must refuse rather than confirm.
  // A separate ledger so its cooldown never absorbs a real "+" beside it.
  const usualLedger =
    useOptimisticLedger<Record<string, ServingCounts>>("food-usual");

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
  const [frozenOrder] = useState<Record<FoodSlot, string[]>>(
    () =>
      Object.fromEntries(
        FOOD_SLOTS.map((meal) => [
          meal,
          groupsBySlot[meal].map((group) => group.slug),
        ])
      ) as Record<FoodSlot, string[]>
  );
  const orderedGroupsBySlot = useMemo(
    () =>
      Object.fromEntries(
        FOOD_SLOTS.map((meal) => {
          const idx = new Map(frozenOrder[meal].map((slug, i) => [slug, i]));
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
    [groupsBySlot, frozenOrder]
  );
  const orderedGroups = orderedGroupsBySlot[activeSlot];

  // The quick set is the HEAD of the frozen row order — the first FOOD_QUICK_COUNT of
  // this meal's ranked groups, exactly the slice the Telegram nudge takes off the same
  // ranking (#2225). It is frozen with the order and for the same reason: the server
  // re-ranks on every read, so a live re-rank would move rows out from under the finger
  // that just tapped one.
  //
  // There used to be a tier QUOTA here (4 encourage / 1 neutral / 1 limit, each slot
  // filled by the top-ranked unselected group of that tier). It was the capped demotion
  // #1980 reversed, expressed as selection instead of weight, and it made the page and
  // the chat show a different six for the same window. Tier still LABELS a row and
  // SECTIONS the overflow below; it does not decide which are fast. The slot-`logged`
  // pre-sort that fed the quota went with it — `rankFoodGroups` already carries a slot
  // signal with #2019's proximity weighting, and the boost was a second, cruder
  // derivation of that one question (#221).
  //
  // The complete remainder is always one disclosure away (#559).
  const [quickSlugs] = useState<Record<FoodSlot, Set<string>>>(
    () =>
      Object.fromEntries(
        FOOD_SLOTS.map((meal) => [
          meal,
          new Set(
            orderedGroupsBySlot[meal]
              .slice(0, FOOD_QUICK_COUNT)
              .map((group) => group.slug)
          ),
        ])
      ) as Record<FoodSlot, Set<string>>
  );
  const initialGroup = initialFoodGroup
    ? orderedGroups.find((group) => group.slug === initialFoodGroup)
    : undefined;
  const quickGroups = [
    ...(initialGroup ? [initialGroup] : []),
    ...orderedGroups.filter(
      (group) =>
        group.slug !== initialGroup?.slug &&
        quickSlugs[activeSlot].has(group.slug)
    ),
  ];
  const moreGroups = orderedGroups.filter(
    (group) =>
      group.slug !== initialGroup?.slug &&
      !quickSlugs[activeSlot].has(group.slug)
  );

  // Where the protein control sits among the quick rows (#1980). Frozen with the row
  // order and for the same reason: logging protein re-ranks it server-side, and the
  // control must not slide out from under the finger that just tapped it.
  const [frozenProteinRank] = useState<Record<FoodSlot, number | null>>(
    () =>
      Object.fromEntries(
        FOOD_SLOTS.map((meal) => [meal, proteinRankBySlot?.[meal] ?? null])
      ) as Record<FoodSlot, number | null>
  );
  const proteinRank = frozenProteinRank[activeSlot];
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

  function commitProjection(next: FoodProjectionState) {
    if (!isMountedProfile()) return;
    // Keep the async mutation boundary and the provider on the exact same object.
    // Every caller below computes both halves before this one publication.
    projectionRef.current = next;
    setProjection(next);
  }

  // Set one serving coordinate in the day and meal projections together.
  function setServingCounts(
    date: string,
    targetSlot: FoodSlot,
    slug: string,
    next: (prev: { day: number; meal: number }) => {
      day: number;
      meal: number;
    }
  ) {
    const current = projectionRef.current;
    const dayCounts = current.countsByDate[date] ?? {};
    const slotDay = current.slotCountsByDate[date] ?? {
      Morning: {},
      Midday: {},
      Evening: {},
    };
    const mealCounts = slotDay[targetSlot] ?? {};
    const value = next({
      day: dayCounts[slug] ?? 0,
      meal: mealCounts[slug] ?? 0,
    });
    commitProjection({
      countsByDate: {
        ...current.countsByDate,
        [date]: {
          ...dayCounts,
          [slug]: Math.max(0, value.day),
        },
      },
      slotCountsByDate: {
        ...current.slotCountsByDate,
        [date]: {
          ...slotDay,
          [targetSlot]: {
            ...mealCounts,
            [slug]: Math.max(0, value.meal),
          },
        },
      },
    });
  }

  // Adopt one or more server-named coordinates as ONE client projection (#1934).
  // A correction answers with the placement the serving LEFT and the one it LANDED
  // in. Both must be folded before either context state is published: publishing the
  // source first lets a render restore the old slot map before the destination write.
  // These are SETs, not deltas, so replaying the result can never drift.
  function applyPlacements(placements: readonly FoodPlacement[]) {
    const next = applyFoodServingPlacements(
      projectionRef.current.countsByDate,
      projectionRef.current.slotCountsByDate,
      placements
    );
    commitProjection(next);
  }

  function applyPlacement(placement: FoodPlacement) {
    applyPlacements([placement]);
  }

  // Reconcile a completed add burst in one paint from one post-burst server
  // snapshot. All meal projections travel together so a cross-slot burst cannot
  // repair its latest row while leaving an earlier row optimistic or stale.
  function applyServingTruth(
    date: string,
    slug: string,
    truth: FoodServingTruth
  ) {
    const current = projectionRef.current;
    const day = current.countsByDate[date] ?? {};
    const nextCounts = {
      ...current.countsByDate,
      [date]: { ...day, [slug]: truth.servings },
    };

    const slotDay = current.slotCountsByDate[date] ?? {
      Morning: {},
      Midday: {},
      Evening: {},
    };
    const nextDay = { ...slotDay };
    for (const slot of FOOD_SLOTS) {
      nextDay[slot] = {
        ...(slotDay[slot] ?? {}),
        [slug]: truth.mealServings[slot],
      };
    }
    const nextSlotCounts = {
      ...current.slotCountsByDate,
      [date]: nextDay,
    };
    commitProjection({
      countsByDate: nextCounts,
      slotCountsByDate: nextSlotCounts,
    });
  }

  async function reconcileServingTruthIfIdle(
    receiptKey: string,
    date: string,
    slug: string
  ) {
    if (!isMountedProfile()) return;
    const captured =
      servingBursts.current.get(receiptKey) ?? emptyFoodServingBurst();
    // A current add burst owns the final read after its last response. Reading
    // before that would snapshot only a prefix of its writes.
    if (captured.pending.size > 0) {
      deferredServingTruth.current.set(receiptKey, { date, slug });
      return;
    }
    const requested = requestFoodServingTruth(captured);
    servingBursts.current.set(receiptKey, requested.state);
    if (!requested.readNow) {
      deferredServingTruth.current.set(receiptKey, { date, slug });
      return;
    }
    deferredServingTruth.current.delete(receiptKey);
    const form = new FormData();
    form.set("group_key", slug);
    form.set("date", date);
    if (activeProfileId != null) form.set("profileId", String(activeProfileId));
    let truth: FoodServingTruthResult;
    try {
      truth = await readFoodServingTruth(form);
    } catch {
      return;
    }
    const current =
      servingBursts.current.get(receiptKey) ?? emptyFoodServingBurst();
    if (
      isMountedProfile() &&
      current.epoch === captured.epoch &&
      current.nextTapId === captured.nextTapId &&
      current.truthRevision === captured.truthRevision &&
      current.pending.size === 0 &&
      current.nonAddPending.size === 0 &&
      truth.ok
    )
      applyServingTruth(date, slug, truth);
  }

  function isServingMutationCurrent(receiptKey: string, epoch: number) {
    return (
      isMountedProfile() &&
      (servingBursts.current.get(receiptKey) ?? emptyFoodServingBurst())
        .epoch === epoch
    );
  }

  type ServingMutationClaim = { epoch: number; owner: symbol };
  function beginServingMutations(
    receiptKeys: readonly string[],
    existingOwners: ReadonlyMap<string, symbol> = new Map()
  ) {
    const epochs = new Map<string, ServingMutationClaim>();
    for (const key of new Set(receiptKeys)) {
      const next = beginFoodServingNonAddMutation(
        servingBursts.current.get(key) ?? emptyFoodServingBurst()
      );
      servingBursts.current.set(key, next);
      const owner = existingOwners.get(key) ?? reserveToastLifecycle(key);
      epochs.set(key, { epoch: next.epoch, owner });
    }
    return epochs;
  }

  function finishServingMutations(
    epochs: ReadonlyMap<string, ServingMutationClaim>
  ) {
    for (const [key, claim] of epochs) {
      const finished = finishFoodServingNonAddMutation(
        servingBursts.current.get(key) ?? emptyFoodServingBurst(),
        claim.epoch
      );
      servingBursts.current.set(key, finished.state);
      if (!finished.refreshDeferredTruth) continue;
      const deferred = deferredServingTruth.current.get(key);
      deferredServingTruth.current.delete(key);
      if (deferred)
        void reconcileServingTruthIfIdle(key, deferred.date, deferred.slug);
    }
  }

  function areServingMutationsCurrent(
    epochs: ReadonlyMap<string, ServingMutationClaim>
  ) {
    return [...epochs].every(([key, claim]) =>
      isServingMutationCurrent(key, claim.epoch)
    );
  }

  // The bounded recent days the sheet may correct within — the same seven-day policy
  // the whole picker carries (`days` arrives today-first). The shared when-control's
  // min/max enforce it in the calendar; the save re-checks it for a typed date.
  const maxCorrectionDay = days[0]?.date ?? today;
  const minCorrectionDay = days[days.length - 1]?.date ?? today;

  function openCorrection(event: FoodLogEvent) {
    correctionUiGeneration.current += 1;
    setSaving(false);
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

  function closeCorrection() {
    correctionUiGeneration.current += 1;
    setSaving(false);
    setEditing(null);
    setDraft(null);
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
    const noticeScope = currentReceiptProfileScope();
    // The bounded-days policy the retired Day dropdown physically enforced, kept at
    // save time for a hand-typed date: this sheet recovers a recent meal, it is not an
    // unrestricted historical editor.
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(draft.when.date) ||
      draft.when.date < minCorrectionDay ||
      draft.when.date > maxCorrectionDay
    ) {
      profileToast(noticeScope, "Pick a day from the log's own recent range.", {
        tone: "error",
      });
      return;
    }
    const correctionEpochs = beginServingMutations([
      foodServingToastKey(receiptProfileId, editing.date, editing.groupKey),
      foodServingToastKey(receiptProfileId, draft.when.date, draft.groupKey),
    ]);
    const correctionUi = ++correctionUiGeneration.current;
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
      if (editing.eatenAt !== null) fd.set("occurred_at", "none");
    } else if (
      draftHhmm !== editing.eatenAt ||
      draft.when.date !== editing.date
    ) {
      fd.set("occurred_at", draftHhmm);
    }
    let outcome: FoodEventEditResult;
    try {
      outcome = await updateFoodLogEvent(fd);
    } catch {
      const current = areServingMutationsCurrent(correctionEpochs);
      finishServingMutations(correctionEpochs);
      if (correctionUiGeneration.current === correctionUi) setSaving(false);
      if (current || !isMountedProfile())
        profileToast(
          noticeScope,
          "Couldn't correct that serving — try again.",
          {
            tone: "error",
          }
        );
      return;
    }
    const current = areServingMutationsCurrent(correctionEpochs);
    finishServingMutations(correctionEpochs);
    if (correctionUiGeneration.current === correctionUi) setSaving(false);
    if (!outcome.ok) {
      if (current || !isMountedProfile())
        profileToast(noticeScope, outcome.error, { tone: "error" });
      return;
    }
    if (correctionUiGeneration.current === correctionUi) closeCorrection();
    if (!current) {
      if (isMountedProfile()) {
        void reconcileServingTruthIfIdle(
          foodServingToastKey(receiptProfileId, editing.date, editing.groupKey),
          editing.date,
          editing.groupKey
        );
        void reconcileServingTruthIfIdle(
          foodServingToastKey(
            receiptProfileId,
            draft.when.date,
            draft.groupKey
          ),
          draft.when.date,
          draft.groupKey
        );
      }
      return;
    }
    // The pair is one projection transition. When only the window changes, both name
    // the same (date, group), with `from` clearing the source window and `to` settling
    // the destination at post-move truth.
    applyPlacements([outcome.from, outcome.to]);
    profileToast(noticeScope, "Serving corrected.");
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
    const noticeScope = currentReceiptProfileScope();
    // A delete is not a capture (the lib/offline/queue.ts scope comment), so it stays
    // online-only and says so rather than pretending, exactly as the group "−" does.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      profileToast(
        noticeScope,
        "You're offline — removing a serving needs a connection.",
        {
          tone: "error",
        }
      );
      return;
    }
    const mutationReceiptKey = foodServingToastKey(
      receiptProfileId,
      event.date,
      event.groupKey
    );
    const removalEpochs = beginServingMutations([mutationReceiptKey]);
    const removalOwner = removalEpochs.get(mutationReceiptKey)!.owner;
    const removalUi = ++removalUiGeneration.current;
    setRemovingId(event.id);
    const fd = new FormData();
    fd.set("event_id", String(event.id));
    let outcome: FoodEventDeleteResult;
    try {
      outcome = await deleteFoodLogEvent(fd);
    } catch (err) {
      const current = areServingMutationsCurrent(removalEpochs);
      finishServingMutations(removalEpochs);
      if (removalUiGeneration.current === removalUi) setRemovingId(null);
      if (current || !isMountedProfile())
        profileToast(
          noticeScope,
          shouldQueueOffline(navigator.onLine !== false, err)
            ? "You're offline — removing a serving needs a connection."
            : "Couldn't remove that serving — try again.",
          { tone: "error" }
        );
      return;
    }
    const current = areServingMutationsCurrent(removalEpochs);
    finishServingMutations(removalEpochs);
    if (removalUiGeneration.current === removalUi) setRemovingId(null);
    if (!outcome.ok) {
      if (current || !isMountedProfile())
        profileToast(noticeScope, outcome.error, { tone: "error" });
      return;
    }
    if (!current) {
      if (isMountedProfile())
        void reconcileServingTruthIfIdle(
          mutationReceiptKey,
          event.date,
          event.groupKey
        );
      return;
    }
    // The authoritative post-write counts for the coordinate the serving vacated. A SET,
    // not a delta — the same reconciliation a correction does, so a dropped or refused
    // write can never leave a phantom count behind.
    const vacated = outcome.vacated;
    if (current) applyPlacement(vacated);
    const undoId = outcome.undoId;
    // Precise removal supersedes the cumulative add receipt for this day/group.
    // Reusing its slot prevents two generic Undo buttons on desktop and keeps the
    // just-completed correction at the head of the phone snackbar queue.
    const receiptKey = foodServingToastKey(
      receiptProfileId,
      event.date,
      event.groupKey
    );
    if (!noticeScope) return;
    profileToast(noticeScope, "Serving removed.", {
      key: receiptKey,
      owner: removalOwner,
      onlyIfOwner: true,
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (!isMountedProfile()) return;
          void (async () => {
            const restoreEpochs = beginServingMutations(
              [receiptKey],
              new Map([[receiptKey, removalOwner]])
            );
            let restored: Awaited<ReturnType<typeof undoDelete>>;
            try {
              restored = await undoDelete(undoId);
            } catch {
              const current = areServingMutationsCurrent(restoreEpochs);
              finishServingMutations(restoreEpochs);
              if (current)
                profileToast(noticeScope, "Couldn’t undo — try again.", {
                  tone: "error",
                  key: receiptKey,
                  owner: removalOwner,
                  onlyIfOwner: true,
                });
              return;
            }
            const current = areServingMutationsCurrent(restoreEpochs);
            finishServingMutations(restoreEpochs);
            if (!current) {
              if (isMountedProfile())
                void reconcileServingTruthIfIdle(
                  receiptKey,
                  event.date,
                  event.groupKey
                );
              return;
            }
            if (!restored.ok) {
              profileToast(
                noticeScope,
                "Couldn’t undo — it may have expired.",
                {
                  tone: "error",
                  key: receiptKey,
                  owner: removalOwner,
                  onlyIfOwner: true,
                }
              );
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
            profileToast(noticeScope, "Restored.", {
              key: receiptKey,
              owner: removalOwner,
              onlyIfOwner: true,
            });
          })();
        },
      },
    });
  }

  // Whether the selected day is TODAY — which decides the fold's LABEL and its copy,
  // not whether a statement may be made at all. "Now" is meaningless on a backfill, so
  // a past day is asked "Set time?" and its bare taps stay untimed; today is asked
  // "Happened earlier?" and its bare taps mean now.
  const statingTime = activeDate === today;
  // A statement belongs to the day it was made about. When the selected day moves, the
  // statement and its fold go with it — the alternative is a time chosen for Tuesday
  // silently stamping Wednesday's taps, which is the fabricated instant the NULL default
  // exists to refuse.
  useEffect(() => {
    setEatingWhen({ date: activeDate, statedAt: null });
    setWhenOpen(false);
  }, [activeDate]);
  // The statement in force, as the two things every consumer of it needs: the INSTANT an
  // offline capture carries (resolved here because a replay has no server to ask, and
  // validated server-side before it lands), and the profile-local wall time the online
  // post states. One value behind both, so the queued instant and the posted wall time
  // cannot describe different minutes.
  // The statement is anchored on the SELECTED day by the control's own pair rule, so a
  // stale value from a day that has since been switched away from cannot be in force.
  const statedAt =
    eatingWhen.date === activeDate ? eatingWhen.statedAt : null;
  const statedTime = statedAt ? statedHhmm(statedAt, tz) : "";

  // The meal window the statement in force FILES under (#2269) — the section a "+" will
  // land the serving in, since a stated time wins over the tab at log time — derived
  // through the same boundaries the server's tallies use, exactly as the correction
  // sheet's follow-the-hour Meal default is. Null when no statement is in force: the
  // tab's declaration is then the only fact and the serving files under it.
  function statedFilingSlot(): FoodSlot | null {
    return statedTime ? foodSlotForHhmm(statedTime, slotBoundaries) : null;
  }

  // The pair of counts one tap moves: the day's total for the group, and the group's
  // total inside the meal window under the user's finger. They travel together — the
  // optimistic bump, the rollback and the server's authoritative figures all name both
  // — so the ledger carries them as one slice.
  type ServingCounts = { day: number; meal: number };

  async function bump(
    group: FoodGroup,
    delta: 1 | -1,
    expectedServings?: number,
    inverseWriteKey?: string,
    inverseSlot?: FoodSlot,
    expectedEventId?: number,
    onMutationStarted?: (epoch: number) => void,
    existingReceiptOwner?: symbol
  ): Promise<boolean> {
    const noticeScope = currentReceiptProfileScope();
    const slug = group.slug;
    // WHERE the tap lands (#2269): an add with a statement in force files under the
    // stated time's derived window — the tab stays navigation, the chip stated the
    // consequence — so the optimistic bump moves THAT section's count, not the cell
    // being looked at. An undo (and an add with no statement) stays tab-scoped.
    const filingSlot =
      inverseSlot ?? (delta === 1 ? statedFilingSlot() : null) ?? activeSlot;
    const coordinate = foodServingCoordinate(
      receiptProfileId,
      activeDate,
      filingSlot,
      slug
    );
    const receiptKey = foodServingToastKey(receiptProfileId, activeDate, slug);
    // Reserve every keyed lifecycle when the interaction STARTS. A slower older
    // response can then neither publish nor dismiss over a newer bar/tap.
    const receiptOwner =
      existingReceiptOwner ?? reserveToastLifecycle(receiptKey);
    const endFastOwner =
      delta === 1 ? reserveToastLifecycle("end-fast-offer") : null;
    const limitNoteKey = `food-limit-${slug}`;
    const limitNoteOwner =
      delta === 1 ? reserveToastLifecycle(limitNoteKey, false, false) : null;
    let mutationEpoch: number;
    let nonAddEpochs: ReadonlyMap<string, ServingMutationClaim> | null = null;
    if (delta === -1) {
      nonAddEpochs = beginServingMutations(
        [receiptKey],
        new Map([[receiptKey, receiptOwner]])
      );
      mutationEpoch = nonAddEpochs.get(receiptKey)!.epoch;
      onMutationStarted?.(mutationEpoch);
    }
    const before: ServingCounts = {
      day: projectionRef.current.countsByDate[activeDate]?.[slug] ?? 0,
      meal:
        projectionRef.current.slotCountsByDate[activeDate]?.[filingSlot]?.[
          slug
        ] ?? 0,
    };
    const commit = (next: ServingCounts) => {
      setServingCounts(activeDate, filingSlot, slug, () => next);
    };
    // Queue an ADD tap while offline (#1596): the captured slug + the active meal
    // window and day under the user's finger replay through the same write core on
    // reconnect, so a kitchen-moment tap never fails. The optimistic count stands
    // in for the server total until then. UNDO stays online-only — a decrement is
    // not a capture (see the lib/offline/queue.ts scope comment) — so an offline
    // "−" rolls back with an honest message instead of pretending.
    const queueOffline = async (): Promise<boolean> => {
      const kept =
        (await enqueue("food", activeDate, {
          entry: "serving",
          groupKey: slug,
          // This is the fallback declaration, not an echo of a stated instant. If
          // the replay accepts eatenAt, the write core derives its slot from that
          // instant. If a fast device clock makes eatenAt unusable, the serving
          // stays in the active window the person actually tapped.
          mealSlot: activeSlot,
          grams: null,
          // The statement travels as a RESOLVED instant, because a replay has no server
          // to resolve a wall time against. The replay validates it (judgeEatenAt)
          // rather than trusting it, and an unusable one costs the statement, never the
          // serving.
          eatenAt: statedAt,
        })) === "kept";
      // The device can refuse the capture (#3038) — say so in the shared sentence
      // and report it, so the caller rolls the optimistic counts back.
      if (!kept) {
        if (isCurrentMutation() || !isMountedProfile())
          profileToast(noticeScope, OFFLINE_CAPTURE_REFUSED_MESSAGE, {
            tone: "error",
          });
        return false;
      }
      if (isCurrentMutation())
        profileToast(
          noticeScope,
          "Saved offline — will sync when you reconnect."
        );
      return true;
    };
    const undoNeedsConnection = () => {
      if (isCurrentMutation() || !isMountedProfile())
        profileToast(
          noticeScope,
          "You're offline — removing a serving needs a connection.",
          { tone: "error" }
        );
    };
    // Whether the tap reached a write at all, and what the write said — modeled so
    // the ledger sees exactly one settlement per tap. "refused" is the queue
    // declining the capture (#3038): nothing was kept, so it settles as a
    // rollback, never a phantom count.
    type ServingTap =
      | { kind: "queued" }
      | { kind: "refused" }
      | { kind: "offline-undo" }
      | { kind: "wrote"; outcome: FoodLogResult };
    let addTap: FoodServingAddTap | null = null;
    if (delta === 1) {
      const begun = beginFoodServingAdd(
        servingBursts.current.get(receiptKey) ?? emptyFoodServingBurst(),
        coordinate,
        filingSlot
      );
      servingBursts.current.set(receiptKey, begun.state);
      addTap = begun.tap;
      mutationEpoch = addTap.epoch;
    }
    const isCurrentMutation = () =>
      isServingMutationCurrent(receiptKey, mutationEpoch);
    const reconcileAfterStaleMutation = () => {
      if (isMountedProfile())
        void reconcileServingTruthIfIdle(receiptKey, activeDate, slug);
    };
    const addSettlementBox: { value: FoodServingBurstSettlement | null } = {
      value: null,
    };
    let refreshRefusedInverseTruth = false;
    const settleAddBurst = (
      outcome: { ok: true; eventId: number } | { ok: false }
    ): FoodServingBurstSettlement | null => {
      if (!addTap) return null;
      const settled = settleFoodServingAdd(
        servingBursts.current.get(receiptKey) ?? emptyFoodServingBurst(),
        addTap,
        outcome
      );
      servingBursts.current.set(receiptKey, settled.state);
      addSettlementBox.value = settled;
      return settled;
    };
    const dropAddBurst = () => {
      if (!addTap) return;
      servingBursts.current.set(
        receiptKey,
        dropFoodServingAdd(
          servingBursts.current.get(receiptKey) ?? emptyFoodServingBurst(),
          addTap
        )
      );
    };
    const result = await ledger.tap<ServingTap>({
      // The key names the WRITE, not the row: a "−" correction straight after a "+"
      // is a different write and must not be absorbed by its cooldown. Adds carry a
      // tap sequence because each one is a serving; the cumulative TOAST, not the
      // additive write, is what collapses by coordinate (#3611).
      key:
        delta === 1
          ? `${activeDate}:${filingSlot}:${slug}:add:${addTap!.id}`
          : (inverseWriteKey ?? `${activeDate}:${filingSlot}:${slug}:undo`),
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
          return (await queueOffline())
            ? { kind: "queued" }
            : { kind: "refused" };
        }
        const fd = new FormData();
        fd.set("group_key", slug);
        fd.set("date", activeDate);
        fd.set("meal_slot", filingSlot);
        if (expectedServings != null)
          fd.set("expected_servings", String(expectedServings));
        if (expectedEventId != null)
          fd.set("event_id", String(expectedEventId));
        if (activeProfileId != null)
          fd.set("profileId", String(activeProfileId));
        // The absolute local WALL TIME, not an instant: the server resolves it against
        // its own clock and the profile's timezone, so this island never converts a
        // profile-local hour with its own locale. It is also what a page open since
        // breakfast can still say honestly — "13:00" means the same minute however
        // stale the render is (WhenControl invariant 4). Only an add states a time; an
        // undo removes a serving and asserts nothing about when anything was eaten.
        if (statedTime && delta === 1) fd.set("occurred_at", statedTime);
        stampLoggedVia(fd);
        return {
          kind: "wrote",
          outcome:
            delta === 1 ? await logFoodServing(fd) : await undoFoodServing(fd),
        };
      },
      settle: (tap) => {
        if (tap.kind === "queued") {
          dropAddBurst();
          return { kind: "keep" };
        }
        // Refused capture: queueOffline already said so; the counts roll back.
        if (tap.kind === "refused") {
          const settled = settleAddBurst({ ok: false });
          if (!settled?.accepted || !isCurrentMutation())
            return { kind: "keep" };
          return { kind: "rollback" };
        }
        if (tap.kind === "offline-undo") {
          undoNeedsConnection();
          if (!isCurrentMutation()) return { kind: "keep" };
          return { kind: "rollback" };
        }
        const outcome = tap.outcome;
        if (outcome.ok) {
          if (delta === 1) {
            if (outcome.eventId == null) {
              settleAddBurst({ ok: false });
              return { kind: "keep" };
            }
            const settled = settleAddBurst({
              ok: true,
              eventId: outcome.eventId,
            });
            if (!settled?.accepted) return { kind: "keep" };
            if (
              !isMountedProfile() &&
              settled.completed &&
              settled.reportFailure
            )
              profileToast(
                noticeScope,
                "Couldn't save one of those servings — try again.",
                { tone: "error" }
              );
            if (!isCurrentMutation() && isMountedProfile()) {
              reconcileAfterStaleMutation();
              return { kind: "keep" };
            }
          } else if (!isCurrentMutation()) {
            reconcileAfterStaleMutation();
            return { kind: "keep" };
          }
          // The serving landed and the stated minute did not (#2296). The write is a
          // success, so this is a NOTICE on a normal toast — never an error tone that
          // would read as "your tap failed" for a row that is sitting right there. It
          // is only reachable online when the page went stale across local midnight
          // (the form sends the CHOICE and the server resolves it, so no client clock
          // can push it into the future); the offline capture, which carries a client
          // instant, is where a fast clock actually costs the minute.
          if (isCurrentMutation() && outcome.statedTimeRefused) {
            profileToast(
              noticeScope,
              `Serving saved without its time \u2014 ${
                STATED_TIME_REFUSAL_NOTE[outcome.statedTimeRefused]
              }.`
            );
          }
          // The curated limit note (#2377). NON-BLOCKING and after the fact: the
          // serving is already on the counter, and this only reports what the curated
          // map and the food–drug ledger have to say about the group. Success tone on
          // purpose — an error tone on a tap that worked reads as "your tap failed"
          // (#2296) — so the two kinds are told apart by PROMINENCE instead: an
          // interaction holds until the reader dismisses it, a dietary note takes the
          // ordinary timer. The server already ranked them; at most one ever arrives.
          if (outcome.limitNote) {
            profileToast(noticeScope, foodLimitNoteText(outcome.limitNote), {
              key: limitNoteKey,
              ...(limitNoteOwner != null
                ? { owner: limitNoteOwner, onlyIfOwner: true }
                : {}),
              ...(outcome.limitNote.hold ? { duration: null } : {}),
            });
          }
          if (endFastOwner != null)
            offerEndFast(noticeScope, outcome.endFastOffer, endFastOwner);
          if (delta === 1) {
            if (isMountedProfile()) settleServing(coordinate);
            // Preserve every still-pending optimistic tap. The final response's
            // caller performs one authoritative read and reconciles the whole
            // day/meal slice below; a partial response never commits a smaller
            // settled-only number over later taps.
            return { kind: "keep" };
          } else {
            dismissToast(receiptKey, receiptOwner);
          }
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
        // A failed add still settles the whole rapid burst. If earlier taps
        // succeeded, the final effect publishes their cumulative receipt and
        // reports this failure separately.
        if (delta === 1) {
          const settled = settleAddBurst({ ok: false });
          if (
            !isMountedProfile() &&
            settled?.completed &&
            settled.reportFailure
          )
            profileToast(
              noticeScope,
              outcome.error || "Couldn't save that serving — try again.",
              { tone: "error" }
            );
          return { kind: "keep" };
        }
        if (!isCurrentMutation()) {
          reconcileAfterStaleMutation();
          return { kind: "keep" };
        }
        // A guarded inverse refusal means some other writer changed this coordinate.
        // Its action result cannot always name every meal slot, so keep the optimistic
        // projection only until one fresh day + meal truth read completes below.
        if (
          (expectedServings != null || expectedEventId != null) &&
          outcome.servings != null
        ) {
          refreshRefusedInverseTruth = true;
          return { kind: "keep" };
        }
        if (expectedServings == null && expectedEventId == null) {
          profileToast(
            noticeScope,
            outcome.error || "Couldn't save that serving — try again.",
            {
              tone: "error",
            }
          );
        }
        return { kind: "rollback" };
      },
      onError: async (err) => {
        // Connection dropped mid-tap — queue an add instead of a false failure.
        if (shouldQueueOffline(navigator.onLine !== false, err)) {
          if (delta === 1) {
            const kept = await queueOffline();
            if (!isCurrentMutation()) {
              if (!kept) settleAddBurst({ ok: false });
              return { kind: "keep" };
            }
            if (kept) dropAddBurst();
            else settleAddBurst({ ok: false });
            return kept ? { kind: "keep" } : { kind: "rollback" };
          }
          undoNeedsConnection();
          return { kind: "rollback" };
        }
        if (!isCurrentMutation()) {
          if (delta === 1) {
            const settled = settleAddBurst({ ok: false });
            if (
              !isMountedProfile() &&
              settled?.completed &&
              settled.reportFailure
            )
              profileToast(
                noticeScope,
                "Couldn't save that serving — try again.",
                { tone: "error" }
              );
          }
          reconcileAfterStaleMutation();
          return { kind: "keep" };
        }
        if (delta === 1) {
          settleAddBurst({ ok: false });
          return { kind: "keep" };
        }
        profileToast(noticeScope, "Couldn't save that serving — try again.", {
          tone: "error",
        });
        return { kind: "rollback" };
      },
    });

    if (nonAddEpochs) finishServingMutations(nonAddEpochs);
    if (refreshRefusedInverseTruth && isCurrentMutation())
      await reconcileServingTruthIfIdle(receiptKey, activeDate, slug);
    if (delta === 1) {
      const deferred = deferredServingTruth.current.get(receiptKey);
      if (deferred)
        await reconcileServingTruthIfIdle(
          receiptKey,
          deferred.date,
          deferred.slug
        );
    }

    const addSettlement = addSettlementBox.value;
    if (
      delta === 1 &&
      addTap &&
      addSettlement?.accepted &&
      addSettlement.completed &&
      isMountedProfile()
    ) {
      const completionEpoch = addTap.epoch;
      const completionNextTapId = addSettlement.state.nextTapId;
      const truthForm = new FormData();
      truthForm.set("group_key", slug);
      truthForm.set("date", activeDate);
      if (activeProfileId != null)
        truthForm.set("profileId", String(activeProfileId));
      const isStillLatest = () => {
        const currentBurst =
          servingBursts.current.get(receiptKey) ?? emptyFoodServingBurst();
        return (
          currentBurst.epoch === completionEpoch &&
          currentBurst.nextTapId === completionNextTapId &&
          currentBurst.pending.size === 0
        );
      };
      let truth: FoodServingTruthResult;
      try {
        truth = await readFoodServingTruth(truthForm);
      } catch {
        if (isStillLatest() && noticeScope) {
          profileToast(
            noticeScope,
            "Saved, but couldn't refresh the count — reload to check it.",
            {
              tone: "error",
            }
          );
        }
        return (
          result.status === "settled" &&
          result.result.kind === "wrote" &&
          result.result.outcome.ok
        );
      }
      const stillLatest = isStillLatest();
      if (stillLatest && truth.ok) {
        if (isMountedProfile()) applyServingTruth(activeDate, slug, truth);
        const receipt = addSettlement.receipt;
        const completedOwner = toastLifecycles.current.get(receiptKey);
        if (receipt && noticeScope && completedOwner != null) {
          const feedback = foodServingFeedback(
            receiptProfileId,
            activeDate,
            slug,
            group.name,
            truth.servings,
            activeDay.label
          );
          const inverseKey = foodServingInverseKey(
            receipt.coordinate,
            ++servingInverseSequence.current
          );
          let inverseEpoch: number | null = null;
          announceUndoable({
            ...feedback,
            profileId: noticeScope.profileId,
            profileToken: noticeScope.token,
            owner: completedOwner,
            undo: {
              undoneMessage: "Serving undone.",
              isCurrent: () =>
                inverseEpoch != null &&
                isServingMutationCurrent(feedback.key, inverseEpoch),
              run: async () => {
                if (!isMountedProfile())
                  return { ok: false, reason: "changed" };
                return (await bump(
                  group,
                  -1,
                  truth.servings,
                  inverseKey,
                  receipt.mealSlot as FoodSlot,
                  receipt.eventId,
                  (epoch) => {
                    inverseEpoch = epoch;
                  },
                  completedOwner
                ))
                  ? { ok: true }
                  : { ok: false, reason: "changed" };
              },
            },
          });
        }
        if (addSettlement.reportFailure && noticeScope) {
          profileToast(
            noticeScope,
            "Couldn't save one of those servings — try again.",
            { tone: "error" }
          );
        }
      } else if (stillLatest && !truth.ok) {
        if (noticeScope) {
          profileToast(noticeScope, truth.error, { tone: "error" });
        }
      }
    }
    return (
      result.status === "settled" &&
      result.result.kind === "wrote" &&
      result.result.outcome.ok
    );
  }

  // ---- "Log my usual <window>" (#2380) ----

  // WHAT THE SHORTCUT WOULD WRITE, from the same pure rule the server's offer and the
  // write core run: the habitual groups this window still has nothing logged for,
  // and only while that is at least FOOD_USUAL_MIN_GROUPS of them — below that the
  // ranked row underneath is already one tap and a second control would only be more
  // to read. Empty means the offer is not rendered at all: no habit, nothing already
  // faster, nothing to say.
  //
  // Live off the SAME optimistic counts the rows use, so tapping the shortcut (or the
  // rows one by one) makes it disappear on the same tap rather than a render later.
  // Today only: the offer is a shortcut for the day being lived, never a bulk backfill
  // of days nobody remembers — the ledger is where regularity comes from.
  const usualOffer = useMemo(
    () =>
      activeDate === today
        ? usualFoodOffer(
            usualBySlot?.[activeSlot] ?? [],
            new Set(
              Object.keys(slotCounts).filter(
                (slug) => (slotCounts[slug] ?? 0) > 0
              )
            )
          )
        : [],
    [activeDate, today, usualBySlot, activeSlot, slotCounts]
  );
  const usualGroups = useMemo(
    () =>
      usualOffer
        .map((slug) => groupsBySlot[activeSlot].find((g) => g.slug === slug))
        .filter((g): g is FoodGroup => !!g),
    [usualOffer, groupsBySlot, activeSlot]
  );

  async function logUsual() {
    const slugs = usualGroups.map((g) => g.slug);
    if (slugs.length === 0) return;
    const noticeScope = currentReceiptProfileScope();
    for (const slug of slugs)
      reserveToastLifecycle(
        foodServingToastKey(receiptProfileId, activeDate, slug)
      );
    const endFastOwner = reserveToastLifecycle("end-fast-offer");
    const window = activeSlot;
    const before: Record<string, ServingCounts> = Object.fromEntries(
      slugs.map((slug) => [
        slug,
        {
          day: counts[slug] ?? 0,
          meal: slotCountsByDate[activeDate]?.[window]?.[slug] ?? 0,
        },
      ])
    );
    const commit = (next: Record<string, ServingCounts>) => {
      for (const [slug, value] of Object.entries(next)) {
        setServingCounts(activeDate, window, slug, () => value);
      }
    };
    await usualLedger.tap<UsualFoodResult>({
      from: before,
      optimistic: Object.fromEntries(
        slugs.map((slug) => [
          slug,
          { day: before[slug].day + 1, meal: before[slug].meal + 1 },
        ])
      ),
      commit,
      write: async () => {
        const fd = new FormData();
        fd.set("meal_slot", window);
        // The keys the BUTTON named. The core intersects them with the offer it
        // re-derives from fresh state, so this list is an upper bound on the write and
        // never an instruction to write outside the offer that currently stands.
        fd.set("groups", slugs.join(","));
        return logUsualFood(stampLoggedVia(fd));
      },
      settle: (result) => {
        if (!result.ok) {
          // The offer went stale between render and tap (logged from another device,
          // from the Telegram button). Answered from the typed outcome — never
          // confirmed unconditionally — and the optimistic bump rolls back.
          profileToast(
            noticeScope,
            result.error || "Couldn't log those servings — try again.",
            {
              tone: "error",
            }
          );
          return isMountedProfile() ? { kind: "rollback" } : { kind: "keep" };
        }
        if (!isMountedProfile()) return { kind: "keep" };
        profileToast(
          noticeScope,
          `Logged ${namesPhrase(
            result.groups.map(
              (g) =>
                usualGroups.find((group) => group.slug === g.groupKey)?.name ??
                g.groupKey
            )
          )}.`
        );
        // ONE prompt for the whole bundle (#2756): the server answers a bundled write
        // with a single flag, so a usual-tap that landed five servings asks once.
        offerEndFast(noticeScope, result.endFastOffer, endFastOwner);
        // Adopt the server's authoritative figures for every group it actually wrote —
        // which may be FEWER than the button named, if part of the offer expired.
        // Groups it did not write keep their pre-tap counts, so the display matches
        // what the database now holds rather than what the tap guessed (#748 item 2).
        const adopted: Record<string, ServingCounts> = { ...before };
        for (const g of result.groups)
          adopted[g.groupKey] = { day: g.servings, meal: g.mealServings };
        return { kind: "adopt", value: adopted };
      },
      onError: () => {
        // Online-only by declaration (lib/offline/queue.ts): the offer's justification
        // is server state, and an additive replay could double-log a window. The
        // single-serving rows beside it still queue, so nothing is unreachable.
        profileToast(noticeScope, "Couldn't log those servings — try again.", {
          tone: "error",
        });
        return isMountedProfile() ? { kind: "rollback" } : { kind: "keep" };
      },
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
        const renderedCoordinate = foodServingCoordinate(
          receiptProfileId,
          activeDate,
          statedFilingSlot() ?? activeSlot,
          g.slug
        );
        return (
          <li
            key={g.slug}
            data-testid={`food-group-${g.slug}`}
            data-prefilled={g.slug === initialGroup?.slug ? "true" : undefined}
            // The row's position in the frozen ranked order (#2225). Published so the
            // invariant this surface now holds — the quick rows are the HEAD of the
            // ranking, so nothing in the overflow outranks a quick row — is assertable
            // from the rendered page, which the deleted tier quota would have failed.
            // The overflow is grouped by tier, so rank is not recoverable from DOM order
            // there.
            data-rank={rankBySlug.get(g.slug)}
            className="flex items-center gap-3 rounded-lg border border-(--border) bg-surface px-3 py-2"
          >
            <FoodGroupIcon
              slug={g.slug}
              className={`h-5 w-5 shrink-0 ${FOOD_GROUP_TIER_TINT[g.tier]}`}
            />
            <div className="min-w-0 flex-1">
              <FoodRowLabel group={g} />
            </div>
            {/* NO MINUS AT ZERO (#3987). A permanently disabled control is chrome
                that says nothing, on the row people tap most; there is nothing to
                remove until something is logged. The 32px box is kept for the ones
                that do render — `.tap-target` adds a fixed 12px, so the 44px floor
                (#3486/#3514) is reached only from 32px up. */}
            {mealCount > 0 && (
              <button
                type="button"
                data-testid={`undo-${g.slug}`}
                aria-label={`Remove a ${g.name} serving from ${activeSlot}`}
                onClick={() => void bump(g, -1)}
                className="tap-target flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 dark:hover:bg-ink-800"
              >
                <IconMinus className="h-4 w-4" stroke={2} />
              </button>
            )}
            <span
              data-testid={`count-${g.slug}`}
              className={`w-5 text-center text-sm font-semibold tabular-nums ${
                mealCount === 0
                  ? "text-slate-500 dark:text-slate-400"
                  : "text-slate-700 dark:text-slate-200"
              }`}
            >
              <RollingNumber
                value={mealCount}
                testId={`rolling-count-${g.slug}`}
              />
            </span>
            <button
              type="button"
              data-testid={`log-${g.slug}`}
              aria-label={`Add a ${g.name} serving to ${activeSlot}`}
              onClick={() => void bump(g, 1)}
              className="group tap-target flex h-8 w-8 items-center justify-center rounded-full text-white"
            >
              {/* The full-size painted chip inside carries the one-shot settle class.
                  It is still the tapped chip people see, while the button keeps focus
                  and its 44px effective target throughout. */}
              <span
                data-testid={`food-settle-${g.slug}`}
                data-motion="settle"
                data-reduced-motion={reducedMotion ? "true" : "false"}
                data-settling={
                  settlingCoordinates.has(renderedCoordinate) ? "true" : "false"
                }
                className={`flex h-full w-full items-center justify-center rounded-full bg-brand-600 transition group-hover:bg-brand-700${
                  settlingCoordinates.has(renderedCoordinate)
                    ? ` ${settlePlan.className}`
                    : ""
                }`}
              >
                <IconPlus className="h-4 w-4" stroke={2} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div>
      <IntakeContextBar
        purpose="food-log"
        ledgerDoor={ledgerDoor}
        today={today}
        days={days}
        value={activeDate}
        onChange={setActiveDate}
        context={{ label: activeSlot, value: activeSlot }}
        status={{ kind: "servings", count: dayTotal }}
        action={{
          kind: "food-preferences",
          onActivate: () => setPreferencesOpen(true),
        }}
      />
      <div data-testid="food-log-bar" className="space-y-5">
        {/* THE DAY, STATED ONCE (#3987). The Meals cards and the LOGGED-TODAY list
            below them were two full renderings of the same servings, adjacent; both
            retire into the ledger, which also absorbs the Supplements tab's daily
            schedule so one physical morning is one list. The per-meal totals the
            cards carried are the ledger group headings; the slot SELECTION they
            doubled as is the control on the add list below, where the choice is
            actually made. */}
        {unassignedTotal > 0 && (
          <p
            data-testid="food-unassigned-total"
            className="text-xs text-slate-500 dark:text-slate-400"
          >
            {unassignedTotal} older{" "}
            {unassignedTotal === 1 ? "serving has" : "servings have"} no meal
            assignment.
          </p>
        )}
        {dayLedger && (
          <DayLedger
            key={activeDate}
            date={activeDate}
            groups={dayLedger.groupsByDate[activeDate] ?? []}
            doseWritable={dayLedger.doseWritableDates.includes(activeDate)}
            prefs={dayLedger.prefs}
            keepApart={activeDate === today ? dayLedger.keepApart : []}
            dayContext={activeDate === today ? dayLedger.dayContext : null}
            onCorrectServing={(eventId) => {
              const event = loggedEvents.find((e) => e.id === eventId);
              if (event) openCorrection(event);
            }}
            onRemoveServing={(eventId) => {
              const event = loggedEvents.find((e) => e.id === eventId);
              if (event) void removeServing(event);
            }}
            removingServingId={removingId}
          />
        )}
        <section data-testid="food-quick-log">
          {/* WHERE THE NEXT TAP LANDS. This was the Meals cards' second job — they
              were a totals display AND the slot picker — and only the picker half
              belongs with the add list. The totals are the ledger's group headings
              above; this is the choice, next to the rows that act on it. */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="section-label">Add to {activeSlot}</h3>
            <SegmentedControl
              options={FOOD_SLOTS.map((meal) => ({
                value: meal,
                label: meal,
                testId: `food-slot-${meal.toLowerCase()}`,
              }))}
              value={activeSlot}
              onChange={setActiveSlot}
              ariaLabel="Meal to add to"
              testId="food-meal-slots"
            />
          </div>
          {/* The regularity shortcut (#2380). Present only when the ledger says this
              window has a habit AND at least two of it are still unlogged today — one
              group is already one tap on the row below, so the offer would cost more to
              read than it saves. The label NAMES every group it will write, and both it
              and the write core derive that list from the same rule, so the button
              cannot promise a write the server would not perform. It is an OFFER: the
              user's tap is the write, always. */}
          {usualGroups.length > 0 && (
            <button
              type="button"
              data-testid="food-usual-offer"
              data-groups={usualGroups.map((g) => g.slug).join(",")}
              aria-label={`Log your usual ${activeSlot}: ${namesPhrase(
                usualGroups.map((g) => g.name)
              )}`}
              disabled={usualLedger.blocked()}
              onClick={() => void logUsual()}
              className="mb-2.5 flex w-full items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-left transition hover:bg-brand-50 disabled:opacity-50 dark:border-brand-900 dark:bg-brand-950/40 dark:hover:bg-brand-950/60"
            >
              <IconPlus
                className="h-5 w-5 shrink-0 text-brand-700 dark:text-brand-300"
                stroke={2}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Your usual {activeSlot}
                </span>
                <span
                  data-testid="food-usual-names"
                  className="block truncate text-xs text-slate-600 dark:text-slate-300"
                >
                  {namesPhrase(usualGroups.map((g) => g.name))}
                </span>
              </span>
            </button>
          )}
          {/* TAP WRITES NOW, AND THE TIME IS A FOLD (#3273's ruled shape, #3987).
              The control used to stand open above the rows on every visit; it is a
              question most taps never answer, so it collapses behind one affordance
              and the bare tap keeps its meaning.

              THE PAST-DAY AMENDMENT (owner, 2026-08-29 via #4118). The vocabulary is
              the SAME control on every offered day; only the label moves, because the
              question genuinely differs. On TODAY it is "Happened earlier?" — the tap
              means now, the fold is for a meal you are logging late. On a SELECTED PAST
              DAY a bare tap writes day + meal slot with NO instant (`occurred_at` NULL,
              which the ledger's untimed grammar already renders) because there is no
              honest "now" to fabricate, so the fold reads "Set time?". A time set there
              is STICKY for the batch — set 8pm once, tap several groups, all land at
              8pm — and clearing it returns to untimed slot taps. The day is FIXED to the
              selected one either way, so the pair rule holds by construction and the
              hour offer is that day's own. */}
          <Disclosure
            data-testid="food-eating-time"
            open={whenOpen}
            onToggle={(e) => setWhenOpen(e.currentTarget.open)}
            className="mb-2.5"
          >
            <summary
              data-testid="food-when-summary"
              className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-slate-500 [&::-webkit-details-marker]:hidden dark:text-slate-400"
            >
              <IconChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              <span>{statingTime ? "Happened earlier?" : "Set time?"}</span>
              {statedTime && (
                <span
                  data-testid="food-when-set"
                  className="font-semibold text-slate-700 tabular-nums dark:text-slate-200"
                >
                  {statedTime}
                </span>
              )}
            </summary>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <WhenControl
                mode="state"
                grain="hour"
                value={eatingWhen}
                onChange={setEatingWhen}
                minDate={activeDate}
                maxDate={activeDate}
                timeLabel="When the servings you add were eaten"
                testId="food-when"
              />
              <span
                data-testid="food-eating-time-note"
                className="w-full text-xs text-slate-500 dark:text-slate-400"
              >
                {statedTime
                  ? `Servings you add are recorded as eaten at ${statedTime}${
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
                  : statingTime
                    ? "Servings you add are recorded with no eating time until you say one."
                    : `Servings you add land in ${activeSlot} with no time until you set one.`}
              </span>
            </div>
          </Disclosure>
          {/* THE OVERFLOW DISCLOSURE IS A CITIZEN OF THIS LIST (#3362), not a
              section after it. It does the same job as the rows above it —
              reach a food-group row — so it wears the same card idiom and sits
              at the list's own `space-y-1.5` rhythm. Living INSIDE the list
              container is what makes that gap the same with and without the
              nutrient summary, which renders only on the Nutrition page mount
              and used to sit between the rows and this control. `min-h-14`
              lifts it from the 42px `py-2.5` control it was — under the app's
              own 44px `tap-target` floor — to the food rows' height. */}
          <div className="space-y-1.5">
            {/* THE QUICK ROWS HAVE A NAME, and the reason is the disclosure below
                them. Since #3362 the overflow control is a citizen of this same
                list, so its rows — collapsed, but in the DOM — sit under
                `food-quick-log` too. Three specs had to spell out an exclusion to
                keep saying "the quick rows", and only ONE of them failed loudly
                when it went unsaid: `food-log.spec.ts`'s #2225 head-of-the-ranking
                test. The other two would have stayed GREEN while measuring
                something weaker — `nutrition-composition`'s `toHaveCount(6)`
                becoming "the catalog has N", and `protein-quickadd`'s
                `rowsAbove < rows` comparing against an inflated ceiling. A fourth
                spec would not know to exclude either, and would fail the same
                silent way. So the answer lives here, once, in the DOM that owns
                it: everything inside this element is a row of the list; the
                disclosure and everything it reaches is outside it.

                The nested `space-y-1.5` is deliberate and changes no pixel — the
                gaps between these children and the gap from this element to the
                disclosure are the same 6px they were when all of them were
                siblings. */}
            <div data-testid="food-quick-rows" className="space-y-1.5">
              {proteinSplit > 0 && rows(quickGroups.slice(0, proteinSplit))}
              {activeDate === today && proteinQuickAdd}
              {proteinSplit < quickGroups.length &&
                rows(quickGroups.slice(proteinSplit))}
            </div>
            {moreGroups.length > 0 && (
              <Disclosure data-testid="food-more-groups">
                <summary
                  data-testid="food-more-groups-summary"
                  className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-(--border) bg-surface px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-(--ghost-hover) [&::-webkit-details-marker]:hidden dark:text-slate-200"
                >
                  <span>More food groups ({moreGroups.length})</span>
                  <IconChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                </summary>
                {/* The expanded tier sections keep their own layout — this
                    change is about the collapsed control's size and rhythm. */}
                <div className="mt-4 space-y-5">
                  {TIER_ORDER.map((tier) => {
                    const tierGroups = moreGroups.filter(
                      (g) => g.tier === tier
                    );
                    if (tierGroups.length === 0) return null;
                    return (
                      <div key={tier}>
                        <h3 className="mb-2 section-label">
                          {TIER_LABEL[tier]}
                        </h3>
                        {rows(tierGroups)}
                      </div>
                    );
                  })}
                </div>
              </Disclosure>
            )}
          </div>
        </section>
        {nutrientSummary}
      </div>
      {preferencesOpen && (
        <ModalShell
          title="Dietary preferences"
          onClose={() => setPreferencesOpen(false)}
        >
          <div className="min-h-0 overflow-y-auto pr-1">
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
          onClose={closeCorrection}
          size="sm"
        >
          <div data-testid="food-correct-modal" className="space-y-3">
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
                  the retired Day dropdown offered. `recorded_at` is deliberately not
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
              onClick={closeCorrection}
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
