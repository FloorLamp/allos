"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  IconBarbell,
  IconBolt,
  IconChevronRight,
  IconDroplet,
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
import {
  loadLogSheetContext,
  type LogSheetContext,
} from "@/app/(app)/log-sheet-actions";
import {
  logSheetSegments,
  openingLogSegment,
  type LogSegmentId,
  type SegmentLogDays,
} from "@/lib/log-sheet";
import { type QuickLogIcon, type QuickLogItem } from "@/lib/quick-log";

// The log sheet — what the dock's raised puck opens (issue #2651), and still
// what the top bar's caret opens (issue #1416, section E1). ONE sheet with two
// triggers, deliberately: a second "quick log" surface reachable from the same
// screen is how two menus start disagreeing about what can be logged.
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
//     dashboard's nutrition widget renders, over the SAME server-resolved offer.
//     Not a copy: the component, the props and the write core are one each.
//   • today's due doses — a count over `collectHouseholdRollup(...).dueDoses`,
//     the app's one "what's due" computation. The chip OPENS the existing dose
//     overlay; it confirms nothing itself.
//   • an active or likely session — `workoutOffer` from the activity editor
//     context (lib/workout-offer.ts), the same derivation the top bar's ⚡ and
//     the workout dock read. Its LABEL is the offer, so a live session reads
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
// the puck on Nutrition lands on Food — except on the DASHBOARD, which promotes
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
  salad: IconSalad,
  pill: IconPill,
  scale: IconScale,
  heartbeat: IconHeartbeat,
  sparkles: IconSparkles,
  mood: IconMoodSmile,
  droplet: IconDroplet,
  document: IconFileText,
};

export default function QuickLogSheet({
  open,
  onClose,
  restricted = false,
  cycleRelevant = true,
  logHabitDays = null,
}: {
  open: boolean;
  onClose: () => void;
  // An age-restricted profile has no training surface, so the activity entry is
  // dropped (lib/quick-log.ts owns that rule) and its whole segment with it. It
  // still gets the sheet and the puck that opens it (#2651, owner ruling
  // 2026-08-13) — every entry that survives `quickLogMenu(true)` is one a
  // restricted profile may log, and hiding the door removed one-tap logging
  // without adding any protection the per-entry gates were not already giving.
  restricted?: boolean;
  // The #1042 `cycle` relevance bit, resolved once by the app layout — the SAME bit
  // gating the Cycle nav entry and the dashboard phase widget (#1892).
  cycleRelevant?: boolean;
  // Days-logged per segment over the trailing quarter (#2709), resolved once by
  // the shell. Consulted on the DASHBOARD only; null means "not gathered".
  logHabitDays?: SegmentLogDays | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { openCreate, openLive, workoutOffer } = useActivityEditor();
  const { open: openQuickEntry } = useQuickEntry();

  const segments = logSheetSegments(restricted, cycleRelevant);
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

  const context = useLogSheetContext(open);
  const shown = segments.find((s) => s.id === segment) ?? segments[0];

  function run(item: QuickLogItem) {
    // Close first: whatever opens next is its own overlay, and stacking a second
    // one under this sheet would leave a locked body scroll behind when the
    // inner surface closes.
    onClose();
    if (item.target.kind === "activity") openCreate();
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
      description="Log it right here — you'll stay on this page."
      testId="quick-log-sheet"
    >
      {context && (context.routine || context.dueDoses > 0) && (
        <section
          data-testid="log-sheet-context"
          className="mb-4 border-b border-black/5 pb-3 dark:border-white/5"
        >
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Due &amp; usual now
          </h3>
          {/* The dashboard's own control, unchanged: it names every serving and
          every dose the tap will write, and answers from the typed outcome. */}
          {context.routine && <UsualRoutineControl {...context.routine} />}
          <div className="flex flex-wrap gap-2">
            {context.dueDoses > 0 && (
              <ContextChip
                testId="log-sheet-chip-doses"
                icon={<IconPill className="h-4 w-4" stroke={1.75} />}
                // Named by COUNT, not by verdict: it is a fact about today's
                // ledger, and the chip opens the list where each dose keeps its
                // own confirm control. It never confirms anything itself.
                label={
                  context.dueDoses === 1
                    ? "1 dose due"
                    : `${context.dueDoses} doses due`
                }
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
            {!restricted && workoutOffer.kind === "resume" && (
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
          className="mb-3 flex w-full"
        />
      )}

      <ul className="flex flex-col gap-1 pb-1" data-testid="log-sheet-items">
        {(shown?.items ?? []).map((item) => {
          const Icon = ICONS[item.icon];
          return (
            <li key={item.id}>
              <button
                type="button"
                data-testid={`quick-log-${item.id}`}
                onClick={() => run(item)}
                className="tap-target press flex w-full items-center gap-3 rounded-xl border border-black/10 bg-white/70 px-3 py-3 text-left transition hover:bg-slate-100 dark:border-white/10 dark:bg-ink-850 dark:hover:bg-ink-750"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                  <Icon className="h-5 w-5" stroke={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                    {item.label}
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
      className="tap-target press inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm font-medium text-brand-800 transition hover:bg-brand-50 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-200 dark:hover:bg-brand-950/60"
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
function useLogSheetContext(open: boolean): LogSheetContext | null {
  // Keyed on `open`, so closing DISCARDS the answer during the next render
  // rather than through a follow-up effect: a sheet reopened an hour later must
  // never paint the offers it gathered the first time, and clearing that in an
  // effect would both cascade a render and leave a frame where it had.
  const [context, setContext] = useResettableState<LogSheetContext | null>(
    null,
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
        if (requestRef.current === token) setContext(data);
      },
      () => {
        if (requestRef.current === token) setContext(null);
      }
    );
  }, [open, setContext]);
  return context;
}
