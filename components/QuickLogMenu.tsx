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
import SegmentedControl from "./SegmentedControl";
import { UsualRoutineOfferCard } from "./dashboard/UsualRoutineControl";
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
  logSheetReservePx,
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

// THE QUICK-LOG MENU — the two sections themselves, with no host chrome around
// them (issues #2651, #3154).
//
// TWO HOSTS MOUNT THIS, and neither owns a line of it: the phone's log sheet
// (components/QuickLogSheet.tsx, opened by the dock puck) and the desktop
// sidebar's "+ Log" panel (components/SidebarLogButton.tsx). That is the whole
// reason this file exists — #2184 is the record of what a second copy of a menu
// costs, and one membership list with two renderers is how the palette/sheet
// drift started. The hosts differ in exactly one behaviour, `onRun`: the sheet
// closes behind a row, the desktop panel stays open.
//
// It has two SECTIONS.
//
// ── 1. "DUE & USUAL NOW" — CONTEXT, NOT A MENU ───────────────────────────────
//
// The offers that already exist elsewhere in the app, gathered on open and
// rendered here so the thing you most likely came to log is the first thing
// under your thumb:
//
//   • the composed morning one-tap (#2458) — <UsualRoutineOfferCard>, over the SAME
//     server-resolved offer as the dashboard's row control and posting through the
//     same tap. Not a copy: the props and the write core are one each, and the card
//     is the shape #3736 ruled for a list with no facts column to name members in.
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

// The menu's own surface, named once so the region it declares over its body and the
// surface it opens the activity editor from cannot drift apart (#3087). One value for
// BOTH hosts: a workout started from this menu is a quick-log whether the phone sheet
// or the desktop panel was holding it. Told to the editor rather than read from the
// context, because a component is not inside the provider it renders: the declaration
// below is in this component's OWN returned JSX, so `useLoggedVia()` here would answer
// whatever is above the menu — `page` — and a workout started from its bolt would
// record `page` like one started from the Training page. Which is the sentence this
// mechanism exists to make false.
const LOG_SURFACE: WebLoggedVia = "quick-log";

// The sheet's own full-width row — ONE shape for the context offers and the
// long-tail entries, so the panel reads as one list top to bottom rather than a
// bordered card above a half-width pill (#3736).
const SHEET_ROW_CLASS =
  "press flex w-full items-center gap-3 rounded-xl border border-(--border) bg-surface px-3 py-2 text-left transition hover:bg-(--ghost-hover)";

export default function QuickLogMenu({
  open,
  onRun,
  cycleRelevant = true,
  substanceRelevant = false,
  logHabitDays = null,
}: {
  // Gathers the context row's offers on every OPEN and forgets them on close;
  // also what re-seeds the opening segment. The menu renders regardless — a host
  // that unmounts it while closed simply never passes false.
  open: boolean;
  // A row was activated. The sheet passes its own close (an overlay should stand
  // alone, not stack over a sheet that has finished its job); the desktop panel
  // passes nothing and stays open across logs.
  onRun?: () => void;
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
  } = useActivityEditor(LOG_SURFACE);
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
    context && (context.routine || context.dueDoses.items.length > 0)
  );
  const reduceMotion = usePrefersReducedMotion();
  const arrivePlan = microMotionPlan("arrive", reduceMotion);

  function run(item: QuickLogItem) {
    // Tell the host first. In the sheet that is a close, and the close and the
    // open land in one tick while the sheet's exit animation keeps it mounted,
    // so the two surfaces' body-scroll locks OVERLAP and release in FIFO order
    // — which is exactly why useLockBodyScroll is reference-counted rather than
    // save/restore. See the note there before changing either.
    onRun?.();
    if (item.target.kind === "activity") openCreate();
    else if (item.target.kind === "live") openLive();
    else if (item.target.kind === "overlay") openQuickEntry(item.target.form);
    // No `navigate` branch: the registry guarantees no sheet row carries one
    // (#1468), and the exhaustive union makes a future one a compile error here
    // rather than a silent dead row.
  }

  // EVERY control inside this menu IS the quick-log surface (#3087) — the same
  // declaration `QuickEntryProvider` makes over the overlay a row opens. The
  // composed one-tap below posts the SAME action the dashboard's row control does,
  // off the same shared tap, so the server can only tell this menu from the
  // dashboard atom if the menu says so. Declared at the region root rather than on
  // the control, which is mounted in both places.
  // The panel's whole reserve, spent by the trailing spacer at the very bottom.
  const reservePx = logSheetReservePx(segments);

  return (
    <LoggedViaSurface value={LOG_SURFACE}>
      <div
        data-testid="log-sheet-menu"
        className="flex flex-col"
        style={{ minHeight: `${reservePx}px` }}
      >
        {/* The slot survives an empty or failed gather, and now carries no height
          of its own: with nothing gathered it contributes nothing, and with
          offers it sizes to them so its rule sits directly under the last one.
          Each host keeps the one scroll owner; nothing here adds a nested one. */}
        <div
          data-testid="log-sheet-context-slot"
          data-context-state={contextState}
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
              className={`${arrivePlan.className} mb-4 border-b border-black/5 pb-3 dark:border-white/5`}
            >
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                Due &amp; usual now
              </h3>
              {/* The dashboard's own control, unchanged: it names every serving and
                  every dose the tap will write, and answers from the typed outcome.
                  It is why the offers below took ITS full-width shape rather than the
                  other way round — a control that names doses cannot compress into a
                  pill (#3736). */}
              {context.routine && <UsualRoutineOfferCard {...context.routine} />}
              <div className="flex flex-col gap-1">
                {context.dueDoses.items.length > 0 && (
                  <SheetRow
                    testId="log-sheet-chip-doses"
                    icon="pill"
                    // Names come from the SAME due items the count used to summarize;
                    // the row still opens the list and confirms nothing itself.
                    label={dueDoseChipLabel(context.dueDoses)!}
                    onClick={() => {
                      onRun?.();
                      openQuickEntry("dose");
                    }}
                  />
                )}
                {/* ONLY the `resume` arm. A `start` offer stands on every route at
                    every hour, and a permanently-present offer in a section headed
                    "Due & usual now" would claim that starting a workout is DUE —
                    which is exactly the campaigning this chrome refuses. A live or
                    just-abandoned session genuinely is now, and "Log activity" stays
                    one segment away regardless (#2419: dueness gates nudging, never
                    logging). */}
                {workoutOffer.kind === "resume" && (
                  <SheetRow
                    testId="log-sheet-chip-session"
                    workoutOffer={workoutOffer.kind}
                    icon="bolt"
                    // The LABEL is the offer (#1893) — "Resume workout" with a
                    // session already live, so the tap can never silently reset a
                    // running clock.
                    label={workoutOffer.label}
                    onClick={() => {
                      onRun?.();
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
        >
          {(shown?.items ?? []).map((item) => (
            <li key={item.id}>
              <SheetRow
                testId={`quick-log-${item.id}`}
                workoutOffer={
                  item.target.kind === "live" ? workoutOffer.kind : undefined
                }
                icon={item.icon}
                label={
                  item.target.kind === "live" ? workoutOffer.label : item.label
                }
                onClick={() => run(item)}
              />
            </li>
          ))}
        </ul>

        {/* THE ONE SPACER, LAST (#3736). It takes whatever the regions above did
            not, so the panel is the same height on every segment and across the
            gather — and every pixel of slack collects after the final row, where
            it reads as padding, instead of between the reader's content and a
            rule. */}
        <div data-testid="log-sheet-spacer" className="grow" aria-hidden />
      </div>
    </LoggedViaSurface>
  );
}

// ONE ROW, BOTH SECTIONS (#3736). The context offers and the long-tail entries
// are the same class of thing — something the reader can act on right now, whose
// tap opens an existing form — so they are drawn by one component instead of a
// full-width bordered card above a half-width pill.
function SheetRow({
  testId,
  icon,
  label,
  onClick,
  workoutOffer,
}: {
  testId: string;
  icon: QuickLogIcon;
  label: string;
  onClick: () => void;
  workoutOffer?: string;
}) {
  const Icon = ICONS[icon];
  return (
    <button
      type="button"
      data-testid={testId}
      data-workout-offer={workoutOffer}
      onClick={onClick}
      className={SHEET_ROW_CLASS}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
        <Icon className="h-5 w-5" stroke={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          data-sheet-row-label
          className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100"
        >
          {label}
        </span>
      </span>
      <IconChevronRight
        className="h-4 w-4 shrink-0 text-slate-400"
        stroke={1.75}
      />
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
