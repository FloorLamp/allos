"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  IconBarbell,
  IconBolt,
  IconChevronRight,
  IconDroplet,
  IconToiletPaper,
  IconFlask,
  IconFileText,
  IconHeartbeat,
  IconMoodSmile,
  IconPill,
  IconSalad,
  IconScale,
  IconSparkles,
} from "@tabler/icons-react";
import BottomSheet from "./BottomSheet";
import SegmentedControl from "./SegmentedControl";
import UsualRoutineControl from "./dashboard/UsualRoutineControl";
import { useActivityEditor } from "./ActivityEditorProvider";
import { useQuickEntry } from "./QuickEntryProvider";
import { useResettableState } from "./useResettableState";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import {
  loadLogSheetContext,
  type LogSheetContext,
} from "@/app/(app)/log-sheet-actions";
import {
  dueDoseChipLabel,
  logSheetSegments,
  maxLogSheetRows,
  openingLogSegment,
  type LogSegmentId,
  type SegmentLogDays,
} from "@/lib/log-sheet";
import { type QuickLogIcon, type QuickLogItem } from "@/lib/quick-log";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import type { WebLoggedVia } from "@/lib/logged-via";
import { microMotionPlan } from "@/lib/micro-motion";

// The log sheet — what the dock's raised puck opens (issue #2651). Since #2745
// the puck is the one phone-chrome route here; the duplicate top-bar cluster is
// gone, so there is one menu and one membership list.
//
// Since #2651 it has two SECTIONS.
//
// ── 1. "DUE & USUAL NOW" — CONTEXT, NOT A MENU ───────────────────────────────
//
// The offers that already exist elsewhere in the app, gathered on open and
// rendered here so the thing you most likely came to log is the first thing
// under your thumb:
//
//   • the composed morning one-tap (#2458) — the SAME <UsualRoutineControl> the
//     dashboard's usual-routine atom renders, over the SAME server-resolved offer.
//     Not a copy: the component, the props and the write core are one each.
//   • doses due now — names from `collectDueDosesNow`, the arrived-slot slice of
//     the app's shared scheduled-dose computation. The chip OPENS the existing
//     dose overlay; it confirms nothing itself.
//   • an active or likely session — `workoutOffer` from the activity editor
//     context (lib/workout-offer.ts), the same derivation the workout dock and
//     command palette read. Its LABEL is the offer, so a live session reads
//     "Resume workout" rather than silently restarting the clock.
//
// Every one of them is an OFFER (#1505): the tap is the write, the app logs
// nothing on anybody's behalf, and each label names what its tap will do. They
// are RE-DERIVED on every open (`loadLogSheetContext`) for the #1468 reason — a
// layout-time snapshot is exactly as stale as the page — and the usual-routine
// write core re-derives the bundle a SECOND time server-side and writes only the
// intersection, so a sheet left open across a cross-device write refuses instead
// of logging a second breakfast (#2380/#2419).
//
// Nothing in this section reflects a FINDING, carries an obligation, or reaches
// the suppression bus. Absence means silence: no offer renders as no chip, never
// as a disabled one. And dueness gates NUDGING, never LOGGING (#2419) — every
// entry in section 2 stays exactly as available as it was, whatever the chips
// say.
//
// ── 2. "EVERYTHING ELSE" — THE LONG TAIL, WITH LARGE TARGETS ─────────────────
//
// `logSheetSegments` (lib/log-sheet.ts) is a VIEW over the same `quickLogMenu`
// this sheet has always rendered — same entries, same two gates, same registry —
// grouped into a one-line segmented domain track so no log needs its page first.
// The track opens on the segment holding the current route's promoted log, so
// the puck on Nutrition lands on Consume — except on the DASHBOARD, which promotes
// no log of its own and opens instead on the segment this profile has logged on
// the most DAYS over the trailing quarter (#2709, owner ruling).
// `openingLogSegment` owns that whole composition, including the fallback for a
// profile with no history; none of it is decided here.
//
// Still no navigation and still no second write path: every row opens an
// EXISTING form in place (the shared activity editor, or a quick-entry overlay
// form), which is the whole point of a quick logger (#1468).

const ICONS: Record<QuickLogIcon, typeof IconBarbell> = {
  barbell: IconBarbell,
  bolt: IconBolt,
  salad: IconSalad,
  pill: IconPill,
  scale: IconScale,
  heartbeat: IconHeartbeat,
  sparkles: IconSparkles,
  mood: IconMoodSmile,
  droplet: IconDroplet,
  toilet: IconToiletPaper,
  flask: IconFlask,
  document: IconFileText,
};

// The sheet's own surface, named once so the region it declares over its body and the
// surface it opens the activity editor from cannot drift apart (#3087). Told to the
// editor rather than read from the context, because a component is not inside the
// provider it renders: the declaration below is in this component's OWN returned JSX,
// so `useLoggedVia()` here would answer whatever is above the sheet — `page` — and a
// workout started from the sheet's bolt would record `page` like one started from the
// Training page. Which is the sentence this mechanism exists to make false.
const SHEET_SURFACE: WebLoggedVia = "quick-log";

// One row is 60px (36px icon + 24px vertical padding), followed by the list's
// 4px gap. Its `pb-1` spends that final 4px after the last row, so N×64px is the
// exact rendered list block rather than an approximate minimum (#3675).
const LOG_SHEET_ROW_BLOCK_PX = 64;

export default function QuickLogSheet({
  open,
  onClose,
  cycleRelevant = true,
  substanceRelevant = false,
  logHabitDays = null,
}: {
  open: boolean;
  onClose: () => void;
  // The #1042 `cycle` relevance bit, resolved once by the app layout — the SAME bit
  // gating the Cycle nav entry and dashboard control atom (#1892).
  cycleRelevant?: boolean;
  // The #3327 bit, resolved once by the app layout: this profile has a substance
  // ledger row AND is not a known minor. Defaults FALSE, unlike every other gate
  // here — an unthreaded caller must not offer a substance row to a profile that
  // tracks none, which is the defect the row exists to avoid (lib/quick-log.ts).
  substanceRelevant?: boolean;
  // Days-logged per segment over the trailing quarter (#2709), resolved once by
  // the shell. Consulted on the DASHBOARD only; null means "not gathered".
  logHabitDays?: SegmentLogDays | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    openCreate,
    openLive,
    workoutOffer,
    canStartWorkout,
    trainingRelevant,
  } = useActivityEditor(SHEET_SURFACE);
  const { open: openQuickEntry } = useQuickEntry();

  const segments = logSheetSegments(cycleRelevant, substanceRelevant)
    .map((entry) => ({
      ...entry,
      items: entry.items.filter(
        (item) =>
          !item.training ||
          (item.target.kind === "live" ? canStartWorkout : trainingRelevant)
      ),
    }))
    .filter((entry) => entry.items.length > 0);
  // Reset to the route's own segment on every OPEN, not only on navigation: the
  // sheet is opened repeatedly from the same page and should always lead with
  // what that page is for.
  const [segment, setSegment] = useResettableState<LogSegmentId, string>(
    openingLogSegment({
      segments,
      pathname,
      tab: searchParams.get("tab"),
      habitDays: logHabitDays,
    }),
    `${pathname}|${open ? 1 : 0}`
  );

  const { context, state: contextState } = useLogSheetContext(open);
  const shown = segments.find((s) => s.id === segment) ?? segments[0];
  const maxRows = maxLogSheetRows(segments);
  const hasGatheredOffers = Boolean(
    context && (context.routine || context.dueDoses.count > 0)
  );
  const reduceMotion = usePrefersReducedMotion();
  const arrivePlan = microMotionPlan("arrive", reduceMotion);

  function run(item: QuickLogItem) {
    // Close first: whatever opens next is its own overlay and should stand
    // alone, not stack over a sheet that has finished its job. (This close and
    // the open land in one tick while the sheet's exit animation keeps it
    // mounted, so the two surfaces' body-scroll locks OVERLAP and release in
    // FIFO order — which is exactly why useLockBodyScroll is reference-counted
    // rather than save/restore. See the note there before changing either.)
    onClose();
    if (item.target.kind === "activity") openCreate();
    else if (item.target.kind === "live") openLive();
    else if (item.target.kind === "overlay") openQuickEntry(item.target.form);
    // No `navigate` branch: the registry guarantees no sheet row carries one
    // (#1468), and the exhaustive union makes a future one a compile error here
    // rather than a silent dead row.
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Log"
      testId="quick-log-sheet"
    >
      {/* EVERY control inside this sheet IS the quick-log sheet (#3087) — the same
          declaration `QuickEntryProvider` makes over the overlay this sheet opens.
          The composed one-tap below is the SAME <UsualRoutineControl> the dashboard
          renders, posting the SAME action, so the server can only tell the puck from
          the dashboard atom if the puck says so. Declared here at the region root
          rather than on the control, which is mounted in both places. */}
      <LoggedViaSurface value={SHEET_SURFACE}>
        {/* The 208px context slot exists from the first frame and survives an
            empty or failed gather. It is tall enough for the heading, composed
            routine control, and two wrapping chips at 390px. BottomSheet keeps
            the one scroll owner; this reserve adds no nested scroller. */}
        <div
          data-testid="log-sheet-context-slot"
          data-context-state={contextState}
          className="mb-4 h-52"
        >
          <p
            role="status"
            aria-live="polite"
            data-testid="log-sheet-context-status"
            className="sr-only"
          >
            {hasGatheredOffers ? "Due and usual options are ready." : ""}
          </p>
          {hasGatheredOffers && context && (
            <section
              data-testid="log-sheet-context"
              className={`${arrivePlan.className} h-full border-b border-black/5 pb-3 dark:border-white/5`}
            >
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                Due &amp; usual now
              </h3>
              {/* The dashboard's own control, unchanged: it names every serving and
          every dose the tap will write, and answers from the typed outcome. */}
              {context.routine && (
                <UsualRoutineControl
                  window={context.routine.window}
                  food={context.routine.food}
                  doses={context.routine.doses}
                  subjectName={context.routine.subjectName}
                />
              )}
              <div className="flex flex-wrap gap-2">
                {context.dueDoses.count > 0 && (
                  <ContextChip
                    testId="log-sheet-chip-doses"
                    icon={<IconPill className="h-4 w-4" stroke={1.75} />}
                    // Names come from the SAME due items the count used to summarize;
                    // the chip still opens the list and confirms nothing itself.
                    label={dueDoseChipLabel(context.dueDoses)!}
                    onClick={() => {
                      onClose();
                      openQuickEntry("dose");
                    }}
                  />
                )}
                {/* ONLY the `resume` arm. A `start` offer stands on every route at
            every hour, and a permanently-present chip in a section headed "Due &
            usual now" would claim that starting a workout is DUE — which is
            exactly the campaigning this chrome refuses. A live or just-abandoned
            session genuinely is now, and "Log activity" stays one segment away
            regardless (#2419: dueness gates nudging, never logging). */}
                {workoutOffer.kind === "resume" && (
                  <ContextChip
                    testId="log-sheet-chip-session"
                    workoutOffer={workoutOffer.kind}
                    icon={<IconBolt className="h-4 w-4" stroke={1.75} />}
                    // The LABEL is the offer (#1893) — "Resume workout" with a
                    // session already live, so the tap can never silently reset a
                    // running clock.
                    label={workoutOffer.label}
                    onClick={() => {
                      onClose();
                      openLive();
                    }}
                  />
                )}
              </div>
            </section>
          )}
        </div>

        {segments.length > 1 && (
          <SegmentedControl<LogSegmentId>
            options={segments.map((s) => ({
              value: s.id,
              label: s.label,
              testId: `log-sheet-segment-${s.id}`,
            }))}
            value={shown?.id ?? segments[0]!.id}
            onChange={setSegment}
            ariaLabel="What are you logging?"
            testId="log-sheet-segments"
            fill
            className="mb-3"
          />
        )}

        <ul
          className="flex flex-col gap-1 pb-1"
          data-testid="log-sheet-items"
          data-max-rows={maxRows}
          style={{ height: `${maxRows * LOG_SHEET_ROW_BLOCK_PX}px` }}
        >
          {(shown?.items ?? []).map((item) => {
            const Icon = ICONS[item.icon];
            const label =
              item.target.kind === "live" ? workoutOffer.label : item.label;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`quick-log-${item.id}`}
                  data-workout-offer={
                    item.target.kind === "live" ? workoutOffer.kind : undefined
                  }
                  onClick={() => run(item)}
                  className="press flex min-h-11 w-full items-center gap-3 rounded-xl border border-(--border) bg-surface px-3 py-3 text-left transition hover:bg-(--ghost-hover)"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                    <Icon className="h-5 w-5" stroke={1.75} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                      {label}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {item.hint}
                    </span>
                  </span>
                  <IconChevronRight
                    className="h-4 w-4 shrink-0 text-slate-400"
                    stroke={1.75}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </LoggedViaSurface>
    </BottomSheet>
  );
}

function ContextChip({
  testId,
  icon,
  label,
  onClick,
  workoutOffer,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  workoutOffer?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-workout-offer={workoutOffer}
      onClick={onClick}
      className="press inline-flex min-h-11 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm font-medium text-brand-800 transition hover:bg-brand-50 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-200 dark:hover:bg-brand-950/60"
    >
      {icon}
      {label}
    </button>
  );
}

// Gather the context row's offers ON EVERY OPEN, and forget them on close.
//
// Lazy is not only cheaper (this sheet is mounted on ~60 routes and opens on a
// minority of visits) — it is the CORRECT freshness. A dose confirmed from
// Telegram, or a breakfast logged on another device, between page load and puck
// tap must not still be offered here; a layout-time snapshot is exactly as stale
// as the page (#1468).
//
// A failed gather renders NO context section. These are offers, and the honest
// degradation of an offer nobody could resolve is silence — never a chip that
// can only refuse, and never a blocking error over a menu that still works.
type LogSheetContextLoad = {
  context: LogSheetContext | null;
  state: "idle" | "loading" | "ready" | "failed";
};

function useLogSheetContext(open: boolean): LogSheetContextLoad {
  // Keyed on `open`, so closing DISCARDS the answer during the next render
  // rather than through a follow-up effect: a sheet reopened an hour later must
  // never paint the offers it gathered the first time, and clearing that in an
  // effect would both cascade a render and leave a frame where it had.
  const [load, setLoad] = useResettableState<LogSheetContextLoad>(
    { context: null, state: open ? "loading" : "idle" },
    open
  );
  // Ignore a response that lost its race — a close-then-reopen must not paint the
  // first open's answer into the second.
  const requestRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    const token = ++requestRef.current;
    void loadLogSheetContext().then(
      (data) => {
        if (requestRef.current === token)
          setLoad({ context: data, state: "ready" });
      },
      () => {
        if (requestRef.current === token)
          setLoad({ context: null, state: "failed" });
      }
    );
  }, [open, setLoad]);
  return load;
}
